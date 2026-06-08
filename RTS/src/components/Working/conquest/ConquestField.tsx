// The playable Conquest field: units standing on the planet, monarch piloting,
// and the third-person chase camera.
//
// Single responsibility: take the spawn descriptors from the store, give every
// unit a live position on the sphere, let the player drive their selected
// monarch across the surface (WASD / arrows, Tab to switch unit), keep the rest
// of the roster following, and frame it all with a third-person, slightly
// top-down camera locked onto the monarch — the Conquest analogue of Quick
// Play's monarch piloting.
//
// All per-frame work is imperative (mutating Object3D transforms and the camera
// directly in useFrame) so driving never re-renders the React tree. The store is
// only read for the static spawn set and the selected-monarch id.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { AnimalId, MovementType } from '../../../game/types';
import { ANIMAL_MOVEMENT_TYPES } from '../../../game/types';
import { ANIMAL_FILE_MAP, getBakedAnimalParts, type BakedPart } from '../../../utils/ModelPreloader';
import { useConquestStore } from './conquestState';
import type { GoldbergWorld } from './goldbergWorld';
import type { TileBiome } from './conquestBiomes';
import { BIOMES } from './conquestBiomes';
import { tileTopRadius } from './conquestGlobeGeometry';

// Model footprint on the unit-radius globe. A level-3 tile spans ~0.18 units, so
// each tile should read as a large field ("an acre"): an animal is only a small
// fraction of a tile across. The piloted monarch is a touch larger so the
// controlled unit stands out.
const UNIT_SCALE = 0.005;
const MONARCH_SCALE = 0.007;

// Piloting feel. Speeds are in globe-radius units per second (the planet has
// radius 1, so a full lap at MOVE_SPEED takes ~2π / MOVE_SPEED seconds). Tuned
// so crossing one acre-sized tile takes a couple of seconds, not a blink.
const MOVE_SPEED = 0.1;
const TURN_SPEED = 2.2; // radians / second
const FOLLOW_SPEED = 0.12;
const FOLLOW_GAP = 0.012; // followers hold this distance behind the monarch

// Chase camera placement, expressed as multiples of the monarch's model scale so
// the third-person framing stays correct no matter how small the animals are.
// HEIGHT vs BACK sets the pitch — these give the requested "slightly top-down"
// angle. Multiplied further by the live zoom factor.
const CAM_BACK_FACTOR = 7.0;
const CAM_HEIGHT_FACTOR = 4.5;
const CAM_LERP = 6.0; // higher = snappier follow
const ZOOM_MIN = 0.45;
const ZOOM_MAX = 4.0;

interface LiveUnit {
  id: string;
  ownerId: string;
  isMonarch: boolean;
  movement: MovementType;
  parts: BakedPart[];
  scale: number;
  position: THREE.Vector3;
  facing: THREE.Vector3;
  group: THREE.Group | null;
}

function modelPath(animal: AnimalId): string {
  return `${import.meta.env.BASE_URL}models/${ANIMAL_FILE_MAP[animal]}`;
}

/** Index of the tile whose center is nearest a direction on the sphere. */
function nearestTileId(direction: THREE.Vector3, world: GoldbergWorld): number {
  let best = 0;
  let bestDot = -Infinity;
  for (const tile of world.tiles) {
    const dot = tile.center.dot(direction);
    if (dot > bestDot) {
      bestDot = dot;
      best = tile.id;
    }
  }
  return best;
}

function isPassable(tileBiome: TileBiome | undefined, movement: MovementType): boolean {
  if (!tileBiome) return false;
  return BIOMES[tileBiome.biome].passableBy.has(movement);
}

/** Re-orthogonalize `facing` to be a unit tangent at the surface point `up`. */
function tangentize(facing: THREE.Vector3, up: THREE.Vector3): void {
  facing.addScaledVector(up, -facing.dot(up));
  if (facing.lengthSq() < 1e-8) {
    // Degenerate (facing was parallel to up): pick any tangent.
    facing.crossVectors(up, Math.abs(up.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0));
  }
  facing.normalize();
}

