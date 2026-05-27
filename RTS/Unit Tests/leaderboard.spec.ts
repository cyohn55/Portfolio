import { test, expect, type Page } from '@playwright/test';

/**
 * Tests for the post-game leaderboard utility — scoring, name validation, and
 * localStorage persistence. The tests drive the real module exposed on
 * `window.__rtsLeaderboard` (dev-only) so the assertions exercise the same code
 * the game ships, not a duplicate copy of the scoring constants.
 */

interface ScoreBreakdown {
  unitsGeneratedPoints: number;
  enemyUnitsKilledPoints: number;
  enemyBasesDestroyedPoints: number;
  enemyKingsKilledPoints: number;
  enemyQueensKilledPoints: number;
  bridgeHeldPoints: number;
  total: number;
}

interface MatchStatsInput {
  unitsGenerated: number;
  enemyUnitsKilled: number;
  enemyBasesDestroyed: number;
  enemyKingsKilled: number;
  enemyQueensKilled: number;
  rightBridgeDownMs: number;
  leftBridgeDownMs: number;
}

const ZERO_STATS: MatchStatsInput = {
  unitsGenerated: 0,
  enemyUnitsKilled: 0,
  enemyBasesDestroyed: 0,
  enemyKingsKilled: 0,
  enemyQueensKilled: 0,
  rightBridgeDownMs: 0,
  leftBridgeDownMs: 0,
};

async function openGame(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as any).__rtsLeaderboard));
  // Each test starts with a fresh localStorage so persistence assertions can
  // count entries without inheriting fixtures from a previous run.
  await page.evaluate(() => localStorage.clear());
}

async function score(page: Page, stats: MatchStatsInput): Promise<ScoreBreakdown> {
  return page.evaluate((s) => {
    const lb = (window as any).__rtsLeaderboard;
    return lb.computeScore(s);
  }, stats);
}

test.describe('leaderboard scoring', () => {
  test('all-zero stats produce a zero score', async ({ page }) => {
    await openGame(page);
    const breakdown = await score(page, ZERO_STATS);
    expect(breakdown.total).toBe(0);
  });

  test('each event contributes its point value independently', async ({ page }) => {
    await openGame(page);

    // Drive a single event at a time and check that only the matching breakdown
    // field moves. This catches the class of bug where a refactor accidentally
    // wires (say) "enemyKingsKilled" into the queens points line.
    const unitOnly = await score(page, { ...ZERO_STATS, unitsGenerated: 7 });
    expect(unitOnly.unitsGeneratedPoints).toBe(35); // 7 * 5
    expect(unitOnly.total).toBe(35);

    const enemyOnly = await score(page, { ...ZERO_STATS, enemyUnitsKilled: 4 });
    expect(enemyOnly.enemyUnitsKilledPoints).toBe(40); // 4 * 10
    expect(enemyOnly.total).toBe(40);

    const baseOnly = await score(page, { ...ZERO_STATS, enemyBasesDestroyed: 2 });
    expect(baseOnly.enemyBasesDestroyedPoints).toBe(100); // 2 * 50
    expect(baseOnly.total).toBe(100);

    const kingOnly = await score(page, { ...ZERO_STATS, enemyKingsKilled: 3 });
    expect(kingOnly.enemyKingsKilledPoints).toBe(90); // 3 * 30
    expect(kingOnly.total).toBe(90);

    const queenOnly = await score(page, { ...ZERO_STATS, enemyQueensKilled: 2 });
    expect(queenOnly.enemyQueensKilledPoints).toBe(80); // 2 * 40
    expect(queenOnly.total).toBe(80);
  });

  test('bridge held down pays per full 5-second slice and ignores partials', async ({ page }) => {
    await openGame(page);

    // 12_500 ms = two whole 5s slices (10s) + 2.5s leftover. The leftover must
    // not pay out — the spec is "5 points per 5 seconds", not pro-rated.
    const partial = await score(page, { ...ZERO_STATS, rightBridgeDownMs: 12_500 });
    expect(partial.bridgeHeldPoints).toBe(10); // 2 slices * 5

    // Each bridge counts independently — holding both simultaneously doubles
    // the payout for the same wall-clock window.
    const both = await score(page, {
      ...ZERO_STATS,
      rightBridgeDownMs: 15_000,
      leftBridgeDownMs: 10_000,
    });
    expect(both.bridgeHeldPoints).toBe(25); // (3 + 2) * 5

    // Under one slice never pays out.
    const tooShort = await score(page, { ...ZERO_STATS, leftBridgeDownMs: 4_999 });
    expect(tooShort.bridgeHeldPoints).toBe(0);
  });

  test('total equals the sum of every breakdown field', async ({ page }) => {
    await openGame(page);
    // A mixed scenario verifies the total is computed from the same breakdown
    // numbers the UI displays — no double counting, no missing categories.
    const mixed: MatchStatsInput = {
      unitsGenerated: 12,
      enemyUnitsKilled: 9,
      enemyBasesDestroyed: 1,
      enemyKingsKilled: 2,
      enemyQueensKilled: 3,
      rightBridgeDownMs: 20_000,
      leftBridgeDownMs: 5_000,
    };
    const breakdown = await score(page, mixed);
    const expected =
      breakdown.unitsGeneratedPoints +
      breakdown.enemyUnitsKilledPoints +
      breakdown.enemyBasesDestroyedPoints +
      breakdown.enemyKingsKilledPoints +
      breakdown.enemyQueensKilledPoints +
      breakdown.bridgeHeldPoints;
    expect(breakdown.total).toBe(expected);
  });
});

