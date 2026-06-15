// Human-game replay ingest for the self-play harness.
//
// A recorded single-player game (see src/components/Working/ai/replayRecorder.ts) is
// `{ seed, lineups, frames: [{ tick, owner, command }], outcome }`. Because the sim is
// deterministic lockstep, replaying both sides' recorded command streams from the same
// seed + lineups re-simulates the game EXACTLY — `resimulateReplay` asserts that.
//
// Two uses:
//   * `makeReplayPolicy(replay, role)` turns a recorded side into a drop-in opponent
//     (it satisfies the same `decide({ tick })` interface as every other policy), so a
//     real human can be added to the eval pool — a "human gauntlet".
//   * `resimulateReplay` re-plays both sides and checks the recorded outcome reproduced
//     (a lossless determinism check, and validation that capture was faithful).
//
// LIMITATION — open loop: a replayed human emits the commands they issued in the
// ORIGINAL game. Used as an opponent against a DIFFERENT AI, those commands are no
// longer reactions to the live game (the human "plays back" a fixed script). So the
// human gauntlet measures whether the AI withstands realistic human strategy/timing/
// aggression, NOT live closed-loop human reactions. It is a hardening signal and a
// strategy bank, not a proof of "beats humans". True closed-loop measurement is online.

import { readFileSync } from 'node:fs';
import { runMatch } from './selfPlay.mjs';

/** Normalize a replay from a file path, JSON string, or already-parsed object. */
export function loadReplay(source) {
  if (typeof source === 'object' && source !== null) return source;
  const text = typeof source === 'string' && source.trim().startsWith('{') ? source : readFileSync(source, 'utf8');
  return JSON.parse(text);
}

/**
 * A policy that re-emits the commands `role` issued in the recording. The recorder
 * stamps a command with `tickCounter` at issue time (T ticks already executed); the
 * harness applies a policy's commands at `decide({ tick })` BEFORE the tick that takes
 * the counter from tick-1 to tick — so a frame stamped T is emitted at tick = T + 1,
 * i.e. `byStamp.get(tick - 1)`. This reproduces the original apply ordering.
 */
export function makeReplayPolicy(replay, role) {
  const byStamp = new Map();
  for (const frame of replay.frames) {
    if (frame.owner !== role) continue;
    const list = byStamp.get(frame.tick);
    if (list) list.push(frame.command);
    else byStamp.set(frame.tick, [frame.command]);
  }
  return {
    name: `replay:${role}`,
    decide: ({ tick }) => byStamp.get(tick - 1) ?? [],
  };
}

/** A recorded HUMAN side as an opponent for `evaluate` (note the open-loop caveat above). */
export function makeReplayOpponent(replay, humanRole) {
  return () => makeReplayPolicy(replay, humanRole);
}

/**
 * Re-simulate a recorded game by replaying BOTH sides and return the outcome plus
 * whether it matched what was recorded. A small tick buffer past the recorded length
 * covers the deciding tick. `matches` true means the capture was faithful and the sim
 * is reproducing it exactly.
 */
export function resimulateReplay({ api, replay, tickBuffer = 120 }) {
  const maxTicks = (replay.outcome?.ticks ?? replay.frames.at(-1)?.tick ?? 0) + tickBuffer;
  const outcome = runMatch({
    api,
    seed: replay.seed,
    lineups: replay.lineups,
    subjectPolicy: makeReplayPolicy(replay, 'p0'),
    opponentPolicy: makeReplayPolicy(replay, 'p1'),
    maxTicks,
  });
  const recorded = replay.outcome ?? {};
  const matches = outcome.winner === (recorded.winner ?? null) && outcome.gameOver === (recorded.gameOver ?? outcome.gameOver);
  return { outcome, recorded, matches };
}
