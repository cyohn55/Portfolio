// Worker-offload Phase 1 (P1-2) — the serializable message protocol between the main
// thread and the simulation worker, plus the snapshot shape the worker posts back.
//
// Architecture (Option B): the worker OWNS the authoritative simulation (the `state.ts`
// sim — tick + command handlers + Bucket-A state + the RNG/spatial-grid machinery). The
// main thread keeps `useGameStore` as a READ-ONLY mirror, refreshed each frame by
// ingesting the worker's snapshot. Writes go one way (main → worker) as serializable
// requests; reads come back one way (worker → main) as serializable snapshots. Nothing
// here imports React or a store, so it is safe to load in both the worker and Node.

import type { NetCommand, PlayerRole } from '../net/netMessages';
import type { AnimalId } from '../../../game/types';
import type { TerrainSnapshot } from './terrainOracle';
import type { ArenaBoundary } from '../arenaBoundary';
import type { UnitsHot } from './snapshotCodec';

// --- Main thread → worker -------------------------------------------------------------

/**
 * Start (or restart) a deterministic match inside the worker.
 *
 * `mode` selects the setup the worker reproduces:
 *  - 'single'      → the single-player path (initializeGame + startMatch): an AI opponent,
 *                    netMode 'single', the local lineup taken from `localLineup`. The worker
 *                    is the sole source of truth, so it mints the AI lineup itself and ships
 *                    `players` back in the snapshot.
 *  - 'multiplayer' → mirrors startMultiplayerMatch (both lineups + seed fully determine the
 *                    opening on every peer). The default, so the determinism harness — which
 *                    sends only { localRole, seed, lineups } — keeps its existing behaviour.
 *
 * `terrain` is the serialized nav/terrain the worker installs before building the match
 * (see terrainOracle). It is OPTIONAL: the headless harnesses run terrain-free (the sim
 * degrades to permissive terrain), the live game always sends it.
 *
 * `arenaBoundary` is the map-static off-map clamp (pure numbers, structured-cloneable) the
 * worker registers so `clampToArena` confines units inside the playable field — without it
 * the worker's module-level boundary stays null and units walk off the map. OPTIONAL for the
 * same reason as `terrain` (harnesses run boundary-free; the live game always sends it).
 */
export interface SimStartRequest {
  kind: 'start';
  mode?: 'single' | 'multiplayer';
  seed: number;
  terrain?: TerrainSnapshot;
  arenaBoundary?: ArenaBoundary | null;
  // Single-player: the local human's lobby lineup.
  localLineup?: AnimalId[];
  // Multiplayer (and the determinism harness): this peer's role + both lineups.
  localRole?: PlayerRole;
  lineups?: Record<PlayerRole, AnimalId[]>;
}

/** Apply one already-attributed player/AI/lockstep command to the sim. In single-player
 * the worker pure-applies it (no command router is installed worker-side). */
export interface SimCommandRequest {
  kind: 'command';
  command: NetCommand;
}

/** Advance the simulation by `count` fixed timesteps. `nowMs` is a wall clock the sim
 * overrides with its own deterministic tick-derived clock, so it only satisfies the
 * `tick` signature and never affects the outcome. `pilot` is the local player's live
 * monarch/fire-team-drive vector, sampled main-thread (pilotInput) and shipped each frame
 * so the single-player tick can read it — the worker has no input devices of its own, so
 * without this the worker's pilotInput stays zero and a piloted King/Queen/fire team can
 * be selected (camera follows) but never moves. Mirrors `netUpdate.pilot` for multiplayer. */
export interface SimRunTicksRequest {
  kind: 'runTicks';
  count: number;
  nowMs: number;
  pilot: { x: number; z: number };
}

// --- Multiplayer (worker-side lockstep) ----------------------------------------------
// In multiplayer the deterministic lockstep ENGINE runs in the worker alongside the sim
// (the engine↔sim loop must stay synchronous), while the WebRTC transport + signaling stay
// on the main thread. These messages proxy that transport across the boundary and drive the
// in-worker engine. The wire messages (`message`) are the already-decoded NetMessage objects
// the transport exchanges — plain and structured-cloneable — typed `unknown` here so this
// module needs no net-protocol import.

/** Build the multiplayer match in the worker AND stand up the in-worker lockstep engine
 * (seed + lineups determine the opening identically on both peers). */
export interface SimStartNetMatchRequest {
  kind: 'startNetMatch';
  localRole: PlayerRole;
  seed: number;
  lineups: Record<PlayerRole, AnimalId[]>;
  terrain?: TerrainSnapshot;
  arenaBoundary?: ArenaBoundary | null;
}

