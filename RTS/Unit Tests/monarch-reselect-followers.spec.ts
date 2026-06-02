import { test, expect, type Page } from '@playwright/test';

/**
 * Regression test: reselecting a King must re-select the units already following
 * him, so the player can immediately give that band orders.
 *
 * Background: a King's followers carry `followMonarchId === king.id` and trail
 * him every tick. The monarch-pilot actions (cycle with "A", per-slot pilot,
 * King<->Queen toggle) previously reset the selection to just the monarch
 * (`selectedUnitIds: [monarch.id]`), dropping any followers. So this sequence
 * stranded the army: pilot the King and rally his units (they follow + are
 * selected) -> press "A" to cycle away to another animal's monarch (the Bear
 * followers keep following, since cycling does not clear the rally) -> press "A"
 * again to cycle back to the Bear King. He was reselected alone, leaving his
 * followers trailing him but unselected and therefore unorderable.
 *
 * The fix (`selectionForMonarch` in monarchPilot.ts, used by the three pilot
 * actions in state.ts): the selection applied when a monarch becomes
 * piloted/selected is the monarch PLUS every Unit currently following it.
 *
 * This drives the real store: it plants a King with a band of followers, leaves
 * the King unselected, cycles the pilot onto him with the real `pilotCycleMonarch`
 * action, and asserts the whole following band ends up selected.
 */

const QUEEN_POSITION = { x: 200, y: 0.25, z: 200 };

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

test.describe('reselecting a King reselects his followers', () => {
  test('cycling the pilot back onto a King with followers selects the whole band', async ({ page }) => {
    test.setTimeout(60_000);
    await openMatchWithTerrain(page);

    const result = await page.evaluate(
      async ({ kingAnchor }) => {
        const store = (window as any).__rtsStore;
        const state = store.getState();

        const local = state.localPlayerId;
        const otherOwner = state.units.find((u: any) => u.ownerId !== local)?.ownerId;
        if (!otherOwner) return { setupError: 'no enemy player present' } as const;
        // pilotCycleMonarch walks the animal pool; the King must be one of those
        // animals for the cycle to land on him. The first slot is the simplest target.
        const pool = state.selectedAnimalPool as string[];
        if (!pool || pool.length === 0) return { setupError: 'no animal pool' } as const;
        const kingAnimal = pool[0];

        const playerBase = {
          id: 'test-player-base', ownerId: local, animal: kingAnimal, kind: 'Base',
          position: { x: 250, y: 0, z: 250 }, hp: 10000, maxHp: 10000,
          attackDamage: 0, moveSpeed: 0, attackRange: 4, attackCooldownMs: 1000,
          lastAttackAtMs: 0, rotation: 0,
        };
        const enemyBase = {
          id: 'test-enemy-base', ownerId: otherOwner, animal: kingAnimal, kind: 'Base',
          position: { x: -250, y: 0, z: -250 }, hp: 10000, maxHp: 10000,
          attackDamage: 0, moveSpeed: 0, attackRange: 4, attackCooldownMs: 1000,
          lastAttackAtMs: 0, rotation: 0,
        };
        const king: any = {
          id: 'test-king', ownerId: local, animal: kingAnimal, kind: 'King',
          position: { ...kingAnchor }, hp: 500, maxHp: 500,
          attackDamage: 50, moveSpeed: 18, attackRange: 4, attackCooldownMs: 1000,
          lastAttackAtMs: 0, rotation: 0,
        };
        // Three followers already trailing the King (followMonarchId set), planted
        // a little apart so they are distinct units.
        const followers = [0, 1, 2].map((i) => ({
          id: `test-follower-${i}`, ownerId: local, animal: kingAnimal, kind: 'Unit',
          position: { x: kingAnchor.x + 4 + i * 3, y: 0, z: kingAnchor.z + 4 },
          hp: 100, maxHp: 100,
          attackDamage: 10, moveSpeed: 18, attackRange: 4, attackCooldownMs: 1000,
          lastAttackAtMs: 0, rotation: 0,
          followMonarchId: 'test-king',
        }));
        const followerIds = followers.map((f) => f.id);

        store.setState({
          units: [playerBase, enemyBase, king, ...followers],
          matchStarted: true, isPaused: false, gameOver: false, winner: null,
          unitOrders: {}, queenPatrols: {}, queenRallyTargets: {},
          lastSpawnAtMsByQueenId: {}, deadUnitsToRemove: [],
          targetCache: {}, aiThinkingOffset: {},
          // The King is NOT selected and nothing is piloted — exactly the state
          // after cycling away from him while his band keeps following.
          selectedUnitIds: [],
          pilotedUnitId: null,
        });

        // Reselect the King via the real "A" cycle action. Not piloting, so it
        // lands on the first pool animal's monarch — our planted King.
        store.getState().pilotCycleMonarch();

        const after = store.getState();
        const selected = new Set(after.selectedUnitIds);
        const landedOnKing = after.pilotedUnitId === 'test-king' && selected.has('test-king');
        const everyFollowerSelected = followerIds.every((id) => selected.has(id));

        return { landedOnKing, everyFollowerSelected, selectedCount: after.selectedUnitIds.length };
      },
      { kingAnchor: QUEEN_POSITION },
    );

    if ('setupError' in result) throw new Error(`setup failed: ${result.setupError}`);

    expect(result.landedOnKing, 'cycling should pilot and select the planted King').toBe(true);
    expect(result.everyFollowerSelected, 'every unit following the King should be reselected with him').toBe(true);
    // The band is the King + his three followers, and nothing else.
    expect(result.selectedCount, 'selection should be exactly the King and his followers').toBe(4);
  });
});
