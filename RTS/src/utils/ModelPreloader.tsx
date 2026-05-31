import { useGLTF } from '@react-three/drei';
import type { AnimalId } from '../game/types';
import * as THREE from 'three';

export const ANIMAL_FILE_MAP: Record<AnimalId, string> = {
  Bee: 'Bee.glb',
  Bear: 'Bear.glb',
  Bunny: 'Bunny.glb',
  Chicken: 'Chicken.glb',
  Cat: 'cat.glb',
  Dolphin: 'dolphin.glb',
  Fox: 'Fox.glb',
  Frog: 'Frog.glb',
  Owl: 'Owl.glb',
  Pig: 'Pig.glb',
  Turtle: 'Turtle.glb',
  Yetti: 'Yeti.glb',
};

// Owl wing animation models
export const OWL_WING_MODELS = [
  'Owl_Wings_Up.glb',
  'Owl_Wings_Almost_Down.glb',
  'Owl_Wings_Down.glb',
  'Owl_Wings_Glide.glb',
] as const;

// Preload all animal models at module level. `useDraco: true` matches the
// default DRACO config used by every other useGLTF call site (HexGrid,
// UnitsLayer), so the preloaded cache entries are reused by the components.
const USE_DRACO = true;

// Preload each animal model immediately
Object.values(ANIMAL_FILE_MAP).forEach(filename => {
  useGLTF.preload(`${import.meta.env.BASE_URL}models/${filename}`, USE_DRACO);
});

// Preload owl wing models
OWL_WING_MODELS.forEach(filename => {
  useGLTF.preload(`${import.meta.env.BASE_URL}models/${filename}`, USE_DRACO);
});

// Get preloaded model with optimized cloning
export function usePreloadedModel(animal: AnimalId) {
  if (!animal || !ANIMAL_FILE_MAP[animal]) {
    console.error(`❌ Invalid animal ID: "${animal}". Available animals:`, Object.keys(ANIMAL_FILE_MAP));
    throw new Error(`Invalid animal ID: ${animal}`);
  }
  const path = `${import.meta.env.BASE_URL}models/${ANIMAL_FILE_MAP[animal]}`;
  return useGLTF(path);
}

// Create optimized prepared scene with caching
const preparedScenesCache = new Map<string, THREE.Object3D>();

export function createPreparedScene(gltf: any, animal: AnimalId, unitKind: 'Unit' | 'Queen' | 'King' | 'Base', modelVariant?: string) {
  // Include model variant in cache key for animated models (e.g., owl wings)
  const cacheKey = modelVariant ? `${animal}-${unitKind}-${modelVariant}` : `${animal}-${unitKind}`;

  // Return cached scene if available
  if (preparedScenesCache.has(cacheKey)) {
    return preparedScenesCache.get(cacheKey)!.clone(true);
  }

  if (!gltf?.scene) return null;

  const scene = gltf.scene.clone(true);

  // Configure shadows
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });

  // Calculate and apply scaling
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  let target = unitKind === 'King' ? 6.0 : unitKind === 'Queen' ? 5.0 : 3.0;
  if (animal === 'Yetti') {
    target *= 2.0; // Double the size for Yetti
  }

  // For Owl wing models, use a fixed scale to prevent size changes during animation
  let scale;
  if (animal === 'Owl' && modelVariant?.startsWith('wing')) {
    // Use a consistent fixed scale for all wing animation frames
    // This prevents the model from appearing to grow/shrink during flight
    scale = target / 2.8; // Fixed scale based on average owl model dimensions
  } else {
    scale = target / maxDim;
  }

  scene.scale.setScalar(scale);

  const center = new THREE.Vector3();
  box.getCenter(center);

  // For Owl wing models, use consistent ground plane positioning to prevent bouncing
  if (animal === 'Owl' && modelVariant?.startsWith('wing')) {
    // Use a fixed Y offset for all wing models to prevent vertical bouncing
    scene.position.set(-center.x * scale, 0, -center.z * scale);
  } else {
    // Recenter to ground plane
    scene.position.set(-center.x * scale, -(box.min.y) * scale, -center.z * scale);
  }

  // Flip Bunny, Yetti, and Owl wing models 180 degrees around Y-axis
  if (animal === 'Bunny' || animal === 'Yetti') {
    scene.rotation.y = Math.PI;
  }

  // Flip Owl wing models 180 degrees
  if (animal === 'Owl' && modelVariant?.startsWith('wing')) {
    scene.rotation.y = Math.PI;
  }

  // Cache the prepared scene
  preparedScenesCache.set(cacheKey, scene);

  return scene.clone(true);
}

