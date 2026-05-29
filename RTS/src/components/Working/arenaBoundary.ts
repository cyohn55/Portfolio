import type { Position3D } from '../../game/types';

/**
 * Arena playable boundary.
 *
 * The Battle_Map's ground slab (the "Arena" node) is a square rotated ~45° about the Y axis,
 * so an axis-aligned clamp would leak units into the corner void between the rotated edges
 * and the bounding box. We therefore represent the slab as an oriented box in the XZ plane —
 * a center, two perpendicular world-space axis directions, and a half-extent along each — and
 * clamp positions against it. The boundary is map-static data registered once when the model
 * loads, keeping movement code free of any Three.js / scene-graph coupling: it reads plain
 * numbers and calls {@link clampToArena}.
 */
export interface ArenaBoundary {
  centerX: number;
  centerZ: number;
  /** Unit vector along the slab's local X axis, expressed in world XZ. */
  axisUx: number;
  axisUz: number;
  /** Unit vector along the slab's local Z axis, expressed in world XZ. */
  axisVx: number;
  axisVz: number;
  /** World half-length along axis U (already inset by the unit body radius). */
  halfU: number;
  /** World half-length along axis V (already inset by the unit body radius). */
  halfV: number;
}

/**
 * Clamp a single XZ point to an oriented box. Pure (no shared state) so it can be unit-tested
 * directly with known inputs and outputs. Projects the point's offset from the box center onto
 * each box axis, clamps each projection to its half-extent, then rebuilds the world point from
 * the clamped projections. A point already inside the box is returned unchanged.
 */
export function clampPointToBoundary(
  boundary: ArenaBoundary,
  x: number,
  z: number,
): { x: number; z: number } {
  const { centerX, centerZ, axisUx, axisUz, axisVx, axisVz, halfU, halfV } = boundary;

  const offsetX = x - centerX;
  const offsetZ = z - centerZ;

  let alongU = offsetX * axisUx + offsetZ * axisUz;
  let alongV = offsetX * axisVx + offsetZ * axisVz;
  alongU = Math.max(-halfU, Math.min(halfU, alongU));
  alongV = Math.max(-halfV, Math.min(halfV, alongV));

  return {
    x: centerX + alongU * axisUx + alongV * axisVx,
    z: centerZ + alongU * axisUz + alongV * axisVz,
  };
}

let activeBoundary: ArenaBoundary | null = null;

/**
 * Register the Arena's oriented XZ footprint so movable units can be confined to it. Called
 * once after the battle map loads. Passing null disables clamping (e.g. before the map is
 * ready), so the game behaves exactly as before when no boundary is known.
 */
export function registerArenaBoundary(boundary: ArenaBoundary | null): void {
  activeBoundary = boundary;
}

/** The currently registered boundary, or null if none. Exposed mainly for diagnostics. */
export function getArenaBoundary(): ArenaBoundary | null {
  return activeBoundary;
}

/**
 * Clamp a position to the registered Arena footprint in place, mutating x/z so a unit can never
 * step past the outermost edge of the slab. Y is left untouched (terrain height is resolved
 * elsewhere). No-op until a boundary is registered.
 */
export function clampToArena(position: Position3D): void {
  if (!activeBoundary) return;
  const clamped = clampPointToBoundary(activeBoundary, position.x, position.z);
  position.x = clamped.x;
  position.z = clamped.z;
}
