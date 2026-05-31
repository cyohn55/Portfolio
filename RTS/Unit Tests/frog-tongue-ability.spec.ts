import { test, expect, type Page } from '@playwright/test';

/**
 * Feature test: the Frog's tongue-grab ability.
 *
 * Holding both mouse buttons while a friendly Frog is selected claims one
 * eligible enemy — the enemy within tongue range that is nearest the cursor —
 * and grabs it (store action `fireTongues`). The grab is a small state machine
 * resolved entirely in the game tick (windup -> extend -> latch -> retract):
 *   - the tongue extends from the frog's mouth and latches the first time its
 *     tip reaches the (homing) target;
 *   - latching deals the frog's attack damage exactly once, then the retract
 *     phase drags the caught enemy back to just in front of the frog;
 *   - a frog grabs exactly one enemy, and two frogs may not claim the same enemy;
 *   - a per-frog cooldown blocks a second grab fired before it elapses;
 *   - a press with no eligible enemy in range does nothing.
 *
 * These tests drive the real store (window.__rtsStore) end-to-end — inject a
 * minimal world, call the real `fireTongues` action, tick the sim, and assert on
 * the resulting unit state — with no mocked or hard-coded outputs. The grab's
 * damage is asserted against the real Frog stat (window.__rtsAnimals.Frog.dmg),
 * not a copied literal. Booting a Frog match also forces the four Frog_F# pose
 * variants and the tongue beam to bake in-browser, so a broken bake surfaces
 * here as a runtime error.
 *
 * NOTE: requires the Playwright runner with a browser. It is skipped in
 * environments where headless-browser verification is disabled.
 */

// Real fixed-timestep delta the game loop uses, so phase stepping matches
// production exactly (no tunneling past the latch radius).
const SIM_DT_SEC = (1000 / 60) / 1000;
const SIM_DT_MS = 1000 / 60;
// Open ground far from the moat/bridges so the only behavior under test is the
// frog's grab — no terrain chokepoints.
const FROG_POSITION = { x: 200, y: 0.25, z: 200 };
// Within the tongue's reach (TONGUE_RANGE = 12) but beyond the frog's melee
// range (8), so the grab — not an incidental melee swing — is what connects.
const IN_RANGE_OFFSET = 9;
// Beyond the tongue's reach: a press here should claim nothing.
const OUT_OF_RANGE_OFFSET = 20;
// Enough frames to cover windup + full extend + full retract for IN_RANGE_OFFSET.
const TICK_COUNT = 90;
// Fewer frames: enough to complete one grab while staying inside the cooldown
// window, so the immediate re-fire in the cooldown test is genuinely blocked.
const GRAB_COMPLETE_TICKS = 50;

