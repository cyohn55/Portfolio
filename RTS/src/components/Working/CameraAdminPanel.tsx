import { useEffect, useRef, useState } from 'react';
import {
  useUiSettingsStore,
  DEFAULT_CAMERA_SETTINGS,
  type CameraSettings,
} from '../../game/uiSettingsStore';
import { cameraRuntime } from './cameraTuning';

/**
 * In-game admin panel (toggle with Ctrl+Shift+C) for experimenting with the
 * camera's point of view on the fly. Every control writes straight into the live
 * camera-settings store, which the CameraController reads each frame, so
 * adjustments are visible immediately without a reload.
 *
 * The toggle deliberately avoids F5 so it can ship in the deployed build without
 * hijacking the browser's reload key for portfolio visitors — F5 keeps working
 * as a normal refresh for everyone. Backtick (`) is accepted as an alternate
 * toggle for browsers that reserve Ctrl+Shift+C for their element inspector.
 *
 * Styling is fully inline to stay clear of the global stylesheet (Vite
 * concatenates every component's CSS, so generic class names leak between
 * components — see the project's CSS-collision notes).
 */

// One tunable row's metadata. Keeping the slider config declarative (rather than
// hand-writing a dozen near-identical rows) keeps the panel a single source of
// truth that mirrors the store's CameraSettings shape.
interface SliderSpec {
  key: keyof CameraSettings;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
}

interface PanelSection {
  title: string;
  sliders: SliderSpec[];
}

