import { test, expect, type Page } from '@playwright/test';

/**
 * Feature test: a Queen's spawn rally point.
 *
 * The player selects a lone Queen and taps the rally key twice — once to start
 * aiming the blue line, once to drop the rally point — committing a per-Queen
 * `queenRallyPoints` entry via the `setQueenRally` store action. From then on,
 * every Unit that Queen spawns is handed a move order to that point in the spawn
 * loop (`src/game/state.ts`), so reinforcements march to a staging spot instead
 * of idling beside the Queen.
 *
 * This drives the real store end-to-end. It exercises two contracts:
 *   1. `setQueenRally` records a rally point only for an owned Queen, and rejects
 *      a non-owned / non-Queen target.
 *   2. A Queen carrying a rally point stamps each freshly spawned Unit with a
 *      move order equal to that rally point (and the moving_to_order state).
 *
 * Inputs (positions, the rally point) are the only fixed values; every assertion
 * reads back the store's own output rather than a hard-coded internal.
 */

const SIM_DT_MS = 1000 / 60;
// Open, off-arena spot — same one the patrol specs use. The exact location does
// not matter here: the spawned unit's order is the rally point verbatim, so the
// test asserts the order assignment, not where the newborn ends up walking.
const QUEEN_POSITION = { x: 200, y: 0.25, z: 200 };
// A distinct rally point so a spawned unit's order can't accidentally match the
// Queen's own position or a default.
const RALLY_POINT = { x: 180, y: 0, z: 160 };

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
      (window as any).__rtsTerrain?.isInitialized?.() &&
      (window as any).__rtsPath?.isReady?.(),
    ),
    { timeout: 45000 },
  );
}

test.describe('Queen spawn rally point', () => {
  test('setQueenRally only binds an owned Queen, and her spawns inherit the rally order', async ({ page }) => {
    test.setTimeout(60_000);
    await openMatchWithTerrain(page);

    const result = await page.evaluate(
      async ({ queenPosition, rallyPoint, dtMs, spawnIntervalMs }) => {
        const store = (window as any).__rtsStore;
        const state = store.getState();

        const local = state.localPlayerId;
        const otherOwner = state.units.find((u: any) => u.ownerId !== local)?.ownerId;
        if (!otherOwner) return { setupError: 'no enemy player present' } as const;

        // Minimal world: the friendly Queen plus each side's Base so the win/lose
        // check doesn't end the match. No enemies near the Queen so combat never
        // diverts the freshly spawned unit off its rally order.
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
        const queen: any = {
          id: 'test-queen', ownerId: local, animal: 'Bear', kind: 'Queen',
          position: { ...queenPosition },
          hp: 200, maxHp: 200,
          attackDamage: 10, moveSpeed: 18,
          attackRange: 4, attackCooldownMs: 1000, lastAttackAtMs: 0,
          rotation: 0,
        };

        const preexistingIds = new Set([playerBase.id, enemyBase.id, queen.id]);

        store.setState({
          units: [playerBase, enemyBase, queen],
          matchStarted: true,
          isPaused: false,
          gameOver: false,
          winner: null,
          unitOrders: {},
          queenPatrols: {},
          queenRallyPoints: {},
          // Force the very next tick over the spawn interval threshold.
          lastSpawnAtMsByQueenId: {},
          selectedUnitIds: ['test-queen'],
          deadUnitsToRemove: [],
          targetCache: {},
          aiThinkingOffset: {},
        });

        // Contract 1a: rejecting a non-Queen target (the enemy Base) must not
        // create a rally entry — ownership/kind are validated in the action.
        store.getState().setQueenRally({ queenId: 'test-enemy-base', rallyPoint });
        const rejectedNonQueen = store.getState().queenRallyPoints['test-enemy-base'] === undefined;

        // Contract 1b: the owned Queen records the rally point.
        store.getState().setQueenRally({ queenId: 'test-queen', rallyPoint });
        const recorded = store.getState().queenRallyPoints['test-queen'];
        const rallyRecorded =
          Boolean(recorded) && recorded.x === rallyPoint.x && recorded.z === rallyPoint.z;

        // Tick once past the spawn interval so the Queen spawns exactly one Unit.
        const nowMs = Date.now() + spawnIntervalMs + 1;
        store.getState().tick(dtMs / 1000, nowMs);

        // Contract 2: locate the unit the Queen just spawned (any friendly Unit
        // that wasn't planted above) and read back its order.
        const after = store.getState();
        const spawned = after.units.filter(
          (u: any) => u.ownerId === local && u.kind === 'Unit' && !preexistingIds.has(u.id),
        );
        const spawnedCount = spawned.length;
        const everySpawnedRallied = spawnedCount > 0 && spawned.every((u: any) => {
          const order = after.unitOrders[u.id];
          return Boolean(order) &&
            order.x === rallyPoint.x &&
            order.z === rallyPoint.z &&
            u.unitState === 'moving_to_order';
        });

        return { rejectedNonQueen, rallyRecorded, spawnedCount, everySpawnedRallied };
      },
      { queenPosition: QUEEN_POSITION, rallyPoint: RALLY_POINT, dtMs: SIM_DT_MS, spawnIntervalMs: 5000 },
    );

    if ('setupError' in result) throw new Error(`setup failed: ${result.setupError}`);

    expect(result.rejectedNonQueen, 'setQueenRally must not bind a non-Queen target').toBe(true);
    expect(result.rallyRecorded, 'setQueenRally should record the rally point for the owned Queen').toBe(true);
    expect(result.spawnedCount, 'the Queen should have spawned a Unit this tick').toBeGreaterThan(0);
    expect(result.everySpawnedRallied, 'every freshly spawned Unit should carry a move order to the rally point').toBe(true);
  });
});
