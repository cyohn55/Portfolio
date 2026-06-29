// Worker-offload Phase 1 (P1-2) — the MAIN-THREAD bridge to the simulation worker.
//
// This is the live counterpart to the headless simWorkerHost: it owns the Worker, posts the
// serializable requests (start / command / runTicks) and ingests the snapshots the worker
// posts back into `useGameStore`, which under the flip is a read-only mirror the UI renders
// from. The whole worker path is GATED behind an opt-in flag (default OFF) so the in-thread
// loop stays the working default — flip it on to verify in-browser:
//   localStorage.setItem('rtsSimWorker', '1')   // persists across reloads
//   window.__rtsUseSimWorker = true             // this session only
//
// The flag is read once per match start (in the match-start listener); thereafter the loop
// checks the cheap `isSimWorkerStarted()` boolean, stable for the match's duration.

import {
  ingestSimSnapshot,
  syncLocalPilotMirror,
  syncLocalSelectionMirror,
  setSimWorkerSink,
  onSimMatchStart,
  getSimSnapshot,
  useUiStore,
} from '../../../game/state';
import { pathfinder } from '../pathfinder';
import { serializeTerrain } from './terrainOracle';
import { pilotInput } from '../monarchPilot';
import type { SimRequest, SimResponse } from './simProtocol';
import type { NetCommand, PlayerRole } from '../net/netMessages';
import type { LockstepCallbacks } from '../net/lockstep';
import type { WebRtcTransport } from '../net/webrtcTransport';
import type { AnimalId } from '../../../game/types';

let worker: Worker | null = null;
let started = false;
let pendingSinglePlayerStart = false;

// --- multiplayer state ---
// A multiplayer match waiting to be adopted into the worker once terrain is ready (mirror of
// the single-player pending start). Holds everything the worker + transport pump need.
interface PendingNetMatch {
  role: PlayerRole;
  seed: number;
  lineups: Record<PlayerRole, AnimalId[]>;
  transport: WebRtcTransport;
  callbacks: LockstepCallbacks;
}
let pendingNetMatch: PendingNetMatch | null = null;
let netStarted = false;
let netCallbacks: LockstepCallbacks | null = null;
// The live WebRTC transport for the running worker match (peer sends go here). Held for the
// match's duration so netSend can forward to it after the pending start has been consumed.
let activeNetTransport: WebRtcTransport | null = null;
// Detach the main-thread transport pump (peer messages → worker, status → worker) on teardown.
let transportDetachers: Array<() => void> = [];

/** Read the opt-in flag fresh (localStorage persists; window.__rtsUseSimWorker is per-session). */
export function isWorkerFlagEnabled(): boolean {
  try {
    if (typeof window !== 'undefined' && (window as { __rtsUseSimWorker?: boolean }).__rtsUseSimWorker === true) {
      return true;
    }
    if (typeof localStorage !== 'undefined' && localStorage.getItem('rtsSimWorker') === '1') {
      return true;
    }
  } catch {
    // localStorage can throw in locked-down contexts; treat as disabled.
  }
  return false;
}

/** Lazily construct the worker and wire snapshot ingest. Vite bundles sim.worker.ts via the
 * import.meta.url URL form. */
function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<SimResponse>) => {
      const message = event.data;
      if (!message) return;
      switch (message.kind) {
        case 'snapshot':
          // Refresh the mirror (decoding the structure-of-arrays units), then re-derive the
          // local pilot + selection mirrors from it (the heirs to the tick's old in-thread
          // writes) — exactly the post-tick passes the in-thread loop runs, now on snapshot
          // arrival.
          ingestSimSnapshot(message);
          syncLocalPilotMirror();
          syncLocalSelectionMirror();
          return;
        case 'netSend':
          // The in-worker lockstep engine wants a wire message transmitted to the peer; hand
          // it to the real WebRTC transport, which lives on the main thread.
          activeNetTransport?.send(message.message);
          return;
        case 'netCallback':
          deliverNetCallback(message);
          return;
      }
    };
  }
  return worker;
}

function post(request: SimRequest): void {
  ensureWorker().postMessage(request);
}

/** True once a worker match has been started (the loop drives the worker instead of ticking). */
export function isSimWorkerStarted(): boolean {
  return started;
}

/**
 * Start the worker single-player match if one is pending and terrain is ready. Called from
 * HexGrid's loop, which owns terrain construction — so this waits until the pathfinder grid
 * exists (serializeTerrain reads it) before adopting the match into the worker. Returns true
 * the frame it starts the worker (so the caller can skip banking ticks that frame).
 */
