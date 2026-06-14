// The opponent pool a training candidate must do well against.
//
// Single responsibility: name the reference opponents and how to build a fresh
// one. Kept in its own module because BOTH the trainer (`train.mjs`, sequential
// path) and the evaluation worker (`evalWorker.mjs`, parallel path) must agree on
// exactly the same opponents — a policy factory cannot be sent across the worker
// boundary, so each side builds opponents from this shared registry by name.
//
// Each entry is a factory so a fresh opponent is built per match. The self-mirror
// (the current trained commander) forces a candidate to beat a competent macro
// opponent, not just passive/rush.

import { makePassivePolicy, makeRushPolicy, makeCommanderPolicy } from './policies.mjs';

export const OPPONENT_POOL = [
  { name: 'passive', make: () => makePassivePolicy() },
  { name: 'rush', make: () => makeRushPolicy() },
  { name: 'mirror', make: () => makeCommanderPolicy() },
];

/** Build a fresh opponent policy by pool name; throws on an unknown name. */
export function makeOpponentByName(name) {
  const entry = OPPONENT_POOL.find((opponent) => opponent.name === name);
  if (!entry) throw new Error(`Unknown opponent: ${name}`);
  return entry.make();
}
