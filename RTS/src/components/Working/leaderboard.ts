// Leaderboard storage, scoring, and submitted-name validation for the post-game
// screen. Designed to be runtime-pure (no React, no game-state imports) so it can
// be unit-tested in isolation and reused if the leaderboard ever moves into the
// main menu.
//
// Single responsibility per export: scoring math, name validation, and persisted
// storage are kept on independent functions. The constants near the top are the
// scoring contract — change them here, not at call sites.

import type { MatchStats } from '../../game/types';

// Point values per scored event. Codified once so the breakdown UI and the unit
// tests both reference the same source. "Per 5s bridge held fully down" is paid
// out in 5-second slices: every full 5s of fully-down time grants the points,
// partial slices are not pro-rated (matches the user's "5 points per 5 seconds"
// phrasing).
export const SCORE_POINTS = {
  perUnitGenerated: 5,
  perEnemyUnitKilled: 10,
  perEnemyBaseDestroyed: 50,
  perEnemyKingKilled: 30,
  perEnemyQueenKilled: 40,
  perBridgeFiveSeconds: 5,
} as const;

const BRIDGE_INTERVAL_MS = 5_000;

const STORAGE_KEY = 'rts-leaderboard';
const MAX_ENTRIES = 10;

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 16;

export interface ScoreBreakdown {
  unitsGeneratedPoints: number;
  enemyUnitsKilledPoints: number;
  enemyBasesDestroyedPoints: number;
  enemyKingsKilledPoints: number;
  enemyQueensKilledPoints: number;
  bridgeHeldPoints: number;
  total: number;
}

export interface LeaderboardEntry {
  name: string;
  score: number;
  dateMs: number;       // epoch ms when the score was added (for stable sorting/display)
  result: 'victory' | 'defeat';
  // Wall-clock match duration in milliseconds. Used as the leaderboard
  // tie-break: with two equal scores the lower matchTimeMs ranks higher
  // (a faster win is better). Required — entries without a matchTimeMs are
  // dropped on load by isWellFormedEntry, and getLeaderboard re-persists
  // the cleaned list. (Earlier versions accepted untimed entries as a
  // back-compat measure, but they rendered as "—" in the Time column and
  // were never going to be comparable, so we now garbage-collect them.)
  matchTimeMs: number;
}

/**
 * Compute the points each tracked event contributed plus the overall total. The
 * total is the sum of the named breakdown fields, so adding a new scored event
 * means extending both the breakdown shape and this calculator together.
 */
export function computeScore(stats: MatchStats): ScoreBreakdown {
  const unitsGeneratedPoints      = stats.unitsGenerated      * SCORE_POINTS.perUnitGenerated;
  const enemyUnitsKilledPoints    = stats.enemyUnitsKilled    * SCORE_POINTS.perEnemyUnitKilled;
  const enemyBasesDestroyedPoints = stats.enemyBasesDestroyed * SCORE_POINTS.perEnemyBaseDestroyed;
  const enemyKingsKilledPoints    = stats.enemyKingsKilled    * SCORE_POINTS.perEnemyKingKilled;
  const enemyQueensKilledPoints   = stats.enemyQueensKilled   * SCORE_POINTS.perEnemyQueenKilled;

  // Bridges are paid by whole 5-second intervals while fully down. Sum each
  // bridge's intervals independently, then convert to points.
  const rightIntervals = Math.floor(stats.rightBridgeDownMs / BRIDGE_INTERVAL_MS);
  const leftIntervals  = Math.floor(stats.leftBridgeDownMs  / BRIDGE_INTERVAL_MS);
  const bridgeHeldPoints = (rightIntervals + leftIntervals) * SCORE_POINTS.perBridgeFiveSeconds;

  const total =
    unitsGeneratedPoints +
    enemyUnitsKilledPoints +
    enemyBasesDestroyedPoints +
    enemyKingsKilledPoints +
    enemyQueensKilledPoints +
    bridgeHeldPoints;

  return {
    unitsGeneratedPoints,
    enemyUnitsKilledPoints,
    enemyBasesDestroyedPoints,
    enemyKingsKilledPoints,
    enemyQueensKilledPoints,
    bridgeHeldPoints,
    total,
  };
}

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

// Banned roots — the substrings we will not allow once the name is normalized.
// Kept short so leet-substitution + repeated-letter compression can still match
// common bypasses ("f0ck", "shiiit", "n_i_g_g_e_r"). The list is intentionally
// conservative: the goal is to block the obvious slurs and obscenities that
// would embarrass the portfolio, not to police every borderline word.
const BANNED_ROOTS: readonly string[] = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'cunt', 'cock',
  'pussy', 'whore', 'slut', 'fag', 'faggot', 'nigger', 'nigga', 'chink',
  'spic', 'kike', 'gook', 'tranny', 'retard', 'rape', 'rapist',
  'nazi', 'hitler', 'kkk', 'cum', 'jizz', 'twat', 'wank', 'damnit',
  'goddamn', 'pedo', 'pedophile', 'molest',
];

// Map common leet/symbol substitutions back to the letter they're standing in
// for so "f@ck", "sh1t", "b!tch" all collapse to a single canonical form before
// we check the banned list.
const LEET_TO_LETTER: Record<string, string> = {
  '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a',
  '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b', '9': 'g', '6': 'g',
  '2': 'z',
};

/**
 * Collapse a submitted name into a single lower-case run of letters with leet
 * substitutions resolved and adjacent duplicate letters merged. The combination
 * blocks the common evasions (caps, spacing, "ssshhhiiit", "f.u.c.k", "$h1t")
 * without forbidding legitimate names — duplicates like "Anna" still pass
 * (canonical "ana" doesn't intersect any banned root).
 */
