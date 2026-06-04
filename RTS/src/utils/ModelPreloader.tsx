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

// The Frog model packs four pose objects (Frog_F0..Frog_F3) plus a Tongue into
// one glb. F0 (grounded crouch) and F1 (mid-leap) alternate to read as a hop
// while the frog moves; idle holds F0. F2 (mouth-open windup) and F3 (tongue-out
// strike) drive the tongue-grab ability, and the Tongue mesh is baked separately
// as a stretchable beam (getBakedFrogTongueParts). Like the Fox, the frog is
// authored facing forward, so no yaw flip is applied.
export const FROG_FRAME_COUNT = 4;
export const FROG_WINDUP_FRAME = 2;  // Frog_F2 (mouth-open windup / reel-in pose)
export const FROG_STRIKE_FRAME = 3;  // Frog_F3 (tongue extended toward target)
// The tongue is anchored by two marker nodes baked into the model: Tongue_Origin
// sits at the frog's mouth (where the beam emerges) and Tongue_Tip marks the
// beam's resting far end. The beam stretches along the Origin->Tip axis, and the
// Tip mesh doubles as the stretchable beam geometry (see getBakedFrogTongueParts
// and getFrogTongueAnchors). Driving the beam off these nodes lets the model
// author position the mouth and aim in Blender instead of hand-tuning constants.
export const FROG_TONGUE_ORIGIN_NODE_NAME = 'Tongue_Origin';
export const FROG_TONGUE_TIP_NODE_NAME = 'Tongue_Tip';

export function frogFrameNodeName(frameIndex: number): string {
  return `Frog_F${frameIndex}`;
}

export function frogFrameVariantKey(frameIndex: number): string {
  return `Frog-frame${frameIndex % FROG_FRAME_COUNT}`;
}

// Variant key for the standalone stretchable tongue beam (not a per-frog pose).
export const FROG_TONGUE_VARIANT_KEY = 'Frog-tongue-beam';
// Tint for the tongue beam (#C83D2D). The Tongue mesh shares its glb material
// (Material.014) with parts of the frog body, so the beam bake clones the
// material and recolors only the clone — the body parts keep their original hue.
export const FROG_TONGUE_COLOR = 0xc83d2d;

// The Chicken model packs four pose objects (Chicken_F0..Chicken_F3) plus an Egg
// into one glb. F0 is idle; F1/F2 alternate as the walk cycle; F3 is the egg-throw
// pose, baked together with the held Egg so both appear at once (see UnitsLayer).
// The Egg is also baked on its own as a flying projectile (getBakedEggProjectileParts).
export const CHICKEN_FRAME_COUNT = 4;
export const CHICKEN_THROW_FRAME = 3; // Chicken_F3 (+ Egg) — the throw pose
export const CHICKEN_EGG_NODE_NAME = 'Egg';

export function chickenFrameNodeName(frameIndex: number): string {
  return `Chicken_F${frameIndex}`;
}

export function chickenFrameVariantKey(frameIndex: number): string {
  return `Chicken-frame${frameIndex % CHICKEN_FRAME_COUNT}`;
}

// Variant key for the standalone flying egg projectile (not a per-unit pose).
export const EGG_PROJECTILE_VARIANT_KEY = 'Chicken-egg-projectile';

// ---------------------------------------------------------------------------
// Royal head accessories (crowns / tiaras)
//
// Several animal models ship four extra head props baked in at the same spot:
// a Crown and a Tiara in each team color. The renderer shows exactly one on a
// royal unit — the local player's Kings wear Blue_Crown and Queens Blue_Tiara,
// while enemy Kings wear Red_Crown and Queens Red_Tiara. Regular units, bases,
// and any model lacking these nodes (e.g. Frog, Chicken) show nothing.
//
// Each accessory is baked into its own instanced variant, normalized in the
// SAME frame as the body it rides on (see getBakedRoyalAccessoryParts), so the
// renderer can place it with the unit's own body transform and it lands on the
// head. The accessory nodes are excluded from every body bake so they never
// appear stacked on ordinary units.
// ---------------------------------------------------------------------------
export const ROYAL_ACCESSORY_NODE_NAMES = [
  'Blue_Crown',
  'Blue_Tiara',
  'Red_Crown',
  'Red_Tiara',
] as const;
export type RoyalAccessoryNode = (typeof ROYAL_ACCESSORY_NODE_NAMES)[number];