// Grouped by what the player is actually experimenting with, most-impactful first.
const PANEL_SECTIONS: PanelSection[] = [
  {
    title: 'Point of View',
    sliders: [
      { key: 'tiltDegrees', label: 'Tilt (pitch)', min: 1, max: 89, step: 1, unit: '°' },
      { key: 'yawDegrees', label: 'Yaw (rotate)', min: -180, max: 180, step: 1, unit: '°' },
      { key: 'fov', label: 'Field of view', min: 15, max: 100, step: 1, unit: '°' },
    ],
  },
  {
    title: 'Zoom',
    sliders: [
      { key: 'minDistance', label: 'Min distance', min: 10, max: 300, step: 5 },
      { key: 'maxDistance', label: 'Max distance', min: 20, max: 600, step: 5 },
      { key: 'zoomSpeed', label: 'Zoom speed', min: 0.5, max: 20, step: 0.5 },
    ],
  },
  {
    title: 'Pan feel',
    sliders: [
      { key: 'moveSpeed', label: 'Pan speed', min: 0.1, max: 6, step: 0.1 },
      { key: 'edgePanMargin', label: 'Edge-pan band', min: 0, max: 80, step: 2, unit: 'px' },
      { key: 'dragPanSensitivity', label: 'Drag sensitivity', min: 0.1, max: 3, step: 0.1 },
    ],
  },
  {
    title: 'Follow framing',
    sliders: [
      { key: 'followSpeed', label: 'Follow easing', min: 0.1, max: 6, step: 0.1 },
      { key: 'followScreenBias', label: 'Troop screen bias', min: 0, max: 1, step: 0.01 },
      { key: 'monarchScreenBias', label: 'Monarch screen bias', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: 'Opening shot',
    sliders: [
      { key: 'initialDistance', label: 'Start distance', min: 20, max: 400, step: 5 },
      { key: 'initialFocusDepth', label: 'Start focus depth', min: 0, max: 400, step: 5 },
    ],
  },
];

// Format a value for the readout: integers stay integers, fractional knobs show
// two decimals so a 0.01-step bias slider doesn't render as "0".
function formatValue(value: number, step: number): string {
  return step < 1 ? value.toFixed(2) : String(Math.round(value));
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'fixed',
    top: 16,
    right: 16,
    width: 300,
    maxHeight: 'calc(100vh - 32px)',
    overflowY: 'auto',
    background: 'rgba(14, 18, 32, 0.92)',
    border: '1px solid rgba(120, 160, 255, 0.35)',
    borderRadius: 10,
    padding: '14px 16px',
    color: '#e6ecff',
    font: '12px/1.4 system-ui, sans-serif',
    zIndex: 2000,
    boxShadow: '0 8px 28px rgba(0, 0, 0, 0.45)',
    backdropFilter: 'blur(4px)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  title: { margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: 0.3 },
  hint: { margin: '0 0 10px', fontSize: 10, color: '#8aa0d0' },
  closeButton: {
    background: 'transparent',
    border: 'none',
    color: '#8aa0d0',
    fontSize: 16,
    lineHeight: 1,
    cursor: 'pointer',
    padding: 2,
  },
  sectionTitle: {
    margin: '12px 0 6px',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    color: '#7f9bff',
  },
  row: { marginBottom: 9 },
  rowHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: 2 },
  rowValue: { color: '#9fe0ff', fontVariantNumeric: 'tabular-nums' },
  slider: { width: '100%', accentColor: '#5b8cff', cursor: 'pointer' },
  resetButton: {
    width: '100%',
    marginTop: 12,
    padding: '7px 0',
    background: 'rgba(91, 140, 255, 0.18)',
    border: '1px solid rgba(120, 160, 255, 0.4)',
    borderRadius: 6,
    color: '#e6ecff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
};

export function CameraAdminPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const cameraSettings = useUiSettingsStore((s) => s.cameraSettings);
  const updateCameraSettings = useUiSettingsStore((s) => s.updateCameraSettings);
  const resetCameraSettings = useUiSettingsStore((s) => s.resetCameraSettings);

  // The live zoom distance lives in a CameraController ref (the wheel mutates it
  // every frame), so it's read through the cameraRuntime bridge rather than the
  // store. Poll it while the panel is open so the readout/slider track the wheel.
  const [liveDistance, setLiveDistance] = useState<number | null>(null);
  const rafRef = useRef<number | null>(null);

  // Ctrl+Shift+C (or backtick as a fallback) toggles the panel. Using event.code
  // keeps the match keyboard-layout independent. Avoiding F5 means the browser's
  // reload key stays untouched for ordinary visitors on the live site.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isChord = event.ctrlKey && event.shiftKey && event.code === 'KeyC';
      const isBacktick = event.code === 'Backquote' && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (!isChord && !isBacktick) return;
      event.preventDefault();
      setIsOpen((open) => !open);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const poll = () => {
      setLiveDistance(cameraRuntime.getDistance());
      rafRef.current = requestAnimationFrame(poll);
    };
    rafRef.current = requestAnimationFrame(poll);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <h2 style={styles.title}>Camera Admin</h2>
        <button style={styles.closeButton} onClick={() => setIsOpen(false)} aria-label="Close camera admin panel">
          ✕
        </button>
      </div>
      <p style={styles.hint}>Ctrl+Shift+C or ` to toggle · changes apply live</p>

      {/* Live zoom: reads/sets the active CameraController distance directly. */}
      <p style={styles.sectionTitle}>Live zoom</p>
      <div style={styles.row}>
        <div style={styles.rowHeader}>
          <span>Current distance</span>
          <span style={styles.rowValue}>
            {liveDistance !== null ? Math.round(liveDistance) : '—'}
          </span>
        </div>
        <input
          type="range"
          style={styles.slider}
          min={cameraSettings.minDistance}
          max={cameraSettings.maxDistance}
          step={1}
          value={liveDistance ?? cameraSettings.initialDistance}
          disabled={liveDistance === null}
          onChange={(event) => {
            const next = Number(event.target.value);
            cameraRuntime.setDistance(next);
            setLiveDistance(next);
          }}
        />
      </div>

      {PANEL_SECTIONS.map((section) => (
        <div key={section.title}>
          <p style={styles.sectionTitle}>{section.title}</p>
          {section.sliders.map((spec) => {
            const value = cameraSettings[spec.key];
            return (
              <div key={spec.key} style={styles.row}>
                <div style={styles.rowHeader}>
                  <span>{spec.label}</span>
                  <span style={styles.rowValue}>
                    {formatValue(value, spec.step)}
                    {spec.unit ?? ''}
                  </span>
                </div>
                <input
                  type="range"
                  style={styles.slider}
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  value={value}
                  onChange={(event) =>
                    updateCameraSettings({ [spec.key]: Number(event.target.value) })
                  }
                />
              </div>
            );
          })}
        </div>
      ))}

      <button
        style={styles.resetButton}
        onClick={() => {
          resetCameraSettings();
          cameraRuntime.setDistance(DEFAULT_CAMERA_SETTINGS.initialDistance);
        }}
      >
        Reset to defaults
      </button>
    </div>
  );
}
