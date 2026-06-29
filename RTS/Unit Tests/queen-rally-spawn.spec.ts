import { test, expect, type Page } from '@playwright/test';

/**
 * Feature test: a Queen's spawn rally point.
 *
 * The player selects a lone Queen and taps the rally key twice — once to start
 * aiming the blue line, once to drop the rally point — committing a per-Queen
 * `queenRallyTargets` entry via the `setQueenRally` store action. From then on,
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
          queenRallyTargets: {},
          // Force the very next tick over the spawn interval threshold.
          lastSpawnAtMsByQueenId: {},
          deadUnitsToRemove: [],
          targetCache: {},
          aiThinkingOffset: {},
        });

        // Contract 1a: rejecting a non-Queen target (the enemy Base) must not
        // create a rally entry — ownership/kind are validated in the action.
        store.getState().setQueenRally({ queenId: 'test-enemy-base', target: { mode: 'point', position: rallyPoint } });
        const rejectedNonQueen = store.getState().queenRallyTargets['test-enemy-base'] === undefined;

        // Contract 1b: the owned Queen records the rally point.
        store.getState().setQueenRally({ queenId: 'test-queen', target: { mode: 'point', position: rallyPoint } });
        const recorded = store.getState().queenRallyTargets['test-queen'];
        const rallyRecorded =
          Boolean(recorded) && recorded.mode === 'point' &&
          recorded.position.x === rallyPoint.x && recorded.position.z === rallyPoint.z;

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

  test('a follow rally on a friendly King makes the Queen\'s spawns trail him', async ({ page }) => {
    test.setTimeout(60_000);
    await openMatchWithTerrain(page);

    const result = await page.evaluate(
      async ({ queenPosition, dtMs, spawnIntervalMs }) => {
        const store = (window as any).__rtsStore;
        // Selection lives on useUiStore since P1-1; the spawn auto-select runs in the
        // main-thread derivation (syncLocalSelectionMirror), exposed as __rtsSyncLocalMirrors.
        const ui = (window as any).__rtsUiStore;
        const syncMirrors = (window as any).__rtsSyncLocalMirrors as () => void;
        const state = store.getState();

        const local = state.localPlayerId;
        const otherOwner = state.units.find((u: any) => u.ownerId !== local)?.ownerId;
        if (!otherOwner) return { setupError: 'no enemy player present' } as const;

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
          position: { ...queenPosition }, hp: 200, maxHp: 200,
          attackDamage: 10, moveSpeed: 18, attackRange: 4, attackCooldownMs: 1000,
          lastAttackAtMs: 0, rotation: 0,
        };
        // The King the spawns should follow, set apart from the Queen so the follow
        // order points somewhere distinct.
        const king: any = {
          id: 'test-king', ownerId: local, animal: 'Bear', kind: 'King',
          position: { x: queenPosition.x - 30, y: 0, z: queenPosition.z - 20 },
          hp: 500, maxHp: 500,
          attackDamage: 50, moveSpeed: 18, attackRange: 4, attackCooldownMs: 1000,
          lastAttackAtMs: 0, rotation: 0,
        };

        const preexistingIds = new Set([playerBase.id, enemyBase.id, queen.id, king.id]);

        store.setState({
          units: [playerBase, enemyBase, queen, king],
          matchStarted: true, gameOver: false, winner: null,
          unitOrders: {}, queenPatrols: {}, queenRallyTargets: {},
          lastSpawnAtMsByQueenId: {}, deadUnitsToRemove: [],
          targetCache: {}, aiThinkingOffset: {},
        });
        // Only the QUEEN is selected here (not the King). Selection is local-UI (P1-1);
        // baseline the selection mirror against the pre-spawn units so the next sync
        // only treats the newborn as fresh.
        ui.getState().selectUnits(['test-queen']);
        syncMirrors();

        // Designate the King as the rally target. The action validates it is a
        // living friendly monarch and stores a 'follow' target.
        store.getState().setQueenRally({ queenId: 'test-queen', target: { mode: 'follow', monarchId: 'test-king' } });
        const recorded = store.getState().queenRallyTargets['test-queen'];
        const followRecorded =
          Boolean(recorded) && recorded.mode === 'follow' && recorded.monarchId === 'test-king';

        // Tick once past the spawn interval so the Queen spawns exactly one Unit, then
        // run the main-thread mirror derivation the real game loop runs after each tick.
        const nowMs = Date.now() + spawnIntervalMs + 1;
        store.getState().tick(dtMs / 1000, nowMs);
        syncMirrors();

        const after = store.getState();
        const spawned = after.units.filter(
          (u: any) => u.ownerId === local && u.kind === 'Unit' && !preexistingIds.has(u.id),
        );
        const spawnedCount = spawned.length;
        // The newborn must be bound to follow the King (followMonarchId), and the
        // follow branch in tick() must have already pinned its order toward him.
        const everySpawnedFollows = spawnedCount > 0 && spawned.every(
          (u: any) => u.followMonarchId === 'test-king',
        );
        // Gating: only the QUEEN is selected here (not the King), so the new
        // followers must NOT be auto-folded into the selection.
        const selectedIds = new Set(ui.getState().selectedUnitIds);
        const noneAutoSelected = spawned.every((u: any) => !selectedIds.has(u.id));

        return { followRecorded, spawnedCount, everySpawnedFollows, noneAutoSelected };
      },
      { queenPosition: QUEEN_POSITION, dtMs: SIM_DT_MS, spawnIntervalMs: 5000 },
    );

    if ('setupError' in result) throw new Error(`setup failed: ${result.setupError}`);

    expect(result.followRecorded, 'setQueenRally should record a follow target for the friendly King').toBe(true);
    expect(result.spawnedCount, 'the Queen should have spawned a Unit this tick').toBeGreaterThan(0);
    expect(result.everySpawnedFollows, 'every freshly spawned Unit should be set to follow the King').toBe(true);
    expect(result.noneAutoSelected, 'followers must not be auto-selected when the King is not selected').toBe(true);
  });

  test('spawned followers are auto-selected while the King is selected', async ({ page }) => {
    test.setTimeout(60_000);
    await openMatchWithTerrain(page);

    const result = await page.evaluate(
      async ({ queenPosition, dtMs, spawnIntervalMs }) => {
        const store = (window as any).__rtsStore;
        // Selection is local-UI on useUiStore (P1-1); the spawn auto-select runs in the
        // main-thread derivation (syncLocalSelectionMirror), exposed as __rtsSyncLocalMirrors.
        const ui = (window as any).__rtsUiStore;
        const syncMirrors = (window as any).__rtsSyncLocalMirrors as () => void;
        const state = store.getState();

        const local = state.localPlayerId;
        const otherOwner = state.units.find((u: any) => u.ownerId !== local)?.ownerId;
        if (!otherOwner) return { setupError: 'no enemy player present' } as const;

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
          position: { ...queenPosition }, hp: 200, maxHp: 200,
          attackDamage: 10, moveSpeed: 18, attackRange: 4, attackCooldownMs: 1000,
          lastAttackAtMs: 0, rotation: 0,
        };
        const king: any = {
          id: 'test-king', ownerId: local, animal: 'Bear', kind: 'King',
          position: { x: queenPosition.x - 30, y: 0, z: queenPosition.z - 20 },
          hp: 500, maxHp: 500,
          attackDamage: 50, moveSpeed: 18, attackRange: 4, attackCooldownMs: 1000,
          lastAttackAtMs: 0, rotation: 0,
        };

        const preexistingIds = new Set([playerBase.id, enemyBase.id, queen.id, king.id]);

        store.setState({
          units: [playerBase, enemyBase, queen, king],
          matchStarted: true, gameOver: false, winner: null,
          unitOrders: {}, queenPatrols: {}, queenRallyTargets: {},
          lastSpawnAtMsByQueenId: {}, deadUnitsToRemove: [],
          targetCache: {}, aiThinkingOffset: {},
        });
        // The KING is the active selection — the trigger for auto-selecting followers as
        // they spawn. Selection is local-UI (P1-1); baseline the mirror against the
        // pre-spawn units so the next sync only treats the newborn as fresh.
        ui.getState().selectUnits(['test-king']);
        syncMirrors();

        store.getState().setQueenRally({ queenId: 'test-queen', target: { mode: 'follow', monarchId: 'test-king' } });

        const nowMs = Date.now() + spawnIntervalMs + 1;
        store.getState().tick(dtMs / 1000, nowMs);
        // Run the main-thread mirror derivation the real game loop runs after each tick;
        // this is what folds the newborn follower into the local selection.
        syncMirrors();

        const after = store.getState();
        const spawned = after.units.filter(
          (u: any) => u.ownerId === local && u.kind === 'Unit' && !preexistingIds.has(u.id),
        );
        const spawnedCount = spawned.length;
        const selectedIds = new Set(ui.getState().selectedUnitIds);
        // Every newborn follower must have been folded into the selection, and the
        // King must remain selected alongside them.
        const everySpawnedSelected = spawnedCount > 0 && spawned.every((u: any) => selectedIds.has(u.id));
        const kingStillSelected = selectedIds.has('test-king');

        return { spawnedCount, everySpawnedSelected, kingStillSelected };
      },
      { queenPosition: QUEEN_POSITION, dtMs: SIM_DT_MS, spawnIntervalMs: 5000 },
    );

    if ('setupError' in result) throw new Error(`setup failed: ${result.setupError}`);

    expect(result.spawnedCount, 'the Queen should have spawned a Unit this tick').toBeGreaterThan(0);
    expect(result.everySpawnedSelected, 'a follower spawned while the King is selected should be auto-selected').toBe(true);
    expect(result.kingStillSelected, 'the King should stay selected alongside its new followers').toBe(true);
  });
});
