import { useGLTF } from '@react-three/drei';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
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

// Preload all animal models at module level
const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');

const loader = new GLTFLoader();
loader.setDRACOLoader(draco);

// Preload each animal model immediately
Object.values(ANIMAL_FILE_MAP).forEach(filename => {
  useGLTF.preload(`${import.meta.env.BASE_URL}models/${filename}`, loader);
});

// Preload owl wing models
OWL_WING_MODELS.forEach(filename => {
  useGLTF.preload(`${import.meta.env.BASE_URL}models/${filename}`, loader);
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