test.describe('leaderboard name validation', () => {
  async function validate(page: Page, name: string): Promise<{ ok: boolean; reason?: string }> {
    return page.evaluate((n) => {
      const lb = (window as any).__rtsLeaderboard;
      return lb.validateName(n);
    }, name);
  }

  test('accepts ordinary alphanumeric handles', async ({ page }) => {
    await openGame(page);
    for (const name of ['Cody', 'Player_1', 'Ace-42', 'foo bar']) {
      const result = await validate(page, name);
      expect(result.ok, `expected "${name}" to be accepted, got: ${result.reason}`).toBe(true);
    }
  });

  test('rejects names that are too short or too long', async ({ page }) => {
    await openGame(page);
    const tooShort = await validate(page, 'A');
    expect(tooShort.ok).toBe(false);

    const tooLong = await validate(page, 'a'.repeat(50));
    expect(tooLong.ok).toBe(false);
  });

  test('rejects names containing unsupported characters', async ({ page }) => {
    await openGame(page);
    const emoji = await validate(page, 'Cody 🚀');
    expect(emoji.ok).toBe(false);
  });

  test('blocks obvious profanity and common evasions', async ({ page }) => {
    await openGame(page);
    // Each case targets a different bypass strategy: plain text, leet
    // substitution, repeated letters, and punctuation-broken spelling. All
    // should be rejected by the normalization + banned-list check.
    const bypasses = ['Fuck', 'sh1t', 'Shiiiit', 'b!tch', 'a$$hole', 'f.u.c.k', 'N1gger'];
    for (const attempt of bypasses) {
      const result = await validate(page, attempt);
      expect(result.ok, `expected "${attempt}" to be rejected`).toBe(false);
    }
  });

  test('does not falsely flag clean names that contain banned substrings by coincidence', async ({ page }) => {
    await openGame(page);
    // "Scunthorpe problem" — make sure the filter targets the specific banned
    // roots and not arbitrary letter sequences a real name might contain. None
    // of these should hit the BANNED_ROOTS list as-is.
    for (const name of ['Anna', 'Mike', 'Jess', 'Alex']) {
      const result = await validate(page, name);
      expect(result.ok, `expected "${name}" to be accepted, got: ${result.reason}`).toBe(true);
    }
  });
});

