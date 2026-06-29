// URL-param toggles for the worker-flip + frame profiler, so they can be driven without the
// DevTools console — handy for profiling on the deployed build. Parsed once at boot (App).
//
//   ?simworker=1  → run the simulation in the worker for this load (worker flip ON)
//   ?profile=1    → show the on-screen frame-timing overlay (FrameProfiler) and start collecting
//   ?shadows=0    → disable the Canvas shadow pass for this load (render-cost A/B)
//
// All accept =0/=false to force OFF and =1/=true to force ON. Params are NOT stripped from the
// URL — they persist across reloads, which the A/B runs need (the worker flip + shadows are
// read at match/Canvas mount, so the recommended workflow is to reload between runs).

export function applyDevFlagsFromUrl(search: string): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(search);
  const isTruthy = (value: string | null) => value === '1' || value === 'true';
  const flags = window as { __rtsUseSimWorker?: boolean; __rtsFrameProfile?: boolean; __rtsShadows?: boolean };

  // Worker flip: window flag is session-scoped; isWorkerFlagEnabled (simWorkerBridge) reads it.
  if (params.has('simworker')) flags.__rtsUseSimWorker = isTruthy(params.get('simworker'));
  // Frame profiler: PerfOverlay shows when this is set; FrameProfiler collects while it is true.
  if (params.has('profile')) flags.__rtsFrameProfile = isTruthy(params.get('profile'));
  // Shadow pass: App reads this for the Canvas `shadows` prop (default ON). ?shadows=0 isolates
  // shadow render cost — if fps jumps with it off, shadows are the dominant render cost.
  if (params.has('shadows')) flags.__rtsShadows = isTruthy(params.get('shadows'));
}
