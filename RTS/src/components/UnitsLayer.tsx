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

// Queen/King area-of-effect ring — a chunky flat-lying 3D torus. Built at major
// radius 1 (tube AURA_TORUS_TUBE) and scaled per instance by each aura's world
// radius, so one geometry serves both auras even if their radii differ. The
// tube scales with it, so its world half-height is radius * AURA_TORUS_TUBE
// (used to lift the torus so it rests on the ground rather than half-buried).
const AURA_TORUS_TUBE = 0.1;
const auraRingGeometry = new THREE.TorusGeometry(1, AURA_TORUS_TUBE, 20, 96);
auraRingGeometry.rotateX(FLAT_ROTATION);

const NEON_GREEN = '#39ff14';

// Max Queen + King aura sources on the field at once (3 animals x 2 sides x 2 kinds).
const AURA_CAPACITY = 64;

// The aura ring is only drawn while the aura is actively working — a Queen
// healing a below-full-health unit in range, or a King buffing a unit in range
// that is in combat (unit.auraActive). It is hidden entirely otherwise.
const AURA_ACTIVE_MAT = new THREE.MeshStandardMaterial({
  color: NEON_GREEN,
  emissive: NEON_GREEN,
  emissiveIntensity: 3.0,
  toneMapped: false,
});

// Per-unit neon-green glow pool, drawn on the ground beneath any friendly unit
// currently standing inside an active aura. Additive blending + pulsing scale
// and opacity (see useFrame) read as a radiant green aura around the unit.
const auraUnitGlowGeometry = new THREE.CircleGeometry(1, 28);
auraUnitGlowGeometry.rotateX(FLAT_ROTATION);
const AURA_UNIT_GLOW_MAT = new THREE.MeshBasicMaterial({
  color: NEON_GREEN,
  transparent: true,
  opacity: 0.45,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
});
// Base ground radius of a unit's green glow pool (scaled per frame by the pulse).
const AURA_UNIT_GLOW_RADIUS = 1.6;
// Plenty of room for a whole army clustered around a Queen/King.
const AURA_GLOW_CAPACITY = 4096;

// Floating health bars — a dark backing quad with a colored fill quad in front,
// billboarded to face the camera and drawn above each unit/Queen/King whose HP
// is below maximum. The bar persists until the unit heals to full or dies. Two
// instanced meshes keep the whole field's bars to two draw calls.
const HEALTH_BAR_WIDTH = 3.2;
const HEALTH_BAR_HEIGHT = 0.44;
// Bars are only drawn for damaged units, but a large battle can light up most of
// the field at once, so size generously.
const HEALTH_BAR_CAPACITY = 4096;

const healthBarBgGeometry = new THREE.PlaneGeometry(HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT);
// Fill geometry is shifted so its LEFT edge sits at the local origin; scaling x
// by the HP ratio then drains the bar from the right while the left edge stays
// pinned to the backing bar's left edge.
const healthBarFillGeometry = new THREE.PlaneGeometry(HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT);
healthBarFillGeometry.translate(HEALTH_BAR_WIDTH / 2, 0, 0);

