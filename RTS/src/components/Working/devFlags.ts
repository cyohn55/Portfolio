// URL-param toggles for the worker-flip + frame profiler, so they can be driven without the
// DevTools console — handy for profiling on the deployed build. Parsed once at boot (App).
//
//   ?simworker=1  → run the simulation in the worker for this load (worker flip ON)
//   ?profile=1    → show the on-screen frame-timing overlay (FrameProfiler) and start collecting
//
// Both also accept =0/=false to force OFF. Params are NOT stripped from the URL — they persist
// across reloads, which the worker A/B needs (the flip flag is read at match start, so the
// recommended workflow is to reload between the OFF and ON runs).

export function applyDevFlagsFromUrl(search: string): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(search);
  const isTruthy = (value: string | null) => value === '1' || value === 'true';
  const flags = window as { __rtsUseSimWorker?: boolean; __rtsFrameProfile?: boolean };

  // Worker flip: window flag is session-scoped; isWorkerFlagEnabled (simWorkerBridge) reads it.
  if (params.has('simworker')) flags.__rtsUseSimWorker = isTruthy(params.get('simworker'));
  // Frame profiler: PerfOverlay shows when this is set; FrameProfiler collects while it is true.
  if (params.has('profile')) flags.__rtsFrameProfile = isTruthy(params.get('profile'));
}