const ROYAL_ACCESSORY_NODE_SET: ReadonlySet<string> = new Set(ROYAL_ACCESSORY_NODE_NAMES);

// Resolve which accessory a royal unit should wear from its allegiance and rank:
// the local player ("own") is Blue, the enemy is Red; a King wears a Crown and a
// Queen a Tiara.
export function royalAccessoryNodeFor(isOwnUnit: boolean, kind: 'King' | 'Queen'): RoyalAccessoryNode {
  const color = isOwnUnit ? 'Blue' : 'Red';
  const piece = kind === 'King' ? 'Crown' : 'Tiara';
  return `${color}_${piece}` as RoyalAccessoryNode;
}

// Variant key for a grounded animal's accessory (uses the feet-to-ground body
// normalization shared by base and pose-frame variants).
export function royalAccessoryVariantKey(animal: AnimalId, node: RoyalAccessoryNode): string {
  return `royal:${animal}:${node}`;
}

// Variant key for an accessory baked from a specific owl wing frame, so a flying
// owl's crown tracks the wing model's distinct normalization and 180° flip.
export function owlWingRoyalAccessoryVariantKey(wingFrameIndex: number, node: RoyalAccessoryNode): string {
  return `royal:Owl-wing${wingFrameIndex % OWL_WING_MODELS.length}:${node}`;
}

// Whether a loaded model carries any royal accessory node (Frog/Chicken do not).
export function hasRoyalAccessories(gltf: any): boolean {
  if (!gltf?.scene) return false;
  return ROYAL_ACCESSORY_NODE_NAMES.some((name) => gltf.scene.getObjectByName(name));
}

// True if `object` is a royal accessory node or a descendant of one, so body
// bakes can skip the accessory meshes (they are drawn as their own variants).
function isRoyalAccessoryDescendant(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (ROYAL_ACCESSORY_NODE_SET.has(current.name)) return true;
    current = current.parent;
  }
  return false;
}

// Bounding box of a model's BODY only — every mesh except the royal accessory
// nodes. Both body and accessory bakes normalize against this same box so the
// accessory lands in the body's frame, and the body keeps the exact size/footing
// it had before the accessory nodes were added to the model.
function computeBodyBoundingBox(root: THREE.Object3D): THREE.Box3 {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (isRoyalAccessoryDescendant(mesh)) return;
    mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox) return;
    meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    box.union(meshBox);
  });
  return box;
}

// Capacity for each accessory instanced mesh. Only Kings and Queens wear one, so
// a few dozen at most are ever on the field — sized with generous headroom.
export const ROYAL_ACCESSORY_CAPACITY = 256;

// World-space size (longest edge) a unit should occupy, by kind and animal.
// Mirrors the targets previously used in createPreparedScene.
export function getKindTargetScale(animal: AnimalId, kind: 'Unit' | 'Queen' | 'King' | 'Base'): number {
  // Yetti is the oversized "boss" animal with hand-tuned battlefield sizes.
  if (animal === 'Yetti') {
    if (kind === 'King') return 13.0;
    if (kind === 'Queen') return 11.0;
    if (kind === 'Unit') return 8.0;
    return 6.0; // Base keeps its prior size.
  }

  let target = kind === 'King' ? 6.0 : kind === 'Queen' ? 5.0 : 3.0;
  // The Bear king and queen are 2 units larger than the standard royals.
  if (animal === 'Bear' && (kind === 'King' || kind === 'Queen')) target += 2.0;
  // The Cat king and queen are doubled (king 12 / queen 10). Doubling the standard
  // 6/5 royals preserves the king-slightly-larger-than-queen ratio shared by the
  // other animals.
  if (animal === 'Cat' && (kind === 'King' || kind === 'Queen')) target *= 2.0;
  // Regular units are doubled so they read more clearly on the battlefield;
  // kings and queens keep their base size.
  if (kind === 'Unit') target *= 2.0;
  return target;
}

const bakedVariantCache = new Map<string, BakedPart[]>();

// How to normalize and which subtrees to bake out of a model. Every bake shares
// one normalization frame (computeBodyBoundingBox) so bodies, pose frames, and
// royal accessories all line up when drawn with the same per-instance transform.
type BakeOptions = {
  // Wing frames use a fixed size denominator and center on the origin (no
  // feet-to-ground drop) so successive frames neither resize nor bob.
  isWing?: boolean;
  // Yaw correction for models authored facing backwards (Bunny, Yeti, owl wings).
  yRotation?: number;
  // Node names to bake; when omitted the whole model is baked.
  includeNodeNames?: string[] | null;
  // Skip royal accessory meshes so they are not drawn as part of the body.
  excludeRoyalAccessories?: boolean;
};

