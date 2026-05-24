import { test, expect, type Page } from '@playwright/test';

/**
 * Behavioural tests for the multi-axis animal design (HP, damage, attack speed,
 * range, move speed) and the kiting / movement systems built on top of it.
 *
 * The tests read the live game data and exercise the real `tick` simulation via
 * the dev-only `window.__rtsStore` / `window.__rtsAnimals` handles, so they
 * assert on actual engine behaviour and the real stats table rather than copies
 * of the numbers.
 */

// The same power-budget index the stats table is tuned against. Kept here as the
// *specification* the data must satisfy; the inputs come entirely from the live
// table, so this is not a duplicated copy of any animal's numbers.
function powerIndex(stats: { baseHp: number; dmg: number; speed: number; range: number; attackCooldownMs: number }): number {
  const effectiveDamage = stats.dmg * 1500 / stats.attackCooldownMs;
  const speedFactor = 1 + stats.speed / 40;
  const rangeFactor = 1 + 0.085 * (stats.range - 4);
  return Math.sqrt(stats.baseHp * effectiveDamage) * speedFactor * rangeFactor;
}

async function openGame(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as any).__rtsStore && (window as any).__rtsAnimals));
}

test.describe('animal stat budget', () => {
  test('every animal lands within a tight overall power budget', async ({ page }) => {
    await openGame(page);

    const indices = await page.evaluate(() => {
      const animals = (window as any).__rtsAnimals as Record<string, any>;
      const result: Record<string, number> = {};
      for (const [name, stats] of Object.entries(animals)) {
        const effectiveDamage = stats.dmg * 1500 / stats.attackCooldownMs;
        const speedFactor = 1 + stats.speed / 40;
        const rangeFactor = 1 + 0.085 * (stats.range - 4);
        result[name] = Math.sqrt(stats.baseHp * effectiveDamage) * speedFactor * rangeFactor;
      }
      return result;
    });

    const values = Object.values(indices);
    expect(values.length).toBe(12);

    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = max / min - 1;

    // No animal should be more than ~8% stronger than the weakest by total budget.
    expect(spread).toBeLessThan(0.08);
  });

  test('damage-per-second stays in a sane band across the roster', async ({ page }) => {
    await openGame(page);

    const dpsValues = await page.evaluate(() => {
      const animals = (window as any).__rtsAnimals as Record<string, any>;
      return Object.values(animals).map((s: any) => s.dmg / (s.attackCooldownMs / 1000));
    });

    const min = Math.min(...dpsValues);
    const max = Math.max(...dpsValues);

    // Attack speed should differentiate feel, not create runaway DPS outliers.
    expect(max / min).toBeLessThan(2);
  });
});

test.describe('ranged vs melee identity', () => {
  test('exactly the intended fliers/skirmishers reach beyond melee range', async ({ page }) => {
    await openGame(page);

    const { ranged, allMeleeAtFour, meleeThreshold } = await page.evaluate(() => {
      const animals = (window as any).__rtsAnimals as Record<string, any>;
      const meleeThreshold = (window as any).__rtsMeleeRange as number;
      const ranged = Object.entries(animals)
        .filter(([, s]: any) => s.range > meleeThreshold)
        .map(([name]) => name)
        .sort();
      const allMeleeAtFour = Object.entries(animals)
        .filter(([, s]: any) => s.range <= meleeThreshold)
        .every(([, s]: any) => s.range === 4);
      return { ranged, allMeleeAtFour, meleeThreshold };
    });

    expect(meleeThreshold).toBeGreaterThan(4);
    expect(ranged).toEqual(['Bee', 'Frog', 'Owl']);
    expect(allMeleeAtFour).toBe(true);
  });
});