export function ConquestField() {
  const world = useConquestStore((s) => s.world);
  const biomes = useConquestStore((s) => s.biomes);
  const unitSpawns = useConquestStore((s) => s.units);
  const cycleMonarch = useConquestStore((s) => s.cycleMonarch);

  const { camera, gl } = useThree();

  // Load the models actually fielded this match (stable for the screen's life).
  const inPlayAnimals = useMemo<AnimalId[]>(() => {
    const set = new Set<AnimalId>();
    unitSpawns.forEach((unit) => set.add(unit.animal));
    return Array.from(set);
  }, [unitSpawns]);
  const gltfs = useGLTF(inPlayAnimals.map(modelPath)) as any[];

  // Build the live (mutable) unit set once per match. Positions/facings here are
  // mutated every frame by the sim; React never re-renders for movement.
  const liveUnits = useMemo<LiveUnit[]>(() => {
    if (!world || biomes.length === 0) return [];
    const partsByAnimal = new Map<AnimalId, BakedPart[]>();
    inPlayAnimals.forEach((animal, index) => {
      const gltf = gltfs[index];
      if (gltf) partsByAnimal.set(animal, getBakedAnimalParts(gltf, animal));
    });

    return unitSpawns.map((spawn) => {
      const position = new THREE.Vector3(spawn.position.x, spawn.position.y, spawn.position.z);
      const up = position.clone().normalize();
      // Seed facing as an arbitrary tangent; piloting/following overwrite it.
      const facing = new THREE.Vector3().crossVectors(
        up, Math.abs(up.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0),
      ).normalize();
      return {
        id: spawn.id,
        ownerId: spawn.ownerId,
        isMonarch: spawn.isMonarch,
        movement: ANIMAL_MOVEMENT_TYPES[spawn.animal],
        parts: partsByAnimal.get(spawn.animal) ?? [],
        scale: spawn.isMonarch ? MONARCH_SCALE : UNIT_SCALE,
        position,
        facing,
        group: null,
      };
    });
  }, [world, biomes, unitSpawns, gltfs, inPlayAnimals]);

  // --- Input: pressed keys + zoom, tracked in refs (no per-key re-render). ---
  const keys = useRef<Set<string>>(new Set());
  const zoom = useRef(1.0);
  const cameraInitialized = useRef(false);

  useEffect(() => {
    cameraInitialized.current = false; // re-frame on a new match
  }, [liveUnits]);

  useEffect(() => {
    const driveKeys = new Set([
      'w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
    ]);
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === 'tab') {
        event.preventDefault();
        cycleMonarch();
        return;
      }
      if (driveKeys.has(key)) {
        event.preventDefault();
        keys.current.add(key);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => keys.current.delete(event.key.toLowerCase());
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(event.deltaY * 0.0012);
      zoom.current = THREE.MathUtils.clamp(zoom.current * factor, ZOOM_MIN, ZOOM_MAX);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    const canvas = gl.domElement;
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [cycleMonarch, gl]);

  // Reusable scratch (no per-frame allocation in the hot loop).
  const scratch = useRef({
    up: new THREE.Vector3(),
    right: new THREE.Vector3(),
    forward: new THREE.Vector3(),
    step: new THREE.Vector3(),
    candidateDir: new THREE.Vector3(),
    basis: new THREE.Matrix4(),
    quat: new THREE.Quaternion(),
    camDesired: new THREE.Vector3(),
    camBack: new THREE.Vector3(),
  });

  useFrame((_, rawDelta) => {
    if (!world || liveUnits.length === 0) return;
    const delta = Math.min(rawDelta, 0.05); // clamp hitches
    const { up, step, candidateDir, basis, quat, camDesired, camBack } = scratch.current;

    const monarchId = useConquestStore.getState().selectedMonarchId;
    const monarch = liveUnits.find((unit) => unit.id === monarchId) ?? null;

    // 1) Drive the monarch from input, constrained to the sphere + passability.
    if (monarch) {
      up.copy(monarch.position).normalize();

      const turn = (keys.current.has('a') || keys.current.has('arrowleft') ? 1 : 0)
        - (keys.current.has('d') || keys.current.has('arrowright') ? 1 : 0);
      if (turn !== 0) {
        monarch.facing.applyAxisAngle(up, turn * TURN_SPEED * delta);
        tangentize(monarch.facing, up);
      }

      const drive = (keys.current.has('w') || keys.current.has('arrowup') ? 1 : 0)
        - (keys.current.has('s') || keys.current.has('arrowdown') ? 1 : 0);
      if (drive !== 0) {
        step.copy(monarch.facing).multiplyScalar(drive * MOVE_SPEED * delta);
        candidateDir.copy(monarch.position).add(step).normalize();
        const tileId = nearestTileId(candidateDir, world);
        if (isPassable(biomes[tileId], monarch.movement)) {
          const radius = tileTopRadius(biomes[tileId]);
          monarch.position.copy(candidateDir).multiplyScalar(radius);
          up.copy(candidateDir);
          tangentize(monarch.facing, up);
        }
      }
    }

    // 2) Followers (same owner as the monarch) trail it across the surface.
    if (monarch) {
      for (const unit of liveUnits) {
        if (unit === monarch || unit.ownerId !== monarch.ownerId) continue;
        step.subVectors(monarch.position, unit.position);
        const distance = step.length();
        if (distance > FOLLOW_GAP) {
          const travel = Math.min(FOLLOW_SPEED * delta, distance - FOLLOW_GAP);
          candidateDir.copy(unit.position).addScaledVector(step.normalize(), travel).normalize();
          const tileId = nearestTileId(candidateDir, world);
          if (isPassable(biomes[tileId], unit.movement)) {
            unit.position.copy(candidateDir).multiplyScalar(tileTopRadius(biomes[tileId]));
          }
          up.copy(unit.position).normalize();
          unit.facing.subVectors(monarch.position, unit.position);
          tangentize(unit.facing, up);
        }
      }
    }

    // 3) Push every unit's transform to its group (stand on surface, face along
    //    `facing`, up along the surface normal).
    for (const unit of liveUnits) {
      if (!unit.group) continue;
      up.copy(unit.position).normalize();
      scratch.current.right.crossVectors(up, unit.facing).normalize();
      scratch.current.forward.crossVectors(scratch.current.right, up).normalize();
      basis.makeBasis(scratch.current.right, up, scratch.current.forward);
      quat.setFromRotationMatrix(basis);
      unit.group.position.copy(unit.position);
      unit.group.quaternion.copy(quat);
    }

    // 4) Third-person chase camera, locked onto the monarch. Camera distance is
    //    proportional to the monarch's size so small animals still fill the frame.
    if (monarch) {
      up.copy(monarch.position).normalize();
      const backDistance = monarch.scale * CAM_BACK_FACTOR * zoom.current;
      const heightDistance = monarch.scale * CAM_HEIGHT_FACTOR * zoom.current;
      camBack.copy(monarch.facing).multiplyScalar(-backDistance);
      camDesired.copy(monarch.position)
        .add(camBack)
        .addScaledVector(up, heightDistance);

      if (!cameraInitialized.current) {
        camera.position.copy(camDesired);
        cameraInitialized.current = true;
      } else {
        const t = 1 - Math.exp(-CAM_LERP * delta);
        camera.position.lerp(camDesired, t);
      }
      camera.up.copy(up);
      camera.lookAt(monarch.position);
    }
  });

  return (
    <group>
      {liveUnits.map((unit) => (
        <group
          key={unit.id}
          ref={(element) => { unit.group = element; }}
          scale={unit.scale}
        >
          {unit.parts.map((part, partIndex) => (
            <mesh key={partIndex} geometry={part.geometry} material={part.material} castShadow />
          ))}
        </group>
      ))}
    </group>
  );
}