// Core bake: clone the model, normalize it (longest body edge -> ~1 unit, feet on
// y=0 unless a wing frame), apply any facing correction, then bake the selected
// meshes into world-space geometry. Per-instance matrices later scale by
// getKindTargetScale and translate to the unit's position.
function bakeNormalizedParts(gltf: any, options: BakeOptions): BakedPart[] {
  if (!gltf?.scene) return [];

  const root = gltf.scene.clone(true);

  // Normalize against the BODY bounds (accessories excluded) so adding crowns to
  // a model never rescales or shifts the body it sits on.
  const box = computeBodyBoundingBox(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDimension = Math.max(size.x, size.y, size.z) || 1;
  const normalizeScale = options.isWing ? 1 / OWL_WING_FIXED_SCALE_DENOMINATOR : 1 / maxDimension;
  root.scale.setScalar(normalizeScale);

  const center = new THREE.Vector3();
  box.getCenter(center);
  if (options.isWing) {
    root.position.set(-center.x * normalizeScale, 0, -center.z * normalizeScale);
  } else {
    root.position.set(-center.x * normalizeScale, -box.min.y * normalizeScale, -center.z * normalizeScale);
  }

  root.rotation.y = options.yRotation ?? 0;
  root.updateWorldMatrix(true, true);

  const sourceRoots: THREE.Object3D[] = options.includeNodeNames
    ? options.includeNodeNames.map((name) => root.getObjectByName(name)).filter(Boolean) as THREE.Object3D[]
    : [root];

  const parts: BakedPart[] = [];
  for (const sourceRoot of sourceRoots) {
    sourceRoot.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (options.excludeRoyalAccessories && isRoyalAccessoryDescendant(mesh)) return;
      const geometry = mesh.geometry.clone();
      geometry.applyMatrix4(mesh.matrixWorld); // bake normalization into vertices
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      parts.push({ geometry, material });
    });
  }

  return parts;
}

// Yaw correction for a base animal authored facing backwards. Wing frames flip
// regardless (handled by their callers).
function baseAnimalYRotation(animal: AnimalId): number {
  return animal === 'Bunny' || animal === 'Yetti' ? Math.PI : 0;
}

// Bake a whole base-animal (or owl wing) variant, dropping the royal accessory
// meshes so plain units never wear a crown.
function bakeVariant(gltf: any, animal: AnimalId, isWing: boolean): BakedPart[] {
  return bakeNormalizedParts(gltf, {
    isWing,
    yRotation: isWing ? Math.PI : baseAnimalYRotation(animal),
    excludeRoyalAccessories: true,
  });
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

// Bake one or more named pose objects (Turtle_F#, Fox_F#, …) out of a multi-pose
// glb into instanced parts. All poses share one normalization — derived from the
// whole model's bounds rather than each pose's own — so every frame lands at the
// same size and ground height and the unit never jitters or resizes as the
// renderer cycles poses. (The poses overlap at a common origin, so the union
// bounds match each pose closely while guaranteeing identical placement.)
// Passing several node names bakes them together as one variant, e.g. the
// Chicken's throw pose (Chicken_F3 + the held Egg).
function bakePoseFrame(gltf: any, poseNodeNames: string | string[], yRotation = 0): BakedPart[] {
  const names = Array.isArray(poseNodeNames) ? poseNodeNames : [poseNodeNames];
  return bakeNormalizedParts(gltf, { yRotation, includeNodeNames: names });
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

// Return cached baked parts for one Frog pose-frame variant. The frog is authored
// facing forward (like the Fox), so no yaw flip is applied. Only the named pose
// node is baked, so the glb's other objects (the Tongue and the three unused
// poses) stay hidden — the renderer shows exactly one Frog_F# pose at a time.
export function getBakedFrogFrameParts(gltf: any, frameIndex: number): BakedPart[] {
  const key = frogFrameVariantKey(frameIndex);
  const cached = bakedVariantCache.get(key);
  if (cached) return cached;
  const parts = bakePoseFrame(gltf, frogFrameNodeName(frameIndex));
  bakedVariantCache.set(key, parts);
  return parts;
}

// Return cached baked parts for the Frog's tongue beam. The Tongue_Tip marker
// mesh doubles as the beam: like the flying egg it is normalized on its own
// bounds (longest edge -> 1) and centered at the origin (no feet-to-ground drop)
// so the renderer can stretch and orient it freely each frame, drawing the beam
// from the Tongue_Origin anchor out along the Origin->Tip axis and scaling it by
// the live extension distance (see the tongue block in UnitsLayer).
export function getBakedFrogTongueParts(gltf: any): BakedPart[] {
  const cached = bakedVariantCache.get(FROG_TONGUE_VARIANT_KEY);
  if (cached) return cached;
  const parts: BakedPart[] = [];
  if (gltf?.scene) {
    const root = gltf.scene.clone(true);
    root.updateWorldMatrix(true, true);
    const tongueNode = root.getObjectByName(FROG_TONGUE_TIP_NODE_NAME);
    if (tongueNode) {
      const box = new THREE.Box3().setFromObject(tongueNode);
      const size = new THREE.Vector3();
      box.getSize(size);
      const maxDimension = Math.max(size.x, size.y, size.z) || 1;
      const center = new THREE.Vector3();
      box.getCenter(center);
      tongueNode.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(mesh.matrixWorld); // -> world space
        geometry.translate(-center.x, -center.y, -center.z); // center at origin
        geometry.scale(1 / maxDimension, 1 / maxDimension, 1 / maxDimension); // longest edge -> 1
        const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        // Clone before tinting so the shared source material (used by frog-body
        // parts) is left untouched.
        const material = (source as THREE.MeshStandardMaterial).clone();
        if ((material as any).color) (material as any).color.setHex(FROG_TONGUE_COLOR);
        parts.push({ geometry, material });
      });
    }
  }
  bakedVariantCache.set(FROG_TONGUE_VARIANT_KEY, parts);
  return parts;
}