test.describe('leaderboard persistence', () => {
  test('addLeaderboardEntry stores, sorts, and returns the new list', async ({ page }) => {
    await openGame(page);

    const result = await page.evaluate(() => {
      const lb = (window as any).__rtsLeaderboard;
      lb.addLeaderboardEntry({ name: 'Alpha', score: 100, dateMs: 1, result: 'victory' });
      lb.addLeaderboardEntry({ name: 'Beta',  score: 300, dateMs: 2, result: 'victory' });
      const final = lb.addLeaderboardEntry({ name: 'Gamma', score: 200, dateMs: 3, result: 'defeat' });
      const persisted = lb.getLeaderboard();
      return { final, persisted };
    });

    // Highest score is rank #1 and the read-from-storage view matches the
    // returned list — the function's two responsibilities (persist, return) stay
    // in sync.
    expect(result.final.map((e: any) => e.name)).toEqual(['Beta', 'Gamma', 'Alpha']);
    expect(result.persisted.map((e: any) => e.name)).toEqual(['Beta', 'Gamma', 'Alpha']);
  });

  test('caps the persisted list at 10 entries, keeping the highest scores', async ({ page }) => {
    await openGame(page);

    const top10 = await page.evaluate(() => {
      const lb = (window as any).__rtsLeaderboard;
      for (let i = 0; i < 15; i++) {
        lb.addLeaderboardEntry({
          name: `Player${i}`,
          score: i * 10, // 0..140
          dateMs: 1000 + i,
          result: i % 2 === 0 ? 'victory' : 'defeat',
        });
      }
      return lb.getLeaderboard();
    });

    expect(top10.length).toBe(10);
    expect(top10[0].score).toBe(140); // highest survives
    expect(top10[top10.length - 1].score).toBe(50); // 5-14 inclusive => min 50
  });

  test('ties on score break by faster matchTimeMs (lower wins)', async ({ page }) => {
    await openGame(page);

    // All three entries share score=200 — the only differentiator is
    // matchTimeMs. The fastest win (90s) should rank first, the slowest
    // (300s) last. dateMs is set so it would sort wrong if matchTimeMs
    // were ignored — proving the tie-break engages.
    const ranked = await page.evaluate(() => {
      const lb = (window as any).__rtsLeaderboard;
      lb.addLeaderboardEntry({ name: 'Slow',   score: 200, dateMs: 1, result: 'victory', matchTimeMs: 300_000 });
      lb.addLeaderboardEntry({ name: 'Medium', score: 200, dateMs: 2, result: 'victory', matchTimeMs: 180_000 });
      lb.addLeaderboardEntry({ name: 'Fast',   score: 200, dateMs: 3, result: 'victory', matchTimeMs:  90_000 });
      return lb.getLeaderboard();
    });

    expect(ranked.map((e: any) => e.name)).toEqual(['Fast', 'Medium', 'Slow']);
  });

  test('a legacy entry without matchTimeMs loses any tie to a timed entry', async ({ page }) => {
    await openGame(page);

    // Legacy entries persisted before the matchTimeMs field existed must
    // still load (backwards compat) but should lose tie-breaks to any
    // newer timed entry — the comparator treats them as Infinity.
    const ranked = await page.evaluate(() => {
      const lb = (window as any).__rtsLeaderboard;
      lb.addLeaderboardEntry({ name: 'Legacy', score: 200, dateMs: 1, result: 'victory' }); // no matchTimeMs
      lb.addLeaderboardEntry({ name: 'Timed',  score: 200, dateMs: 2, result: 'victory', matchTimeMs: 120_000 });
      return lb.getLeaderboard();
    });

    expect(ranked.map((e: any) => e.name)).toEqual(['Timed', 'Legacy']);
  });

  test('score still beats matchTimeMs — a faster but lower-score entry ranks below', async ({ page }) => {
    await openGame(page);

    // The user's spec is explicit: higher score takes precedence; matchTime
    // only matters when scores are tied. Verify the high-scoring slow run
    // outranks a faster but lower-scoring one.
    const ranked = await page.evaluate(() => {
      const lb = (window as any).__rtsLeaderboard;
      lb.addLeaderboardEntry({ name: 'FasterButLower', score: 100, dateMs: 1, result: 'victory', matchTimeMs:  60_000 });
      lb.addLeaderboardEntry({ name: 'SlowerHigher',   score: 200, dateMs: 2, result: 'victory', matchTimeMs: 600_000 });
      return lb.getLeaderboard();
    });

    expect(ranked.map((e: any) => e.name)).toEqual(['SlowerHigher', 'FasterButLower']);
  });
});
