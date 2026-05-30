import type { Position3D } from '../../game/types';

/**
 * Arena playable boundary.
 *
 * The Battle_Map's ground slab is a square rotated ~45° about Y, so the playable area is a
 * diamond. We represent the boundary as an oriented box in that rotated frame — a center, two
 * perpendicular world-space axes, and a half-extent along each — plus an optional corner cut
 * (a cap on |alongU| + |alongV|) that lops off the diamond's far tips. Clamping to the raw slab
 * still let units flank out onto those tips, which read as "off the map"; sizing the box and the
 * corner cut to the actual play area (the base line plus a margin) keeps them on the field.
 *
 * The boundary is map-static data registered once after the model loads, so movement code stays
 * free of any Three.js / scene-graph coupling: it reads plain numbers and calls {@link clampToArena}.
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
  /** World half-length along axis U. */
  halfU: number;
  /** World half-length along axis V. */
  halfV: number;
  /**
   * Cap on |alongU| + |alongV|, which cuts the four diamond corners off the oriented box to form
   * an octagon. Use Infinity for no corner cut (a plain oriented box).
   */
  diagLimit: number;
  /**
   * Straight world-space left/right walls, applied after the oriented-box/octagon clamp. The slab
   * is rotated 45°, so the octagon's sides come out as wide as its front/back; these walls let the
   * left (minX, most negative) and right (maxX, most positive) extents be tightened independently
   * of front/back and of each other. Use ±Infinity for no wall.
   */
  minX: number;
  maxX: number;
}

/**
 * Clamp a single XZ point to the oriented box with corner cut. Pure (no shared state) so it can
 * be unit-tested directly. Projects the point's offset from the center onto each box axis, clamps
 * each projection to its half-extent, then, if the projections still violate the corner cut,
 * projects orthogonally onto that diagonal edge. A point already inside is returned unchanged.
 */
export function clampPointToBoundary(
  boundary: ArenaBoundary,
  x: number,
  z: number,
): { x: number; z: number } {
  const { centerX, centerZ, axisUx, axisUz, axisVx, axisVz, halfU, halfV, diagLimit, minX, maxX } = boundary;

  const offsetX = x - centerX;
  const offsetZ = z - centerZ;

  let alongU = offsetX * axisUx + offsetZ * axisUz;
  let alongV = offsetX * axisVx + offsetZ * axisVz;

  // Box edges.
  alongU = Math.max(-halfU, Math.min(halfU, alongU));
  alongV = Math.max(-halfV, Math.min(halfV, alongV));

  // Corner cut: if the point is past the diagonal edge, slide it back onto that edge (the closest
  // point on the line |U| + |V| = diagLimit within this quadrant). Re-clamp the reduced magnitudes
  // to [0, half] so an extreme, lopsided input lands on the box edge rather than overshooting past
  // the center to the wrong side.
  const cornerOverflow = Math.abs(alongU) + Math.abs(alongV) - diagLimit;
  if (cornerOverflow > 0) {
    const halfOverflow = cornerOverflow / 2;
    const reducedU = Math.max(0, Math.min(halfU, Math.abs(alongU) - halfOverflow));
    const reducedV = Math.max(0, Math.min(halfV, Math.abs(alongV) - halfOverflow));
    alongU = Math.sign(alongU) * reducedU;
    alongV = Math.sign(alongV) * reducedV;
  }

  const worldX = centerX + alongU * axisUx + alongV * axisVx;
  const worldZ = centerZ + alongU * axisUz + alongV * axisVz;

  // Left/right walls: clamp world x last. Pulling x toward the center at fixed z keeps the point
  // inside the (convex) octagon, so this only narrows the sides without affecting front/back.
  return {
    x: Math.max(minX, Math.min(maxX, worldX)),
    z: worldZ,
  };
}

/**
 * Tighten a slab-sized boundary down to the region the play actually occupies. Projects the given
 * confinement points (e.g. every base position) into the boundary's rotated frame, then sizes the
 * box half-extents and the corner cut to the farthest point plus a margin — never exceeding the
 * original (slab) extents. This keeps every base comfortably inside while pulling the edges in
 * from the oversized slab so units cannot wander out onto the empty diamond tips.
 */
export function confineBoundaryToPoints(
  slab: ArenaBoundary,
  points: ReadonlyArray<{ x: number; z: number }>,
  axisMargin: number,
  cornerMargin: number,
): ArenaBoundary {
  if (points.length === 0) return slab;

  let maxU = 0;
  let maxV = 0;
  let maxDiagonal = 0;
  for (const point of points) {
    const offsetX = point.x - slab.centerX;
    const offsetZ = point.z - slab.centerZ;
    const alongU = Math.abs(offsetX * slab.axisUx + offsetZ * slab.axisUz);
    const alongV = Math.abs(offsetX * slab.axisVx + offsetZ * slab.axisVz);
    if (alongU > maxU) maxU = alongU;
    if (alongV > maxV) maxV = alongV;
    if (alongU + alongV > maxDiagonal) maxDiagonal = alongU + alongV;
  }

  return {
    ...slab,
    halfU: Math.min(slab.halfU, maxU + axisMargin),
    halfV: Math.min(slab.halfV, maxV + axisMargin),
    diagLimit: Math.min(slab.halfU + slab.halfV, maxDiagonal + cornerMargin),
  };
}

let activeBoundary: ArenaBoundary | null = null;

/**
 * Register the Arena boundary so movable units can be confined to it. Called once after the battle
 * map loads. Passing null disables clamping (e.g. before the map is ready), so the game behaves
 * exactly as before when no boundary is known.
 */
export function registerArenaBoundary(boundary: ArenaBoundary | null): void {
  activeBoundary = boundary;
}

/** The currently registered boundary, or null if none. Exposed mainly for diagnostics. */
export function getArenaBoundary(): ArenaBoundary | null {
  return activeBoundary;
}

/**
 * Clamp a position to the registered Arena boundary in place, mutating x/z so a unit can never step
 * past the playable edge. Y is left untouched (terrain height is resolved elsewhere). No-op until a
 * boundary is registered.
 */
export function clampToArena(position: Position3D): void {
  if (!activeBoundary) return;
  const clamped = clampPointToBoundary(activeBoundary, position.x, position.z);
  position.x = clamped.x;
  position.z = clamped.z;
}
