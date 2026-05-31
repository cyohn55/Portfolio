import { test, expect, type Page } from '@playwright/test';

/**
 * Feature test: the Chicken's egg-throw ability.
 *
 * Holding both mouse buttons while a friendly Chicken is selected fires one egg
 * per press toward the cursor (store action `throwEggs`). The egg is a straight-
 * line projectile resolved in the game tick:
 *   - it deals EGG_DAMAGE (10) to the first ENEMY animal it passes within
 *     EGG_HIT_RADIUS of, then is consumed;
 *   - it never damages friendly animals (it flies through them);
 *   - a per-chicken cooldown blocks a second throw fired in the same instant.
 *
 * These tests drive the real store (window.__rtsStore) end-to-end — inject a
 * minimal world, call the real `throwEggs` action, tick the sim, and assert on
 * the resulting unit/projectile state — with no mocked or hard-coded outputs.
 * Booting a Chicken match also forces the four Chicken_F# pose variants and the
 * Egg projectile to bake in-browser, so a broken bake surfaces here as a runtime
 * error.
 *
 * NOTE: requires the Playwright runner with a browser. It is skipped in
 * environments where headless-browser verification is disabled.
 */

// Real fixed-timestep delta (seconds) the game loop uses, so projectile stepping
// matches production exactly (no tunneling past targets).
const SIM_DT_SEC = (1000 / 60) / 1000;
// Open ground far from the moat/bridges so the only behavior under test is the
// chicken's egg ability — no terrain chokepoints.
const CHICKEN_POSITION = { x: 200, y: 0.25, z: 200 };
// Target sits within egg range and far enough that the egg clearly travels a few
// frames before it connects.
const TARGET_OFFSET = 6;
// Enough frames for an egg at EGG_SPEED (45 u/s) to cross TARGET_OFFSET and hit.
const TICK_COUNT = 40;
// Matches EGG_DAMAGE in state.ts (intentionally asserted as the spec's contract).
const EXPECTED_EGG_DAMAGE = 10;

