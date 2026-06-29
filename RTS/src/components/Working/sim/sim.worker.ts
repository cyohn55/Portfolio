// Worker-offload Phase 1 (P1-2) — the simulation Web Worker entry. Intentionally thin:
// it owns no logic, only the message plumbing. All behaviour lives in simWorkerHost.ts so
// a Node harness can verify the exact request → snapshot path in-thread (a real Worker
// can't run under the determinism harness). Loaded by the main thread via
// `new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' })`.
//
// NOTE: not yet wired into the live game — P1-2 builds and verifies the worker pipeline
// additively first; flipping HexGrid's loop + dispatchCommand onto it is the final step.

import { processSimRequest, buildSimSnapshot, setSimOutbound } from './simWorkerHost';
import type { SimRequest } from './simProtocol';

// The dedicated-worker global. Typed minimally so this file needs no "webworker" lib in
// the project tsconfig (the host carries all the real types).
declare const self: {
  onmessage: ((event: { data: SimRequest }) => void) | null;
  postMessage: (message: unknown) => void;
};

// Let the host initiate worker→main messages mid-processing (the in-worker lockstep engine's
// transport sends + its stall/desync/disconnect callbacks), not just the per-request snapshot.
setSimOutbound((message) => self.postMessage(message));

self.onmessage = (event) => {
  const request = event.data;
  processSimRequest(request);
  // Publish a fresh snapshot after any state-advancing request. Commands that arrive
  // between ticks still post (cheap, and the main-thread mirror stays current for
  // input-read-back); the dominant case is one snapshot per `runTicks` / `netUpdate` frame.
  self.postMessage(buildSimSnapshot());
};
