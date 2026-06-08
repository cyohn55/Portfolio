// The interactive Conquest planet rendered with React Three Fiber.
//
// Single responsibility: render the generated Goldberg world as one merged,
// vertex-colored globe, mark each player's spawn pentagon, and let the player
// hover/click tiles to inspect and select them. All world/owner data comes from
// useConquestStore; this component is a pure view over that store plus local
// hover state.

import { Suspense, useMemo, useState } from 'react';
import { type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { useConquestStore } from './conquestState';
import { ConquestField } from './ConquestField';
import {
  buildGlobeGeometry,
  buildTileHighlightGeometry,
  DEFAULT_GLOBE_OPTIONS,
  type GlobeBuildOptions,
} from './conquestGlobeGeometry';

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
          enemies stay findable while the camera is locked near your monarch. */}
      <SpawnBeacons />

      {/* Units on the surface + monarch piloting + the third-person chase camera.
          Wrapped in its own Suspense so the globe stays visible while the animal
          GLBs stream in. */}
      <Suspense fallback={null}>
        <ConquestField />
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
