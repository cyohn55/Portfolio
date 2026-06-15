// Single-player replay recorder (local-only, opt-in).
//
// Captures a single-player match as `(seed, lineups, per-tick command stream)` so it
// can be re-simulated losslessly later (the sim is deterministic lockstep) and fed to
// the training harness as a human opponent / strategy bank. See the harness side in
// `Unit Tests/selfplay/replay.mjs`.
//
// PRIVACY: recording is OFF by default and must be started explicitly
// (`__rtsReplay.start()` in the dev console). Captured games are kept LOCAL — exported
// as a JSON download / stashed on `window` — and never uploaded. Sharing a replay would
// be a deliberate, separate act.
//
// Determinism: the recorder only OBSERVES (via the state.ts recorder seam); it never
// mutates the simulation, so an unrecorded and a recorded run of the same match are
// identical.

import { useGameStore, setCommandRecorder } from '../../../game/state';
import type { NetCommand } from '../net/netMessages';

const REPLAY_VERSION = 1;

interface ReplayFrame {
  tick: number;   // store.tickCounter when the command was issued (see replay.mjs mapping)
  owner: string;  // issuing player id (p0 / p1)
  command: NetCommand;
}

interface Replay {
  version: number;
  seed: number;
  lineups: Record<string, string[]>;
  localRole: string | null;
  frames: ReplayFrame[];
  // Recorded result, so a re-simulation can assert it reproduced the game exactly.
  outcome: { winner: string | null; gameOver: boolean; ticks: number };
}

let armed = false;            // user asked to record; the next match start begins capture
let active = false;           // currently capturing a match
let capturedNonce = -1;       // matchStartNonce of the match being captured (detects a new match)
let current: Replay | null = null;

/** Per-player animal lineup actually used this match (local uses the lobby selection). */
function captureLineups(state: ReturnType<typeof useGameStore.getState>): Record<string, string[]> {
  const lineups: Record<string, string[]> = {};
  for (const player of state.players) {
    lineups[player.id] =
      player.id === state.localPlayerId ? [...state.selectedAnimalPool] : [...player.animals];
  }
  return lineups;
}

/** The recorder sink installed into state.ts; appends one frame per issued command. */
function record(owner: string, command: NetCommand): void {
  if (!current) return;
  current.frames.push({ tick: useGameStore.getState().tickCounter, owner, command });
}

function beginCapture(state: ReturnType<typeof useGameStore.getState>): void {
  current = {
    version: REPLAY_VERSION,
    seed: state.matchSeed,
    lineups: captureLineups(state),
    localRole: state.localPlayerId,
    frames: [],
    outcome: { winner: null, gameOver: false, ticks: 0 },
  };
  capturedNonce = state.matchStartNonce;
  active = true;
  setCommandRecorder(record);
}

/** Finalize the in-progress capture, export it, and detach the recorder. */
function finishCapture(state: ReturnType<typeof useGameStore.getState>): Replay | null {
  setCommandRecorder(null);
  active = false;
  if (!current) return null;
  current.outcome = { winner: state.winner, gameOver: state.gameOver, ticks: state.tickCounter };
  const finished = current;
  current = null;
  exportReplay(finished);
  return finished;
}

/** Serialize a replay to a timestamped JSON download and stash it on `window`. */
function exportReplay(replay: Replay): void {
  const json = JSON.stringify(replay);
  (window as unknown as { __rtsReplayLast?: Replay }).__rtsReplayLast = replay;
  try {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `rts-replay-${replay.seed >>> 0}-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch {
    // Non-browser / download blocked: the replay is still on window.__rtsReplayLast.
  }
  console.log(`📼 Replay captured: ${replay.frames.length} commands, ${replay.outcome.ticks} ticks`);
}

/** Arm recording — the next single-player match start begins capturing. */
export function startReplayRecording(): void {
  armed = true;
  console.log('📼 Replay recording armed — start/continue a single-player match to capture.');
}

/** Stop recording; if a capture is in progress, finalize and export it. */
export function stopReplayRecording(): void {
  armed = false;
  if (active) finishCapture(useGameStore.getState());
}

/**
 * Drive the recorder once per frame (call from the single-player game loop). Detects
 * match start (begin capture) and match end / a new match (finalize + export). A
 * no-op unless recording is armed and we are in single-player.
 */
export function replayRecorderTick(): void {
  const state = useGameStore.getState();
  if (state.netMode !== 'single') return;

  if (active && (state.gameOver || state.matchStartNonce !== capturedNonce)) {
    finishCapture(state);
  }
  if (armed && !active && state.matchStarted && !state.gameOver) {
    beginCapture(state);
  }
}

// Dev handle so a tester can record without UI: `__rtsReplay.start()` / `.stop()`.
if (typeof window !== 'undefined') {
  (window as unknown as { __rtsReplay?: object }).__rtsReplay = {
    start: startReplayRecording,
    stop: stopReplayRecording,
  };
}