export function normalizeName(raw: string): string {
  const lower = raw.toLowerCase();

  let mapped = '';
  for (const ch of lower) {
    if (ch >= 'a' && ch <= 'z') {
      mapped += ch;
    } else if (LEET_TO_LETTER[ch]) {
      mapped += LEET_TO_LETTER[ch];
    }
    // any other character (whitespace, punctuation, digits not in the table)
    // is dropped — that's what lets "f_u_c_k" still match "fuck".
  }

  // Collapse runs of the same letter so "shiiiiit" -> "shit".
  let collapsed = '';
  let prev = '';
  for (const ch of mapped) {
    if (ch !== prev) {
      collapsed += ch;
      prev = ch;
    }
  }

  return collapsed;
}

export interface NameValidation {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a leaderboard name. Returns `{ ok: true }` if accepted, otherwise
 * `{ ok: false, reason }` with a short human-readable message that the UI can
 * surface directly. Validation is intentionally cheap and synchronous so the
 * submit button can disable/enable as the user types.
 */
export function validateName(raw: string): NameValidation {
  const trimmed = raw.trim();
  if (trimmed.length < NAME_MIN_LENGTH) {
    return { ok: false, reason: `Name must be at least ${NAME_MIN_LENGTH} characters.` };
  }
  if (trimmed.length > NAME_MAX_LENGTH) {
    return { ok: false, reason: `Name must be at most ${NAME_MAX_LENGTH} characters.` };
  }

  // Allow only printable ASCII letters, digits, spaces, hyphens, underscores —
  // enough for handles like "Cody_42" without admitting control characters or
  // emoji that would break the leaderboard row layout.
  if (!/^[A-Za-z0-9 _-]+$/.test(trimmed)) {
    return { ok: false, reason: 'Use letters, numbers, spaces, "-" or "_" only.' };
  }

  const normalized = normalizeName(trimmed);
  for (const root of BANNED_ROOTS) {
    if (normalized.includes(root)) {
      return { ok: false, reason: 'Please choose a different name.' };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Read the leaderboard from localStorage and return the top entries sorted
 * by score → matchTimeMs → dateMs (see compareEntries). Tolerates corrupt
 * or absent storage by returning an empty list rather than throwing.
 *
 * Self-healing cleanup: any persisted entry that fails isWellFormedEntry
 * (today: entries missing matchTimeMs, persisted before the field was
 * required) is dropped. If that filter removed anything OR the on-disk
 * representation wasn't already in the canonical sorted/trimmed form, we
 * write the cleaned list back to storage so it doesn't have to be cleaned
 * again on the next read. Callers see a clean list; subsequent reads are
 * cheaper; the cleanup is a one-time cost per stale leaderboard.
 */
export function getLeaderboard(): LeaderboardEntry[] {
  if (typeof localStorage === 'undefined') return [];
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const cleaned = parsed
    .filter(isWellFormedEntry)
    .sort(compareEntries)
    .slice(0, MAX_ENTRIES);

  // If anything was filtered or the order/length is out of date, rewrite
  // storage so the malformed entries vanish for good. JSON.stringify
  // round-tripped vs the raw read is the cheapest "is it already canonical"
  // check available without diffing.
  try {
    const canonical = JSON.stringify(cleaned);
    if (canonical !== raw) {
      localStorage.setItem(STORAGE_KEY, canonical);
    }
  } catch {
    // Storage write failed (quota / disabled) — caller still gets the
    // cleaned in-memory list; we just can't persist it this turn.
  }

  return cleaned;
}

/**
 * Append an entry and persist the top `MAX_ENTRIES` back to localStorage.
 * Returns the new, sorted, trimmed leaderboard so the caller can re-render
 * without re-reading from storage. Caller is responsible for having validated
 * the name first.
 */
export function addLeaderboardEntry(entry: LeaderboardEntry): LeaderboardEntry[] {
  const current = getLeaderboard();
  const next = [...current, entry].sort(compareEntries).slice(0, MAX_ENTRIES);

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota exceeded or storage disabled — return the computed list anyway
      // so the current session at least shows the entry.
    }
  }
  return next;
}

function compareEntries(a: LeaderboardEntry, b: LeaderboardEntry): number {
  // Primary: higher score ranks first.
  if (b.score !== a.score) return b.score - a.score;
  // Tie-break #1: a faster win (lower matchTimeMs) ranks higher. Entries
  // persisted before matchTimeMs existed are treated as Infinity so a
  // freshly timed run still beats a legacy un-timed run on a tied score.
  const aTime = a.matchTimeMs ?? Number.POSITIVE_INFINITY;
  const bTime = b.matchTimeMs ?? Number.POSITIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;
  // Tie-break #2: older entry keeps the record on a true tie.
  return a.dateMs - b.dateMs;
}

function isWellFormedEntry(value: unknown): value is LeaderboardEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<LeaderboardEntry>;
  // matchTimeMs is required. Entries without one — either persisted before
  // the field existed, or constructed by hand without it — are filtered out
  // here; getLeaderboard() re-persists the cleaned list so they don't
  // resurface on subsequent reads.
  const matchTimeOk =
    typeof entry.matchTimeMs === 'number' &&
    Number.isFinite(entry.matchTimeMs) &&
    entry.matchTimeMs >= 0;
  return (
    typeof entry.name === 'string' &&
    typeof entry.score === 'number' &&
    Number.isFinite(entry.score) &&
    typeof entry.dateMs === 'number' &&
    Number.isFinite(entry.dateMs) &&
    (entry.result === 'victory' || entry.result === 'defeat') &&
    matchTimeOk
  );
}