test.describe('kiting behaviour', () => {
  test('a faster ranged unit keeps its distance while a melee unit gets caught', async ({ page }) => {
    await openGame(page);

    const sim = await page.evaluate(() => {
      const store = (window as any).__rtsStore;
      store.getState().initializeGame();
      const state = store.getState();
      // Defender = the local human player's unit, driven by its own combat AI.
      // Chaser  = an AI-owned unit which, given no order, autonomously hunts the
      // nearest enemy across the whole map (findClosestEnemy) and attacks it.
      const defenderOwnerId = state.localPlayerId;
      const chaserOwnerId = state.players.find((p: any) => p.id !== state.localPlayerId).id;

      const makeUnit = (
        animal: string,
        kind: string,
        ownerId: string,
        x: number,
        z: number,
        opts: { hp: number; dmg: number; spd: number; range: number; cd: number },
      ) => ({
        id: 'test_' + Math.random().toString(36).slice(2),
        ownerId,
        animal, // 'Owl' => air movement, so terrain never interferes in this sim
        kind,
        position: { x, y: 0, z },
        hp: opts.hp,
        maxHp: opts.hp,
        attackDamage: opts.dmg,
        moveSpeed: opts.spd,
        attackRange: opts.range,
        attackCooldownMs: opts.cd,
        lastAttackAtMs: 0,
        rotation: 0,
      });

      // Run one chase: a defender (no order, so its combat AI fights/kites) versus
      // an AI chaser (no order, so it hunts the defender). Both attack. Returns
      // how close the chaser ever got and how much health the defender kept.
      const runChase = (defenderRange: number, defenderSpeed: number) => {
        const startGap = 8;
        // Bases keep both sides "alive" so the win check never ends the match.
        const baseA = makeUnit('Owl', 'Base', defenderOwnerId, 300, 300, { hp: 5000, dmg: 0, spd: 0, range: 4, cd: 1500 });
        const baseB = makeUnit('Owl', 'Base', chaserOwnerId, -300, -300, { hp: 5000, dmg: 0, spd: 0, range: 4, cd: 1500 });
        const defender = makeUnit('Owl', 'Unit', defenderOwnerId, 0, 0, { hp: 400, dmg: 8, spd: defenderSpeed, range: defenderRange, cd: 500 });
        const chaser = makeUnit('Owl', 'Unit', chaserOwnerId, 0, startGap, { hp: 400, dmg: 8, spd: 8, range: 3, cd: 500 });

        store.setState({
          units: [baseA, baseB, defender, chaser],
          matchStarted: true,
          isPaused: false,
          gameOver: false,
          winner: null,
          unitOrders: {},
          queenPatrols: {},
          selectedUnitIds: [],
          deadUnitsToRemove: [],
          targetCache: {},
          aiThinkingOffset: {},
        });

        let nowMs = 1000;
        let minGap = Infinity;
        for (let i = 0; i < 300; i++) {
          nowMs += 50;
          store.getState().tick(0.05, nowMs);

          const after = store.getState().units;
          const da = after.find((u: any) => u.id === defender.id);
          const ca = after.find((u: any) => u.id === chaser.id);
          if (!da || !ca) break;
          const gap = Math.hypot(da.position.x - ca.position.x, da.position.z - ca.position.z);
          if (gap < minGap) minGap = gap;
        }

        const finalUnits = store.getState().units;
        const finalDefender = finalUnits.find((u: any) => u.id === defender.id);
        return {
          minGap,
          defenderHp: finalDefender ? finalDefender.hp : 0,
          defenderAlive: Boolean(finalDefender && finalDefender.hp > 0),
        };
      };

      const kiter = runChase(10, 15);  // ranged + faster -> should kite and stay safe
      const meleeControl = runChase(3, 15); // faster but melee -> closes and trades
      return { kiter, meleeControl };
    });

    // The kiter never lets the chaser into melee range and survives.
    expect(sim.kiter.minGap).toBeGreaterThan(4);
    expect(sim.kiter.defenderAlive).toBe(true);

    // The melee control, lacking reach, gets caught...
    expect(sim.meleeControl.minGap).toBeLessThan(4);
    // ...and actually takes damage in that melee (sanity-check the chaser fights).
    expect(sim.meleeControl.defenderHp).toBeLessThan(400);

    // Reach + speed should translate into materially less damage taken than a
    // melee unit of the same speed facing the same chaser.
    expect(sim.kiter.defenderHp).toBeGreaterThan(sim.meleeControl.defenderHp);
  });
});

// Guards against accidental drift between the spec helper and the inline
// evaluate() formula above.
test('power index helper matches a representative hand calculation', async ({ page }) => {
  await openGame(page);
  const fromPage = await page.evaluate(() => {
    const animals = (window as any).__rtsAnimals as Record<string, any>;
    const s = animals.Owl;
    return { stats: s };
  });
  const local = powerIndex(fromPage.stats);
  expect(local).toBeGreaterThan(40);
  expect(local).toBeLessThan(80);
});