// Local-space tongue anchors, expressed in the same normalized frame the Frog's
// pose meshes are baked into (longest edge -> 1, feet on y=0, centered on x/z by
// the whole model's bounds — see bakePoseFrame). `origin` is the mouth point the
// beam emerges from; `axis` is the unit direction from the origin to the tip,
// i.e. the way the tongue shoots "straight outward". The renderer scales these by
// the unit's world scale, rotates them by its yaw, and offsets by its position to
// place and aim the beam — so the mouth height and aim follow the model markers
// (Tongue_Origin / Tongue_Tip) instead of a hand-tuned constant.
export type FrogTongueAnchors = {
  origin: { x: number; y: number; z: number };
  axis: { x: number; y: number; z: number };
};

let frogTongueAnchorsCache: FrogTongueAnchors | null = null;

export function getFrogTongueAnchors(gltf: any): FrogTongueAnchors | null {
  if (frogTongueAnchorsCache) return frogTongueAnchorsCache;
  if (!gltf?.scene) return null;

  // Reproduce bakePoseFrame's normalization so the anchors land in the exact
  // frame the rendered frog body occupies. The clone is left at identity, so each
  // node's world position is its untransformed model-space position.
  const root = gltf.scene.clone(true);
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const normalizeScale = 1 / (Math.max(size.x, size.y, size.z) || 1);
  const center = new THREE.Vector3();
  box.getCenter(center);

  // A node's baked position mirrors bakePoseFrame: scale by normalizeScale, then
  // recenter horizontally on the model center and drop feet (box.min.y) to y=0.
  const scratch = new THREE.Vector3();
  const toBakedFrame = (nodeName: string): THREE.Vector3 | null => {
    const node = root.getObjectByName(nodeName);
    if (!node) return null;
    node.getWorldPosition(scratch);
    return new THREE.Vector3(
      (scratch.x - center.x) * normalizeScale,
      (scratch.y - box.min.y) * normalizeScale,
      (scratch.z - center.z) * normalizeScale
    );
  };

  const origin = toBakedFrame(FROG_TONGUE_ORIGIN_NODE_NAME);
  const tip = toBakedFrame(FROG_TONGUE_TIP_NODE_NAME);
  if (!origin || !tip) return null;

  const axis = tip.clone().sub(origin);
  if (axis.lengthSq() < 1e-8) axis.set(0, 0, 1); // degenerate markers: shoot forward
  axis.normalize();

  frogTongueAnchorsCache = {
    origin: { x: origin.x, y: origin.y, z: origin.z },
    axis: { x: axis.x, y: axis.y, z: axis.z },
  };
  return frogTongueAnchorsCache;
}

