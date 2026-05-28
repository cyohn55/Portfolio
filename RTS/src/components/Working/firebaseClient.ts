// Firebase initialization for the global leaderboard.
//
// Single responsibility: stand up exactly one Firebase app + Firestore handle
// for the whole client and hand it out. No leaderboard logic lives here — see
// leaderboardRemote.ts for the read/write orchestration and leaderboard.ts for
// the pure scoring/validation domain code.
//
// Design notes:
//   * The config below is NOT a secret. A Firebase web "apiKey" is a public
//     project identifier, not a credential — it is meant to ship in client
//     bundles. All access control is enforced by Firestore security rules
//     (see firestore.rules), never by hiding this key.
//   * Initialization is wrapped so a misconfigured / blocked / offline Firebase
//     can never throw at import time. getDb() returns null in that case and
//     every caller is expected to fall back to the local cache, so the game
//     "always works" even when the backend is unreachable.
//   * Analytics is deliberately omitted. getAnalytics() requires a measurement
//     environment that is routinely blocked inside the portfolio's <iframe>
//     embed, and the leaderboard does not need it — pulling it in would add a
//     failure mode for zero benefit.

import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getFirestore, type Firestore } from 'firebase/firestore';

// Public project configuration. Safe to commit (see header note).
const firebaseConfig = {
  apiKey: 'AIzaSyDqGyOhBkM5aj3O-ROjpaHMlUmizQBKBiA',
  authDomain: 'rts-leader-board.firebaseapp.com',
  projectId: 'rts-leader-board',
  storageBucket: 'rts-leader-board.firebasestorage.app',
  messagingSenderId: '852018506583',
  appId: '1:852018506583:web:2452256a982a5f52b52c12',
  measurementId: 'G-XLH1B9S4ZM',
} as const;

// Lazily memoized singletons. We init on first request rather than at module
// load so that simply importing this file (e.g. from a unit test that only
// wants the leaderboard math) never reaches out to Firebase.
let cachedApp: FirebaseApp | null = null;
let cachedDb: Firestore | null = null;
let initFailed = false;

/**
 * Return the shared Firestore instance, or null if Firebase could not be
 * initialized in this environment. Callers MUST treat null as "backend
 * unavailable" and fall back to the local cache rather than assuming a handle.
 *
 * The first failure is sticky (initFailed) so we don't re-attempt — and
 * re-log — a hopeless init on every leaderboard read.
 */
export function getDb(): Firestore | null {
  if (cachedDb) return cachedDb;
  if (initFailed) return null;

  try {
    cachedApp = initializeApp(firebaseConfig);
    cachedDb = getFirestore(cachedApp);
    return cachedDb;
  } catch (error) {
    initFailed = true;
    // Non-fatal: the leaderboard degrades to the local cache. Log once so the
    // condition is diagnosable without spamming the console.
    console.warn('[leaderboard] Firebase unavailable; using local cache only.', error);
    return null;
  }
}

// The Firestore collection that holds every submitted score. Centralized here
// so the remote layer and the security-rules documentation reference one name.
export const SCORES_COLLECTION = 'scores';