async function openFrogMatch(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('text=QUICK PLAY', { timeout: 30000 });
  await page.click('text=QUICK PLAY');
  for (const animal of ['Frog', 'Bear', 'Bunny']) {
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

test.describe('Frog tongue ability', () => {
  test('a grabbed enemy takes the frog\'s attack damage and is dragged in', async ({ page }) => {
    test.setTimeout(60_000);
    await openFrogMatch(page);

    const result = await page.evaluate(({ frogPos, offset, dtSec, dtMs, ticks }) => {
      const store = (window as any).__rtsStore;
      const animals = (window as any).__rtsAnimals;
      const state = store.getState();
      const localId = state.localPlayerId as string;
      const enemyId = state.players.find((p: any) => p.id !== localId)!.id as string;

      const template = state.units.find((u: any) => u.animal === 'Frog' && u.ownerId === localId);
      if (!template) return { frogFound: false } as any;

      const enemyStartHp = 400;
      const frog = {
        ...template, id: 'frog-grab', kind: 'Unit', position: { ...frogPos },
        attackDamage: animals.Frog.dmg,   // the value the grab should deal
        attackCooldownMs: 1e9,            // never melee within the window — isolate the grab's damage
        lastAttackAtMs: 0, moveSpeed: 0, tongue: undefined, lastTongueAtMs: undefined,
      };
      const enemyPos = { x: frogPos.x + offset, y: frogPos.y, z: frogPos.z };
      const enemy = {
        ...template, id: 'enemy-target', ownerId: enemyId, kind: 'Unit', position: { ...enemyPos },
        hp: enemyStartHp, maxHp: enemyStartHp, moveSpeed: 0, attackCooldownMs: 1e9, lastAttackAtMs: 0,
        tongue: undefined,
      };
      // Keep-alive bases for both sides so the periodic win check doesn't end the
      // match (and freeze the tick) mid-grab.
      const playerBase = { ...template, id: 'player-base', kind: 'Base', position: { x: frogPos.x - 60, y: frogPos.y, z: frogPos.z }, moveSpeed: 0 };
      const enemyBase = { ...template, id: 'enemy-base', ownerId: enemyId, kind: 'Base', position: { x: frogPos.x + 60, y: frogPos.y, z: frogPos.z }, moveSpeed: 0 };
      store.setState({ units: [frog, enemy, playerBase, enemyBase], unitOrders: {}, projectiles: [] });

      const dist = (a: any, b: any) => Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
      const distBefore = dist(frog, enemy);

      store.getState().fireTongues({ unitIds: [frog.id], cursor: { ...enemyPos } });
      const fired = store.getState().units.find((u: any) => u.id === frog.id);
      const claimedTargetId = fired?.tongue?.targetId ?? null;
      const facing = fired?.rotation ?? null;

      const nowBase = performance.now();
      for (let i = 0; i < ticks; i++) store.getState().tick(dtSec, nowBase + i * dtMs);

      const f = store.getState().units.find((u: any) => u.id === frog.id);
      const e = store.getState().units.find((u: any) => u.id === enemy.id);
      return {
        frogFound: true,
        claimedTargetId,
        facing,
        expectedDamage: animals.Frog.dmg,
        enemyDamageTaken: enemyStartHp - (e?.hp ?? enemyStartHp),
        distBefore,
        distAfter: e && f ? dist(f, e) : null,
        tongueCleared: !f?.tongue,
      };
    }, { frogPos: FROG_POSITION, offset: IN_RANGE_OFFSET, dtSec: SIM_DT_SEC, dtMs: SIM_DT_MS, ticks: TICK_COUNT });

    expect(result.frogFound).toBe(true);
    // The frog claimed the one enemy and turned to face the grab.
    expect(result.claimedTargetId).toBe('enemy-target');
    expect(result.facing).not.toBeNull();
    // The latch dealt exactly the frog's attack damage — once.
    expect(result.enemyDamageTaken).toBe(result.expectedDamage);
    // The enemy was reeled in: it ends meaningfully closer than it started.
    expect(result.distAfter).not.toBeNull();
    expect(result.distAfter!).toBeLessThan(result.distBefore);
    expect(result.distAfter!).toBeLessThanOrEqual(4);
    // The tongue fully retracted and released the frog.
    expect(result.tongueCleared).toBe(true);
  });

  test('two frogs cannot grab the same enemy at once', async ({ page }) => {
    test.setTimeout(60_000);
    await openFrogMatch(page);

    const result = await page.evaluate(({ frogPos, offset }) => {
      const store = (window as any).__rtsStore;
      const animals = (window as any).__rtsAnimals;
      const state = store.getState();
      const localId = state.localPlayerId as string;
      const enemyId = state.players.find((p: any) => p.id !== localId)!.id as string;

      const template = state.units.find((u: any) => u.animal === 'Frog' && u.ownerId === localId);
      if (!template) return { frogFound: false } as any;

      const enemyPos = { x: frogPos.x + offset, y: frogPos.y, z: frogPos.z };
      // Two frogs flanking the single enemy, both within tongue range of it.
      const frogA = { ...template, id: 'frog-a', kind: 'Unit', position: { x: enemyPos.x - 5, y: frogPos.y, z: frogPos.z }, attackDamage: animals.Frog.dmg, moveSpeed: 0, tongue: undefined, lastTongueAtMs: undefined };
      const frogB = { ...template, id: 'frog-b', kind: 'Unit', position: { x: enemyPos.x + 5, y: frogPos.y, z: frogPos.z }, attackDamage: animals.Frog.dmg, moveSpeed: 0, tongue: undefined, lastTongueAtMs: undefined };
      const enemy = { ...template, id: 'enemy-target', ownerId: enemyId, kind: 'Unit', position: { ...enemyPos }, hp: 400, maxHp: 400, moveSpeed: 0, tongue: undefined };
      store.setState({ units: [frogA, frogB, enemy], unitOrders: {}, projectiles: [] });

      store.getState().fireTongues({ unitIds: [frogA.id, frogB.id], cursor: { ...enemyPos } });

      const a = store.getState().units.find((u: any) => u.id === frogA.id)?.tongue ?? null;
      const b = store.getState().units.find((u: any) => u.id === frogB.id)?.tongue ?? null;
      return {
        frogFound: true,
        frogsWithTongue: [a, b].filter(Boolean).length,
        claimedTargetIds: [a?.targetId ?? null, b?.targetId ?? null].filter(Boolean),
      };
    }, { frogPos: FROG_POSITION, offset: IN_RANGE_OFFSET });

    expect(result.frogFound).toBe(true);
    // Exactly one frog grabbed the lone enemy; the other found no free target.
    expect(result.frogsWithTongue).toBe(1);
    expect(result.claimedTargetIds).toEqual(['enemy-target']);
  });

  test('the per-frog cooldown blocks a second grab fired too soon', async ({ page }) => {
    test.setTimeout(60_000);
    await openFrogMatch(page);

    const result = await page.evaluate(({ frogPos, offset, dtSec, dtMs, ticks }) => {
      const store = (window as any).__rtsStore;
      const animals = (window as any).__rtsAnimals;
      const state = store.getState();
      const localId = state.localPlayerId as string;
      const enemyId = state.players.find((p: any) => p.id !== localId)!.id as string;

      const template = state.units.find((u: any) => u.animal === 'Frog' && u.ownerId === localId);
      if (!template) return { frogFound: false } as any;

      const enemyPos = { x: frogPos.x + offset, y: frogPos.y, z: frogPos.z };
      const frog = { ...template, id: 'frog-cooldown', kind: 'Unit', position: { ...frogPos }, attackDamage: animals.Frog.dmg, attackCooldownMs: 1e9, moveSpeed: 0, tongue: undefined, lastTongueAtMs: undefined };
      const enemy = { ...template, id: 'enemy-target', ownerId: enemyId, kind: 'Unit', position: { ...enemyPos }, hp: 400, maxHp: 400, moveSpeed: 0, attackCooldownMs: 1e9, tongue: undefined };
      const playerBase = { ...template, id: 'player-base', kind: 'Base', position: { x: frogPos.x - 60, y: frogPos.y, z: frogPos.z }, moveSpeed: 0 };
      const enemyBase = { ...template, id: 'enemy-base', ownerId: enemyId, kind: 'Base', position: { x: frogPos.x + 60, y: frogPos.y, z: frogPos.z }, moveSpeed: 0 };
      store.setState({ units: [frog, enemy, playerBase, enemyBase], unitOrders: {}, projectiles: [] });

      // First grab.
      store.getState().fireTongues({ unitIds: [frog.id], cursor: { ...enemyPos } });
      const firedFirst = Boolean(store.getState().units.find((u: any) => u.id === frog.id)?.tongue);

      // Run the grab to completion (the tongue clears) while staying inside the cooldown.
      const nowBase = performance.now();
      for (let i = 0; i < ticks; i++) store.getState().tick(dtSec, nowBase + i * dtMs);
      const clearedAfterGrab = !store.getState().units.find((u: any) => u.id === frog.id)?.tongue;

      // Immediately try again — still within the per-frog cooldown.
      store.getState().fireTongues({ unitIds: [frog.id], cursor: { ...enemyPos } });
      const firedSecond = Boolean(store.getState().units.find((u: any) => u.id === frog.id)?.tongue);

      return { frogFound: true, firedFirst, clearedAfterGrab, firedSecond };
    }, { frogPos: FROG_POSITION, offset: IN_RANGE_OFFSET, dtSec: SIM_DT_SEC, dtMs: SIM_DT_MS, ticks: GRAB_COMPLETE_TICKS });

    expect(result.frogFound).toBe(true);
    expect(result.firedFirst).toBe(true);
    expect(result.clearedAfterGrab).toBe(true);
    // The cooldown rejected the immediate second grab: no new tongue.
    expect(result.firedSecond).toBe(false);
  });

  test('a press with no enemy in range does nothing', async ({ page }) => {
    test.setTimeout(60_000);
    await openFrogMatch(page);

    const result = await page.evaluate(({ frogPos, offset, dtSec, dtMs }) => {
      const store = (window as any).__rtsStore;
      const animals = (window as any).__rtsAnimals;
      const state = store.getState();
      const localId = state.localPlayerId as string;
      const enemyId = state.players.find((p: any) => p.id !== localId)!.id as string;

      const template = state.units.find((u: any) => u.animal === 'Frog' && u.ownerId === localId);
      if (!template) return { frogFound: false } as any;

      const enemyStartHp = 400;
      const enemyPos = { x: frogPos.x + offset, y: frogPos.y, z: frogPos.z }; // out of tongue range
      const frog = { ...template, id: 'frog-no-target', kind: 'Unit', position: { ...frogPos }, attackDamage: animals.Frog.dmg, attackCooldownMs: 1e9, moveSpeed: 0, tongue: undefined, lastTongueAtMs: undefined };
      const enemy = { ...template, id: 'enemy-far', ownerId: enemyId, kind: 'Unit', position: { ...enemyPos }, hp: enemyStartHp, maxHp: enemyStartHp, moveSpeed: 0, attackCooldownMs: 1e9, tongue: undefined };
      const playerBase = { ...template, id: 'player-base', kind: 'Base', position: { x: frogPos.x - 60, y: frogPos.y, z: frogPos.z }, moveSpeed: 0 };
      const enemyBase = { ...template, id: 'enemy-base', ownerId: enemyId, kind: 'Base', position: { x: frogPos.x + 80, y: frogPos.y, z: frogPos.z }, moveSpeed: 0 };
      store.setState({ units: [frog, enemy, playerBase, enemyBase], unitOrders: {}, projectiles: [] });

      store.getState().fireTongues({ unitIds: [frog.id], cursor: { ...enemyPos } });
      const tongueAfterFire = Boolean(store.getState().units.find((u: any) => u.id === frog.id)?.tongue);

      const nowBase = performance.now();
      for (let i = 0; i < 20; i++) store.getState().tick(dtSec, nowBase + i * dtMs);

      const e = store.getState().units.find((u: any) => u.id === enemy.id);
      return { frogFound: true, tongueAfterFire, enemyDamageTaken: enemyStartHp - (e?.hp ?? enemyStartHp) };
    }, { frogPos: FROG_POSITION, offset: OUT_OF_RANGE_OFFSET, dtSec: SIM_DT_SEC, dtMs: SIM_DT_MS });

    expect(result.frogFound).toBe(true);
    // No target was claimed and the far enemy took no damage.
    expect(result.tongueAfterFire).toBe(false);
    expect(result.enemyDamageTaken).toBe(0);
  });
});
