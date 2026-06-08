// Pose baking for Conquest unit animation.
//
// Single responsibility: turn an animal's multi-pose GLB into an ordered set of
// baked pose variants (one per authored frame), reusing the exact baked frames
// the main game uses (ModelPreloader). This is what fixes the previous bug where
// a multi-pose model was baked whole, stacking every frame on top of each other.
//
// Which frame to *show* each tick is decided by the pure, import-light
// conquestPose module (re-exported here for convenience). Single-pose animals
// (Bear, Bunny, Dolphin, Owl, Pig) return one variant and simply hold it.

import type { AnimalId } from '../../../game/types';
import {
  getBakedAnimalParts,
  getBakedTurtleFrameParts,
  getBakedFoxFrameParts,
  getBakedYetiFrameParts,
  getBakedCatFrameParts,
  getBakedBeeFrameParts,
  getBakedFrogFrameParts,
  getBakedChickenFrameParts,
  TURTLE_FRAME_COUNT,
  FOX_FRAME_COUNT,
  YETI_FRAME_COUNT,
  CAT_FRAME_COUNT,
  BEE_FRAME_COUNT,
  FROG_FRAME_COUNT,
  CHICKEN_FRAME_COUNT,
  type BakedPart,
} from '../../../utils/ModelPreloader';

export { selectPoseIndex, airLiftFactor } from './conquestPose';

export interface PoseVariant {
  key: string;
  parts: BakedPart[];
}

/** Animals that pack multiple pose objects in one GLB and animate by swapping. */
const MULTI_POSE_FRAME_COUNTS: Partial<Record<AnimalId, number>> = {
  Turtle: TURTLE_FRAME_COUNT,
  Fox: FOX_FRAME_COUNT,
  Yetti: YETI_FRAME_COUNT,
  Cat: CAT_FRAME_COUNT,
  Bee: BEE_FRAME_COUNT,
  Frog: FROG_FRAME_COUNT,
  Chicken: CHICKEN_FRAME_COUNT,
};

const FRAME_BAKERS: Partial<Record<AnimalId, (gltf: any, frame: number) => BakedPart[]>> = {
  Turtle: getBakedTurtleFrameParts,
  Fox: getBakedFoxFrameParts,
  Yetti: getBakedYetiFrameParts,
  Cat: getBakedCatFrameParts,
  Bee: getBakedBeeFrameParts,
  Frog: getBakedFrogFrameParts,
  Chicken: getBakedChickenFrameParts,
};

/**
 * Bake an animal's pose variants in canonical frame order. Index i is always
 * frame i, so `selectPoseIndex` can address poses by their authored frame number.
 * Single-pose animals return one "base" variant.
 */
export function buildPoseVariants(animal: AnimalId, gltf: any): PoseVariant[] {
  const frameCount = MULTI_POSE_FRAME_COUNTS[animal];
  const baker = FRAME_BAKERS[animal];
  if (frameCount && baker) {
    const variants: PoseVariant[] = [];
    for (let frame = 0; frame < frameCount; frame++) {
      variants.push({ key: `${animal}-f${frame}`, parts: baker(gltf, frame) });
    }
    return variants;
  }
  return [{ key: `${animal}-base`, parts: getBakedAnimalParts(gltf, animal) }];
}
