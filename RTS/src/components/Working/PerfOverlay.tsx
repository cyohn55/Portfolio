// On-screen frame-timing overlay — a no-console way to read the FrameProfiler buckets while
// playing, on the deployed build. Toggle with Ctrl+Shift+P or the ?profile=1 URL param.
//
// The overlay's visibility drives the profiler (visible ⟺ collecting), and it polls the
// latest flushed numbers (window.__rtsFrameStats, refreshed ~every 2s) for a stable readout.
// "Copy" puts the full JSON on the clipboard so a run can be pasted back for analysis.
//
// For the worker-flip A/B: open with ?profile=1 (worker OFF — the sim shows under `advance`),
// then ?simworker=1&profile=1 (worker ON — `advance` collapses and `workerSim` + `ingest`
// appear). The difference is exactly what moved off the main thread.
//
// Inline styles only (no class names) to avoid the global-CSS class-collision trap.

import { useEffect, useState, type CSSProperties } from 'react';

interface BucketRow {
  avgMs: string;
  peakMs: string;
  pctOfFrame: string;
}
interface FrameStats {
  fps: number;
  avgFrameMs: number;
  frames: number;
  windowMs: number;
  buckets: Record<string, BucketRow>;
}

type ProfileWindow = { __rtsFrameProfile?: boolean; __rtsFrameStats?: FrameStats };
const profileWindow = (): ProfileWindow => window as unknown as ProfileWindow;

// Buckets that represent the worker path, highlighted so the off-thread split is obvious.
const WORKER_BUCKETS = new Set(['workerSim', 'ingest']);

export function PerfOverlay() {
  const [visible, setVisible] = useState<boolean>(() => profileWindow().__rtsFrameProfile === true);
  const [stats, setStats] = useState<FrameStats | null>(null);

  // Ctrl+Shift+P toggles the overlay (and, via the effect below, the profiler with it).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && (event.key === 'P' || event.key === 'p')) {
        event.preventDefault();
        setVisible((shown) => !shown);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Visibility drives collection; while shown, poll the latest flushed stats for display.
  useEffect(() => {
    profileWindow().__rtsFrameProfile = visible;
    if (!visible) {
      setStats(null);
      return;
    }
    const poll = setInterval(() => setStats(profileWindow().__rtsFrameStats ?? null), 500);
    return () => clearInterval(poll);
  }, [visible]);

  if (!visible) return null;

  const copy = () => {
    const current = profileWindow().__rtsFrameStats;
    if (current) navigator.clipboard?.writeText(JSON.stringify(current, null, 2)).catch(() => undefined);
  };

  return (
    <div style={PANEL}>
      <div style={HEADER}>
        <span>⏱️ Frame profile</span>
        <button style={BUTTON} onClick={copy}>Copy</button>
      </div>
      {!stats ? (
        <div style={DIM}>collecting… (~2s)</div>
      ) : (
        <>
          <div style={ROW}><span>fps</span><b>{stats.fps.toFixed(1)}</b></div>
          <div style={ROW}><span>ms / frame</span><b>{stats.avgFrameMs.toFixed(2)}</b></div>
          <div style={DIVIDER} />
          {Object.entries(stats.buckets).map(([name, bucket]) => (
            <div key={name} style={ROW}>
              <span style={WORKER_BUCKETS.has(name) ? HOT : undefined}>{name}</span>
              <span>{bucket.avgMs} ms · {bucket.pctOfFrame}</span>
            </div>
          ))}
          <div style={DIVIDER} />
          <div style={DIM}>render/idle ≈ (ms/frame) − frame − ingest</div>
        </>
      )}
      <div style={DIM}>Ctrl+Shift+P to toggle</div>
    </div>
  );
}

const PANEL: CSSProperties = {
  position: 'fixed',
  top: 8,
  right: 8,
  zIndex: 2000,
  minWidth: 190,
  padding: '8px 10px',
  background: 'rgba(12, 16, 28, 0.86)',
  color: '#e7ecf5',
  font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
  borderRadius: 8,
  border: '1px solid rgba(120, 150, 200, 0.35)',
  pointerEvents: 'auto',
  userSelect: 'text',
};
const HEADER: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 6,
  fontWeight: 700,
};
const ROW: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12 };
const DIVIDER: CSSProperties = { height: 1, background: 'rgba(120,150,200,0.25)', margin: '5px 0' };
const DIM: CSSProperties = { opacity: 0.6, fontSize: 11, marginTop: 4 };
const HOT: CSSProperties = { color: '#7fd1ff', fontWeight: 700 };
const BUTTON: CSSProperties = {
  font: 'inherit',
  color: '#cfe0ff',
  background: 'rgba(90, 130, 200, 0.25)',
  border: '1px solid rgba(120,150,200,0.4)',
  borderRadius: 5,
  padding: '1px 7px',
  cursor: 'pointer',
};
