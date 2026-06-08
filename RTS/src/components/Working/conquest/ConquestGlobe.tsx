// The interactive Conquest planet rendered with React Three Fiber.
//
// Single responsibility: render the generated Goldberg world as one merged,
// vertex-colored globe, mark each player's spawn pentagon, and let the player
// hover/click tiles to inspect and select them. All world/owner data comes from
// useConquestStore; this component is a pure view over that store plus local
// hover state.

import { useMemo, useState } from 'react';
import { type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { useConquestStore } from './conquestState';
import {
  buildGlobeGeometry,
  buildTileHighlightGeometry,
  DEFAULT_GLOBE_OPTIONS,
  type GlobeBuildOptions,
} from './conquestGlobeGeometry';

/** Slow idle spin so the planet feels alive without fighting the user's drag. */
const AUTO_ROTATE_SPEED = 0.35;
const SPAWN_MARKER_RADIUS = 1.16;

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
        enablePan={false}
        enableDamping
        dampingFactor={0.06}
        minDistance={1.7}
        maxDistance={6}
        autoRotate
        autoRotateSpeed={AUTO_ROTATE_SPEED}
        rotateSpeed={0.5}
      />

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

      <SpawnMarkers />
    </>
  );
}

/** A small floating beacon over each player's home pentagon, in team color. */
function SpawnMarkers() {
  const world = useConquestStore((s) => s.world);
  const players = useConquestStore((s) => s.players);

  if (!world) return null;

  return (
    <group>
      {players.map((player) => {
        const tile = world.tiles[player.homeTileId];
        if (!tile) return null;
        const position = tile.center.clone().multiplyScalar(SPAWN_MARKER_RADIUS);
        const markerSize = player.isAI ? 0.035 : 0.05;
        return (
          <mesh key={player.id} position={position}>
            <sphereGeometry args={[markerSize, 16, 16]} />
            <meshStandardMaterial
              color={player.color}
              emissive={player.color}
              emissiveIntensity={player.isAI ? 0.4 : 0.8}
              roughness={0.3}
            />
          </mesh>
        );
      })}
    </group>
  );
}