// Get owl wing model based on wing phase (0-1 cycle)
export function useOwlWingModel(wingPhase: number) {
  // Map wing phase to model index
  // 0.00-0.25: Wings Up
  // 0.25-0.50: Wings Almost Down
  // 0.50-0.75: Wings Down
  // 0.75-1.00: Wings Glide
  const modelIndex = Math.floor(wingPhase * 4) % 4;
  const modelName = OWL_WING_MODELS[modelIndex];
  const path = `${import.meta.env.BASE_URL}models/${modelName}`;
  return useGLTF(path);
}

// ---------------------------------------------------------------------------
// Instanced rendering support
//
// Each animal model is a single mesh split into several primitives, each with
// its own material (no skeletal animation — movement is pure transform + model
// swap). That makes the units ideal for GPU instancing: one InstancedMesh per
// (model variant, primitive) draws every unit of that animal in a single draw
// call, independent of unit count.
//
// A "variant" is the geometry source: a base animal, or one of the owl wing
// frames used while flying. The kind-specific size (King/Queen/Unit, Yetti x2)
// is NOT baked into the geometry — it is applied per-instance via the matrix
// scale so a single baked variant serves every unit kind.
// ---------------------------------------------------------------------------

export type BakedPart = { geometry: THREE.BufferGeometry; material: THREE.Material };

// Fixed scale used for the owl wing frames so the model does not appear to
// pulse in size as the loader swaps between wing-frame meshes mid-flight.
const OWL_WING_FIXED_SCALE_DENOMINATOR = 2.8;

// All paths that must be resolved before instanced geometry can be baked.
// Ordering is stable so callers can rely on useGLTF(array) index positions.
export const ALL_ANIMAL_PATHS: string[] = [
  ...Object.values(ANIMAL_FILE_MAP),
  ...OWL_WING_MODELS,
].map((filename) => `${import.meta.env.BASE_URL}models/${filename}`);

// Variant key helpers keep the bake cache and per-frame bucketing in sync.
export function baseVariantKey(animal: AnimalId): string {
  return animal;
}

export function owlWingVariantKey(wingFrameIndex: number): string {
  return `Owl-wing${wingFrameIndex % OWL_WING_MODELS.length}`;
}

// The Turtle model packs six pose objects (Turtle_F0..Turtle_F5) into one glb.
// F0 is the shell-lock pose; F1..F5 are the walk-cycle frames. Each pose is
// baked into its own instanced variant and the renderer shows exactly one at a
// time, so the unbaked frames cost nothing.
export const TURTLE_FRAME_COUNT = 6;

export function turtleFrameNodeName(frameIndex: number): string {
  return `Turtle_F${frameIndex}`;
}

export function turtleFrameVariantKey(frameIndex: number): string {
  return `Turtle-frame${frameIndex % TURTLE_FRAME_COUNT}`;
}

// The Fox model packs three pose objects (Fox_F0..Fox_F2) into one glb. They are
// cycled as a three-frame walk loop while moving; idle holds Fox_F1. Like the
// Turtle, each pose is baked into its own instanced variant and the renderer
// shows exactly one at a time, so the unbaked frames cost nothing.
export const FOX_FRAME_COUNT = 3;

export function foxFrameNodeName(frameIndex: number): string {
  return `Fox_F${frameIndex}`;
}

export function foxFrameVariantKey(frameIndex: number): string {
  return `Fox-frame${frameIndex % FOX_FRAME_COUNT}`;
}

// The Yeti model packs three pose objects (Yeti_F0..Yeti_F2) into one glb,
// cycled as a three-frame walk loop while moving; idle holds Yeti_F1. Like the
// Bunny, the Yeti faces backwards out of the exporter and needs a 180° yaw flip.
export const YETI_FRAME_COUNT = 3;

