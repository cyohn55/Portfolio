// Renders each Conquest player's animal army standing on their home tile.
//
// Single responsibility: place the actual RTS animal models on the planet's
// surface at every player's spawn pentagon, oriented so the model's "up" follows
// the tile's surface normal (animals stand on the globe, not float beside it).
// It reuses the game's baked animal geometry (ModelPreloader) so Conquest armies
// are the very same models the player fields in Quick Play — just scaled down to
// the unit-radius globe and re-oriented onto the sphere.

import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { AnimalId } from '../../../game/types';
import { ANIMAL_FILE_MAP, getBakedAnimalParts, type BakedPart } from '../../../utils/ModelPreloader';
import { useConquestStore } from './conquestState';
import { tileTopRadius, DEFAULT_GLOBE_OPTIONS } from './conquestGlobeGeometry';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

// Model footprint on the unit-radius globe. A level-3 tile spans ~0.18 units, so
// a ~0.11-unit animal reads as standing on its tile. The first animal in a
// roster is the "leader" and stands a touch larger.
const ARMY_UNIT_SIZE = 0.11;
const ARMY_LEADER_SIZE = 0.145;
// How far each animal sits from the tile center, in the tile's tangent plane.
const CLUSTER_RADIUS = 0.045;

function modelPath(animal: AnimalId): string {
  return `${import.meta.env.BASE_URL}models/${ANIMAL_FILE_MAP[animal]}`;
}

interface ArmyPlacement {
  playerId: string;
  animal: AnimalId;
  parts: BakedPart[];
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: number;
}

/**
 * Build an orthonormal tangent basis (right, forward) at a point on the sphere
 * whose outward normal is `normal`, so we can offset cluster members within the
 * tile's surface plane.
 */
function tangentBasis(normal: THREE.Vector3): { right: THREE.Vector3; forward: THREE.Vector3 } {
  const reference = Math.abs(normal.x) < 0.9 ? X_AXIS : Y_AXIS;
  const right = new THREE.Vector3().crossVectors(normal, reference).normalize();
  const forward = new THREE.Vector3().crossVectors(normal, right).normalize();
  return { right, forward };
}

export function ConquestArmies() {
  const world = useConquestStore((s) => s.world);
  const biomes = useConquestStore((s) => s.biomes);
  const players = useConquestStore((s) => s.players);

  // Load only the animal models actually fielded this match. Stable for the life
  // of the screen (players are fixed once the world is generated).
  const inPlayAnimals = useMemo<AnimalId[]>(() => {
    const set = new Set<AnimalId>();
    players.forEach((player) => player.animals.forEach((animal) => set.add(animal)));
    return Array.from(set);
  }, [players]);

  const gltfs = useGLTF(inPlayAnimals.map(modelPath)) as any[];

  const placements = useMemo<ArmyPlacement[]>(() => {
    if (!world || biomes.length === 0) return [];

    const gltfByAnimal = new Map<AnimalId, any>();
    inPlayAnimals.forEach((animal, index) => gltfByAnimal.set(animal, gltfs[index]));

    const result: ArmyPlacement[] = [];
    for (const player of players) {
      const tile = world.tiles[player.homeTileId];
      const tileBiome = biomes[player.homeTileId];
      if (!tile || !tileBiome) continue;

      const normal = tile.center.clone().normalize();
      const surfaceRadius = tileTopRadius(tileBiome, DEFAULT_GLOBE_OPTIONS.thickness);
      const surfacePoint = normal.clone().multiplyScalar(surfaceRadius);
      const { right, forward } = tangentBasis(normal);

      // Align the model's +Y to the tile normal so it stands upright on the
      // sphere, then add a per-member yaw so the army fans out around the tile.
      const standUp = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, normal);

      player.animals.forEach((animal, memberIndex) => {
        const gltf = gltfByAnimal.get(animal);
        if (!gltf) return;
        const parts = getBakedAnimalParts(gltf, animal);
        if (parts.length === 0) return;

        const angle = (memberIndex / Math.max(1, player.animals.length)) * Math.PI * 2;
        const offset = right.clone().multiplyScalar(Math.cos(angle) * CLUSTER_RADIUS)
          .addScaledVector(forward, Math.sin(angle) * CLUSTER_RADIUS);
        const position = surfacePoint.clone().add(offset);

        const yaw = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, angle);
        const quaternion = standUp.clone().multiply(yaw);

        result.push({
          playerId: player.id,
          animal,
          parts,
          position,
          quaternion,
          scale: memberIndex === 0 ? ARMY_LEADER_SIZE : ARMY_UNIT_SIZE,
        });
      });
    }
    return result;
  }, [world, biomes, players, gltfs, inPlayAnimals]);

  return (
    <group>
      {placements.map((placement, index) => (
        <group
          key={`${placement.playerId}-${placement.animal}-${index}`}
          position={placement.position}
          quaternion={placement.quaternion}
          scale={placement.scale}
        >
          {placement.parts.map((part, partIndex) => (
            <mesh
              key={partIndex}
              geometry={part.geometry}
              material={part.material}
              castShadow
            />
          ))}
        </group>
      ))}
    </group>
  );
}