export function beginSinglePlayerIfPending(): boolean {
  if (!pendingSinglePlayerStart || !pathfinder.isReady()) return false;
  pendingSinglePlayerStart = false;

  const terrain = serializeTerrain();
  const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
  const localLineup = useUiStore.getState().selectedAnimalPool;

  // From now, sim commands route to the worker instead of mutating the main-thread mirror.
  setSimWorkerSink((command) => postCommand(command));
  started = true;
  post({ kind: 'start', mode: 'single', seed, terrain, localLineup });
  return true;
}

/** Advance the worker sim by `count` fixed timesteps (one runTicks per animation frame). */
export function runWorkerTicks(count: number, nowMs: number): void {
  if (started && count > 0) post({ kind: 'runTicks', count, nowMs });
}

/** Forward a sim command to the worker (installed as the dispatchCommand sink). In single-
 * player the worker pure-applies it; in multiplayer it is scheduled on the in-worker engine. */
export function postCommand(command: NetCommand): void {
  if (started || netStarted) post({ kind: 'command', command });
}

/** Tear down the worker single-player match: stop driving it and restore in-thread commands. */
export function stopSimWorker(): void {
  started = false;
  pendingSinglePlayerStart = false;
  if (!netStarted) setSimWorkerSink(null);
}

// --- multiplayer ---------------------------------------------------------------------

/**
 * Latch a multiplayer match to be adopted into the worker once terrain is ready. Called by
 * netMatch.startNetMatch under the flag instead of building an in-thread engine. The actual
 * worker start is deferred to beginNetMatchIfPending (terrain — serializeTerrain — only
 * exists after HexGrid builds it).
 */
export function requestNetMatchStart(match: PendingNetMatch): void {
  pendingNetMatch = match;
  netCallbacks = match.callbacks;
}

/**
 * Start the worker multiplayer match if one is pending and terrain is ready (mirror of
 * beginSinglePlayerIfPending). Stands up the main-thread transport pump — decoded peer
 * messages + status forwarded to the worker engine, its sends already routed back via the
 * onmessage netSend case — then posts startNetMatch. Returns true the frame it starts.
 */
export function beginNetMatchIfPending(): boolean {
  if (!pendingNetMatch || !pathfinder.isReady()) return false;
  const { role, seed, lineups, transport } = pendingNetMatch;
  pendingNetMatch = null;

  activeNetTransport = transport;
  transportDetachers = [
    transport.addMessageListener((message) => post({ kind: 'netRecv', message })),
    transport.addStatusListener((status) => post({ kind: 'netStatus', status })),
  ];

  setSimWorkerSink((command) => postCommand(command));
  netStarted = true;
  post({ kind: 'startNetMatch', localRole: role, seed, lineups, terrain: serializeTerrain() });
  return true;
}

/** Drive the in-worker engine one frame, shipping the local pilot vector sampled main-thread. */
export function runNetUpdate(dtMs: number): void {
  if (netStarted) post({ kind: 'netUpdate', dtMs, pilot: pilotInput.getMove() });
}

/** Tear down the worker multiplayer match + transport pump; restore in-thread commands. */
export function stopNetMatchInWorker(): void {
  if (netStarted) post({ kind: 'stopNetMatch' });
  transportDetachers.forEach((detach) => detach());
  transportDetachers = [];
  activeNetTransport = null;
  netCallbacks = null;
  netStarted = false;
  pendingNetMatch = null;
  if (!started) setSimWorkerSink(null);
}

/** Surface an in-worker engine callback (stall/desync/disconnect) to the match's callbacks. */
function deliverNetCallback(message: { event: string; stalled?: boolean; tick?: number }): void {
  if (!netCallbacks) return;
  if (message.event === 'stall') netCallbacks.onStallChange?.(message.stalled ?? false);
  else if (message.event === 'desync') netCallbacks.onDesync?.(message.tick ?? 0);
  else if (message.event === 'disconnect') netCallbacks.onDisconnect?.();
}

// Latch a pending single-player worker start whenever a single-player match begins under the
// flag. The main-thread startMatch (lobby / Play Again) fires this; the worker then adopts
// the match once HexGrid reports terrain ready. Multiplayer is handled separately (P1-3).
onSimMatchStart(() => {
  if (isWorkerFlagEnabled() && getSimSnapshot().netMode === 'single') {
    pendingSinglePlayerStart = true;
  }
});
