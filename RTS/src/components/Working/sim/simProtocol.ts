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

// --- Main thread → worker -------------------------------------------------------------

/** Start (or restart) a deterministic match. Mirrors `startMultiplayerMatch`'s inputs —
 * the lineups + seed fully determine the opening on every peer, so the worker needs no
 * main-thread state to build the initial units. */
export interface SimStartRequest {
  kind: 'start';
  localRole: PlayerRole;
  seed: number;
  lineups: Record<PlayerRole, AnimalId[]>;
}

/** Apply one already-attributed player/AI/lockstep command to the sim. In single-player
 * the worker pure-applies it (no command router is installed worker-side). */
export interface SimCommandRequest {
  kind: 'command';
  command: NetCommand;
}

/** Advance the simulation by `count` fixed timesteps. `nowMs` is a wall clock the sim
 * overrides with its own deterministic tick-derived clock, so it only satisfies the
 * `tick` signature and never affects the outcome. */
export interface SimRunTicksRequest {
  kind: 'runTicks';
  count: number;
  nowMs: number;
}

export type SimRequest = SimStartRequest | SimCommandRequest | SimRunTicksRequest;

// --- Worker → main thread -------------------------------------------------------------

/** The plain-data slice of the authoritative sim the UI renders from — Bucket-A minus the
 * worker-internal machinery that must never cross the wire (the RNG and spatial grid are
 * class instances; the per-tick caches/timers are sim-private). Every field here is
 * structured-cloneable, so the worker can `postMessage` it directly. The main thread
 * ingests this wholesale into the `useGameStore` mirror (see ingestSimSnapshot). */
export const SIM_SNAPSHOT_FIELDS = [
  'config',
  'players',
  'units',
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
}

export type SimResponse = SimSnapshot;