// Return cached baked parts for one Chicken pose-frame variant. The walk/idle
// frames (F0–F2) are authored facing forward (like the Fox), so no yaw flip is
// applied and they bake only their own pose (Egg + unused poses stay hidden).
// The throw frame (F3) bakes the held Egg alongside Chicken_F3 and is spun 180°
// about the Y axis — Blender's Z axis maps to glTF/three.js Y, so this is the
// requested "rotate Chicken_F3 180° on Blender's Z" — turning the chicken so its
// tail feathers face the target it is throwing toward.
export function getBakedChickenFrameParts(gltf: any, frameIndex: number): BakedPart[] {
  const key = chickenFrameVariantKey(frameIndex);
  const cached = bakedVariantCache.get(key);
  if (cached) return cached;
  const isThrowFrame = frameIndex === CHICKEN_THROW_FRAME;
  const nodeNames = isThrowFrame
    ? [chickenFrameNodeName(CHICKEN_THROW_FRAME), CHICKEN_EGG_NODE_NAME]
    : chickenFrameNodeName(frameIndex);
  const yRotation = isThrowFrame ? Math.PI : 0; // tail-to-target for the throw pose
  const parts = bakePoseFrame(gltf, nodeNames, yRotation);
  bakedVariantCache.set(key, parts);
  return parts;
}

// Return cached baked parts for the flying egg projectile. Unlike a pose frame,
// the egg is normalized on its own bounds (longest edge -> 1) and centered at the
// origin (no feet-to-ground drop), so the renderer can place and scale it freely
// at each projectile's world position.
export function getBakedEggProjectileParts(gltf: any): BakedPart[] {
  const cached = bakedVariantCache.get(EGG_PROJECTILE_VARIANT_KEY);
  if (cached) return cached;
  const parts: BakedPart[] = [];
  if (gltf?.scene) {
    const root = gltf.scene.clone(true);
    root.updateWorldMatrix(true, true);
    const eggNode = root.getObjectByName(CHICKEN_EGG_NODE_NAME);
    if (eggNode) {
      const box = new THREE.Box3().setFromObject(eggNode);
      const size = new THREE.Vector3();
      box.getSize(size);
      const maxDimension = Math.max(size.x, size.y, size.z) || 1;
      const center = new THREE.Vector3();
      box.getCenter(center);
      eggNode.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(mesh.matrixWorld); // -> world space
        geometry.translate(-center.x, -center.y, -center.z); // center at origin
        geometry.scale(1 / maxDimension, 1 / maxDimension, 1 / maxDimension); // longest edge -> 1
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        parts.push({ geometry, material });
      });
    }
  }
  bakedVariantCache.set(EGG_PROJECTILE_VARIANT_KEY, parts);
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

// Return cached baked parts for one royal accessory on a grounded animal. The
// accessory is normalized in the same body frame as the animal's base/pose
// variants (feet-to-ground, same facing correction), so drawing it with a royal
// unit's own body transform lands it on the head. Returns [] for models lacking
// the node (e.g. Frog, Chicken) or for an unknown node name.
export function getBakedRoyalAccessoryParts(gltf: any, animal: AnimalId, node: RoyalAccessoryNode): BakedPart[] {
  const key = royalAccessoryVariantKey(animal, node);
  const cached = bakedVariantCache.get(key);
  if (cached) return cached;
  const parts = bakeNormalizedParts(gltf, {
    yRotation: baseAnimalYRotation(animal),
    includeNodeNames: [node],
  });
  bakedVariantCache.set(key, parts);
  return parts;
}

// Return cached baked parts for one royal accessory on an owl wing frame. Baked
// in the wing's own normalization (fixed size, origin-centered, 180° flip) so a
// flying owl's crown tracks the wing model rather than the grounded body.
export function getBakedOwlWingRoyalAccessoryParts(gltf: any, wingFrameIndex: number, node: RoyalAccessoryNode): BakedPart[] {
  const key = owlWingRoyalAccessoryVariantKey(wingFrameIndex, node);
  const cached = bakedVariantCache.get(key);
  if (cached) return cached;
  const parts = bakeNormalizedParts(gltf, {
    isWing: true,
    yRotation: Math.PI,
    includeNodeNames: [node],
  });
  bakedVariantCache.set(key, parts);
  return parts;
}

// Preload component to be used in App.tsx
export function ModelPreloader() {
  // Models are already preloaded at module level
  return null;
}