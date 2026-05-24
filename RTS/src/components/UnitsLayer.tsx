import { Suspense, useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { shallow } from 'zustand/shallow';
import { useGameStore } from '../game/state';
import type { AnimalId, Unit } from '../game/types';
import {
  ALL_ANIMAL_PATHS,
  ANIMAL_FILE_MAP,
  OWL_WING_MODELS,
  baseVariantKey,
  owlWingVariantKey,
  getKindTargetScale,
  getBakedAnimalParts,
  getBakedOwlWingParts,
  type BakedPart,
} from '../utils/ModelPreloader';
import * as THREE from 'three';
import { clickState } from '../utils/clickState';

// Maximum instances drawn for a single animal variant. Sized to comfortably
// hold hundreds of units per team even if they all share one animal.
const MAX_INSTANCES_PER_VARIANT = 1200;
// Owner/selection rings are not per-variant, so they need room for every unit.
const RING_CAPACITY = 4096;
// Units beyond this distance from the camera are skipped (distance LOD).
const MAX_RENDER_DISTANCE = 400;

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const FLAT_ROTATION = -Math.PI / 2;

const isMobileDevice = (): boolean =>
  typeof window !== 'undefined' && (window.innerWidth <= 768 || 'ontouchstart' in window);

// Flat (ground-plane) ring geometries, rotated once at module load so each
// instance matrix only needs a translation.
const ownerRingGeometry = new THREE.RingGeometry(0.7, 1.0, 16);
ownerRingGeometry.rotateX(FLAT_ROTATION);
const selectionOuterGeometry = new THREE.RingGeometry(0.9, 1.5, 16);
selectionOuterGeometry.rotateX(FLAT_ROTATION);
const selectionInnerGeometry = new THREE.RingGeometry(1.0, 1.4, 16);
selectionInnerGeometry.rotateX(FLAT_ROTATION);

const OWN_OWNER_RING_MAT = new THREE.MeshBasicMaterial({ color: '#4169E1' });
const ENEMY_OWNER_RING_MAT = new THREE.MeshBasicMaterial({ color: '#DC143C' });
const SELECTION_OUTER_MAT = new THREE.MeshStandardMaterial({
  color: '#000080',
  transparent: true,
  opacity: 0.4,
  emissive: '#000080',
  emissiveIntensity: 2.0,
  toneMapped: false,
});
const SELECTION_INNER_MAT = new THREE.MeshStandardMaterial({
  color: '#000080',
  transparent: true,
  opacity: 0.8,
  emissive: '#000080',
  emissiveIntensity: 3.0,
  toneMapped: false,
});

type VariantSpec = {
  key: string;
  parts: BakedPart[];
};

function BaseMarker({ x, y, z }: { x: number; y: number; z: number }) {
  const tileSize = 2; // Fixed size for bases
  return (
    <group position={[x, y + 0.4, z]}>
      <mesh castShadow receiveShadow>
        <cylinderGeometry args={[tileSize * 0.9, tileSize * 0.9, 0.8, 6]} />
        <meshStandardMaterial color="#06d6a0" />
      </mesh>
      <mesh position={[0, 0.45, 0]} castShadow>
        <boxGeometry args={[0.4, 0.4, 0.4]} />
        <meshStandardMaterial color="#15a37a" />
      </mesh>
    </group>
  );
}

// Bases are few (<=6) and effectively static, so they stay as plain meshes.
// A shallow-compared selector keeps this from re-rendering on every game tick.
function Bases() {
  const bases = useGameStore((s) => s.units.filter((u) => u.kind === 'Base'), shallow);
  return (
    <group>
      {bases.map((base) => (
        <BaseMarker key={base.id} x={base.position.x} y={base.position.y} z={base.position.z} />
      ))}
    </group>
  );
}

// Resolve the variant key for a unit's current visual state (owls swap to a
// wing frame while flying).
function variantKeyForUnit(unit: Unit): string {
  if (unit.animal === 'Owl' && unit.isFlying) {
    const wingFrameIndex = Math.floor((unit.wingPhase || 0) * 4) % OWL_WING_MODELS.length;
    return owlWingVariantKey(wingFrameIndex);
  }
  return baseVariantKey(unit.animal);
}

// Vertical animation/positioning offsets applied per unit (hop, flight, Yetti).
function verticalOffset(unit: Unit): number {
  let offset = 0;
  if ((unit.animal === 'Frog' || unit.animal === 'Bunny') && unit.isHopping) {
    offset += Math.sin((unit.hopPhase || 0) * Math.PI) * 1.5;
  }
  if (unit.animal === 'Owl' && unit.isFlying) {
    offset += 10;
  }
  if (unit.animal === 'Yetti') {
    offset -= 0.9;
  }
  return offset;
}

function InstancedUnits() {
  const { camera } = useThree();
  const isMobile = useMemo(isMobileDevice, []);

  // Load every animal + owl-wing model up front (stable hook call order).
  const gltfs = useGLTF(ALL_ANIMAL_PATHS) as any[];

  // Which animals are actually fielded this match — limits how many instanced
  // meshes we create. Recomputed only when players/selection change.
  const players = useGameStore((s) => s.players);
  const selectedAnimalPool = useGameStore((s) => s.selectedAnimalPool);
  const inPlayAnimals = useMemo<AnimalId[]>(() => {
    const set = new Set<AnimalId>();
    players.forEach((p) => p.animals.forEach((a) => set.add(a)));
    selectedAnimalPool.forEach((a) => set.add(a));
    return Array.from(set);
  }, [players, selectedAnimalPool]);

  // Build the baked variant specs (one entry per animal, plus owl wing frames
  // when owls are present). Geometry baking itself is cached module-side.
  const variants = useMemo<VariantSpec[]>(() => {
    const animalIds = Object.keys(ANIMAL_FILE_MAP) as AnimalId[];
    const gltfByAnimal = new Map<AnimalId, any>();
    animalIds.forEach((animal, index) => gltfByAnimal.set(animal, gltfs[index]));
    const wingGltfs = gltfs.slice(animalIds.length);

    const specs: VariantSpec[] = [];
    for (const animal of inPlayAnimals) {
      const gltf = gltfByAnimal.get(animal);
      if (!gltf) continue;
      specs.push({ key: baseVariantKey(animal), parts: getBakedAnimalParts(gltf, animal) });
    }
    if (inPlayAnimals.includes('Owl')) {
      for (let frame = 0; frame < OWL_WING_MODELS.length; frame++) {
        specs.push({ key: owlWingVariantKey(frame), parts: getBakedOwlWingParts(wingGltfs[frame], frame) });
      }
    }
    return specs;
  }, [gltfs, inPlayAnimals]);

  // Imperative handles, populated by ref callbacks. Not React state — updated
  // directly each frame to avoid re-rendering the component tree.
  const meshRefs = useRef<Map<string, THREE.InstancedMesh[]>>(new Map());
  const ownRingRef = useRef<THREE.InstancedMesh>(null);
  const enemyRingRef = useRef<THREE.InstancedMesh>(null);
  const selectionOuterRef = useRef<THREE.InstancedMesh>(null);
  const selectionInnerRef = useRef<THREE.InstancedMesh>(null);
  // instanceId -> unitId per variant, rebuilt each frame for picking.
  const variantUnitIds = useRef<Map<string, string[]>>(new Map());

  // Reusable scratch objects (no per-frame allocation).
  const scratch = useRef({
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    scale: new THREE.Vector3(),
    matrix: new THREE.Matrix4(),
    projScreen: new THREE.Matrix4(),
    frustum: new THREE.Frustum(),
  });

  // Mark ring instance buffers as dynamic (updated every frame) for the GPU.
  useEffect(() => {
    [ownRingRef, enemyRingRef, selectionOuterRef, selectionInnerRef].forEach((ref) => {
      ref.current?.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    });
  }, []);

  useFrame(() => {
    const s = useGameStore.getState();
    const units = s.units;
    const localPlayerId = s.localPlayerId;
    const selected = s.selectedUnitIds;
    const selectedSet = selected.length > 0 ? new Set(selected) : null;

    const { position, quaternion, scale, matrix, projScreen, frustum } = scratch.current;

    // Build the camera frustum once per frame for cheap off-screen culling.
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    const maxDistanceSq = MAX_RENDER_DISTANCE * MAX_RENDER_DISTANCE;

    // Per-frame counters for each variant and each ring bucket.
    const counts = new Map<string, number>();
    for (const variant of variants) {
      counts.set(variant.key, 0);
      let ids = variantUnitIds.current.get(variant.key);
      if (!ids) {
        ids = [];
        variantUnitIds.current.set(variant.key, ids);
      }
    }
    let ownRingCount = 0;
    let enemyRingCount = 0;
    let selectionOuterCount = 0;
    let selectionInnerCount = 0;

    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (unit.kind === 'Base') continue;

      const key = variantKeyForUnit(unit);
      if (!counts.has(key)) continue; // not a currently-mounted variant
      const meshes = meshRefs.current.get(key);
      if (!meshes || meshes.length === 0) continue;

      const renderY = unit.position.y + verticalOffset(unit);
      position.set(unit.position.x, renderY, unit.position.z);

      // Distance + frustum cull (units we can't see cost nothing).
      if (camera.position.distanceToSquared(position) > maxDistanceSq) continue;
      if (!frustum.containsPoint(position)) continue;

      const variantCount = counts.get(key)!;
      if (variantCount >= MAX_INSTANCES_PER_VARIANT) continue;

      // Compose the per-instance transform: position, yaw, kind-based scale.
      quaternion.setFromAxisAngle(Y_AXIS, unit.rotation);
      const target = getKindTargetScale(unit.animal, unit.kind);
      scale.set(target, target, target);
      matrix.compose(position, quaternion, scale);
      for (let p = 0; p < meshes.length; p++) {
        if (meshes[p]) meshes[p].setMatrixAt(variantCount, matrix);
      }
      variantUnitIds.current.get(key)![variantCount] = unit.id;
      counts.set(key, variantCount + 1);

      // Owner ring sits on the ground beneath the unit (ignores flight lift).
      const ringMesh = unit.ownerId === localPlayerId ? ownRingRef.current : enemyRingRef.current;
      if (ringMesh) {
        const ringIndex = unit.ownerId === localPlayerId ? ownRingCount : enemyRingCount;
        if (ringIndex < RING_CAPACITY) {
          matrix.makeTranslation(unit.position.x, unit.position.y + 0.02, unit.position.z);
          ringMesh.setMatrixAt(ringIndex, matrix);
          if (unit.ownerId === localPlayerId) ownRingCount++;
          else enemyRingCount++;
        }
      }

      // Selection rings only for currently selected units.
      if (selectedSet && selectedSet.has(unit.id)) {
        if (selectionOuterRef.current && selectionOuterCount < RING_CAPACITY) {
          matrix.makeTranslation(unit.position.x, unit.position.y + 0.04, unit.position.z);
          selectionOuterRef.current.setMatrixAt(selectionOuterCount++, matrix);
        }
        if (selectionInnerRef.current && selectionInnerCount < RING_CAPACITY) {
          matrix.makeTranslation(unit.position.x, unit.position.y + 0.25, unit.position.z);
          selectionInnerRef.current.setMatrixAt(selectionInnerCount++, matrix);
        }
      }
    }

    // Flush instance counts + matrix updates to the GPU.
    for (const variant of variants) {
      const meshes = meshRefs.current.get(variant.key);
      if (!meshes) continue;
      const count = counts.get(variant.key)!;
      for (let p = 0; p < meshes.length; p++) {
        if (!meshes[p]) continue;
        meshes[p].count = count;
        meshes[p].instanceMatrix.needsUpdate = true;
      }
    }
    const flush = (mesh: THREE.InstancedMesh | null, count: number) => {
      if (!mesh) return;
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
    };
    flush(ownRingRef.current, ownRingCount);
    flush(enemyRingRef.current, enemyRingCount);
    flush(selectionOuterRef.current, selectionOuterCount);
    flush(selectionInnerRef.current, selectionInnerCount);
  });

  // Pointer handling mirrors the previous per-unit behavior: left-click selects
  // own units (shift adds), right-click on an enemy attacks with the selection.
  const handlePointerDown = (variantKey: string, e: any) => {
    const id = variantUnitIds.current.get(variantKey)?.[e.instanceId];
    if (!id) return;
    e.stopPropagation();

    const s = useGameStore.getState();
    const unit = s.units.find((u) => u.id === id);
    if (!unit) return;
    const isOwnUnit = unit.ownerId === s.localPlayerId;

    if (e.button === 2 && !isOwnUnit) {
      const selectedOwn = s.units.filter(
        (u) => s.selectedUnitIds.includes(u.id) && u.ownerId === s.localPlayerId
      );
      if (selectedOwn.length > 0) {
        s.attackTarget({ unitIds: selectedOwn.map((u) => u.id), targetId: unit.id });
      }
      return;
    }

    if (!isOwnUnit) return;
    clickState.setUnitClicked();
    if (e.shiftKey) s.addToSelection([id]);
    else s.selectUnits([id]);
  };

  const registerPartRef = (variantKey: string, partIndex: number) => (mesh: THREE.InstancedMesh | null) => {
    if (!mesh) return;
    let meshes = meshRefs.current.get(variantKey);
    if (!meshes) {
      meshes = [];
      meshRefs.current.set(variantKey, meshes);
    }
    meshes[partIndex] = mesh;
    mesh.frustumCulled = false; // we cull per-instance ourselves
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = !isMobile;
    mesh.receiveShadow = !isMobile;
    mesh.count = 0;
  };

  return (
    <group>
      {variants.map((variant) =>
        variant.parts.map((part, partIndex) => (
          <instancedMesh
            key={`${variant.key}-${partIndex}`}
            ref={registerPartRef(variant.key, partIndex)}
            args={[part.geometry, part.material, MAX_INSTANCES_PER_VARIANT]}
            onPointerDown={(e) => handlePointerDown(variant.key, e)}
          />
        ))
      )}

      {/* Owner rings — always visible, blue for the local player, red for AI. */}
      <instancedMesh
        ref={ownRingRef}
        args={[ownerRingGeometry, OWN_OWNER_RING_MAT, RING_CAPACITY]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={enemyRingRef}
        args={[ownerRingGeometry, ENEMY_OWNER_RING_MAT, RING_CAPACITY]}
        frustumCulled={false}
      />

      {/* Selection rings — only drawn for selected units. */}
      <instancedMesh
        ref={selectionOuterRef}
        args={[selectionOuterGeometry, SELECTION_OUTER_MAT, RING_CAPACITY]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={selectionInnerRef}
        args={[selectionInnerGeometry, SELECTION_INNER_MAT, RING_CAPACITY]}
        frustumCulled={false}
      />
    </group>
  );
}

export function UnitsLayer() {
  return (
    <Suspense fallback={null}>
      <InstancedUnits />
      <Bases />
    </Suspense>
  );
}
