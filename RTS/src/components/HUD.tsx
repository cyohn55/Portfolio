import { useGameStore } from '../game/state';
import { performanceMonitor } from '../utils/PerformanceMonitor';
import { Minimap } from './screens/Minimap';
import { AnimalSelectionButtons } from './AnimalSelectionButtons';
import { PauseMenu } from './PauseMenu';
import { useState, useEffect } from 'react';

export function HUD() {
  const matchStarted = useGameStore((s) => s.matchStarted);
  const selectedUnitIds = useGameStore((s) => s.selectedUnitIds);
  const units = useGameStore((s) => s.units);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const players = useGameStore((s) => s.players);
  const selectedAnimalPool = useGameStore((s) => s.selectedAnimalPool);

  // FPS monitoring state
  const [fps, setFps] = useState({ current: 0, average: 0, min: 0, max: 0 });

  // Pause menu state
  const [isPaused, setIsPaused] = useState(false);

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

  const selectedUnits = units.filter(u => selectedUnitIds.includes(u.id));

  // Count units by animal type for player
  const playerUnits = units.filter(u => u.ownerId === localPlayerId && u.kind === 'Unit');
  const unitCounts: Record<string, number> = {};
  selectedAnimalPool.forEach(animal => {
    unitCounts[animal] = playerUnits.filter(u => u.animal === animal).length;
  });

  return (
    <>
    {/* Pause Menu */}
    {isPaused && <PauseMenu onClose={() => setIsPaused(false)} />}

    {/* Settings Gear Icon - Bottom Left */}
    <button
      onClick={() => setIsPaused(true)}
      style={{
        position: 'fixed',
        bottom: '20px',
        left: '20px',
        width: '56px',
        height: '56px',
        borderRadius: '50%',
        background: 'linear-gradient(135deg, rgba(88,120,255,0.9) 0%, rgba(118,75,162,0.9) 100%)',
        border: '2px solid rgba(255,255,255,0.3)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'all 0.3s ease',
        zIndex: 1000,
        boxShadow: '0 4px 15px rgba(88,120,255,0.4)',
        backdropFilter: 'blur(10px)'
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
      {/* Gear Icon SVG */}
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v6m0 6v6m9-9h-6m-6 0H3" />
        <path d="M17.657 6.343l-4.243 4.243m0 3.536l4.243 4.243M6.343 6.343l4.243 4.243m3.536 0l4.243 4.243" />
      </svg>
    </button>

    {/* Top bar with unit counts and FPS */}
    <div style={{
      position: 'fixed',
      top: '20px',
      left: '20px',
      right: '20px',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      pointerEvents: 'none',
      zIndex: 1000
    }}>
      {/* Unit counter */}
      <div style={{
        background: 'rgba(17,23,38,0.85)',
        border: '1px solid rgba(88,120,255,0.4)',
        borderRadius: '8px',
        padding: '12px 16px',
        display: 'flex',
        gap: '16px',
        backdropFilter: 'blur(10px)'
      }}>
        {selectedAnimalPool.map(animal => (
          <div key={animal} style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            color: '#fff',
            fontSize: '14px',
            fontWeight: '600'
          }}>
            <span>{animal}:</span>
            <span style={{ color: '#4ade80' }}>{unitCounts[animal] || 0}</span>
          </div>
        ))}
      </div>

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

    {/* Compact Instructions Panel - only show when units are selected */}
    {matchStarted && selectedUnits.length > 0 && (
      <div style={{
        position: 'fixed',
        bottom: '160px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(17,23,38,0.8)',
        border: '1px solid rgba(88,120,255,0.3)',
        borderRadius: '6px',
        padding: '8px 16px',
        fontSize: '12px',
        color: 'rgba(255,255,255,0.8)',
        textAlign: 'center',
        pointerEvents: 'none',
        zIndex: 999
      }}>
        Selected: {selectedUnits.length} units - <strong>Click+drag: box select</strong> | <strong>Right click: move</strong>
      </div>
    )}
    </>
  );
}


