import { test, expect, type Page } from '@playwright/test';

/**
 * Behavioural tests for the title-screen chase choreography
 * (src/components/Working/titleScreenChoreography.ts).
 *
 * The tests read live placements off the dev-only `window.__rtsTitleChoreographer`
 * handle the title-screen background publishes, so they assert on the real
 * choreographer's output rather than re-deriving the loop maths here. Because
 * the chase only animates when Title_Screen.glb carries the named animal groups
 * (Bee / Bear / Bunny / Turtle / Fox / Kitty / Pig / Chicken), each test skips
 * gracefully when no pairs have resolved — so it stays green until the GLB is
 * re-exported, then begins enforcing the chase the moment the groups exist.
 */

interface RouteDebugInfo {
  name: string;
  role: 'leader' | 'chaser';
  gait: 'hop' | 'fly' | 'walk';
  visible: boolean;
  position: { x: number; y: number; z: number };
}

const TITLE_HANDLE = '__rtsTitleChoreographer';

async function waitForTitleScreen(page: Page): Promise<void> {
  await page.goto('/');
  // The main menu mounts the title-screen Canvas; give the choreographer handle
  // time to publish after the ~15 MB GLB resolves.
  await page.waitForFunction((handle) => handle in window, TITLE_HANDLE, { timeout: 60_000 });
}

async function readRoutes(page: Page): Promise<RouteDebugInfo[]> {
  return page.evaluate((handle) => {
    const choreographer = (window as unknown as Record<string, { getDebugRoutes(): RouteDebugInfo[] }>)[handle];
    return choreographer ? choreographer.getDebugRoutes() : [];
  }, TITLE_HANDLE);
}

async function pairCount(page: Page): Promise<number> {
  return page.evaluate((handle) => {
    const choreographer = (window as unknown as Record<string, { pairCount: number }>)[handle];
    return choreographer ? choreographer.pairCount : 0;
  }, TITLE_HANDLE);
}

async function activeIndex(page: Page): Promise<number> {
  return page.evaluate((handle) => {
    const choreographer = (window as unknown as Record<string, { activeIndex: number }>)[handle];
    return choreographer ? choreographer.activeIndex : -1;
  }, TITLE_HANDLE);
}

test.describe('Title-screen chase choreography', () => {
  test('every resolved pair animates a leader and a chaser', async ({ page }) => {
    await waitForTitleScreen(page);
    const pairs = await pairCount(page);
    test.skip(pairs === 0, 'Title_Screen.glb has no named animal groups yet — re-export to enable.');

    const routes = await readRoutes(page);
    expect(routes.length).toBe(pairs * 2);

    const leaders = routes.filter((r) => r.role === 'leader');
    const chasers = routes.filter((r) => r.role === 'chaser');
    expect(leaders.length).toBe(pairs);
    expect(chasers.length).toBe(pairs);
  });

  test('only one pair plays at a time and it moves while playing', async ({ page }) => {
    await waitForTitleScreen(page);
    test.skip((await pairCount(page)) === 0, 'No animal groups in GLB yet.');

    // Exactly one pair (two animals) is visible at any moment; the rest wait.
    const routes = await readRoutes(page);
    const visible = routes.filter((r) => r.visible);
    expect(visible.length).toBe(2);
    expect(new Set(visible.map((r) => r.role))).toEqual(new Set(['leader', 'chaser']));

    // The visible (active) animals translate measurably over a short window,
    // while the hidden ones stay parked at their start.
    const before = await readRoutes(page);
    await page.waitForTimeout(900);
    const after = await readRoutes(page);

    for (const start of before.filter((r) => r.visible)) {
      const end = after.find((r) => r.name === start.name)!;
      const moved = Math.hypot(end.position.x - start.position.x, end.position.z - start.position.z);
      expect(moved).toBeGreaterThan(0.5);
    }
  });

  test('pairs play in sequence (the active pair cycles over time)', async ({ page }) => {
    await waitForTitleScreen(page);
    const pairs = await pairCount(page);
    test.skip(pairs < 2, 'Need at least two pairs to observe the sequence advance.');

    // Watch the active index until it changes — proves the sequence hands off
    // from one pair to the next rather than animating them all at once.
    const first = await activeIndex(page);
    const advanced = await page
      .waitForFunction(
        ([handle, start]) => {
          const c = (window as unknown as Record<string, { activeIndex: number }>)[handle as string];
          return c && c.activeIndex !== start;
        },
        [TITLE_HANDLE, first] as const,
        { timeout: 60_000 },
      )
      .then(() => true)
      .catch(() => false);
    expect(advanced).toBe(true);
  });

  test('gaits match the in-game motion: Bunny hops, Bee flies, others walk', async ({ page }) => {
    await waitForTitleScreen(page);
    test.skip((await pairCount(page)) === 0, 'No animal groups in GLB yet.');

    const routes = await readRoutes(page);
    const gaitOf = (fragment: string) =>
      routes.find((r) => r.name.toLowerCase().includes(fragment))?.gait;

    if (gaitOf('bunny')) expect(gaitOf('bunny')).toBe('hop');
    if (gaitOf('bee')) expect(gaitOf('bee')).toBe('fly');
    for (const grounded of ['bear', 'turtle', 'fox', 'pig', 'chicken']) {
      if (gaitOf(grounded)) expect(gaitOf(grounded)).toBe('walk');
    }
  });

  test('a flyer (Bee) is held above its grounded quarry (Bear)', async ({ page }) => {
    await waitForTitleScreen(page);
    test.skip((await pairCount(page)) === 0, 'No animal groups in GLB yet.');

    const routes = await readRoutes(page);
    const bee = routes.find((r) => r.name.toLowerCase().includes('bee'));
    const bear = routes.find((r) => r.name.toLowerCase().includes('bear'));
    test.skip(!bee || !bear, 'Bee/Bear pair not present in GLB.');

    // The flyer should ride above the walker it pursues. The gap reflects the
    // authored heights (Bee ~7.3, Bear ~4.1) minus the worst-case flight bob.
    expect(bee!.position.y).toBeGreaterThan(bear!.position.y + 1);
  });
});
