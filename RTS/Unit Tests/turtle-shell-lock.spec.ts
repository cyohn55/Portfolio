import { test, expect, type Page } from '@playwright/test';

/**
 * Feature test: the Turtle "shell" lock.
 *
 * A Turtle is toggled into a shell pose (F0) by pressing the primary and
 * secondary mouse buttons together. While shelled it must:
 *   1. hold position — every movement branch in the sim funnels its proposed
 *      next position through checkCollision, which refuses to move a shelled
 *      unit (src/game/state.ts), so even an active move order cannot displace it;
 *   2. still attack any enemy in range (combat never touches checkCollision).
 *
 * The toggle action (store.toggleTurtleShell) must additionally drop the unit's
 * pending move order when it engages, so the turtle does not lurch toward a
 * stale destination when later released — and must only ever affect the local
 * player's own Turtle units.
 *
 * These tests drive the real store end-to-end (window.__rtsStore) exactly as the
 * sim runs it: inject a minimal world, run the action under test, tick the sim,
 * and assert on the resulting unit state — no mocked or hard-coded outputs.
 */

const SIM_DT_MS = 1000 / 60;
// Open ground far from the moat/bridges so the only behavior under test is the
// shell lock itself — no terrain chokepoints, no pathfinding detours.
const TURTLE_POSITION = { x: 200, y: 0.25, z: 200 };
// A move destination well outside arrival tolerance, so an *unlocked* turtle
// would clearly travel toward it within the simulated window.
const FAR_DESTINATION = { x: 240, y: 0, z: 200 };
// Enemy placed inside the turtle's attack range so "attack in place" can fire,
// and within the 8-unit combat-acquisition radius used while a unit has an order.
const ENEMY_OFFSET = 4;