export function yetiFrameNodeName(frameIndex: number): string {
  return `Yeti_F${frameIndex}`;
}

export function yetiFrameVariantKey(frameIndex: number): string {
  return `Yeti-frame${frameIndex % YETI_FRAME_COUNT}`;
}

// The Cat model packs three pose objects (Kitty_F0..Kitty_F2) into one glb.
// F0 is the idle pose; F0/F1 alternate for the walk cycle and F1/F2 alternate
// for the attack cycle (see UnitsLayer). Like the Fox, each pose is baked into
// its own instanced variant and the renderer shows exactly one at a time, so the
// unbaked frames cost nothing.
export const CAT_FRAME_COUNT = 3;

export function catFrameNodeName(frameIndex: number): string {
  return `Kitty_F${frameIndex}`;
}

export function catFrameVariantKey(frameIndex: number): string {
  return `Cat-frame${frameIndex % CAT_FRAME_COUNT}`;
}

// The Bee model packs two pose objects (Bee_F0..Bee_F1) into one glb. They are
// alternated as a two-frame wing-flap loop continuously (the bee is always
// airborne). Like the Fox, each pose is baked into its own instanced variant and
// the renderer shows exactly one at a time, so the unbaked frame costs nothing.
export const BEE_FRAME_COUNT = 2;

export function beeFrameNodeName(frameIndex: number): string {
  return `Bee_F${frameIndex}`;
}

export function beeFrameVariantKey(frameIndex: number): string {
  return `Bee-frame${frameIndex % BEE_FRAME_COUNT}`;
}

// World-space size (longest edge) a unit should occupy, by kind and animal.
// Mirrors the targets previously used in createPreparedScene.
export function getKindTargetScale(animal: AnimalId, kind: 'Unit' | 'Queen' | 'King' | 'Base'): number {
  let target = kind === 'King' ? 6.0 : kind === 'Queen' ? 5.0 : 3.0;
  if (animal === 'Yetti') target *= 2.0;
  return target;
}

const bakedVariantCache = new Map<string, BakedPart[]>();

// Bake one variant's primitives into normalized, world-space geometry whose
// longest edge is ~1 unit and whose feet rest on y=0. Per-instance matrices
// then scale by getKindTargetScale and translate to the unit's position.
function bakeVariant(gltf: any, animal: AnimalId, isWing: boolean): BakedPart[] {
  if (!gltf?.scene) return [];

  const root = gltf.scene.clone(true);

  // Normalize size: longest edge -> 1 unit (fixed denominator for wing frames
  // so successive frames stay the same size).
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDimension = Math.max(size.x, size.y, size.z) || 1;
  const normalizeScale = isWing ? 1 / OWL_WING_FIXED_SCALE_DENOMINATOR : 1 / maxDimension;
  root.scale.setScalar(normalizeScale);

  const center = new THREE.Vector3();
  box.getCenter(center);
  if (isWing) {
    // Wing frames center on the model origin (no feet-to-ground correction) to
    // avoid vertical bouncing between frames.
    root.position.set(-center.x * normalizeScale, 0, -center.z * normalizeScale);
  } else {
    // Recenter horizontally and drop feet to the ground plane.
    root.position.set(-center.x * normalizeScale, -box.min.y * normalizeScale, -center.z * normalizeScale);
  }

  // Match the original facing corrections.
  if (animal === 'Bunny' || animal === 'Yetti' || isWing) {
    root.rotation.y = Math.PI;
  }

  root.updateWorldMatrix(true, true);

  const parts: BakedPart[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld); // bake normalization into vertices
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    parts.push({ geometry, material });
  });

  return parts;
}

// Return cached baked parts for a base animal variant.
export function getBakedAnimalParts(gltf: any, animal: AnimalId): BakedPart[] {
  const key = baseVariantKey(animal);
  const cached = bakedVariantCache.get(key);
  if (cached) return cached;
  const parts = bakeVariant(gltf, animal, false);
  bakedVariantCache.set(key, parts);
  return parts;
}