// depthTest off + a high render order keeps bars readable on top of the scene.
const HEALTH_BAR_BG_MAT = new THREE.MeshBasicMaterial({
  color: '#000000',
  transparent: true,
  opacity: 0.6,
  side: THREE.DoubleSide,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
});
const HEALTH_BAR_FILL_MAT = new THREE.MeshBasicMaterial({
  color: '#ffffff', // multiplied by per-instance color (see setColorAt)
  transparent: true,
  opacity: 0.95,
  side: THREE.DoubleSide,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
});

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
  // Bees have no land/takeoff state — they're always airborne, so apply the
  // same +10 lift as a flying Owl unconditionally to keep flight altitudes
  // consistent across air units.
  if (unit.animal === 'Bee') {
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
  const auraActiveRef = useRef<THREE.InstancedMesh>(null);
  const auraUnitGlowRef = useRef<THREE.InstancedMesh>(null);
  const healthBarBgRef = useRef<THREE.InstancedMesh>(null);
  const healthBarFillRef = useRef<THREE.InstancedMesh>(null);
  // instanceId -> unitId per variant, rebuilt each frame for picking.
  const variantUnitIds = useRef<Map<string, string[]>>(new Map());

  // Reusable scratch objects (no per-frame allocation).
  const scratch = useRef({
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    identityQuaternion: new THREE.Quaternion(),
    scale: new THREE.Vector3(),
    one: new THREE.Vector3(1, 1, 1),
    matrix: new THREE.Matrix4(),
    projScreen: new THREE.Matrix4(),
    frustum: new THREE.Frustum(),
    cameraRight: new THREE.Vector3(),
    color: new THREE.Color(),
  });

  // Mark ring instance buffers as dynamic (updated every frame) for the GPU.
  useEffect(() => {
    [ownRingRef, enemyRingRef, selectionOuterRef, selectionInnerRef, auraActiveRef, auraUnitGlowRef, healthBarBgRef, healthBarFillRef].forEach((ref) => {
      ref.current?.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    });
  }, []);

  useFrame(({ clock }) => {
    const s = useGameStore.getState();
    const units = s.units;
    const localPlayerId = s.localPlayerId;
    const selected = s.selectedUnitIds;
    const selectedSet = selected.length > 0 ? new Set(selected) : null;
    const queenAuraRadius = s.config.regenRadius;
    const kingAuraRadius = s.config.kingAuraRadius;
    const healthBarsEnabled = s.healthBarsEnabled;

    const { position, quaternion, identityQuaternion, scale, one, matrix, projScreen, frustum, cameraRight, color } = scratch.current;

    // Billboard orientation for health bars: camera's quaternion makes each bar
    // face the screen, and its world-space right axis anchors the fill's left edge.
    if (healthBarsEnabled) {
      cameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    }

    // Pulse drives the neon-green active ring glow + per-unit glow this frame.
    const pulse = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 4);
    AURA_ACTIVE_MAT.emissiveIntensity = 2.5 + pulse * 3.0; // 2.5 .. 5.5 (neon)
    const activeAuraScale = 1 + pulse * 0.05;
    AURA_UNIT_GLOW_MAT.opacity = 0.3 + pulse * 0.45; // 0.3 .. 0.75
    const unitGlowScale = AURA_UNIT_GLOW_RADIUS * (0.85 + pulse * 0.4);

    // Active aura sources (auraActive Queens/Kings) — friendly units standing
    // inside any of these get the pulsing green glow pool. Few sources (<=12).
    const activeAuras: { x: number; z: number; r2: number; owner: string }[] = [];
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if ((u.kind === 'Queen' || u.kind === 'King') && u.auraActive) {
        const r = u.kind === 'Queen' ? queenAuraRadius : kingAuraRadius;
        activeAuras.push({ x: u.position.x, z: u.position.z, r2: r * r, owner: u.ownerId });
      }
    }

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
    let auraActiveCount = 0;
    let auraUnitGlowCount = 0;
    let healthBarCount = 0;

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

      // Green glow pool beneath any unit standing inside an active friendly aura.
      if (activeAuras.length > 0 && auraUnitGlowRef.current && auraUnitGlowCount < AURA_GLOW_CAPACITY) {
        let inAura = false;
        for (const a of activeAuras) {
          if (a.owner !== unit.ownerId) continue;
          const dx = unit.position.x - a.x;
          const dz = unit.position.z - a.z;
          if (dx * dx + dz * dz <= a.r2) { inAura = true; break; }
        }
        if (inAura) {
          position.set(unit.position.x, unit.position.y + 0.05, unit.position.z);
          scale.set(unitGlowScale, unitGlowScale, unitGlowScale);
          matrix.compose(position, identityQuaternion, scale);
          auraUnitGlowRef.current.setMatrixAt(auraUnitGlowCount++, matrix);
        }
      }

      // Queen/King aura ring: a neon-green pulsing torus drawn on the ground at
      // the aura's world radius, but ONLY while the aura is actively working
      // (unit.auraActive — Queen healing a hurt unit, or King buffing a unit in
      // combat). Hidden entirely otherwise. Ground-placed so flight lift doesn't
      // move it.
      if ((unit.kind === 'Queen' || unit.kind === 'King') && unit.auraActive) {
        const radius = unit.kind === 'Queen' ? queenAuraRadius : kingAuraRadius;
        // Lift by the tube's world half-height so the torus rests on the ground.
        const ringY = unit.position.y + radius * AURA_TORUS_TUBE;
        const ringMesh = auraActiveRef.current;
        if (ringMesh && auraActiveCount < AURA_CAPACITY) {
          const r = radius * activeAuraScale;
          position.set(unit.position.x, ringY, unit.position.z);
          scale.set(r, r, r);
          matrix.compose(position, identityQuaternion, scale);
          ringMesh.setMatrixAt(auraActiveCount++, matrix);
        }
      }

      // Floating health bar — drawn for any unit below full HP (and still alive),
      // persisting until it heals to full or dies, when the player has bars on.
      if (
        healthBarsEnabled &&
        unit.hp > 0 &&
        unit.hp < unit.maxHp &&
        healthBarCount < HEALTH_BAR_CAPACITY &&
        healthBarBgRef.current &&
        healthBarFillRef.current
      ) {
        const ratio = Math.max(0, Math.min(1, unit.hp / unit.maxHp));
        // Sit the bar just above the model's head; taller kinds need more lift.
        const barY = renderY + target * 0.55 + 0.9;

        // Backing bar: centered on the unit, facing the camera.
        position.set(unit.position.x, barY, unit.position.z);
        matrix.compose(position, camera.quaternion, one);
        healthBarBgRef.current.setMatrixAt(healthBarCount, matrix);

        // Fill: anchored at the bar's left edge, scaled in x by the HP ratio.
        position.set(
          unit.position.x - cameraRight.x * (HEALTH_BAR_WIDTH / 2),
          barY - cameraRight.y * (HEALTH_BAR_WIDTH / 2),
          unit.position.z - cameraRight.z * (HEALTH_BAR_WIDTH / 2)
        );
        scale.set(Math.max(ratio, 0.0001), 1, 1);
        matrix.compose(position, camera.quaternion, scale);
        healthBarFillRef.current.setMatrixAt(healthBarCount, matrix);

        // Fill color reflects remaining HP: red (low) -> yellow -> green (high).
        if (ratio > 0.5) {
          color.setRGB((1 - ratio) * 2, 1, 0.1);
        } else {
          color.setRGB(1, ratio * 2, 0.1);
        }
        healthBarFillRef.current.setColorAt(healthBarCount, color);
        healthBarCount++;
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
    flush(auraActiveRef.current, auraActiveCount);
    flush(auraUnitGlowRef.current, auraUnitGlowCount);
    flush(healthBarBgRef.current, healthBarCount);
    flush(healthBarFillRef.current, healthBarCount);
    if (healthBarFillRef.current?.instanceColor) {
      healthBarFillRef.current.instanceColor.needsUpdate = true;
    }
  });

  // Only right-click attack-move onto an enemy unit is handled per-mesh here.
  // Left-click selection lives in MapInteraction's screen-space picking: the
  // instanced models are tiny and units cluster tightly, so per-mesh raycast
  // picking was unreliable for selecting an individual unit.
  const handlePointerDown = (variantKey: string, e: any) => {
    if (e.button !== 2) return;
    const id = variantUnitIds.current.get(variantKey)?.[e.instanceId];
    if (!id) return;

    const s = useGameStore.getState();
    const unit = s.units.find((u) => u.id === id);
    if (!unit || unit.ownerId === s.localPlayerId) return;

    e.stopPropagation();
    const selectedOwn = s.units.filter(
      (u) => s.selectedUnitIds.includes(u.id) && u.ownerId === s.localPlayerId
    );
    if (selectedOwn.length > 0) {
      s.attackTarget({ unitIds: selectedOwn.map((u) => u.id), targetId: unit.id });
    }
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

      {/* Queen/King aura ring — only drawn (glowing green) while the aura is
          actively healing or buffing; plus per-unit green glow pools. */}
      <instancedMesh
        ref={auraActiveRef}
        args={[auraRingGeometry, AURA_ACTIVE_MAT, AURA_CAPACITY]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={auraUnitGlowRef}
        args={[auraUnitGlowGeometry, AURA_UNIT_GLOW_MAT, AURA_GLOW_CAPACITY]}
        frustumCulled={false}
      />

      {/* Floating health bars — backing + colored fill, billboarded toward the
          camera and drawn on top of the scene. Only populated for units that are
          currently taking damage or healing. */}
      <instancedMesh
        ref={healthBarBgRef}
        args={[healthBarBgGeometry, HEALTH_BAR_BG_MAT, HEALTH_BAR_CAPACITY]}
        frustumCulled={false}
        renderOrder={998}
      />
      <instancedMesh
        ref={healthBarFillRef}
        args={[healthBarFillGeometry, HEALTH_BAR_FILL_MAT, HEALTH_BAR_CAPACITY]}
        frustumCulled={false}
        renderOrder={999}
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
