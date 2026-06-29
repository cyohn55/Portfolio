// Worker-offload Phase 1 (P1-2) — the simulation host: the bridge that drives the
// `state.ts` sim from serializable requests and produces serializable snapshots. The Web
// Worker entry (sim.worker.ts) is a thin shell that pipes `self.onmessage` into
// `processSimRequest` and posts the result of `buildSimSnapshot`; everything testable
// lives HERE so a Node harness can exercise the exact same code path in-thread (no Worker
// or DOM required), which is how P1-2 is verified before the live loop is flipped.
//
// The host holds no state of its own: the authoritative simulation is the `useGameStore`
// singleton inside this module's copy of `state.ts`. In the worker that singleton is the
// one true sim; in a Node harness it is the harness's sim. Either way the host only
// forwards requests to the store's existing, already-deterministic actions.

import {
  useGameStore,
  useUiStore,
  dispatchCommand,
  computeStateChecksum,
  applyNetCommand,
  setCommandRouter,
} from '../../../game/state';
import { pathfinder } from '../pathfinder';
import { runAiCommanders } from '../ai/aiCommander';
import { LockstepEngine, type LockstepTransport } from '../net/lockstep';
import type { PlayerRole, NetCommand } from '../net/netMessages';
import { installTerrainOracle, type TerrainOracle } from './terrainOracle';
import { encodeUnits } from './snapshotCodec';
import { SIM_SNAPSHOT_FIELDS, type SimRequest, type SimSnapshot } from './simProtocol';

/**
 * Outbound channel for messages the host initiates mid-processing (the in-worker lockstep
 * engine's transport sends + its callbacks) rather than returning. The worker shell injects
 * `self.postMessage`; a Node harness injects a capturing function. Defaults to a no-op so the
 * single-player path (which never sends) needs no injection.
 */
type Outbound = (message: unknown) => void;
let outbound: Outbound = () => {};
export function setSimOutbound(fn: Outbound): void {
  outbound = fn;
}

// Re-export the sim store + snapshot ingest so the P1-2 determinism harness can resolve the
// SAME singleton the host drives (a separate import would be a different instance). Worker/
// main code uses the host's request API and the bridge's ingest, not these — they exist for
// the headless test seam.
export { useGameStore, ingestSimSnapshot } from '../../../game/state';
// Codec re-export for the headless snapshot harnesses (decode the SoA units the host encodes).
export { encodeUnits, decodeUnits } from './snapshotCodec';

// The simulation's fixed timestep (seconds). Matches FIXED_TIMESTEP/1000 in HexGrid's loop
// and the DT every determinism harness uses, so a message-driven run reproduces them.
export const SIM_FIXED_DT_SEC = 1 / 60;

// The grid-backed terrain installed for this match (null when the start request carried no
// terrain — the terrain-free determinism harnesses). When present, the host re-syncs its
// crossability from the sim's bridgeState each runTicks batch, exactly as the main thread
// feeds terrainValidator in HexGrid's updateBridgeVisibility.
let oracle: TerrainOracle | null = null;

/**
 * Worker-side stand-in for the WebRTC transport. The in-worker lockstep engine talks to this
 * exactly as it would the real transport; sends are posted to the main thread (which owns the
 * actual WebRTC channel), and decoded peer messages / status changes arriving from the main
 * thread are delivered to the engine's listeners. Pure plumbing — no protocol knowledge.
 */
class WorkerTransport implements LockstepTransport {
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly statusListeners = new Set<(status: string) => void>();

