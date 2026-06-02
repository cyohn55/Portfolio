import { test, expect, type Page } from '@playwright/test';

/**
 * Regression test: setting a Queen's patrol route must not be shadowed by a
 * stale A* path cached on that Queen.
 *
 * Background: a ground Queen's patrol leg is steered through the same pathfinder
 * as a normal move order (`steeringTarget` -> `pathfinder.nextWaypoint`), which
 * reuses a cached route whenever the new goal is within ~12 world units of the
 * cached one (`hasUsablePath`). After any earlier movement the Queen carries a
 * path whose final waypoint sits on her own position.
 *
 * The bug fixed here: `setPatrol` wrote the patrol route and cleared the Queen's
 * move order but left her path cache intact — unlike `moveCommand` /
 * `attackTarget`, which both drop it. So the very first patrol tick reused the
 * stale path, whose last waypoint IS the Queen's current position, producing a
 * (0,0,0) steering direction. The Queen sat still and never began patrolling.
 *
 * This regression was *introduced* by suppressing the competing right-mouse-down
 * `moveCommand` that previously fired on the same press: that move had been
 * incidentally clearing the path cache and masking the omission in `setPatrol`.
 *
 * The fix (in `src/game/state.ts` `setPatrol`): drop all path-cache and
 * movement-blocking fields when the patrol is set, mirroring `moveCommand`, so
 * the first patrol tick rebuilds the route from the Queen's actual position.
 *
 * This drives the real store end-to-end: it plants a Queen with a stale cached
 * path pinned to her own spot, issues `setPatrol`, ticks the sim, and asserts she
 * actually moves toward the patrol point instead of freezing.
 */

const SIM_DT_MS = 1000 / 60;
// Same open-but-off-arena spot the moveCommand stale-path test uses, where the
// straight line to the goal is not a clear shot, so the pathfinder falls through
// to its cached route (the path under test) instead of short-circuiting on
// line-of-sight.
const QUEEN_POSITION = { x: 200, y: 0.25, z: 200 };
// Patrol endpoint within hasUsablePath's tolerance (step=3, tolerance=step*4=12)
// of the stale cached goal, so the pre-fix code would have reused the stale path.
const PATROL_END = { x: 208, y: 0, z: 208 };

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

test.describe('setPatrol clears stale path cache', () => {
  test('a Queen with a stale path to her current spot starts patrolling when a route is set', async ({ page }) => {
    test.setTimeout(60_000);
    await openMatchWithTerrain(page);

    const result = await page.evaluate(
      async ({ queenPosition, patrolEnd, dtMs }) => {
        const store = (window as any).__rtsStore;
        const state = store.getState();

        const local = state.localPlayerId;
        const otherOwner = state.units.find((u: any) => u.ownerId !== local)?.ownerId;
        if (!otherOwner) return { setupError: 'no enemy player present' } as const;

        // Minimal world: the patrol Queen plus each side's Base so the win/lose
        // check doesn't end the match. No enemies near the Queen — we are testing
        // pure patrol-order handling.
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
        // Stale cache: the path's only waypoint sits on top of the Queen's
        // position, and pathDestX/Z record a previous goal that the patrol point
        // falls within tolerance of — the exact state a Queen ends up in after
        // finishing an earlier move, and the state the bug reproduced from.
        const queen: any = {
          id: 'test-queen', ownerId: local, animal: 'Bear', kind: 'Queen',
          position: { ...queenPosition },
          hp: 200, maxHp: 200,
          attackDamage: 10, moveSpeed: 18,
          attackRange: 4, attackCooldownMs: 1000, lastAttackAtMs: 0,
          rotation: 0,
          pathWaypoints: [{ x: queenPosition.x, y: 0, z: queenPosition.z }],
          pathIndex: 0,
          pathDestX: queenPosition.x,
          pathDestZ: queenPosition.z,
          pathVersion: 1,
        };

        store.setState({
          units: [playerBase, enemyBase, queen],
          matchStarted: true,
          isPaused: false,
          gameOver: false,
          winner: null,
          unitOrders: {},
          queenPatrols: {},
          selectedUnitIds: ['test-queen'],
          deadUnitsToRemove: [],
          targetCache: {},
          aiThinkingOffset: {},
        });

        // Set the patrol route — the action under test. Start at the Queen's
        // gold-ring position (as the input layer does), end at the patrol point.
        store.getState().setPatrol({
          queenId: 'test-queen',
          startPosition: { ...queenPosition },
          endPosition: patrolEnd,
        });

        // The cache fields should be gone *immediately* after the action runs;
        // without the fix they'd survive into the next tick and steer the Queen
        // back to her own position.
        const afterCommand = store.getState().units.find((x: any) => x.id === 'test-queen');
        const pathClearedSynchronously =
          afterCommand &&
          afterCommand.pathWaypoints === undefined &&
          afterCommand.pathDestX === undefined &&
          afterCommand.pathDestZ === undefined;
        const patrolWasSet = Boolean(store.getState().queenPatrols['test-queen']);

        // Sim ~1 second of game time. With the fix the Queen should start moving
        // toward the patrol point; the bug left her motionless on the stale path.
        let nowMs = Date.now();
        const startX = queenPosition.x;
        const startZ = queenPosition.z;
        let earlyDelta = 0; // displacement after just 6 ticks
        for (let i = 0; i < 60; i++) {
          nowMs += dtMs;
          store.getState().tick(dtMs / 1000, nowMs);
          if (i === 5) {
            const q6 = store.getState().units.find((x: any) => x.id === 'test-queen');
            if (q6) earlyDelta = Math.hypot(q6.position.x - startX, q6.position.z - startZ);
          }
        }
        const final = store.getState().units.find((x: any) => x.id === 'test-queen');
        if (!final) return { setupError: 'Queen vanished during sim' } as const;

        const totalDelta = Math.hypot(final.position.x - startX, final.position.z - startZ);
        return { pathClearedSynchronously, patrolWasSet, earlyDelta, totalDelta };
      },
      { queenPosition: QUEEN_POSITION, patrolEnd: PATROL_END, dtMs: SIM_DT_MS },
    );

    if ('setupError' in result) throw new Error(`setup failed: ${result.setupError}`);

    expect(result.patrolWasSet, 'setPatrol should record the patrol route').toBe(true);
    expect(result.pathClearedSynchronously, 'setPatrol should drop the stale path cache synchronously').toBe(true);

    // Within ~6 ticks (~100 ms) the Queen must already have started moving.
    // Pre-fix she sat on the stale path and did not budge.
    expect(result.earlyDelta, 'Queen did not start patrolling promptly after the route was set').toBeGreaterThan(0.5);
    expect(result.totalDelta, 'Queen barely moved overall').toBeGreaterThan(5);
  });
});
