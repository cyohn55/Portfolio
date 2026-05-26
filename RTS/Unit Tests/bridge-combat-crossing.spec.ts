import { test, expect, type Page } from '@playwright/test';

/**
 * Regression test for the "units freeze on the Center_Bridge" bug.
 *
 * Two compounding rules used to leave a player ground unit stuck mid-deck whenever
 * an enemy was on or near the bridge:
 *
 *   1. The combat phase moved the unit *toward* the enemy (to engage) regardless
 *      of an active move order. The order phase moved the unit south toward its
 *      destination, and the combat phase pulled it north toward the enemy on the
 *      deck. The two steps cancelled out and the unit oscillated to a stop.
 *
 *   2. Enemy collision-push shoved the unit off the narrow deck centreline. Once
 *      a unit ended up where every adjacent step hit water, the wall-slide rescue
 *      could not help and the unit was terrain-trapped at the chokepoint.
 *
 * The fixes (in src/game/state.ts):
 *   - The combat "advance toward target" branch now respects an active move
 *     order, matching the existing rule already applied to kiting. The move
 *     order is authoritative; engage-pursuit only kicks in when idle.
 *   - A ground unit with an active move order that is currently on a bridge
 *     deck ignores enemy collision push (combat damage still applies through
 *     the normal combat phase). This lets it slip past a blocker at the
 *     chokepoint and complete the crossing instead of dying in place.
 *
 * This test drives the real game loop end-to-end (via the dev-only window
 * handles), plants one enemy on the deck, orders one player ground unit across
 * the Center_Bridge, and asserts the player reaches the far side rather than
 * freezing on the deck.
 */

const GROUND_ANIMALS = ['Bear', 'Bunny', 'Chicken', 'Cat', 'Fox', 'Pig', 'Yetti'] as const;

// Sim cadence matches the game's fixed-timestep tick.
const SIM_DT_MS = 1000 / 60;

// Center_Bridge spans roughly z ∈ [-50, 50] over the moat; spawn the player unit just
// north of the bridge, plant the enemy mid-deck, and send the player past the south
// shore. Numbers are well inside the bridge footprint reported by getBridgeBounds().
const PLAYER_SPAWN = { x: 0, y: 0.25, z: 80 };
const ENEMY_ON_DECK = { x: 0, y: 0.25, z: 10 };
const DEST_SOUTH = { x: 0, y: 0, z: -120 };

async function openMatchWithTerrain(page: Page): Promise<void> {
  // The terrain validator and pathfinder are only built after the BattleMap component
  // mounts, which happens inside a live match. Click through the lobby to get there.
  await page.goto('/');
  await page.waitForSelector('text=QUICK PLAY', { timeout: 30000 });
  await page.click('text=QUICK PLAY');
  for (const animal of ['Bear', 'Bunny', 'Cat']) {
    await page.waitForSelector(`text=${animal}`, { timeout: 15000 });
    await page.click(`text=${animal}`);
  }
  await (await page.waitForSelector('button:has-text("Start")', { timeout: 15000 })).click();
  await page.waitForFunction(
    () => Boolean(
      (window as any).__rtsStore &&
      (window as any).__rtsTerrain?.isInitialized?.() &&
      (window as any).__rtsPath?.isReady?.(),
    ),
    { timeout: 45000 },
  );
}

