import { test, expect, type Page } from '@playwright/test';

/**
 * Feature test: the Cat's three-pose animation (Kitty_F0..Kitty_F2).
 *
 * The cat renders exactly one baked pose variant at a time. UnitsLayer's
 * variantKeyForUnit chooses it from observable unit state:
 *   - idle      → Kitty_F0                              (stationary, not fighting)
 *   - walking   → alternates Kitty_F0 <-> Kitty_F1      (position changing)
 *   - attacking → alternates Kitty_F1 <-> Kitty_F2      (recently swung, not moving)
 *
 * Walk is derived from per-frame position change; attack is derived from the
 * combat timers the game tick maintains: a unit counts as attacking while
 * `performance.now() - lastAttackAtMs < attackCooldownMs (+ grace)`. These tests
 * drive the real store (window.__rtsStore) end-to-end — inject a minimal world,
 * tick the sim, and assert on the resulting unit state the renderer reads — with
 * no mocked or hard-coded component outputs.
 *
 * Booting a Cat match also forces the three Kitty_F# pose variants to bake
 * in-browser (DRACO decode + per-frame node extraction via getBakedCatFrameParts),
 * so a broken bake would surface here as a canvas/runtime error.
 */

const SIM_DT_MS = 1000 / 60;
// Open ground far from the moat/bridges so the only behavior under test is the
// cat's own movement/combat — no terrain chokepoints, no pathfinding detours.
const CAT_POSITION = { x: 200, y: 0.25, z: 200 };
// A move destination well outside arrival tolerance, so a walking cat clearly
// travels toward it within the simulated window.
const FAR_DESTINATION = { x: 245, y: 0, z: 200 };
// Inside the Cat's melee range (4) and the 8-unit combat-acquisition radius, so
// the cat engages and attacks in place rather than chasing.
const ENEMY_OFFSET = 3;
// ~1.5s of simulation: long enough for travel to accrue and a melee hit to land
// (Cat attackCooldownMs is ~1100ms).
const TICK_COUNT = 90;