// Bake a single named pose object (Turtle_F#, Fox_F#, …) out of a multi-pose
// glb into instanced parts. All poses share one normalization — derived from the
// whole model's bounds rather than each pose's own — so every frame lands at the
// same size and ground height and the unit never jitters or resizes as the
// renderer cycles poses. (The poses overlap at a common origin, so the union
// bounds match each pose closely while guaranteeing identical placement.)
function bakePoseFrame(gltf: any, poseNodeName: string, yRotation = 0): BakedPart[] {
  if (!gltf?.scene) return [];

  const root = gltf.scene.clone(true);

  // Shared normalization: longest edge of the combined model -> 1 unit, feet to
  // the ground plane.
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDimension = Math.max(size.x, size.y, size.z) || 1;
  const normalizeScale = 1 / maxDimension;
  root.scale.setScalar(normalizeScale);

  const center = new THREE.Vector3();
  box.getCenter(center);
  root.position.set(-center.x * normalizeScale, -box.min.y * normalizeScale, -center.z * normalizeScale);

  // Facing correction for models authored backwards (matches bakeVariant).
  root.rotation.y = yRotation;

  root.updateWorldMatrix(true, true);

  const frameRoot = root.getObjectByName(poseNodeName);
  if (!frameRoot) return [];

  const parts: BakedPart[] = [];
  frameRoot.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld); // bake normalization into vertices
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    parts.push({ geometry, material });
  });

  return parts;
}

// Return cached baked parts for one Turtle pose-frame variant.
export function getBakedTurtleFrameParts(gltf: any, frameIndex: number): BakedPart[] {
  const key = turtleFrameVariantKey(frameIndex);
  const cached = bakedVariantCache.get(key);
  if (cached) return cached;
  const parts = bakePoseFrame(gltf, turtleFrameNodeName(frameIndex));
  bakedVariantCache.set(key, parts);
  return parts;
}

// Return cached baked parts for one Fox pose-frame variant.
export function getBakedFoxFrameParts(gltf: any, frameIndex: number): BakedPart[] {
  const key = foxFrameVariantKey(frameIndex);
  const cached = bakedVariantCache.get(key);
  if (cached) return cached;
  const parts = bakePoseFrame(gltf, foxFrameNodeName(frameIndex));
  bakedVariantCache.set(key, parts);
  return parts;
}

// Return cached baked parts for one Yeti pose-frame variant (flipped 180° to
// match the Yeti's backwards authoring, like the base-variant baker does).
export function getBakedYetiFrameParts(gltf: any, frameIndex: number): BakedPart[] {
  const key = yetiFrameVariantKey(frameIndex);
  const cached = bakedVariantCache.get(key);
  if (cached) return cached;
  const parts = bakePoseFrame(gltf, yetiFrameNodeName(frameIndex), Math.PI);
  bakedVariantCache.set(key, parts);
  return parts;
}

// Return cached baked parts for one Cat pose-frame variant. The cat is authored
// facing forward (like the Fox), so no yaw flip is applied.
export function getBakedCatFrameParts(gltf: any, frameIndex: number): BakedPart[] {
  const key = catFrameVariantKey(frameIndex);
  const cached = bakedVariantCache.get(key);
  if (cached) return cached;
  const parts = bakePoseFrame(gltf, catFrameNodeName(frameIndex));
  bakedVariantCache.set(key, parts);
  return parts;
}

// Return cached baked parts for one Bee pose-frame variant. The bee is authored
// facing forward (like the Fox), so no yaw flip is applied.
export function getBakedBeeFrameParts(gltf: any, frameIndex: number): BakedPart[] {
  const key = beeFrameVariantKey(frameIndex);
  const cached = bakedVariantCache.get(key);
  if (cached) return cached;
  const parts = bakePoseFrame(gltf, beeFrameNodeName(frameIndex));
  bakedVariantCache.set(key, parts);
  return parts;
}

// Return cached baked parts for one owl wing frame variant.
export function getBakedOwlWingParts(gltf: any, wingFrameIndex: number): BakedPart[] {
  const key = owlWingVariantKey(wingFrameIndex);
  const cached = bakedVariantCache.get(key);
  if (cached) return cached;
  const parts = bakeVariant(gltf, 'Owl', true);
  bakedVariantCache.set(key, parts);
  return parts;
}

// Preload component to be used in App.tsx
export function ModelPreloader() {
  // Models are already preloaded at module level
  return null;
}