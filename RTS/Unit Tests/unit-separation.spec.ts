import { test, expect, type Page } from '@playwright/test';

/**
 * Regression test for the "animals pile up / clip into each other" bug.
 *
 * Idle units (ones that have arrived at an order, been set down by an Owl, or are
 * simply standing still) never passed through the moving-unit collision routine —
 * only the active movement branches did. So a group dropped or gathered onto a
 * single point would stack with overlapping, intersecting geometry and stay that
 * way, because nothing pushed the stationary models apart.
 *
 * The fix (separateOverlappingUnits in src/game/state.ts) runs a relaxation pass
 * every tick that nudges any pair of settled units closer than their minimum
 * spacing apart, so piles resolve into a spread-out formation.
 *
 * This test drives the real game loop (via the dev-only window handles), plants a
 * cluster of friendly ground units essentially on top of one another with NO move
 * orders, runs the sim, and asserts the cluster spreads out — i.e. no two units
 * remain stacked on the same location. Thresholds are expressed as behavioural
 * expectations (units must end visibly farther apart than they started, and not
 * occupy the same spot), not as copies of the engine's internal spacing constant.
 */

const GROUND_ANIMALS = ['Bear', 'Bunny', 'Cat', 'Fox', 'Pig'] as const;

// Sim cadence matches the game's fixed-timestep tick.
const SIM_DT_MS = 1000 / 60;

// Number of units to stack and how tightly to stack them at the start.
const CLUSTER_SIZE = 6;
const INITIAL_JITTER = 0.3; // units start within this radius of the centre — effectively a pile.

// Two models that end up closer than this (XZ) are considered to be clipping into
// one another. It is well below the engine's spacing target, so passing means the
// pile genuinely resolved rather than the threshold being lenient.
const CLIP_DISTANCE = 1.5;

async function openMatchWithTerrain(page: Page): Promise<void> {
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
      (window as any).__rtsTerrain?.isInitialized?.(),
    ),
    { timeout: 45000 },
  );
}

test.describe('Idle unit separation', () => {
  test('a pile of stationary friendly units spreads out instead of clipping', async ({ page }) => {
    test.setTimeout(90_000);
    await openMatchWithTerrain(page);

    const result = await page.evaluate(
      async ({ clusterSize, jitter, dtMs, groundAnimals }) => {
        const store = (window as any).__rtsStore;
        const tv = (window as any).__rtsTerrain;
        const state = store.getState();
        const local = state.localPlayerId;
        const otherOwner = state.units.find((u: any) => u.ownerId !== local)?.ownerId;
        if (!otherOwner) return { setupError: 'no enemy player present' } as const;

        // Find a walkable, open patch of land for the pile. Probe a few candidate
        // centres and keep the first one whose whole cluster footprint is traversable
        // ground, so the spread-out test isn't fighting water/arena edges.
        const candidates = [
          { x: 0, z: 90 }, { x: 0, z: 130 }, { x: 60, z: 90 },
          { x: -60, z: 90 }, { x: 0, z: -90 }, { x: 0, z: 160 },
        ];
        const animal = groundAnimals[0];
        const footprintOk = (cx: number, cz: number) => {
          for (let r = 0; r <= 8; r += 2) {
            for (const [ox, oz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
              if (!tv.canAnimalMoveTo(animal, { x: cx + ox, y: 0, z: cz + oz })) return false;
            }
          }
          return true;
        };
        const centre = candidates.find((c) => footprintOk(c.x, c.z));
        if (!centre) return { setupError: 'no open land patch found for the cluster' } as const;

        // Bases for both sides so win/lose checks don't end the match mid-sim.
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

        // The pile: friendly ground units packed within `jitter` of the centre, with
        // NO move orders — exactly the idle/stacked case that used to clip forever.
        const cluster: any[] = [];
        for (let i = 0; i < clusterSize; i++) {
          const angle = (i / clusterSize) * Math.PI * 2;
          cluster.push({
            id: `test-pile-${i}`, ownerId: local, animal, kind: 'Unit',
            position: {
              x: centre.x + Math.cos(angle) * jitter,
              y: 0,
              z: centre.z + Math.sin(angle) * jitter,
            },
            hp: 200, maxHp: 200,
            attackDamage: 10, moveSpeed: 12,
            attackRange: 4, attackCooldownMs: 1000, lastAttackAtMs: 0,
            rotation: 0,
          });
        }

        store.setState({
          units: [playerBase, enemyBase, ...cluster],
          matchStarted: true,
          isPaused: false,
          gameOver: false,
          winner: null,
          unitOrders: {}, // no orders — units are idle, separation is the only thing moving them
          queenPatrols: {},
          selectedUnitIds: [],
          deadUnitsToRemove: [],
          targetCache: {},
          aiThinkingOffset: {},
        });

        const pileIds = cluster.map((u) => u.id);
        const readPile = () =>
          store.getState().units.filter((u: any) => pileIds.includes(u.id));

        const startMin = (() => {
          const units = readPile();
          let smallest = Infinity;
          for (let i = 0; i < units.length; i++) {
            for (let j = i + 1; j < units.length; j++) {
              const dx = units[i].position.x - units[j].position.x;
              const dz = units[i].position.z - units[j].position.z;
              const d = Math.sqrt(dx * dx + dz * dz);
              if (d < smallest) smallest = d;
            }
          }
          return smallest;
        })();

        // ~6 s of game time is plenty for a gentle per-tick relaxation to unpile.
        let nowMs = Date.now();
        for (let i = 0; i < 60 * 6; i++) {
          nowMs += dtMs;
          store.getState().tick(dtMs / 1000, nowMs);
        }

        const finalUnits = readPile();
        let endMin = Infinity;
        for (let i = 0; i < finalUnits.length; i++) {
          for (let j = i + 1; j < finalUnits.length; j++) {
            const dx = finalUnits[i].position.x - finalUnits[j].position.x;
            const dz = finalUnits[i].position.z - finalUnits[j].position.z;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d < endMin) endMin = d;
          }
        }

        // Every unit must still be on walkable ground (separation must never shove a
        // unit into water or off the arena).
        const allOnLand = finalUnits.every((u: any) => tv.canAnimalMoveTo(u.animal, u.position));

        return {
          centre, count: finalUnits.length,
          startMinDistance: startMin,
          endMinDistance: endMin,
          allOnLand,
        };
      },
      { clusterSize: CLUSTER_SIZE, jitter: INITIAL_JITTER, dtMs: SIM_DT_MS, groundAnimals: GROUND_ANIMALS },
    );

    if ('setupError' in result) {
      throw new Error(`Test setup failed: ${result.setupError}`);
    }

    // Every unit survived the relaxation and stayed in the cluster.
    expect(result.count).toBe(CLUSTER_SIZE);
    // The pile started essentially stacked...
    expect(result.startMinDistance).toBeLessThan(CLIP_DISTANCE);
    // ...and ended with no two units clipping into one another.
    expect(result.endMinDistance).toBeGreaterThan(CLIP_DISTANCE);
    // The spread strictly increased — separation did real work.
    expect(result.endMinDistance).toBeGreaterThan(result.startMinDistance);
    // Nobody got shoved off walkable ground.
    expect(result.allOnLand).toBe(true);
  });
});