  send(message: unknown): boolean {
    outbound({ kind: 'netSend', message });
    return true;
  }
  addMessageListener(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }
  addStatusListener(listener: (status: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  deliverMessage(message: unknown): void {
    this.messageListeners.forEach((listener) => listener(message));
  }
  deliverStatus(status: string): void {
    this.statusListeners.forEach((listener) => listener(status));
  }
}

// The in-worker multiplayer engine + its proxy transport, or null in single-player / menus.
let netTransport: WorkerTransport | null = null;
let netEngine: LockstepEngine | null = null;
// The local player's per-frame monarch-drive vector, delivered by netUpdate and ridden onto
// each tick by the engine's adapter (the worker has no input devices of its own).
let localPilot = { x: 0, z: 0 };

// Profiling only: the worker-thread time the last advance (runTicks / netUpdate) spent in the
// sim, stamped onto the next snapshot (FrameProfiler's `workerSim`). Read-and-cleared by
// buildSimSnapshot so only post-advance snapshots report it. Never feeds the sim.
let lastSimMs = 0;

/**
 * Apply one request to the authoritative simulation, forwarding to the store's existing
 * deterministic actions so a sequence of requests produces byte-identical state to the same
 * sequence issued in-thread:
 *  - `start`    → installs the terrain (if any), then builds the match: single-player
 *                 (initializeGame + startMatch, an AI opponent) or multiplayer
 *                 (startMultiplayerMatch). Absent `mode` defaults to multiplayer, so the
 *                 determinism harness's { localRole, seed, lineups } start is unchanged.
 *  - `command`  → dispatchCommand (no command router worker-side in single-player, so it
 *                 pure-applies as the local owner — exactly the single-player path).
 *  - `runTicks` → sync the terrain's live crossability from the sim's bridgeState, then
 *                 advance N fixed timesteps, driving the AI opponent before each tick
 *                 (single-player only; runAiCommanders no-ops in multiplayer/lockstep).
 */
export function processSimRequest(request: SimRequest): void {
  switch (request.kind) {
    case 'start': {
      oracle = request.terrain ? installTerrainOracle(request.terrain) : null;
      if (request.mode === 'single') {
        // Reproduce the single-player lobby path: seed the local lineup, set up the AI
        // opponent + netMode 'single', then spawn the match with the shared seed.
        if (request.localLineup) {
          useUiStore.getState().chooseAnimalsForLocal(request.localLineup);
        }
        useGameStore.getState().initializeGame();
        useGameStore.getState().startMatch(true, request.seed);
      } else {
        useGameStore.getState().startMultiplayerMatch({
          localRole: request.localRole!,
          seed: request.seed,
          lineups: request.lineups!,
        });
      }
      return;
    }
    case 'command':
      dispatchCommand(request.command);
      return;
    case 'runTicks': {
      const simStart = performance.now();
      syncTerrainBridgeState();
      for (let i = 0; i < request.count; i++) {
        runAiCommanders();
        useGameStore.getState().tick(SIM_FIXED_DT_SEC, request.nowMs);
      }
      lastSimMs = performance.now() - simStart;
      return;
    }

    // --- multiplayer (worker-side lockstep) ---
    case 'startNetMatch': {
      oracle = request.terrain ? installTerrainOracle(request.terrain) : null;
      useGameStore.getState().startMultiplayerMatch({
        localRole: request.localRole,
        seed: request.seed,
        lineups: request.lineups,
      });
      startNetEngine(request.localRole);
      return;
    }
    case 'netUpdate': {
      localPilot = request.pilot;
      const simStart = performance.now();
      netEngine?.update(request.dtMs);
      lastSimMs = performance.now() - simStart;
      return;
    }
    case 'netRecv':
      netTransport?.deliverMessage(request.message);
      return;
    case 'netStatus':
      netTransport?.deliverStatus(request.status);
      return;
    case 'stopNetMatch':
      netEngine?.stop();
      setCommandRouter(null);
      netEngine = null;
      netTransport = null;
      return;
  }
}

/**
 * Stand up the in-worker lockstep engine on top of the just-built match. The adapter wires
 * the engine to the in-worker sim — identical to netMatch.ts's main-thread adapter — and the
 * command router schedules routed commands onto it. Engine callbacks are forwarded to the
 * main thread for the UI. The wall clock passed to tick is irrelevant (the sim overrides it).
 */
function startNetEngine(localRole: PlayerRole): void {
  netTransport = new WorkerTransport();
  netEngine = new LockstepEngine({
    transport: netTransport,
    localPlayerId: localRole,
    adapter: {
      applyCommand: (playerId: PlayerRole, command: NetCommand) => applyNetCommand(playerId, command),
      runTick: () => {
        syncTerrainBridgeState();
        useGameStore.getState().tick(SIM_FIXED_DT_SEC, performance.now());
      },
      checksum: () => computeStateChecksum(),
      sampleLocalPilot: () => localPilot,
    },
    callbacks: {
      onStallChange: (stalled) => outbound({ kind: 'netCallback', event: 'stall', stalled }),
      onDesync: (tick) => outbound({ kind: 'netCallback', event: 'desync', tick }),
      onDisconnect: () => outbound({ kind: 'netCallback', event: 'disconnect' }),
    },
  });
  setCommandRouter((command) => netEngine!.enqueueLocalCommand(command));
  netEngine.start();
}

/**
 * Re-derive the installed terrain's side-bridge crossability from the sim's own bridgeState
 * and invalidate cached A* paths on a change — the worker-side equivalent of HexGrid's
 * updateBridgeVisibility feeding terrainValidator + pathfinder.refresh(). No-op when no
 * terrain oracle is installed (terrain-free harness runs), keeping those byte-identical.
 */
function syncTerrainBridgeState(): void {
  if (!oracle) return;
  const { bridgeState } = useGameStore.getState();
  oracle.updateBridgeState({
    right: bridgeState.rightBridge.currentFrame,
    left: bridgeState.leftBridge.currentFrame,
  });
  pathfinder.refresh();
}

/**
 * Snapshot the authoritative sim into the serializable Bucket-A slice the main-thread
 * mirror ingests. Picks SIM_SNAPSHOT_FIELDS by name (so the worker-internal machinery —
 * the RNG, the spatial grid, the per-tick caches — never crosses the wire) and stamps it
 * with the current checksum + tick for desync detection and snapshot ordering. The values
 * are referenced as-is (not deep-cloned here): `postMessage`'s structured clone copies
 * them across the worker boundary, and the Node harness clones explicitly to prove the
 * slice is structured-cloneable.
 *
 * The heavy `units` array is encoded out-of-band (P1-4): hot numeric columns in a transferable
 * Float32Array + a lean cold object, via snapshotCodec. The worker shell transfers
 * `unitsHot.buffer` (zero-copy) when it posts this (see sim.worker.ts).
 */
export function buildSimSnapshot(): SimSnapshot {
  const liveState = useGameStore.getState();
  const state = liveState as unknown as Record<string, unknown>;
  const snapshotState = {} as SimSnapshot['state'];
  for (const field of SIM_SNAPSHOT_FIELDS) {
    snapshotState[field] = state[field];
  }
  const { hot, cold } = encodeUnits(liveState.units);
  const simMs = lastSimMs;
  lastSimMs = 0; // only the snapshot right after an advance reports a sim time
  return {
    kind: 'snapshot',
    tickCounter: liveState.tickCounter,
    checksum: computeStateChecksum(),
    state: snapshotState,
    unitsHot: hot,
    unitsCold: cold,
    simMs,
  };
}