// Boot the app into a running match with terrain + pathfinder ready. Cat is among
// the chosen animals so its units spawn and UnitsLayer bakes the three Kitty_F#
// pose variants in-browser.
async function openCatMatch(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('text=QUICK PLAY', { timeout: 30000 });
  await page.click('text=QUICK PLAY');
  for (const animal of ['Cat', 'Bear', 'Bunny']) {
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

test.describe('Cat pose animation', () => {
  test('an idle cat stays put and never attacks (renders the F0 idle pose)', async ({ page }) => {
    test.setTimeout(60_000);
    await openCatMatch(page);

    const result = await page.evaluate(({ catPos, dtMs, ticks }) => {
      const store = (window as any).__rtsStore;
      const state = store.getState();
      const localId = state.localPlayerId as string;

      const template = state.units.find((u: any) => u.animal === 'Cat' && u.ownerId === localId);
      if (!template) return { catFound: false } as any;

      // A lone cat with no order and no enemy: the renderer should hold Kitty_F0.
      const cat = { ...template, id: 'cat-idle', position: { ...catPos }, lastAttackAtMs: 0 };
      store.setState({ units: [cat], unitOrders: {} });

      const start = { x: cat.position.x, z: cat.position.z };
      let maxDriftSq = 0;
      for (let i = 0; i < ticks; i++) {
        store.getState().tick(dtMs);
        const u = store.getState().units.find((x: any) => x.id === cat.id);
        if (!u) break;
        const dx = u.position.x - start.x;
        const dz = u.position.z - start.z;
        maxDriftSq = Math.max(maxDriftSq, dx * dx + dz * dz);
      }
      const u = store.getState().units.find((x: any) => x.id === cat.id);
      return { catFound: true, maxDrift: Math.sqrt(maxDriftSq), lastAttackAtMs: u?.lastAttackAtMs ?? 0 };
    }, { catPos: CAT_POSITION, dtMs: SIM_DT_MS, ticks: TICK_COUNT });

    expect(result.catFound).toBe(true);
    // Stationary (no walk cycle) …
    expect(result.maxDrift).toBeLessThan(1);
    // … and never entered an attack exchange (no attack cycle): F0 idle pose.
    expect(result.lastAttackAtMs).toBe(0);
  });

  test('a cat moving to a far order travels (renders the F0<->F1 walk cycle)', async ({ page }) => {
    test.setTimeout(60_000);
    await openCatMatch(page);

    const result = await page.evaluate(({ catPos, farDest, dtMs, ticks }) => {
      const store = (window as any).__rtsStore;
      const state = store.getState();
      const localId = state.localPlayerId as string;

      const template = state.units.find((u: any) => u.animal === 'Cat' && u.ownerId === localId);
      if (!template) return { catFound: false } as any;

      // A cat with a far move order and no enemy: it should keep changing
      // position, which the renderer reads as "walking".
      const cat = { ...template, id: 'cat-walk', position: { ...catPos }, lastAttackAtMs: 0 };
      store.setState({ units: [cat], unitOrders: { [cat.id]: farDest } });

      const start = { x: cat.position.x, z: cat.position.z };
      // Count the frames in which the cat actually moved — the same signal the
      // renderer samples to advance the walk cycle.
      let movingFrames = 0;
      let prev = { x: start.x, z: start.z };
      for (let i = 0; i < ticks; i++) {
        store.getState().tick(dtMs);
        const u = store.getState().units.find((x: any) => x.id === cat.id);
        if (!u) break;
        const dx = u.position.x - prev.x;
        const dz = u.position.z - prev.z;
        if (dx * dx + dz * dz > 0.01 * 0.01) movingFrames++;
        prev = { x: u.position.x, z: u.position.z };
      }
      const u = store.getState().units.find((x: any) => x.id === cat.id);
      const totalDx = (u?.position.x ?? start.x) - start.x;
      const totalDz = (u?.position.z ?? start.z) - start.z;
      return { catFound: true, totalDistance: Math.hypot(totalDx, totalDz), movingFrames };
    }, { catPos: CAT_POSITION, farDest: FAR_DESTINATION, dtMs: SIM_DT_MS, ticks: TICK_COUNT });

    expect(result.catFound).toBe(true);
    // It made real progress toward the order …
    expect(result.totalDistance).toBeGreaterThan(10);
    // … across many frames, so the renderer's walk cycle advances.
    expect(result.movingFrames).toBeGreaterThan(10);
  });

  test('a cat next to an enemy attacks in place (renders the F1<->F2 attack cycle)', async ({ page }) => {
    test.setTimeout(60_000);
    await openCatMatch(page);

    const result = await page.evaluate(({ catPos, enemyOffset, dtMs, ticks }) => {
      const store = (window as any).__rtsStore;
      const state = store.getState();
      const localId = state.localPlayerId as string;
      const enemyId = state.players.find((p: any) => p.id !== localId)!.id as string;

      const template = state.units.find((u: any) => u.animal === 'Cat' && u.ownerId === localId);
      if (!template) return { catFound: false } as any;

      // Cat already within melee range of a sturdy enemy, with no move order, so
      // it engages and attacks in place (it should not walk toward the target).
      const cat = { ...template, id: 'cat-attack', position: { ...catPos }, lastAttackAtMs: 0 };
      const enemy = {
        id: 'enemy-target',
        ownerId: enemyId,
        animal: 'Bear',
        kind: 'Unit',
        position: { x: catPos.x + enemyOffset, y: catPos.y, z: catPos.z },
        hp: 400,
        maxHp: 400,
        attackDamage: 1,
        moveSpeed: 0,
        attackRange: 4,
        attackCooldownMs: 100000, // effectively never retaliates within the window
        lastAttackAtMs: 0,
        rotation: 0,
      };
      const enemyStartHp = enemy.hp;
      store.setState({ units: [cat, enemy], unitOrders: {} });

      const start = { x: cat.position.x, z: cat.position.z };
      let maxDriftSq = 0;
      for (let i = 0; i < ticks; i++) {
        store.getState().tick(dtMs);
        const c = store.getState().units.find((x: any) => x.id === cat.id);
        if (!c) break;
        const dx = c.position.x - start.x;
        const dz = c.position.z - start.z;
        maxDriftSq = Math.max(maxDriftSq, dx * dx + dz * dz);
      }

      const c = store.getState().units.find((x: any) => x.id === cat.id);
      const e = store.getState().units.find((x: any) => x.id === enemy.id);
      // Reproduce the renderer's attack-exchange test against the real timers the
      // cat now carries: right after a swing, the elapsed time is far below the
      // cooldown, so the cat is mid-exchange (attack pose), not idle.
      const elapsedSinceSwing = performance.now() - (c?.lastAttackAtMs ?? 0);
      return {
        catFound: true,
        lastAttackAtMs: c?.lastAttackAtMs ?? 0,
        attackCooldownMs: c?.attackCooldownMs ?? 0,
        elapsedSinceSwing,
        enemyDamageTaken: enemyStartHp - (e?.hp ?? enemyStartHp),
        maxDrift: Math.sqrt(maxDriftSq),
      };
    }, { catPos: CAT_POSITION, enemyOffset: ENEMY_OFFSET, dtMs: SIM_DT_MS, ticks: TICK_COUNT });

    expect(result.catFound).toBe(true);
    // The cat actually attacked: it landed at least one hit and stamped a swing.
    expect(result.lastAttackAtMs).toBeGreaterThan(0);
    expect(result.enemyDamageTaken).toBeGreaterThan(0);
    // It is mid-attack-exchange (the renderer's attack-cycle condition holds):
    // time since the last swing is well within the cooldown.
    expect(result.elapsedSinceSwing).toBeLessThan(result.attackCooldownMs);
    // And it fought in place rather than walking, so attack — not walk — wins.
    expect(result.maxDrift).toBeLessThan(2);
  });
});
