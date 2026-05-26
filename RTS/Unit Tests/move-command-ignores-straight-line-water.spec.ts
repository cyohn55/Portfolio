import { test, expect, type Page } from '@playwright/test';

/**
 * Regression: `moveCommand` must not silently drop a player order just because the
 * unit's straight line to the click crosses water.
 *
 * Bug: state.ts `moveCommand` used to call
 * `terrainValidator.isPathValid(u.animal, u.position, cmd.target)` — a raster
 * sample of the straight line between the unit and the click. For ground units,
 * any sample over non-bridged water made it return false, and the unit's order
 * was `continue`d without being recorded. But the actual mover is now grid A*
 * (`pathfinder.nextWaypoint`), which routes around water, so the precheck was
 * rejecting orders the pathfinder would have fulfilled. Worse: because the
 * verdict depends on each unit's own position, units in the same selection got
 * different answers once they spread out across the map — exactly the
 * "some clusters listen to move orders and others don't, especially after the
 * units reach their destination" symptom users reported.
 *
 * Fix (in src/game/state.ts `moveCommand`): drop the per-unit straight-line
 * precheck. The destination-tile check (`canAnimalMoveTo(cmd.target)`) is kept
 * — it depends only on the click, not on each unit's position, so it can't
 * cause cluster asymmetry.
 *
 * This test makes `isPathValid` return false (the bug condition) and asserts
 * that the new order is still recorded and the unit actually moves. Pre-fix
 * the assertion on `unitOrders[id]` would have been undefined; post-fix it's
 * the new target.
 */

const SIM_DT_MS = 1000 / 60;
// Open ground on the southern half of the map (well clear of map edges and
// the moat in the middle).
const UNIT_POSITION = { x: 60, y: 0.25, z: 80 };
// A second point on the same land mass, far enough away that the bug fix is
// observable as actual movement within the simulated second. Critically the
// destination tile itself must still pass canAnimalMoveTo — the kept check —
// so we pick another point on the same side of the moat.
const NEW_DESTINATION = { x: -60, y: 0, z: 80 };

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

test.describe('moveCommand ignores straight-line water rejections', () => {
  test('a player order is recorded even when isPathValid would reject the straight line', async ({ page }) => {
    test.setTimeout(60_000);
    await openMatchWithTerrain(page);

    const result = await page.evaluate(
      async ({ unitPosition, newDest, dtMs }) => {
        const store = (window as any).__rtsStore;
        const terrain = (window as any).__rtsTerrain;
        const state = store.getState();

        const local = state.localPlayerId;
        const otherOwner = state.units.find((u: any) => u.ownerId !== local)?.ownerId;
        if (!otherOwner) return { setupError: 'no enemy player present' } as const;

        // Force the bug condition: every straight-line path check fails.
        // The fix must make moveCommand independent of this. The destination
        // tile check (canAnimalMoveTo) is left alone so it can keep guarding
        // against ordering ground units onto water.
        const originalIsPathValid = terrain.isPathValid.bind(terrain);
        terrain.isPathValid = () => false;

        try {
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
          const playerUnit: any = {
            id: 'test-player-unit', ownerId: local, animal: 'Bear', kind: 'Unit',
            position: { ...unitPosition },
            hp: 100, maxHp: 100,
            attackDamage: 10, moveSpeed: 12,
            attackRange: 4, attackCooldownMs: 1000, lastAttackAtMs: 0,
            rotation: 0,
          };

          store.setState({
            units: [playerBase, enemyBase, playerUnit],
            matchStarted: true,
            isPaused: false,
            gameOver: false,
            winner: null,
            unitOrders: {},
            queenPatrols: {},
            selectedUnitIds: ['test-player-unit'],
            deadUnitsToRemove: [],
            targetCache: {},
            aiThinkingOffset: {},
          });

          // Sanity: confirm the destination tile itself is still considered
          // reachable by the kept check. If this ever fails it means the test
          // coordinates wandered onto water — pick a different NEW_DESTINATION.
          const destinationStillReachable = terrain.canAnimalMoveTo('Bear', newDest);

          store.getState().moveCommand({ unitIds: ['test-player-unit'], target: newDest });

          const afterCommand = store.getState();
          const orderRecorded = afterCommand.unitOrders['test-player-unit'];

          // Sim ~1 second to verify the unit actually starts moving — proves
          // the order wasn't just stored cosmetically but is being acted on by
          // the per-tick mover (which now does its own A* routing).
          let nowMs = Date.now();
          const startX = unitPosition.x;
          const startZ = unitPosition.z;
          for (let i = 0; i < 60; i++) {
            nowMs += dtMs;
            store.getState().tick(dtMs / 1000, nowMs);
          }
          const final = store.getState().units.find((x: any) => x.id === 'test-player-unit');
          if (!final) return { setupError: 'unit vanished during sim' } as const;

          const totalDelta = Math.hypot(final.position.x - startX, final.position.z - startZ);
          return {
            destinationStillReachable,
            orderRecorded: orderRecorded ?? null,
            totalDelta,
          };
        } finally {
          // Always restore — leaking a stub onto the singleton would break
          // every subsequent test in this worker.
          terrain.isPathValid = originalIsPathValid;
        }
      },
      { unitPosition: UNIT_POSITION, newDest: NEW_DESTINATION, dtMs: SIM_DT_MS },
    );

    if ('setupError' in result) throw new Error(`setup failed: ${result.setupError}`);

    expect(
      result.destinationStillReachable,
      'precondition: NEW_DESTINATION must still pass canAnimalMoveTo — adjust coords if this fails',
    ).toBe(true);

    expect(
      result.orderRecorded,
      'moveCommand should record the order even when isPathValid rejects the straight line',
    ).not.toBeNull();
    expect(result.orderRecorded).toMatchObject({ x: NEW_DESTINATION.x, z: NEW_DESTINATION.z });

    // The unit should make real progress toward the new destination. Pre-fix
    // the order was never recorded so it stayed put (delta ≈ 0).
    expect(
      result.totalDelta,
      'unit did not move after a moveCommand whose straight line crossed water',
    ).toBeGreaterThan(5);
  });
});
