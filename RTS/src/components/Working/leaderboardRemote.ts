// Global-leaderboard orchestration: reads and writes the shared Firestore
// `scores` collection, with the local cache as an always-available fallback.
//
// Responsibility split (low coupling, high cohesion):
//   * leaderboard.ts       — pure scoring/validation + localStorage cache.
//   * firebaseClient.ts    — the single Firestore handle (or null if offline).
//   * leaderboardRemote.ts — THIS file — turns "talk to the backend" into two
//                            async functions and guarantees they never reject:
//                            any failure degrades to the cache so the UI always
//                            has a list to render.
//
// Every public function returns a LeaderboardResult tagged with its `source`
// so the UI can tell the player when it's looking at the live global board vs.
// a cached copy (e.g. backend unreachable).

import {
  collection,
  getDocs,
  addDoc,
  query,
  orderBy,
  limit,
} from 'firebase/firestore';

import { getDb, SCORES_COLLECTION } from './firebaseClient';
import {
  cacheLeaderboard,
  compareEntries,
  isWellFormedEntry,
  getLeaderboard,
  addLeaderboardEntry,
  MAX_ENTRIES,
  type LeaderboardEntry,
} from './leaderboard';

// How many rows to pull from Firestore before client-side ranking. We over-fetch
// past MAX_ENTRIES because the server can only cheaply order by a single field
// (score, via the automatic index); the secondary tie-breaks (matchTimeMs, then
// dateMs) are applied client-side by compareEntries. Pulling the top FETCH_LIMIT
// by score guarantees the true top MAX_ENTRIES are present in the candidate set,
// since a tie-break can only reorder rows that already share a score.
const FETCH_LIMIT = 100;

// Hard ceiling on how long we'll wait for a single Firestore round-trip before
// giving up and falling back to the cache. The Firestore SDK retries some
// errors (e.g. an unprovisioned/disabled backend) indefinitely, which would
// otherwise leave the UI spinning forever — this guarantees a bounded wait so
// the leaderboard always resolves to *some* list.
const NETWORK_TIMEOUT_MS = 8_000;

/**
 * Resolve with the operation's result, or reject with a timeout error if it
 * hasn't settled within NETWORK_TIMEOUT_MS. Used to bound Firestore calls that
 * the SDK might otherwise retry without end.
 */
function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[leaderboard] ${label} timed out after ${NETWORK_TIMEOUT_MS}ms`)),
      NETWORK_TIMEOUT_MS,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Where the returned rows came from, so the UI can label a degraded state. */
export type LeaderboardSource = 'remote' | 'cache';

export interface LeaderboardResult {
  entries: LeaderboardEntry[];
  source: LeaderboardSource;
}

/**
 * Fetch the global top-{MAX_ENTRIES}. On success the authoritative list is
 * written through to the local cache (so a later offline load still shows the
 * last-seen global board) and returned with source 'remote'. On any failure —
 * Firebase uninitialized, network down, permission error — the local cache is
 * returned with source 'cache'. Never rejects.
 */
export async function fetchLeaderboard(): Promise<LeaderboardResult> {
  const db = getDb();
  if (!db) {
    return { entries: getLeaderboard(), source: 'cache' };
  }

  try {
    const scoresQuery = query(
      collection(db, SCORES_COLLECTION),
      orderBy('score', 'desc'),
      limit(FETCH_LIMIT),
    );
    const snapshot = await withTimeout(getDocs(scoresQuery), 'fetch');

    // Validate each document with the same gate the cache uses, then apply the
    // full ranking rule and trim. A malformed server row is dropped rather than
    // rendered.
    const entries = snapshot.docs
      .map((doc) => doc.data())
      .filter(isWellFormedEntry)
      .sort(compareEntries)
      .slice(0, MAX_ENTRIES);

    cacheLeaderboard(entries);
    return { entries, source: 'remote' };
  } catch (error) {
    console.warn('[leaderboard] fetch failed; serving cached board.', error);
    return { entries: getLeaderboard(), source: 'cache' };
  }
}

/**
 * Submit one score to the global board and return the refreshed list. On
 * success the entry is written to Firestore and the freshly re-fetched global
 * board is returned (source 'remote'). If the write fails the entry is still
 * recorded in the local cache and that list is returned (source 'cache'), so
 * the player always sees their score land somewhere and a later online session
 * shows the global standings. Never rejects.
 *
 * Caller is responsible for having validated the name (validateName) before
 * calling — the security rules enforce bounds server-side as a backstop, but
 * the friendly rejection message comes from the client-side validator.
 */
export async function submitScore(entry: LeaderboardEntry): Promise<LeaderboardResult> {
  const db = getDb();
  if (!db) {
    return { entries: addLeaderboardEntry(entry), source: 'cache' };
  }

  try {
    // Persist only the well-defined entry fields; never spread unknown extras
    // into the document (the security rules reject documents with extra keys).
    await withTimeout(
      addDoc(collection(db, SCORES_COLLECTION), {
        name: entry.name,
        score: entry.score,
        dateMs: entry.dateMs,
        result: entry.result,
        matchTimeMs: entry.matchTimeMs,
      }),
      'submit',
    );

    // Re-read so ranking reflects every other player's scores, not just ours.
    const refreshed = await fetchLeaderboard();
    if (refreshed.source === 'remote') return refreshed;

    // The write succeeded but the re-read fell back to cache (rare: transient
    // read error). Make sure our own entry is at least in the cache so the UI
    // reflects it, and report the degraded source honestly.
    return { entries: addLeaderboardEntry(entry), source: 'cache' };
  } catch (error) {
    console.warn('[leaderboard] submit failed; recording to local cache.', error);
    return { entries: addLeaderboardEntry(entry), source: 'cache' };
  }
}
