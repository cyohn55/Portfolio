// The interactive Conquest planet rendered with React Three Fiber.
//
// Single responsibility: render the generated Goldberg world as one merged,
// vertex-colored globe, mark each player's spawn pentagon, and let the player
// hover/click tiles to inspect and select them. All world/owner data comes from
// useConquestStore; this component is a pure view over that store plus local
// hover state.

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { useConquestStore } from './conquestState';
import { ConquestArmies } from './ConquestArmies';
import {
  buildGlobeGeometry,
  buildTileHighlightGeometry,
  DEFAULT_GLOBE_OPTIONS,
  type GlobeBuildOptions,
} from './conquestGlobeGeometry';

// Distance the camera sits from the planet center when framing a spawn. Planet
// radius is 1, so this keeps the home tile and its army comfortably in view
// while leaving room to zoom in to the surface.
const SPAWN_VIEW_DISTANCE = 2.4;

export function ConquestGlobe() {
  const world = useConquestStore((s) => s.world);
  const biomes = useConquestStore((s) => s.biomes);
  const players = useConquestStore((s) => s.players);
  const tileOwners = useConquestStore((s) => s.tileOwners);
  const selectedTileId = useConquestStore((s) => s.selectedTileId);
  const selectTile = useConquestStore((s) => s.selectTile);

  const [hoveredTileId, setHoveredTileId] = useState<number | null>(null);

  // Resolve owner colors once per ownership change so the merged geometry can
  // tint claimed tiles toward their owner.
  const buildOptions = useMemo<GlobeBuildOptions>(() => {
    const ownerColors = new Map<number, number>();
    const colorByPlayer = new Map(players.map((p) => [p.id, p.color]));
    for (const [tileIdKey, ownerId] of Object.entries(tileOwners)) {
      const color = colorByPlayer.get(ownerId);
      if (color !== undefined) ownerColors.set(Number(tileIdKey), color);
    }
    return { ...DEFAULT_GLOBE_OPTIONS, ownerColors };
  }, [players, tileOwners]);

  // Rebuild the merged globe whenever the world or ownership changes. Disposing
  // the previous geometry here avoids leaking GPU buffers across regenerations.
  const { geometry, triangleTileIds } = useMemo(() => {
    if (!world || biomes.length === 0) {
      return { geometry: null as THREE.BufferGeometry | null, triangleTileIds: [] as number[] };
    }
    return buildGlobeGeometry(world, biomes, buildOptions);
  }, [world, biomes, buildOptions]);

  const highlightGeometry = useMemo(() => {
    if (!world || biomes.length === 0) return null;
    const target = selectedTileId ?? hoveredTileId;
    if (target === null) return null;
    return buildTileHighlightGeometry(world, biomes, target, buildOptions);
  }, [world, biomes, selectedTileId, hoveredTileId, buildOptions]);

  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    if (event.faceIndex === undefined || event.faceIndex === null) return;
    const tileId = triangleTileIds[event.faceIndex];
    if (tileId !== undefined && tileId !== hoveredTileId) setHoveredTileId(tileId);
  };

  const handlePointerOut = () => setHoveredTileId(null);

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    if (event.faceIndex === undefined || event.faceIndex === null) return;
    const tileId = triangleTileIds[event.faceIndex];
    if (tileId !== undefined) selectTile(tileId === selectedTileId ? null : tileId);
  };

  if (!geometry) return null;

  return (
    <>
      <OrbitControls
        makeDefault
        enablePan={false}
        enableDamping
        dampingFactor={0.06}
        minDistance={1.3}
        maxDistance={6}
        rotateSpeed={0.5}
      />
      <SpawnCameraFramer />

      <mesh
        geometry={geometry}
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
        onClick={handleClick}
      >
        <meshStandardMaterial vertexColors roughness={0.85} metalness={0.05} flatShading />
      </mesh>

      {highlightGeometry && (
        <mesh geometry={highlightGeometry} renderOrder={2}>
          <meshBasicMaterial
            color={0xffffff}
            transparent
            opacity={0.35}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Team-colored locator beacons floating above each spawn, so distant
          enemies stay findable while orbiting; the armies themselves stand on
          the surface below. */}
      <SpawnBeacons />
      {/* The real animal models, standing on each player's home tile. Wrapped in
          its own Suspense so the globe stays visible while the GLBs stream in. */}
      <Suspense fallback={null}>
        <ConquestArmies />
      </Suspense>
    </>
  );
}

/** A small floating beacon over each player's home pentagon, in team color. */
function SpawnBeacons() {
  const world = useConquestStore((s) => s.world);
  const players = useConquestStore((s) => s.players);

  if (!world) return null;

  return (
    <group>
      {players.map((player) => {
        const tile = world.tiles[player.homeTileId];
        if (!tile) return null;
        const position = tile.center.clone().multiplyScalar(1.22);
        const markerSize = player.isAI ? 0.022 : 0.03;
        return (
          <mesh key={player.id} position={position}>
            <sphereGeometry args={[markerSize, 12, 12]} />
            <meshStandardMaterial
              color={player.color}
              emissive={player.color}
              emissiveIntensity={player.isAI ? 0.5 : 0.9}
              roughness={0.3}
            />
          </mesh>
        );
      })}
    </group>
  );
}

/**
 * Frames the camera on the local (human) player's spawn when the world loads —
 * the Conquest analogue of Quick Play opening on your own base — so the player
 * sees their army immediately instead of a random face of the planet. Runs once
 * per generated world; the player is free to orbit away afterward.
 */
function SpawnCameraFramer() {
  const world = useConquestStore((s) => s.world);
  const players = useConquestStore((s) => s.players);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as
    { target: THREE.Vector3; update: () => void } | null;

  useEffect(() => {
    if (!world) return;
    const human = players.find((player) => !player.isAI);
    if (!human) return;
    const tile = world.tiles[human.homeTileId];
    if (!tile) return;

    const outward = tile.center.clone().normalize();
    camera.position.copy(outward.multiplyScalar(SPAWN_VIEW_DISTANCE));
    camera.lookAt(0, 0, 0);
    if (controls) {
      controls.target.set(0, 0, 0);
      controls.update();
    }
    // Re-frame whenever a new planet is generated (world identity changes).
  }, [world, players, camera, controls]);

  return null;
}
