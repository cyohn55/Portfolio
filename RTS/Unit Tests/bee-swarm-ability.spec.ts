import { test, expect, type Page } from '@playwright/test';

/**
 * Feature test: the Bee's "Swarm" ability.
 *
 * Holding both mouse buttons while friendly Bees are selected commits each bee to
 * a sacrificial dive at the closest unclaimed enemy (store action `swarm`). The
 * dive + sting resolves entirely in the game tick (see updateBeeSwarms):
 *   - against an enemy ANIMAL the sting is a coin flip (handled elsewhere);
 *   - against an enemy BASE — a structure that can't be coin-flip killed — the bee
 *     always sacrifices itself, chipping the base for SWARM_BASE_STING_MULT (3)
 *     times its attack damage;
 *   - bees spread their dives across distinct enemy ANIMALS (one bee per animal),
 *     but a whole cloud may pile onto the same wide BASE at once.
 *
 * These tests drive the real store (window.__rtsStore) end-to-end — inject a
 * minimal world, call the real `swarm` action, tick the sim, and assert on the
 * resulting unit state — with no mocked or hard-coded outputs. The sting damage is
 * asserted against the real Bee stat (window.__rtsAnimals.Bee.dmg), not a copied
 * literal. The base-multiplier (3) is asserted as the ability's contract.
 *
 * NOTE: requires the Playwright runner with a browser. It is skipped in
 * environments where headless-browser verification is disabled.
 */

// Real fixed-timestep delta the game loop uses, so the dive steps match production.
const SIM_DT_SEC = (1000 / 60) / 1000;
const SIM_DT_MS = 1000 / 60;
// Open ground far from the moat/bridges so the only behavior under test is the dive.
const BEE_POSITION = { x: 200, y: 0.25, z: 200 };
// The bee's per-Base sting deals this multiple of its attack damage (matches
// SWARM_BASE_STING_MULT in state.ts — asserted as the ability's contract).
const EXPECTED_BASE_STING_MULT = 3;
// Enough frames for a bee at SWARM_DIVE_SPEED (60 u/s) to close on a base ~20 away
// (it stings once it reaches the base's footprint) and resolve the sting.
const TICK_COUNT = 60;

async function openBeeMatch(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('text=QUICK PLAY', { timeout: 30000 });
  await page.click('text=QUICK PLAY');
  for (const animal of ['Bee', 'Bear', 'Bunny']) {
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

test.describe('Bee swarm ability', () => {
  test('a bee that dives an enemy base chips it for 3x its sting and dies', async ({ page }) => {
    test.setTimeout(60_000);
    await openBeeMatch(page);

    const result = await page.evaluate(({ beePos, dtSec, dtMs, ticks }) => {
      const store = (window as any).__rtsStore;
      const animals = (window as any).__rtsAnimals;
      const state = store.getState();
      const localId = state.localPlayerId as string;
      const enemyId = state.players.find((p: any) => p.id !== localId)!.id as string;

      const template = state.units.find((u: any) => u.animal === 'Bee' && u.ownerId === localId);
      if (!template) return { beeFound: false } as any;

      const bee = {
        ...template, id: 'bee-dive', kind: 'Unit', position: { ...beePos },
        attackDamage: animals.Bee.dmg,
        attackCooldownMs: 1e9,            // never melee within the window — isolate the sting
        lastAttackAtMs: 0, swarmTargetId: undefined,
      };
      // The enemy base is the only enemy, so it is the bee's closest target.
      const baseStartHp = 2000; // survives the hit so the win check doesn't end the match
      const enemyBasePos = { x: beePos.x + 20, y: beePos.y, z: beePos.z };
      const enemyBase = {
        ...template, id: 'enemy-base', ownerId: enemyId, kind: 'Base',
        position: { ...enemyBasePos }, hp: baseStartHp, maxHp: baseStartHp, moveSpeed: 0, swarmTargetId: undefined,
      };
      const playerBase = { ...template, id: 'player-base', kind: 'Base', position: { x: beePos.x - 60, y: beePos.y, z: beePos.z }, moveSpeed: 0 };
      store.setState({ units: [bee, enemyBase, playerBase], unitOrders: {}, projectiles: [] });

      store.getState().swarm({ unitIds: [bee.id] });
      const claimedTargetId = store.getState().units.find((u: any) => u.id === bee.id)?.swarmTargetId ?? null;

      const nowBase = performance.now();
      for (let i = 0; i < ticks; i++) store.getState().tick(dtSec, nowBase + i * dtMs);

      const b = store.getState().units.find((u: any) => u.id === enemyBase.id);
      const survivingBee = store.getState().units.find((u: any) => u.id === bee.id);
      return {
        beeFound: true,
        claimedTargetId,
        expectedDamage: animals.Bee.dmg,
        baseDamageTaken: baseStartHp - (b?.hp ?? baseStartHp),
        beeDied: !survivingBee || survivingBee.hp <= 0,
      };
    }, { beePos: BEE_POSITION, dtSec: SIM_DT_SEC, dtMs: SIM_DT_MS, ticks: TICK_COUNT });

    expect(result.beeFound).toBe(true);
    // The bee committed to the base and stung it once on contact.
    expect(result.claimedTargetId).toBe('enemy-base');
    expect(result.baseDamageTaken).toBe(result.expectedDamage * EXPECTED_BASE_STING_MULT);
    // The dive is sacrificial: the bee is gone afterward.
    expect(result.beeDied).toBe(true);
  });

  test('a bee dives the closer enemy animal in preference to a farther base', async ({ page }) => {
    test.setTimeout(60_000);
    await openBeeMatch(page);

    const result = await page.evaluate(({ beePos }) => {
      const store = (window as any).__rtsStore;
      const state = store.getState();
      const localId = state.localPlayerId as string;
      const enemyId = state.players.find((p: any) => p.id !== localId)!.id as string;

      const template = state.units.find((u: any) => u.animal === 'Bee' && u.ownerId === localId);
      if (!template) return { beeFound: false } as any;

      const bee = { ...template, id: 'bee-choose', kind: 'Unit', position: { ...beePos }, swarmTargetId: undefined };
      // A near enemy animal and a far enemy base: the bee should claim the animal.
      const enemyAnimal = {
        ...template, id: 'enemy-animal', ownerId: enemyId, kind: 'Unit',
        position: { x: beePos.x + 10, y: beePos.y, z: beePos.z }, swarmTargetId: undefined,
      };
      const enemyBase = {
        ...template, id: 'enemy-base', ownerId: enemyId, kind: 'Base',
        position: { x: beePos.x + 60, y: beePos.y, z: beePos.z }, moveSpeed: 0, swarmTargetId: undefined,
      };
      store.setState({ units: [bee, enemyAnimal, enemyBase], unitOrders: {}, projectiles: [] });

      store.getState().swarm({ unitIds: [bee.id] });
      return { beeFound: true, claimedTargetId: store.getState().units.find((u: any) => u.id === bee.id)?.swarmTargetId ?? null };
    }, { beePos: BEE_POSITION });

    expect(result.beeFound).toBe(true);
    expect(result.claimedTargetId).toBe('enemy-animal');
  });
});