async function openChickenMatch(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('text=QUICK PLAY', { timeout: 30000 });
  await page.click('text=QUICK PLAY');
  for (const animal of ['Chicken', 'Bear', 'Bunny']) {
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

test.describe('Chicken egg ability', () => {
  test('an egg thrown at an enemy deals 10 damage and is then consumed', async ({ page }) => {
    test.setTimeout(60_000);
    await openChickenMatch(page);

    const result = await page.evaluate(({ chickenPos, offset, dtSec, ticks }) => {
      const store = (window as any).__rtsStore;
      const state = store.getState();
      const localId = state.localPlayerId as string;
      const enemyId = state.players.find((p: any) => p.id !== localId)!.id as string;

      const template = state.units.find((u: any) => u.animal === 'Chicken' && u.ownerId === localId);
      if (!template) return { chickenFound: false } as any;

      const chicken = { ...template, id: 'chicken-throw', position: { ...chickenPos }, lastEggAtMs: undefined, eggThrowUntilMs: undefined };
      const enemy = {
        ...template,
        id: 'enemy-target',
        ownerId: enemyId,
        kind: 'Unit',
        position: { x: chickenPos.x + offset, y: chickenPos.y, z: chickenPos.z },
        hp: 400,
        maxHp: 400,
        moveSpeed: 0,           // hold still so the egg's flight is the only variable
        attackCooldownMs: 1e9,  // never retaliates within the window
        lastAttackAtMs: 0,
      };
      const enemyStartHp = enemy.hp;
      store.setState({ units: [chicken, enemy], unitOrders: {}, projectiles: [] });

      // Fire one egg straight at the enemy.
      store.getState().throwEggs({ unitIds: [chicken.id], target: { ...enemy.position } });
      const spawnedProjectiles = store.getState().projectiles.length;
      const facing = store.getState().units.find((u: any) => u.id === chicken.id)?.rotation ?? null;

      for (let i = 0; i < ticks; i++) store.getState().tick(dtSec, performance.now());

      const e = store.getState().units.find((x: any) => x.id === enemy.id);
      return {
        chickenFound: true,
        spawnedProjectiles,
        facing,
        enemyDamageTaken: enemyStartHp - (e?.hp ?? enemyStartHp),
        remainingProjectiles: store.getState().projectiles.length,
      };
    }, { chickenPos: CHICKEN_POSITION, offset: TARGET_OFFSET, dtSec: SIM_DT_SEC, ticks: TICK_COUNT });

    expect(result.chickenFound).toBe(true);
    // Exactly one egg launched, and the chicken turned to face the throw.
    expect(result.spawnedProjectiles).toBe(1);
    expect(result.facing).not.toBeNull();
    // The egg struck the enemy for exactly the egg's damage, then was consumed.
    expect(result.enemyDamageTaken).toBe(EXPECTED_EGG_DAMAGE);
    expect(result.remainingProjectiles).toBe(0);
  });

  test('an egg never damages a friendly animal (enemies only)', async ({ page }) => {
    test.setTimeout(60_000);
    await openChickenMatch(page);

    const result = await page.evaluate(({ chickenPos, offset, dtSec, ticks }) => {
      const store = (window as any).__rtsStore;
      const state = store.getState();
      const localId = state.localPlayerId as string;

      const template = state.units.find((u: any) => u.animal === 'Chicken' && u.ownerId === localId);
      if (!template) return { chickenFound: false } as any;

      const chicken = { ...template, id: 'chicken-throw', position: { ...chickenPos }, lastEggAtMs: undefined, eggThrowUntilMs: undefined };
      // A friendly (same-owner) unit sitting right where the egg is thrown.
      const friendly = {
        ...template, id: 'friendly-target', kind: 'Unit',
        position: { x: chickenPos.x + offset, y: chickenPos.y, z: chickenPos.z },
        hp: 400, maxHp: 400, moveSpeed: 0,
      };
      const friendlyStartHp = friendly.hp;
      store.setState({ units: [chicken, friendly], unitOrders: {}, projectiles: [] });

      store.getState().throwEggs({ unitIds: [chicken.id], target: { ...friendly.position } });
      for (let i = 0; i < ticks; i++) store.getState().tick(dtSec, performance.now());

      const f = store.getState().units.find((x: any) => x.id === friendly.id);
      return {
        chickenFound: true,
        friendlyDamageTaken: friendlyStartHp - (f?.hp ?? friendlyStartHp),
        // The egg should fly through the friendly and expire at its max range.
        remainingProjectiles: store.getState().projectiles.length,
      };
    }, { chickenPos: CHICKEN_POSITION, offset: TARGET_OFFSET, dtSec: SIM_DT_SEC, ticks: TICK_COUNT });

    expect(result.chickenFound).toBe(true);
    expect(result.friendlyDamageTaken).toBe(0);
    expect(result.remainingProjectiles).toBe(0);
  });

  test('the per-press cooldown blocks a second egg fired in the same instant', async ({ page }) => {
    test.setTimeout(60_000);
    await openChickenMatch(page);

    const result = await page.evaluate(({ chickenPos, offset }) => {
      const store = (window as any).__rtsStore;
      const state = store.getState();
      const localId = state.localPlayerId as string;

      const template = state.units.find((u: any) => u.animal === 'Chicken' && u.ownerId === localId);
      if (!template) return { chickenFound: false } as any;

      const chicken = { ...template, id: 'chicken-cooldown', position: { ...chickenPos }, lastEggAtMs: undefined, eggThrowUntilMs: undefined };
      const target = { x: chickenPos.x + offset, y: chickenPos.y, z: chickenPos.z };
      store.setState({ units: [chicken], unitOrders: {}, projectiles: [] });

      store.getState().throwEggs({ unitIds: [chicken.id], target });
      const afterFirst = store.getState().projectiles.length;
      // Immediately attempt a second throw within the cooldown window.
      store.getState().throwEggs({ unitIds: [chicken.id], target });
      const afterSecond = store.getState().projectiles.length;
      return { chickenFound: true, afterFirst, afterSecond };
    }, { chickenPos: CHICKEN_POSITION, offset: TARGET_OFFSET });

    expect(result.chickenFound).toBe(true);
    expect(result.afterFirst).toBe(1);
    // No extra egg: the cooldown rejected the immediate second press.
    expect(result.afterSecond).toBe(1);
  });
});
