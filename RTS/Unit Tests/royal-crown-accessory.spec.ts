import { test, expect, type Page } from '@playwright/test';

/**
 * Feature test: team-colored royal head accessories (crowns / tiaras).
 *
 * Several animal models ship four head props baked at the same spot — a Crown
 * and a Tiara in each team color. The renderer (UnitsLayer) shows exactly one on
 * a royal unit, chosen from observable unit state:
 *   - local player's King   → Blue_Crown
 *   - local player's Queen  → Blue_Tiara
 *   - enemy King            → Red_Crown
 *   - enemy Queen           → Red_Tiara
 * Regular units, Bases, and models without these nodes (Frog, Chicken) show none.
 *
 * These tests drive the real app: they boot a match (which bakes the accessory
 * variants in-browser via getBakedRoyalAccessoryParts), then assert the renderer's
 * own selection rule (window.__rtsRoyalAccessoryKeyForUnit) against the REAL units
 * in the store and the REAL set of baked variants (window.__rtsMountedAccessoryVariants).
 * Nothing is mocked or hard-coded: the unit inputs come from the live store and the
 * outputs come from the renderer's own logic and bake pipeline.
 */

// All three carry the full Blue/Red Crown/Tiara node set, so every royal in the
// match should resolve a concrete accessory variant.
const ACCESSORY_ANIMALS = ['Bear', 'Cat', 'Bunny'] as const;

async function openMatch(page: Page, animals: readonly string[]): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('text=QUICK PLAY', { timeout: 30000 });
  await page.click('text=QUICK PLAY');
  for (const animal of animals) {
    await page.waitForSelector(`text=${animal}`, { timeout: 15000 });
    await page.click(`text=${animal}`);
  }
  await (await page.waitForSelector('button:has-text("Start")', { timeout: 15000 })).click();
  await page.waitForFunction(
    () =>
      Boolean(
        (window as any).__rtsStore &&
          (window as any).__rtsTerrain?.isInitialized?.() &&
          (window as any).__rtsPath?.isReady?.() &&
          (window as any).__rtsRoyalAccessoryKeyForUnit &&
          (window as any).__rtsMountedAccessoryVariants,
      ),
    { timeout: 45000 },
  );
}

test.describe('Royal crown/tiara accessories', () => {
  test('each royal resolves the team-colored crown/tiara the renderer can draw', async ({ page }) => {
    test.setTimeout(60_000);
    await openMatch(page, ACCESSORY_ANIMALS);

    const result = await page.evaluate(() => {
      const store = (window as any).__rtsStore;
      const state = store.getState();
      const localId = state.localPlayerId as string;
      const keyForUnit = (window as any).__rtsRoyalAccessoryKeyForUnit as (u: any, own: boolean) => string | null;
      const mounted: string[] = (window as any).__rtsMountedAccessoryVariants;
      const mountedSet = new Set(mounted);

      const royals = state.units.filter((u: any) => u.kind === 'King' || u.kind === 'Queen');

      const rows = royals.map((u: any) => {
        const isOwn = u.ownerId === localId;
        const key = keyForUnit(u, isOwn);
        return {
          animal: u.animal,
          kind: u.kind,
          isOwn,
          key,
          // The chosen variant must actually be baked + mounted, or nothing draws.
          mounted: key ? mountedSet.has(key) : false,
          // The variant key must carry the correct color + piece for this royal.
          expectedColor: isOwn ? 'Blue' : 'Red',
          expectedPiece: u.kind === 'King' ? 'Crown' : 'Tiara',
        };
      });

      return { royalCount: royals.length, rows, ownerId: localId };
    });

    // A match has Kings and Queens on both sides.
    expect(result.royalCount).toBeGreaterThan(0);
    const owners = new Set(result.rows.map((r: any) => r.isOwn));
    expect(owners.has(true)).toBe(true);
    expect(owners.has(false)).toBe(true);
    const kinds = new Set(result.rows.map((r: any) => r.kind));
    expect(kinds.has('King')).toBe(true);
    expect(kinds.has('Queen')).toBe(true);

    for (const row of result.rows) {
      // Every royal of an accessory-bearing animal resolves a concrete variant …
      expect(row.key, `${row.animal} ${row.kind} (own=${row.isOwn})`).toBeTruthy();
      // … that is actually baked + mounted (so the crown/tiara will render) …
      expect(row.mounted, `variant ${row.key} mounted`).toBe(true);
      // … and the variant encodes the correct team color and rank piece.
      expect(row.key).toContain(`${row.expectedColor}_${row.expectedPiece}`);
    }
  });

  test('the same unit flips Blue<->Red purely by allegiance', async ({ page }) => {
    test.setTimeout(60_000);
    await openMatch(page, ACCESSORY_ANIMALS);

    const result = await page.evaluate(() => {
      const store = (window as any).__rtsStore;
      const state = store.getState();
      const keyForUnit = (window as any).__rtsRoyalAccessoryKeyForUnit as (u: any, own: boolean) => string | null;

      const king = state.units.find((u: any) => u.kind === 'King');
      const queen = state.units.find((u: any) => u.kind === 'Queen');

      return {
        kingOwn: king ? keyForUnit(king, true) : null,
        kingEnemy: king ? keyForUnit(king, false) : null,
        queenOwn: queen ? keyForUnit(queen, true) : null,
        queenEnemy: queen ? keyForUnit(queen, false) : null,
      };
    });

    // A King wears a Crown; allegiance only swaps the color.
    expect(result.kingOwn).toContain('Blue_Crown');
    expect(result.kingEnemy).toContain('Red_Crown');
    expect(result.kingOwn).not.toEqual(result.kingEnemy);

    // A Queen wears a Tiara; allegiance only swaps the color.
    expect(result.queenOwn).toContain('Blue_Tiara');
    expect(result.queenEnemy).toContain('Red_Tiara');
    expect(result.queenOwn).not.toEqual(result.queenEnemy);
  });

  test('non-royal units never resolve an accessory variant', async ({ page }) => {
    test.setTimeout(60_000);
    await openMatch(page, ACCESSORY_ANIMALS);

    const result = await page.evaluate(() => {
      const store = (window as any).__rtsStore;
      const state = store.getState();
      const localId = state.localPlayerId as string;
      const keyForUnit = (window as any).__rtsRoyalAccessoryKeyForUnit as (u: any, own: boolean) => string | null;

      const plain = state.units.filter((u: any) => u.kind === 'Unit');
      const anyResolved = plain.some((u: any) => keyForUnit(u, u.ownerId === localId) !== null);
      return { plainCount: plain.length, anyResolved };
    });

    // Plain units exist and not one of them maps to a crown/tiara variant.
    expect(result.plainCount).toBeGreaterThan(0);
    expect(result.anyResolved).toBe(false);
  });

  test('models without crown nodes (Frog) bake no accessory variants', async ({ page }) => {
    test.setTimeout(60_000);
    // Frog lacks the accessory nodes; Bear/Cat carry them.
    await openMatch(page, ['Frog', 'Bear', 'Cat']);

    const mounted: string[] = await page.evaluate(() => (window as any).__rtsMountedAccessoryVariants);

    // Accessory-bearing animals contribute variants …
    expect(mounted.some((k) => k.startsWith('royal:Bear:'))).toBe(true);
    expect(mounted.some((k) => k.startsWith('royal:Cat:'))).toBe(true);
    // … while the Frog, which has no crown/tiara nodes, contributes none.
    expect(mounted.some((k) => k.startsWith('royal:Frog:'))).toBe(false);
  });
});