/** Drive the in-worker engine one animation frame. `pilot` is the local player's live
 * monarch-drive vector, sampled main-thread (pilotInput) and shipped each frame so the
 * engine's adapter can ride it onto the tick exactly as the in-thread engine does. */
export interface SimNetUpdateRequest {
  kind: 'netUpdate';
  dtMs: number;
  pilot: { x: number; z: number };
}

/** A decoded wire message that arrived from the peer (main-thread transport → worker engine). */
export interface SimNetRecvRequest {
  kind: 'netRecv';
  message: unknown;
}

/** A transport status change (main-thread transport → worker engine). */
export interface SimNetStatusRequest {
  kind: 'netStatus';
  status: string;
}

/** Tear down the in-worker engine + command router. */
export interface SimStopNetMatchRequest {
  kind: 'stopNetMatch';
}

export type SimRequest =
  | SimStartRequest
  | SimCommandRequest
  | SimRunTicksRequest
  | SimStartNetMatchRequest
  | SimNetUpdateRequest
  | SimNetRecvRequest
  | SimNetStatusRequest
  | SimStopNetMatchRequest;

// --- Worker → main thread -------------------------------------------------------------

/** The plain-data slice of the authoritative sim the UI renders from — Bucket-A minus the
 * worker-internal machinery that must never cross the wire (the RNG and spatial grid are
 * class instances; the per-tick caches/timers are sim-private). Every field here is
 * structured-cloneable, so the worker can `postMessage` it directly. The main thread
 * ingests this wholesale into the `useGameStore` mirror (see ingestSimSnapshot). */
// NOTE: `units` is NOT here — it is the heaviest field and crosses the boundary separately,
// structure-of-arrays encoded (hot columns transferred zero-copy + a lean cold object), see
// snapshotCodec + SimSnapshot.unitsHot/unitsCold. These are the remaining plain-clone fields.
export const SIM_SNAPSHOT_FIELDS = [
  'config',
  'players',
  'matchStarted',
  'matchStartNonce',
  'gameOver',
  'winner',
  'netMode',
  'matchStats',
  'projectiles',
  'fireTeams',
  'bridgeState',
  'movementHeldUnitId',
  'unitOrders',
  'queenPatrols',
  'queenRallyTargets',
  // Authoritative per-owner pilot state the main thread DERIVES the local UI mirror from
  // (syncLocalPilotMirror) — not the local-only pilotedUnitId/pilotedFireTeamId, which
  // are main-thread UI state on useUiStore.
  'pilotedUnitIdByOwner',
  'pilotMoveByOwner',
  'pilotedFireTeamByOwner',
  // The match clock the renderer reads for animation phases / cooldown bars.
  'tickCounter',
] as const;

export type SimSnapshotField = (typeof SIM_SNAPSHOT_FIELDS)[number];

/** A posted snapshot: the picked Bucket-A fields plus a checksum + tick for desync
 * detection and ordering. Typed loosely (the concrete field types live on the store's
 * GameState) so this module stays free of a store import. */
export interface SimSnapshot {
  kind: 'snapshot';
  tickCounter: number;
  checksum: string;
  // The SIM_SNAPSHOT_FIELDS, by name. Indexed access keeps this decoupled from GameState.
  state: Record<SimSnapshotField, unknown>;
  // The units, structure-of-arrays encoded (P1-4): `unitsHot.buffer` is TRANSFERRED across
  // the boundary (zero-copy); `unitsCold` carries the remaining per-unit fields. The main
  // thread reassembles full units via snapshotCodec.decodeUnits during ingest.
  unitsHot: UnitsHot;
  unitsCold: unknown[];
  // Profiling only (FrameProfiler): the worker-thread wall time the sim spent advancing for
  // this snapshot (tick batch / engine update). Never feeds the sim, so determinism is
  // unaffected. The main thread records it as the `workerSim` bucket.
  simMs?: number;
}

/** A wire message the in-worker engine wants transmitted to the peer (worker → main-thread
 * transport.send). `message` is a NetMessage object. */
export interface SimNetSend {
  kind: 'netSend';
  message: unknown;
}

/** A lockstep engine callback surfaced for the main-thread UI (stall/desync/disconnect). */
export interface SimNetCallback {
  kind: 'netCallback';
  event: 'stall' | 'desync' | 'disconnect';
  stalled?: boolean;
  tick?: number;
}

export type SimResponse = SimSnapshot | SimNetSend | SimNetCallback;
