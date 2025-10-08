import { useMemo } from 'react';
import { useGameStore } from '../../game/state';
import './Minimap.css';

export function Minimap() {
  const units = useGameStore((s) => s.units);
  const localPlayerId = useGameStore((s) => s.localPlayerId);

  // Map bounds (adjust based on your actual map size)
  const MAP_MIN_X = -100;
  const MAP_MAX_X = 100;
  const MAP_MIN_Z = -300;
  const MAP_MAX_Z = 300;

  const MINIMAP_SIZE = 180;

  // Convert world coordinates to minimap coordinates
  const worldToMinimap = (x: number, z: number) => {
    const normalizedX = (x - MAP_MIN_X) / (MAP_MAX_X - MAP_MIN_X);
    const normalizedZ = (z - MAP_MIN_Z) / (MAP_MAX_Z - MAP_MIN_Z);

    return {
      x: normalizedX * MINIMAP_SIZE,
      y: normalizedZ * MINIMAP_SIZE
    };
  };

  const minimapUnits = useMemo(() => {
    return units.map(unit => {
      const pos = worldToMinimap(unit.position.x, unit.position.z);
      const isPlayer = unit.ownerId === localPlayerId;
      const isImportant = unit.kind === 'Base' || unit.kind === 'Queen' || unit.kind === 'King';

      return {
        id: unit.id,
        x: pos.x,
        y: pos.y,
        isPlayer,
        isImportant,
        kind: unit.kind
      };
    });
  }, [units, localPlayerId]);

  return (
    <div className="minimap-container">
      <div className="minimap">
        {/* Center line indicators */}
        <div className="minimap-center-line horizontal" />
        <div className="minimap-center-line vertical" />

        {/* Units */}
        {minimapUnits.map((unit) => (
          <div
            key={unit.id}
            className={`minimap-unit ${unit.isPlayer ? 'player' : 'enemy'} ${unit.isImportant ? 'important' : ''} ${unit.kind.toLowerCase()}`}
            style={{
              left: `${unit.x}px`,
              top: `${unit.y}px`,
            }}
          />
        ))}
      </div>
      <div className="minimap-label">MAP</div>
    </div>
  );
}