// Boot the app into a running match with terrain + pathfinder ready. Turtle is
// among the chosen animals so UnitsLayer actually bakes the six Turtle_F#
// pose variants in-browser (DRACO decode + per-frame node extraction) — if that
// bake threw, the canvas would error and these tests would surface it.
async function openTurtleMatch(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('text=QUICK PLAY', { timeout: 30000 });
  await page.click('text=QUICK PLAY');
  for (const animal of ['Turtle', 'Bear', 'Bunny']) {
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

test.describe('Turtle shell lock', () => {
  test('a shelled turtle holds position despite an active order, yet still attacks in place', async ({ page }) => {
    test.setTimeout(60_000);
    await openTurtleMatch(page);

    const result = await page.evaluate(
      async ({ turtlePos, farDest, enemyOffset, dtMs }) => {
        const store = (window as any).__rtsStore;
        const state = store.getState();
        const local = state.localPlayerId;
        const otherOwner = state.units.find((u: any) => u.ownerId !== local)?.ownerId;
        if (!otherOwner) return { setupError: 'no enemy player present' } as const;

        const makeBase = (id: string, ownerId: string, x: number, z: number) => ({
          id, ownerId, animal: 'Bear', kind: 'Base',
          position: { x, y: 0, z }, hp: 10000, maxHp: 10000,
          attackDamage: 0, moveSpeed: 0, attackRange: 4,
          attackCooldownMs: 1000, lastAttackAtMs: 0, rotation: 0,
        });

        // Shelled turtle WITH a standing order to a far point: proves the lock
        // overrides even the highest-priority movement path.
        const turtle: any = {
          id: 'test-turtle', ownerId: local, animal: 'Turtle', kind: 'Unit',
          position: { ...turtlePos }, hp: 100, maxHp: 100,
          attackDamage: 15, moveSpeed: 12,
          attackRange: 6, attackCooldownMs: 300, lastAttackAtMs: 0,
          rotation: 0, isShelled: true,
        };
        // Enemy sitting just inside the turtle's reach.
        const enemy: any = {
          id: 'test-enemy', ownerId: otherOwner, animal: 'Bear', kind: 'Unit',
          position: { x: turtlePos.x + enemyOffset, y: turtlePos.y, z: turtlePos.z },
          hp: 500, maxHp: 500,
          attackDamage: 0, moveSpeed: 0, attackRange: 0,
          attackCooldownMs: 100000, lastAttackAtMs: 0, rotation: 0,
        };

        store.setState({
          units: [
            makeBase('test-player-base', local, 250, 250),
            makeBase('test-enemy-base', otherOwner, -250, -250),
            turtle, enemy,
          ],
          matchStarted: true, isPaused: false, gameOver: false, winner: null,
          unitOrders: { 'test-turtle': { ...farDest } },
          queenPatrols: {}, selectedUnitIds: ['test-turtle'],
          deadUnitsToRemove: [], targetCache: {}, aiThinkingOffset: {},
        });

        const enemyHpBefore = store.getState().units.find((u: any) => u.id === 'test-enemy').hp;

        let nowMs = Date.now();
        for (let i = 0; i < 90; i++) {
          nowMs += dtMs;
          store.getState().tick(dtMs / 1000, nowMs);
        }

        const finalTurtle = store.getState().units.find((u: any) => u.id === 'test-turtle');
        const finalEnemy = store.getState().units.find((u: any) => u.id === 'test-enemy');
        if (!finalTurtle || !finalEnemy) return { setupError: 'a test unit vanished during sim' } as const;

        return {
          positionDelta: Math.hypot(
            finalTurtle.position.x - turtlePos.x,
            finalTurtle.position.z - turtlePos.z,
          ),
          stillShelled: finalTurtle.isShelled === true,
          enemyHpDrop: enemyHpBefore - finalEnemy.hp,
        };
      },
      { turtlePos: TURTLE_POSITION, farDest: FAR_DESTINATION, enemyOffset: ENEMY_OFFSET, dtMs: SIM_DT_MS },
    );

    if ('setupError' in result) throw new Error(`setup failed: ${result.setupError}`);

    // Movement is fully locked: after ~1.5 s of ticks with an active far order,
    // the turtle has not meaningfully left its spot.
    expect(result.positionDelta, 'a shelled turtle must not move').toBeLessThan(0.5);
    expect(result.stillShelled, 'the turtle should remain shelled until toggled').toBe(true);
    // Combat is untouched by the lock: the in-range enemy took damage.
    expect(result.enemyHpDrop, 'a shelled turtle must still attack an enemy in range').toBeGreaterThan(0);
  });

  test('toggleTurtleShell locks then releases the turtle, clears its order, and ignores non-owned / non-turtle units', async ({ page }) => {
    test.setTimeout(60_000);
    await openTurtleMatch(page);

    const result = await page.evaluate(
      async ({ turtlePos, farDest, dtMs }) => {
        const store = (window as any).__rtsStore;
        const state = store.getState();
        const local = state.localPlayerId;
        const otherOwner = state.units.find((u: any) => u.ownerId !== local)?.ownerId;
        if (!otherOwner) return { setupError: 'no enemy player present' } as const;

        const makeBase = (id: string, ownerId: string, x: number, z: number) => ({
          id, ownerId, animal: 'Bear', kind: 'Base',
          position: { x, y: 0, z }, hp: 10000, maxHp: 10000,
          attackDamage: 0, moveSpeed: 0, attackRange: 4,
          attackCooldownMs: 1000, lastAttackAtMs: 0, rotation: 0,
        });
        const baseUnit = (id: string, ownerId: string, animal: string, x: number, z: number) => ({
          id, ownerId, animal, kind: 'Unit',
          position: { x, y: turtlePos.y, z }, hp: 100, maxHp: 100,
          attackDamage: 10, moveSpeed: 12, attackRange: 4,
          attackCooldownMs: 1000, lastAttackAtMs: 0, rotation: 0,
        });

        const playerTurtle = baseUnit('player-turtle', local, 'Turtle', turtlePos.x, turtlePos.z);
        const playerBear = baseUnit('player-bear', local, 'Bear', turtlePos.x + 30, turtlePos.z); // not a turtle
        const enemyTurtle = baseUnit('enemy-turtle', otherOwner, 'Turtle', turtlePos.x - 30, turtlePos.z); // not owned

        store.setState({
          units: [
            makeBase('p-base', local, 250, 250),
            makeBase('e-base', otherOwner, -250, -250),
            playerTurtle, playerBear, enemyTurtle,
          ],
          matchStarted: true, isPaused: false, gameOver: false, winner: null,
          // Player turtle starts with a standing order, to verify the toggle clears it.
          unitOrders: { 'player-turtle': { ...farDest } },
          queenPatrols: { },
          selectedUnitIds: ['player-turtle', 'player-bear', 'enemy-turtle'],
          deadUnitsToRemove: [], targetCache: {}, aiThinkingOffset: {},
        });

        // --- Engage the lock on the whole selection ---
        store.getState().toggleTurtleShell(['player-turtle', 'player-bear', 'enemy-turtle']);
        const afterEngage = store.getState();
        const lockedTurtle = afterEngage.units.find((u: any) => u.id === 'player-turtle');
        const engaged = {
          turtleShelled: lockedTurtle.isShelled === true,
          orderCleared: afterEngage.unitOrders['player-turtle'] === undefined,
          bearUntouched: afterEngage.units.find((u: any) => u.id === 'player-bear').isShelled !== true,
          enemyTurtleUntouched: afterEngage.units.find((u: any) => u.id === 'enemy-turtle').isShelled !== true,
        };

        // Locked turtle should not move even after re-issuing an order.
        store.getState().moveCommand({ unitIds: ['player-turtle'], target: farDest });
        let nowMs = Date.now();
        for (let i = 0; i < 30; i++) { nowMs += dtMs; store.getState().tick(dtMs / 1000, nowMs); }
        const lockedTurtleAfterTicks = store.getState().units.find((u: any) => u.id === 'player-turtle');
        const lockedDelta = Math.hypot(
          lockedTurtleAfterTicks.position.x - turtlePos.x,
          lockedTurtleAfterTicks.position.z - turtlePos.z,
        );

        // --- Release the lock and confirm movement resumes ---
        store.getState().toggleTurtleShell(['player-turtle']);
        const released = store.getState().units.find((u: any) => u.id === 'player-turtle');
        const releasedStartX = released.position.x;
        const releasedStartZ = released.position.z;
        store.getState().moveCommand({ unitIds: ['player-turtle'], target: farDest });
        for (let i = 0; i < 60; i++) { nowMs += dtMs; store.getState().tick(dtMs / 1000, nowMs); }
        const movedTurtle = store.getState().units.find((u: any) => u.id === 'player-turtle');
        const releasedDelta = Math.hypot(
          movedTurtle.position.x - releasedStartX,
          movedTurtle.position.z - releasedStartZ,
        );

        return {
          engaged,
          stillShelledWhileLocked: lockedTurtleAfterTicks.isShelled === true,
          lockedDelta,
          releasedShelledFlag: released.isShelled === true,
          releasedDelta,
        };
      },
      { turtlePos: TURTLE_POSITION, farDest: FAR_DESTINATION, dtMs: SIM_DT_MS },
    );

    if ('setupError' in result) throw new Error(`setup failed: ${result.setupError}`);

    // Engage only the owned turtle; clear its order; leave others alone.
    expect(result.engaged.turtleShelled, 'toggling should shell the owned turtle').toBe(true);
    expect(result.engaged.orderCleared, 'shelling should drop the pending move order').toBe(true);
    expect(result.engaged.bearUntouched, 'a non-turtle unit must not be shelled').toBe(true);
    expect(result.engaged.enemyTurtleUntouched, 'an enemy turtle must not be shelled').toBe(true);

    // While locked it stays put even with a fresh order.
    expect(result.stillShelledWhileLocked, 'turtle should stay shelled until toggled off').toBe(true);
    expect(result.lockedDelta, 'a locked turtle must not move on a new order').toBeLessThan(0.5);

    // Toggling again releases the lock and movement resumes.
    expect(result.releasedShelledFlag, 'second toggle should un-shell the turtle').toBe(false);
    expect(result.releasedDelta, 'a released turtle must move on a new order').toBeGreaterThan(5);
  });
});
