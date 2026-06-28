import { useGameStore } from '../game/state';

import { useUiSettingsStore } from "../game/uiSettingsStore";
import { performanceMonitor } from '../utils/PerformanceMonitor';
import { Minimap } from './screens/Minimap';
import { AnimalSelectionButtons } from './AnimalSelectionButtons';
import { PauseMenu } from './PauseMenu';
import { computeScore } from './Working/leaderboard';
import { FullscreenToggle } from './Working/FullscreenToggle';
import { useState, useEffect } from 'react';

/**
 * Format a millisecond match duration as "M:SS" (or "H:MM:SS" past the hour).
 * Mirrors the post-game card's formatter so the in-game timer and the final
 * card read identically when the match ends. Kept colocated with the HUD
 * because this is the only place that consumes a live duration.
 */
function formatMatchTime(matchTimeMs: number): string {
  if (!Number.isFinite(matchTimeMs) || matchTimeMs < 0) return '0:00';
  const totalSeconds = Math.floor(matchTimeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = seconds.toString().padStart(2, '0');
  if (hours > 0) {
    const mm = minutes.toString().padStart(2, '0');
    return `${hours}:${mm}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

export function HUD() {
  const matchStarted = useGameStore((s) => s.matchStarted);
  // `units` gets a fresh array reference at the end of every tick (state.ts
  // `set({ units: draft.units.slice() })`), so subscribing to it drives the
  // re-render that picks up the freshly mutated matchStats below. See
  // `rts-mutated-state-ui-trap` memory.
  const units = useGameStore((s) => s.units);
  const matchStats = useGameStore((s) => s.matchStats);
  const musicEnabled = useUiSettingsStore((s) => s.musicEnabled);
  const setMusicEnabled = useUiSettingsStore((s) => s.setMusicEnabled);
  const pilotedUnitId = useGameStore((s) => s.pilotedUnitId);

  // FPS monitoring state
  const [fps, setFps] = useState({ current: 0, average: 0, min: 0, max: 0 });

  // Pause menu state
  const [isPaused, setIsPaused] = useState(false);

  // Controller (Start) and the keyboard pause key dispatch 'rts:toggle-pause'
  // so the pause menu has a single mount point here, however it is opened.
  useEffect(() => {
    const handleTogglePause = () => setIsPaused((prev) => !prev);
    window.addEventListener('rts:toggle-pause', handleTogglePause);
    return () => window.removeEventListener('rts:toggle-pause', handleTogglePause);
  }, []);

  // Update FPS display every second
  useEffect(() => {
    const interval = setInterval(() => {
      setFps({
        current: performanceMonitor.updateFPS(),
        average: performanceMonitor.getAverageFPS(),
        min: performanceMonitor.getMinFPS(),
        max: performanceMonitor.getMaxFPS(),
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // The King/Queen the player is directly piloting, if any. The followers it has
  // rallied are this animal's army Units that carry its id in followMonarchId.
  const pilotedUnit = pilotedUnitId ? units.find(u => u.id === pilotedUnitId) ?? null : null;
  const rallyCount = pilotedUnit
    ? units.filter(u => u.followMonarchId === pilotedUnit.id).length
    : 0;

  // Live score using the same scoring contract the post-game screen uses, so
  // the in-game total matches what gets persisted to the leaderboard.
  const playerScore = computeScore(matchStats).total;
  const matchTimeDisplay = formatMatchTime(matchStats.matchDurationMs);

  return (
    <>
    {/* Pause Menu */}
    {isPaused && <PauseMenu onClose={() => setIsPaused(false)} />}

    {/* Top-left: Score + Match Time panel. */}
    {matchStarted && (
      <div style={{
        position: 'fixed',
        top: '20px',
        left: '20px',
        zIndex: 1000,
        pointerEvents: 'none',
        background: 'rgba(17,23,38,0.85)',
        border: '1px solid rgba(88,120,255,0.4)',
        borderRadius: '8px',
        padding: '12px 16px',
        backdropFilter: 'blur(10px)',
        fontFamily: 'monospace',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        fontSize: '12px',
        color: '#fff',
        minWidth: '140px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
          <span style={{ color: '#94a3b8' }}>Score:</span>
          <span style={{ color: '#facc15', fontWeight: 'bold', fontSize: '14px' }}>
            {playerScore}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
          <span style={{ color: '#94a3b8' }}>Time:</span>
          <span style={{ color: '#4ade80', fontWeight: 'bold', fontSize: '14px' }}>
            {matchTimeDisplay}
          </span>
        </div>
      </div>
    )}

    {/* Piloting indicator: shows which monarch is under direct control and the
        active rally count, plus the drive/rally hint. Sits just under the
        top-left Score/Time panel. */}
    {matchStarted && pilotedUnit && (
      <div style={{
        position: 'fixed',
        top: '92px',
        left: '20px',
        zIndex: 1000,
        pointerEvents: 'none',
        background: 'rgba(28,18,46,0.85)',
        border: '1px solid rgba(212,175,55,0.55)',
        borderRadius: '8px',
        padding: '10px 14px',
        backdropFilter: 'blur(10px)',
        fontFamily: 'monospace',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        fontSize: '12px',
        color: '#fff',
        minWidth: '140px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
          <span style={{ color: '#facc15', fontWeight: 'bold' }}>
            👑 Piloting
          </span>
          <span style={{ color: '#fde68a', fontWeight: 'bold' }}>
            {pilotedUnit.animal} {pilotedUnit.kind}
          </span>
        </div>
        <div style={{ color: '#94a3b8', fontSize: '10px' }}>
          ESDF: drive · A: switch · G: King/Queen · Space: rally + select{rallyCount > 0 ? ` (${rallyCount})` : ''} · 2×Space: all
        </div>
      </div>
    )}

    {/* Bottom-left: pause-menu gear + music toggle. Kept separate from the
        top-left Score/Time panel so the two clusters can live at independent
        screen edges. Bottom-right is the minimap and bottom-center is the
        animal-selection bar, so the bottom-left corner is the only open
        quadrant for these controls. */}
    {matchStarted && (
      <div style={{
        position: 'fixed',
        bottom: '20px',
        left: '20px',
        display: 'flex',
        flexDirection: 'row',
        gap: '8px',
        alignItems: 'center',
        zIndex: 1000,
      }}>
        {/* Pause-menu trigger using the ⚙️ glyph so it reads visually
            consistent with the speaker emoji beside it. */}
        <button
          type="button"
          aria-label="Open pause menu"
          onClick={() => setIsPaused(true)}
          style={{
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, rgba(88,120,255,0.9) 0%, rgba(118,75,162,0.9) 100%)',
            border: '2px solid rgba(255,255,255,0.3)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'transform 0.3s ease, box-shadow 0.3s ease',
            boxShadow: '0 4px 15px rgba(88,120,255,0.4)',
            backdropFilter: 'blur(10px)',
            fontSize: '24px',
            lineHeight: 1,
            padding: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.1) rotate(90deg)';
            e.currentTarget.style.boxShadow = '0 6px 20px rgba(88,120,255,0.6)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1) rotate(0deg)';
            e.currentTarget.style.boxShadow = '0 4px 15px rgba(88,120,255,0.4)';
          }}
        >
          <span role="img" aria-hidden="true">⚙️</span>
        </button>

        {/* Background-music toggle. 🔊 (U+1F50A) = on, 🔇 (U+1F507) = off.
            Persisted via the store so the choice survives reloads (see
            MUSIC_STORAGE_KEY in state.ts). */}
        <button
          type="button"
          role="switch"
          aria-checked={musicEnabled}
          aria-label={musicEnabled ? 'Mute background music' : 'Unmute background music'}
          onClick={() => setMusicEnabled(!musicEnabled)}
          style={{
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            background: musicEnabled
              ? 'linear-gradient(135deg, rgba(88,120,255,0.9) 0%, rgba(118,75,162,0.9) 100%)'
              : 'rgba(60,68,90,0.85)',
            border: '2px solid rgba(255,255,255,0.3)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'transform 0.3s ease, box-shadow 0.3s ease, background 0.3s ease',
            boxShadow: musicEnabled
              ? '0 4px 15px rgba(88,120,255,0.4)'
              : '0 4px 15px rgba(0,0,0,0.4)',
            backdropFilter: 'blur(10px)',
            fontSize: '22px',
            lineHeight: 1,
            padding: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
          }}
        >
          <span role="img" aria-hidden="true">{musicEnabled ? '🔊' : '🔇'}</span>
        </button>

        {/* Fullscreen toggle, sits to the right of the music button so the
            bottom-left cluster reads left-to-right: pause → music → fullscreen.
            Same component is used on the title screen (MainMenu.tsx) so the
            affordance is identical across the two screens. */}
        <FullscreenToggle />
      </div>
    )}

    {/* Top bar with FPS */}
    <div style={{
      position: 'fixed',
      top: '20px',
      right: '20px',
      display: 'flex',
      justifyContent: 'flex-end',
      alignItems: 'center',
      pointerEvents: 'none',
      zIndex: 1000
    }}>
      {/* FPS Counter */}
      <div style={{
        background: 'rgba(17,23,38,0.85)',
        border: '1px solid rgba(88,120,255,0.4)',
        borderRadius: '8px',
        padding: '12px 16px',
        backdropFilter: 'blur(10px)',
        fontFamily: 'monospace'
      }}>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          fontSize: '12px',
          color: '#fff'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
            <span style={{ color: '#94a3b8' }}>FPS:</span>
            <span style={{
              color: fps.average >= 50 ? '#4ade80' : fps.average >= 30 ? '#facc15' : '#f87171',
              fontWeight: 'bold',
              fontSize: '14px'
            }}>
              {fps.average.toFixed(0)}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '10px' }}>
            <span style={{ color: '#64748b' }}>Min: {fps.min.toFixed(0)}</span>
            <span style={{ color: '#64748b' }}>Max: {fps.max.toFixed(0)}</span>
          </div>
        </div>
      </div>
    </div>

    {/* Minimap */}
    <Minimap />

    {/* Animal Selection Buttons */}
    <AnimalSelectionButtons />
    </>
  );
}
