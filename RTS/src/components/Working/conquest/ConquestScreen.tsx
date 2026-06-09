// The Conquest match screen: the 3D planet plus its HUD overlays.
//
// Single responsibility: host the WebGL canvas (nebula skybox + lighting + globe)
// and the 2D HUD (commander roster, tile inspector, capture banner, win/lose
// overlay, back control) for the Conquest mode. Game logic lives in the store and
// the geometry/biome/combat modules; this is the composition root that wires them
// to the screen.

import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { Suspense, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useGameStore } from '../../../game/state';
import { useConquestStore, effectiveController } from './conquestState';
import { BIOMES } from './conquestBiomes';
import {
  countOwnedFarmTiles,
  populationCap,
  planetPopulationCeiling,
} from './conquestGrowth';
import { ConquestGlobe } from './ConquestGlobe';
import './ConquestScreen.css';

/** The human player's controller id (index 0 of the roster). */
const HUMAN_ID = 'p0';

// The skybox is centered on the camera each frame and rendered behind everything,
// so its only real constraint is fitting inside the camera's far plane (100). The
// source asset ships an 8192×4096 (2:1) equirectangular panorama, which maps
// cleanly onto an inverted sphere's default UVs — far more robust than scaling the
// enormous source gltf, whose authored transforms made runtime fitting fragile.
const SKYBOX_RADIUS = 50;
const SKYBOX_TEXTURE_PATH =
  `${import.meta.env.BASE_URL}models/nebula_skybox/textures/Material.001_baseColor.jpeg`;

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

        {/* Lighting rig: a hemisphere fill plus a warm key and a cool rim so the
            planet reads with depth against the nebula instead of a flat disc. */}
        <ambientLight intensity={0.55} />
        <hemisphereLight color={0xbcd4ff} groundColor={0x0b1020} intensity={0.7} />
        <directionalLight position={[6, 5, 4]} intensity={1.6} color={0xfff4e0} />
        <directionalLight position={[-6, -2, -5]} intensity={0.5} color={0x6f9bff} />

        <Suspense fallback={null}>
          <NebulaSkybox />
        </Suspense>
        <Suspense fallback={null}>
          <ConquestGlobe />
        </Suspense>
      </Canvas>

      <button className="conquest-screen-back" onClick={handleBack}>
        ← New Planet
      </button>

      <PlayerRosterPanel />
      <TileInspectorPanel />
      <CaptureBanner />
      <OutcomeOverlay onPlayAgain={handleBack} />

      <div className="conquest-screen-hint">
        Move keys drive · A switch King/Queen · Scroll zoom · Left-click / drag-box
        select your units · Right-click to move (or an enemy to attack) · Shift +
        right-click sets a selected Queen's rally · Both mouse buttons fire your army's
        ability · Stand on grassland to claim it; each owned field lets your Queens grow
        +2 units · King (gold aura) buffs damage, Queen (green aura) heals · Down a
        rival's King AND Queen to capture their whole army
      </div>
    </div>
  );
}

/**
 * Nebula backdrop wrapping the planet: the equirectangular panorama painted on the
 * inside of a large sphere, locked to the camera each frame so it reads as an
 * infinitely distant sky. A `meshBasicMaterial` makes it self-lit (independent of
 * the scene lights), and disabling depth writes keeps it behind everything.
 */
function NebulaSkybox() {
  const texture = useLoader(THREE.TextureLoader, SKYBOX_TEXTURE_PATH);
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
  }, [texture]);

  useFrame(({ camera }) => {
    meshRef.current?.position.copy(camera.position);
  });

  return (
    <mesh ref={meshRef} renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[SKYBOX_RADIUS, 64, 40]} />
      <meshBasicMaterial map={texture} side={THREE.BackSide} depthWrite={false} fog={false} />
    </mesh>
  );
}

/** Lists every commander, their team color, territory, and capture status. */
function PlayerRosterPanel() {
  const players = useConquestStore((s) => s.players);
  const tileOwners = useConquestStore((s) => s.tileOwners);
  const biomes = useConquestStore((s) => s.biomes);
  const armyController = useConquestStore((s) => s.armyController);
  const controlledUnitCounts = useConquestStore((s) => s.controlledUnitCounts);

  const tileCountByPlayer = new Map<string, number>();
  for (const ownerId of Object.values(tileOwners)) {
    tileCountByPlayer.set(ownerId, (tileCountByPlayer.get(ownerId) ?? 0) + 1);
  }

  // Your nation's standing forces against its territory-derived population cap (two
  // units per owned farmable tile), with the planet's total farmland as the ceiling.
  const yourForces = controlledUnitCounts[HUMAN_ID] ?? 0;
  const yourCap = populationCap(countOwnedFarmTiles(tileOwners, biomes, HUMAN_ID));
  const planetCeiling = planetPopulationCeiling(biomes);

  return (
    <div className="conquest-roster">
      <h3 className="conquest-panel-heading">Commanders</h3>
      <div className="conquest-roster-forces">
        <span>Your forces</span>
        <span>{yourForces} / {yourCap}<span className="conquest-roster-ceiling"> (max {planetCeiling})</span></span>
      </div>
      {players.map((player) => {
        const controller = effectiveController(armyController, player.id);
        const isYours = controller === 'p0';
        const isCaptured = controller !== player.id;
        return (
          <div
            key={player.id}
            className={`conquest-roster-row ${isCaptured ? 'conquest-roster-row-captured' : ''}`}
          >
            <span
              className="conquest-color-swatch"
              style={{ background: `#${player.color.toString(16).padStart(6, '0')}` }}
            />
            <span className="conquest-roster-name">{player.name}</span>
            {isCaptured && (
              <span className="conquest-roster-badge">
                {isYours ? '⚔ yours' : 'fallen'}
              </span>
            )}
            <span className="conquest-roster-territory">
              {tileCountByPlayer.get(player.id) ?? 0} 🚩
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A transient banner announcing the most recent army capture. */
function CaptureBanner() {
  const lastCapture = useConquestStore((s) => s.lastCapture);
  const players = useConquestStore((s) => s.players);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!lastCapture) return;
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 3500);
    return () => window.clearTimeout(timer);
  }, [lastCapture]);

  if (!lastCapture || !visible) return null;

  const conqueror = players.find((p) => p.id === lastCapture.conquerorId);
  const defeated = players.find((p) => p.id === lastCapture.defeatedId);
  const message = lastCapture.conquerorId === 'p0'
    ? `You captured the ${defeated?.name ?? 'rival'} army — their king & queen serve you now!`
    : `${conqueror?.name ?? 'A rival'} captured the ${defeated?.name ?? 'rival'} army.`;

  return <div className="conquest-capture-banner">⚔ {message}</div>;
}

/** Full-screen victory / defeat overlay shown when the match resolves. */
function OutcomeOverlay({ onPlayAgain }: { onPlayAgain: () => void }) {
  const outcome = useConquestStore((s) => s.outcome);
  if (outcome === 'playing') return null;

  const isVictory = outcome === 'victory';
  return (
    <div className="conquest-outcome-overlay">
      <div className={`conquest-outcome-card ${isVictory ? 'victory' : 'defeat'}`}>
        <h2 className="conquest-outcome-title">{isVictory ? 'Planet Conquered' : 'Defeated'}</h2>
        <p className="conquest-outcome-text">
          {isVictory
            ? 'Every rival monarch now answers to you. The planet is yours.'
            : 'Your last monarch has fallen and your armies serve another.'}
        </p>
        <button className="conquest-outcome-button" onClick={onPlayAgain}>
          New Planet
        </button>
      </div>
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
