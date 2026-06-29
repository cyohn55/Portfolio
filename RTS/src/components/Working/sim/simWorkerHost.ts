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
  dispatchCommand,
  computeStateChecksum,
} from '../../../game/state';
import { SIM_SNAPSHOT_FIELDS, type SimRequest, type SimSnapshot } from './simProtocol';

// Re-export the sim store so the P1-2 determinism harness can resolve the SAME singleton
// the host drives (a separate import would be a different instance). Worker/main code uses
// the host's request API, not this — it exists for the headless test seam.
export { useGameStore } from '../../../game/state';

// The simulation's fixed timestep (seconds). Matches FIXED_TIMESTEP/1000 in HexGrid's loop
// and the DT every determinism harness uses, so a message-driven run reproduces them.
export const SIM_FIXED_DT_SEC = 1 / 60;

/**
 * Apply one request to the authoritative simulation. Pure forwarding to the store's
 * existing deterministic actions, so a sequence of requests produces byte-identical state
 * to the same sequence issued in-thread:
 *  - `start`    → startMultiplayerMatch (seed + lineups fully determine the opening).
 *  - `command`  → dispatchCommand (no command router is installed worker-side, so it
 *                 pure-applies as the local owner — exactly the single-player path).
 *  - `runTicks` → advance N fixed timesteps via the store's tick.
 */
export function processSimRequest(request: SimRequest): void {
  switch (request.kind) {
    case 'start':
      useGameStore.getState().startMultiplayerMatch({
        localRole: request.localRole,
        seed: request.seed,
        lineups: request.lineups,
      });
      return;
    case 'command':
      dispatchCommand(request.command);
      return;
    case 'runTicks':
      for (let i = 0; i < request.count; i++) {
        useGameStore.getState().tick(SIM_FIXED_DT_SEC, request.nowMs);
      }
      return;
  }
}

/**
 * Snapshot the authoritative sim into the serializable Bucket-A slice the main-thread
 * mirror ingests. Picks SIM_SNAPSHOT_FIELDS by name (so the worker-internal machinery —
 * the RNG, the spatial grid, the per-tick caches — never crosses the wire) and stamps it
 * with the current checksum + tick for desync detection and snapshot ordering. The values
 * are referenced as-is (not deep-cloned here): `postMessage`'s structured clone copies
 * them across the worker boundary, and the Node harness clones explicitly to prove the
 * slice is structured-cloneable.
 */
export function buildSimSnapshot(): SimSnapshot {
  const state = useGameStore.getState() as unknown as Record<string, unknown>;
  const snapshotState = {} as SimSnapshot['state'];
  for (const field of SIM_SNAPSHOT_FIELDS) {
    snapshotState[field] = state[field];
  }
  return {
    kind: 'snapshot',
    tickCounter: useGameStore.getState().tickCounter,
    checksum: computeStateChecksum(),
    state: snapshotState,
  };
}
