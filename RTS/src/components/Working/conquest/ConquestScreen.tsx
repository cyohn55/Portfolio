// The Conquest match screen: the 3D planet plus its HUD overlays.
//
// Single responsibility: host the WebGL canvas (nebula skybox + lighting + globe)
// and the 2D HUD (commander roster, tile inspector, capture banner, win/lose
// overlay, back control) for the Conquest mode. Game logic lives in the store and
// the geometry/biome/combat modules; this is the composition root that wires them
// to the screen.

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { useGameStore } from '../../../game/state';
import { useConquestStore, effectiveController } from './conquestState';
import { BIOMES } from './conquestBiomes';
import { ConquestGlobe } from './ConquestGlobe';
import './ConquestScreen.css';

// The skybox is centered on the camera each frame and rendered behind everything,
// so its only real constraint is fitting inside the camera's far plane. We fit it
// to this radius at runtime from its bounding sphere (the source asset is ~800
// units across) so the value is independent of the model's authored scale.
const SKYBOX_RADIUS = 50;
const SKYBOX_PATH = `${import.meta.env.BASE_URL}models/nebula_skybox/scene.gltf`;

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
        Move keys drive · A switch army · Scroll zoom · March onto a rival army to
        battle — beat them and their king/queen join you · Click a tile to inspect
      </div>
    </div>
  );
}

/**
 * Nebula backdrop wrapping the planet. The source sphere is enormous, so we fit
 * it to SKYBOX_RADIUS from its measured bounding sphere, flip its faces inward,
 * and lock it to the camera each frame so it reads as an infinitely distant sky.
 */
function NebulaSkybox() {
  const gltf = useGLTF(SKYBOX_PATH);
  const groupRef = useRef<THREE.Group>(null);

  const { object, fitScale } = useMemo(() => {
    const clone = gltf.scene.clone(true);
    const boundingSphere = new THREE.Box3()
      .setFromObject(clone)
      .getBoundingSphere(new THREE.Sphere());
    const nativeRadius = boundingSphere.radius || 1;

    clone.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = (mesh.material as THREE.MeshStandardMaterial).clone();
      material.side = THREE.BackSide;   // we view the sphere from inside
      material.depthWrite = false;
      material.depthTest = false;       // always behind the scene
      material.fog = false;
      mesh.material = material;
      mesh.renderOrder = -1;
      mesh.frustumCulled = false;
    });

    return { object: clone, fitScale: SKYBOX_RADIUS / nativeRadius };
  }, [gltf]);

  useFrame(({ camera }) => {
    groupRef.current?.position.copy(camera.position);
  });

  return <primitive ref={groupRef} object={object} scale={fitScale} />;
}

useGLTF.preload(SKYBOX_PATH);

/** Lists every commander, their team color, territory, and capture status. */
function PlayerRosterPanel() {
  const players = useConquestStore((s) => s.players);
  const tileOwners = useConquestStore((s) => s.tileOwners);
  const armyController = useConquestStore((s) => s.armyController);

  const tileCountByPlayer = new Map<string, number>();
  for (const ownerId of Object.values(tileOwners)) {
    tileCountByPlayer.set(ownerId, (tileCountByPlayer.get(ownerId) ?? 0) + 1);
  }

  return (
    <div className="conquest-roster">
      <h3 className="conquest-panel-heading">Commanders</h3>
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
