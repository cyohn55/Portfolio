// The Conquest match screen: the 3D planet plus its HUD overlays.
//
// Single responsibility: host the WebGL canvas (lighting + globe) and the 2D HUD
// (player roster, tile inspector, back control) for the Conquest mode. Game
// logic lives in the store and the geometry/biome modules; this is the
// composition root that wires them to the screen.

import { Canvas } from '@react-three/fiber';
import { Suspense } from 'react';
import { useGameStore } from '../../../game/state';
import { useConquestStore } from './conquestState';
import { BIOMES } from './conquestBiomes';
import { ConquestGlobe } from './ConquestGlobe';
import './ConquestScreen.css';

export function ConquestScreen() {
  const transitionToScreen = useGameStore((s) => s.transitionToScreen);
  const reset = useConquestStore((s) => s.reset);

  const handleBack = () => {
    reset();
    transitionToScreen('conquestLobby');
  };

  return (
    <div className="conquest-screen">
      <Canvas
        camera={{ fov: 45, position: [0, 0, 3.2], near: 0.01, far: 100 }}
        onContextMenu={(event) => event.preventDefault()}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
      >
        <color attach="background" args={[0x05070f]} />
        <ambientLight intensity={0.45} />
        <directionalLight position={[5, 4, 5]} intensity={1.4} />
        <directionalLight position={[-5, -3, -4]} intensity={0.4} color={0x4f8cff} />
        <Suspense fallback={null}>
          <ConquestGlobe />
        </Suspense>
      </Canvas>

      <button className="conquest-screen-back" onClick={handleBack}>
        ← New Planet
      </button>

      <PlayerRosterPanel />
      <TileInspectorPanel />

      <div className="conquest-screen-hint">
        Drag to orbit · Scroll to zoom · Click a tile to inspect
      </div>
    </div>
  );
}

/** Lists every player with their team color and home node. */
function PlayerRosterPanel() {
  const players = useConquestStore((s) => s.players);
  const tileOwners = useConquestStore((s) => s.tileOwners);

  const tileCountByPlayer = new Map<string, number>();
  for (const ownerId of Object.values(tileOwners)) {
    tileCountByPlayer.set(ownerId, (tileCountByPlayer.get(ownerId) ?? 0) + 1);
  }

  return (
    <div className="conquest-roster">
      <h3 className="conquest-panel-heading">Commanders</h3>
      {players.map((player) => (
        <div key={player.id} className="conquest-roster-row">
          <span
            className="conquest-color-swatch"
            style={{ background: `#${player.color.toString(16).padStart(6, '0')}` }}
          />
          <span className="conquest-roster-name">{player.name}</span>
          <span className="conquest-roster-territory">
            {tileCountByPlayer.get(player.id) ?? 0} 🚩
          </span>
        </div>
      ))}
    </div>
  );
}

/** Shows the biome + ownership of the currently selected tile. */
function TileInspectorPanel() {
  const world = useConquestStore((s) => s.world);
  const biomes = useConquestStore((s) => s.biomes);
  const players = useConquestStore((s) => s.players);
  const tileOwners = useConquestStore((s) => s.tileOwners);
  const selectedTileId = useConquestStore((s) => s.selectedTileId);

  if (selectedTileId === null || !world) return null;
  const tile = world.tiles[selectedTileId];
  const tileBiome = biomes[selectedTileId];
  if (!tile || !tileBiome) return null;

  const biomeDef = BIOMES[tileBiome.biome];
  const ownerId = tileOwners[selectedTileId];
  const owner = ownerId ? players.find((p) => p.id === ownerId) : undefined;

  const passable = Array.from(biomeDef.passableBy).join(', ');

  return (
    <div className="conquest-inspector">
      <h3 className="conquest-panel-heading">Tile #{tile.id}</h3>
      <div className="conquest-inspector-row">
        <span>Biome</span>
        <span style={{ color: `#${biomeDef.color.toString(16).padStart(6, '0')}` }}>
          {biomeDef.label}
        </span>
      </div>
      <div className="conquest-inspector-row">
        <span>Type</span>
        <span>{tile.sides === 5 ? 'Pentagon (spawn)' : 'Hexagon'}</span>
      </div>
      <div className="conquest-inspector-row">
        <span>Owner</span>
        <span>{owner ? owner.name : 'Unclaimed'}</span>
      </div>
      <div className="conquest-inspector-row">
        <span>Farmable</span>
        <span>{biomeDef.farmable ? 'Yes (grows units)' : 'No'}</span>
      </div>
      <div className="conquest-inspector-row">
        <span>Passable by</span>
        <span>{biomeDef.claimable ? passable : 'Impassable'}</span>
      </div>
      <div className="conquest-inspector-row">
        <span>Elevation</span>
        <span>{(tileBiome.elevation * 100).toFixed(0)}%</span>
      </div>
      <div className="conquest-inspector-row">
        <span>Neighbors</span>
        <span>{tile.neighbors.length}</span>
      </div>
    </div>
  );
}
