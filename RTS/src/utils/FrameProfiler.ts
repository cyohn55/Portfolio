// Opt-in per-frame timing breakdown, for deciding where (if anywhere) parallelism would pay
// off. Buckets the frame into the work that actually costs time — sim advance, snapshot
// ingest, mirror derivation, visuals, and (under the worker flip) the worker's own tick time —
// so a real run shows whether the bottleneck is the simulation, the boundary, or rendering.
//
// Enable in a browser session (works in production builds too, unlike the DEV-only perf log):
//   window.__rtsFrameProfile = true
// It then logs a table every ~2s and stashes the latest numbers on window.__rtsFrameStats.
// Disabled by default and near-zero cost when off (a single boolean check per record call).
//
// A/B for the worker flip: capture with the flag OFF (sim shows up under `advance` on the
// main thread), then with it ON (`advance` collapses to the postMessage cost while `workerSim`
// + `ingest` appear) — the delta is exactly what moved off the main thread.

interface Bucket {
  sum: number;
  peak: number;
}

const REPORT_INTERVAL_MS = 2000;

class FrameProfiler {
  private readonly buckets = new Map<string, Bucket>();
  private frames = 0;
  private windowStartMs = now();

  /** Opt-in via window flag; safe (and false) off the main thread / in non-browser contexts. */
  isEnabled(): boolean {
    return typeof window !== 'undefined' && (window as { __rtsFrameProfile?: boolean }).__rtsFrameProfile === true;
  }

  /** Record a timed span (ms) for a bucket. Cheap no-op when profiling is off. */
  add(bucket: string, ms: number): void {
    if (!this.isEnabled()) return;
    const existing = this.buckets.get(bucket);
    if (existing) {
      existing.sum += ms;
      if (ms > existing.peak) existing.peak = ms;
    } else {
      this.buckets.set(bucket, { sum: ms, peak: ms });
    }
  }

  /** Time a synchronous block into a bucket and return its result. */
  measure<T>(bucket: string, fn: () => T): T {
    if (!this.isEnabled()) return fn();
    const start = now();
    const result = fn();
    this.add(bucket, now() - start);
    return result;
  }

  /**
   * Close out one rendered frame, given the wall-clock interval since the previous frame.
   * Flushes a report every REPORT_INTERVAL_MS. Call once per animation frame.
   */
  endFrame(frameIntervalMs: number): void {
    if (!this.isEnabled()) {
      if (this.frames > 0) this.reset(); // shed any stale window when toggled off
      return;
    }
    this.add('interval', frameIntervalMs);
    this.frames++;
    if (now() - this.windowStartMs >= REPORT_INTERVAL_MS) this.flush();
  }

  private flush(): void {
    const elapsedMs = now() - this.windowStartMs;
    const frames = this.frames || 1;
    const avgIntervalMs = (this.buckets.get('interval')?.sum ?? 0) / frames || 1;

    const table: Record<string, { avgMs: string; peakMs: string; pctOfFrame: string }> = {};
    for (const [name, bucket] of this.buckets) {
      if (name === 'interval') continue;
      const avg = bucket.sum / frames;
      table[name] = {
        avgMs: avg.toFixed(3),
        peakMs: bucket.peak.toFixed(3),
        pctOfFrame: `${((avg / avgIntervalMs) * 100).toFixed(0)}%`,
      };
    }

    const fps = frames / (elapsedMs / 1000);
    const stats = {
      fps: Number(fps.toFixed(1)),
      avgFrameMs: Number(avgIntervalMs.toFixed(3)),
      frames,
      windowMs: Math.round(elapsedMs),
      buckets: table,
    };
    (window as { __rtsFrameStats?: unknown }).__rtsFrameStats = stats;

    console.log(`⏱️ Frame profile — ${fps.toFixed(1)} fps, ${avgIntervalMs.toFixed(2)} ms/frame (${frames} frames). %ofFrame is share of the ${avgIntervalMs.toFixed(1)}ms wall frame; sum of main-thread rows + render/idle = 100%. workerSim runs off-thread (may overlap).`);
    // eslint-disable-next-line no-console
    console.table(table);

    this.reset();
  }

  private reset(): void {
    this.buckets.clear();
    this.frames = 0;
    this.windowStartMs = now();
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export const frameProfiler = new FrameProfiler();