test.describe('Center_Bridge crossing under combat', () => {
  test('a player ground unit ordered across the bridge reaches the far side despite an enemy on the deck', async ({ page }) => {
    test.setTimeout(90_000);
    await openMatchWithTerrain(page);

    const result = await page.evaluate(
      async ({ playerSpawn, enemyOnDeck, dest, dtMs, groundAnimals }) => {
        const store = (window as any).__rtsStore;
        const tv = (window as any).__rtsTerrain;
        const state = store.getState();

        // Sanity: the planted enemy needs to sit on a bridge deck for the regression
        // to actually exercise the freeze scenario.
        const isOnDeck = tv.isPositionOnBridge
          ? tv.isPositionOnBridge(enemyOnDeck).onBridge
          : tv.bridgeAt(enemyOnDeck).onBridge;
        if (!isOnDeck) {
          return { setupError: `enemy position ${JSON.stringify(enemyOnDeck)} is not on a bridge deck` } as const;
        }

        const local = state.localPlayerId;
        const otherOwner = state.units.find((u: any) => u.ownerId !== local)?.ownerId;
        if (!otherOwner) return { setupError: 'no enemy player present' } as const;

        // Reset the world to a known minimal setup: one player ground unit, one
        // immovable enemy parked mid-deck, plus each side's Base so win/lose checks
        // don't end the match early.
        const groundAnimal = groundAnimals[0];
        const playerBase = {
          id: 'test-player-base', ownerId: local, animal: 'Bear', kind: 'Base',
          position: { x: 250, y: 0, z: 250 }, hp: 10000, maxHp: 10000,
          attackDamage: 0, moveSpeed: 0, attackRange: 4, attackCooldownMs: 1000,
          lastAttackAtMs: 0, rotation: 0,
        };
        const enemyBase = {
          id: 'test-enemy-base', ownerId: otherOwner, animal: 'Bear', kind: 'Base',
          position: { x: -250, y: 0, z: -250 }, hp: 10000, maxHp: 10000,
          attackDamage: 0, moveSpeed: 0, attackRange: 4, attackCooldownMs: 1000,
          lastAttackAtMs: 0, rotation: 0,
        };
        const playerUnit = {
          id: 'test-player-unit', ownerId: local, animal: groundAnimal, kind: 'Unit',
          position: { ...playerSpawn },
          hp: 200, maxHp: 200,
          attackDamage: 10, moveSpeed: 12,
          attackRange: 4, attackCooldownMs: 1000, lastAttackAtMs: 0,
          rotation: 0,
        };
        // moveSpeed=0 keeps the enemy parked exactly on the deck the whole sim.
        const enemyUnit = {
          id: 'test-enemy-blocker', ownerId: otherOwner, animal: groundAnimal, kind: 'Unit',
          position: { ...enemyOnDeck },
          hp: 9999, maxHp: 9999,
          attackDamage: 5, moveSpeed: 0,
          attackRange: 4, attackCooldownMs: 1500, lastAttackAtMs: 0,
          rotation: 0,
        };

        store.setState({
          units: [playerBase, enemyBase, playerUnit, enemyUnit],
          matchStarted: true,
          isPaused: false,
          gameOver: false,
          winner: null,
          unitOrders: { 'test-player-unit': dest },
          queenPatrols: {},
          selectedUnitIds: [],
          deadUnitsToRemove: [],
          targetCache: {},
          aiThinkingOffset: {},
        });

        // Run a generous simulated window (~25 s of game time) and record the unit's
        // best (most southerly) position and whether it ever appears stuck.
        let nowMs = Date.now();
        const startZ = playerSpawn.z;
        let mostSouthZ = startZ;
        let stuckTicks = 0;
        let lastZ = startZ;
        for (let i = 0; i < 60 * 25; i++) {
          nowMs += dtMs;
          store.getState().tick(dtMs / 1000, nowMs);

          const u = store.getState().units.find((x: any) => x.id === 'test-player-unit');
          if (!u) break; // killed — counted as a failure to cross.
          if (u.position.z < mostSouthZ) mostSouthZ = u.position.z;

          // "Stuck" = z barely changed for many consecutive ticks while still north of
          // the destination (i.e. still trying to advance south).
          if (Math.abs(u.position.z - lastZ) < 0.05 && u.position.z > dest.z + 10) {
            stuckTicks++;
          } else {
            stuckTicks = 0;
          }
          lastZ = u.position.z;
          if (u.position.z <= dest.z + 5) break; // reached the far side.
        }

        const finalUnit = store.getState().units.find((x: any) => x.id === 'test-player-unit');
        return {
          startZ,
          mostSouthZ,
          stuckTicks,
          finalAlive: Boolean(finalUnit && finalUnit.hp > 0),
          finalZ: finalUnit ? finalUnit.position.z : null,
        };
      },
      { playerSpawn: PLAYER_SPAWN, enemyOnDeck: ENEMY_ON_DECK, dest: DEST_SOUTH, dtMs: SIM_DT_MS, groundAnimals: GROUND_ANIMALS },
    );

    if ('setupError' in result) throw new Error(`setup failed: ${result.setupError}`);

    // The unit must actually make it across — well past the south shore of the moat.
    // Stationary-for-300+-ticks (5+ s of game time) is the user-visible "frozen" state.
    expect(result.finalAlive, 'player unit died en route').toBe(true);
    expect(result.stuckTicks, 'player unit froze on the deck for many consecutive ticks').toBeLessThan(180);
    expect(result.mostSouthZ, 'player unit never made it past the moat').toBeLessThan(-60);
  });
});
