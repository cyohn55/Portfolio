import { test, expect, type Page } from '@playwright/test';

/**
 * Regression test: a new player move order must not be shadowed by a stale A* path
 * cached on the unit.
 *
 * Background: each ground unit caches its current pathfinding route on itself
 * (`pathWaypoints` / `pathDestX` / `pathDestZ` / `pathVersion`). The pathfinder's
 * `hasUsablePath` check reuses that cache whenever the new destination is within
 * ~12 world units of the cached goal — so two right-clicks dropped near each other
 * skip a full A* recompute.
 *
 * The bug fixed here: `moveCommand` cleared combat / collision / blocking state on
 * the unit but NOT the path cache. So a unit that had just finished moving to A
 * and was then ordered to B (within tolerance, with no direct line-of-sight from
 * the unit's current position to B — e.g. a small redirect that still has to route
 * around terrain) would reuse the cached path, whose last waypoint is A — which IS
 * its current position. The normalized direction vector would be (0,0,0) and the
 * unit would just sit there until the stall detector eventually re-pathed
 * (~0.75 s). To the player this looked like the order was ignored, especially
 * noticeable for units that had already arrived somewhere when a new order came in.
 *
 * The fix (in src/game/state.ts `moveCommand` and `attackTarget`): drop all path
 * cache fields when a new order is issued, so the very next tick rebuilds the
 * route from the unit's actual position to the new target.
 *
 * This test drives the real store end-to-end: it plants a ground unit with a stale
 * cached path whose last waypoint coincides with the unit's position, issues a
 * fresh `moveCommand` toward a nearby point, ticks the sim, and asserts that the
 * unit actually moved instead of freezing.
 */

const SIM_DT_MS = 1000 / 60;
// Open ground far from the moat so the only thing under test is the order
// itself — no bridges, no chokepoints, no enemies.
const UNIT_POSITION = { x: 200, y: 0.25, z: 200 };
// Destination within hasUsablePath's tolerance (step=3, tolerance=step*4=12).
// Crucially, this matches the "right-click somewhere new while the unit is
// already at its previous destination" scenario the user reported.
const NEW_DESTINATION = { x: 208, y: 0, z: 208 };

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

test.describe('moveCommand clears stale path cache', () => {
  test('a player ground unit with a stale path to its current spot moves when re-ordered', async ({ page }) => {
    test.setTimeout(60_000);
    await openMatchWithTerrain(page);

    const result = await page.evaluate(
      async ({ unitPosition, newDest, dtMs }) => {
        const store = (window as any).__rtsStore;
        const state = store.getState();

        const local = state.localPlayerId;
        const otherOwner = state.units.find((u: any) => u.ownerId !== local)?.ownerId;
        if (!otherOwner) return { setupError: 'no enemy player present' } as const;

        // Minimal world: one player ground unit on open ground, plus each side's
        // Base so the win/lose check doesn't end the match. No enemies near the
        // unit — we are testing pure movement-order handling.
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
        // Stale cache: the path's last waypoint sits on top of the unit's
        // position, and pathDestX/Z record a previous destination that the new
        // order's target falls within tolerance of. This is exactly the state a
        // unit ends up in after finishing a move order — and the state the bug
        // reproduced from.
        const playerUnit: any = {
          id: 'test-player-unit', ownerId: local, animal: 'Bear', kind: 'Unit',
          position: { ...unitPosition },
          hp: 100, maxHp: 100,
          attackDamage: 10, moveSpeed: 12,
          attackRange: 4, attackCooldownMs: 1000, lastAttackAtMs: 0,
          rotation: 0,
          pathWaypoints: [{ x: unitPosition.x, y: 0, z: unitPosition.z }],
          pathIndex: 0,
          pathDestX: unitPosition.x,
          pathDestZ: unitPosition.z,
          pathVersion: 1,
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

        // Issue the new order — the action under test.
        store.getState().moveCommand({ unitIds: ['test-player-unit'], target: newDest });

        // The cache fields should be gone *immediately* after the action runs;
        // without the fix they'd survive into the next tick and steer the unit
        // back to its starting point.
        const afterCommand = store.getState().units.find((x: any) => x.id === 'test-player-unit');
        const pathClearedSynchronously =
          afterCommand &&
          afterCommand.pathWaypoints === undefined &&
          afterCommand.pathDestX === undefined &&
          afterCommand.pathDestZ === undefined;

        // Sim ~1 second of game time. With the fix the unit should clear plenty
        // of ground toward the new destination; the bug used to leave the unit
        // motionless until pathStall (~45 ticks ≈ 0.75 s) re-triggered planning.
        let nowMs = Date.now();
        const startX = unitPosition.x;
        const startZ = unitPosition.z;
        let earlyDelta = 0; // displacement after just 6 ticks
        for (let i = 0; i < 60; i++) {
          nowMs += dtMs;
          store.getState().tick(dtMs / 1000, nowMs);
          if (i === 5) {
            const u6 = store.getState().units.find((x: any) => x.id === 'test-player-unit');
            if (u6) earlyDelta = Math.hypot(u6.position.x - startX, u6.position.z - startZ);
          }
        }
        const final = store.getState().units.find((x: any) => x.id === 'test-player-unit');
        if (!final) return { setupError: 'unit vanished during sim' } as const;

        const totalDelta = Math.hypot(final.position.x - startX, final.position.z - startZ);
        const distanceToDest = Math.hypot(final.position.x - newDest.x, final.position.z - newDest.z);
        return {
          pathClearedSynchronously,
          earlyDelta,
          totalDelta,
          distanceToDest,
        };
      },
      { unitPosition: UNIT_POSITION, newDest: NEW_DESTINATION, dtMs: SIM_DT_MS },
    );

    if ('setupError' in result) throw new Error(`setup failed: ${result.setupError}`);

    expect(result.pathClearedSynchronously, 'moveCommand should drop the stale path cache synchronously').toBe(true);

    // Tight: within ~6 ticks (~100 ms) the unit must already have started moving.
    // Pre-fix the unit was stationary for ~45 ticks before the stall detector
    // re-pathed, so this would have been 0 well within tolerance.
    expect(result.earlyDelta, 'unit did not start moving promptly after the new order').toBeGreaterThan(0.5);

    // Within 1 second of game time a unit at moveSpeed=12 should cover most of
    // the ~11-unit gap to the new destination.
    expect(result.distanceToDest, 'unit failed to converge on the new destination').toBeLessThan(2);
    expect(result.totalDelta, 'unit barely moved overall').toBeGreaterThan(8);
  });
});
