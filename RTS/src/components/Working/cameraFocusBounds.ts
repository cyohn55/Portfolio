import { type ArenaBoundary, clampPointToBoundary } from './arenaBoundary';

/**
 * cameraFocusBounds — confine the camera's focus point to the playable map.
 *
 * The camera has its own continuous pan inputs (controller stick, mouse edge-pan, middle-drag,
 * selection auto-follow). None of them were bounded, so any residual input — most notably analog
 * stick drift — could slide the focus point off the map indefinitely and "push the camera out of
 * the map" with no way to stop it. This module clamps the focus to the registered Arena boundary
 * so the view can never leave the field.
 *
 * The focus is clamped to a slightly *expanded* copy of the unit-confinement boundary: the camera
 * frames an area, so its focus must be allowed a little past the last unit's footprint to keep a
 * unit fighting at the very edge comfortably on screen — but only by a fixed margin, never into the
 * empty void beyond the slab. Pure (no Three.js / scene-graph coupling) so it is unit-testable.
 */

/**
 * How far (world units) the camera focus may travel past the unit-confinement boundary on each
 * side. Enough to keep edge skirmishes framed; far short of the slab rim, so the focus still rests
 * over solid terrain. The Arena slab is much larger than the unit boundary, so this never exposes
 * the void.
 */
export const CAMERA_FOCUS_MARGIN = 40;

/**
 * Grow a boundary outward by `margin` on every side so the camera focus has breathing room past the
 * unit edge. Both rotated half-extents grow by `margin`; the diagonal corner cut grows by `2 *
 * margin` (it caps |U| + |V|, and both terms may grow by `margin`); the straight left/right walls
 * each move out by `margin`. Infinite limits (no corner cut / no wall) stay infinite.
 */
export function expandBoundaryForCamera(boundary: ArenaBoundary, margin: number): ArenaBoundary {
  return {
    ...boundary,
    halfU: boundary.halfU + margin,
    halfV: boundary.halfV + margin,
    diagLimit: Number.isFinite(boundary.diagLimit) ? boundary.diagLimit + 2 * margin : boundary.diagLimit,
    minX: Number.isFinite(boundary.minX) ? boundary.minX - margin : boundary.minX,
    maxX: Number.isFinite(boundary.maxX) ? boundary.maxX + margin : boundary.maxX,
  };
}

/**
 * Clamp a camera focus point to the map. Returns the point unchanged when no boundary is registered
 * (e.g. before the map loads) so behaviour is identical to before clamping existed. Otherwise the
 * focus is confined to the boundary grown by `margin`.
 */
export function clampCameraFocus(
  boundary: ArenaBoundary | null,
  x: number,
  z: number,
  margin: number = CAMERA_FOCUS_MARGIN,
): { x: number; z: number } {
  if (!boundary) return { x, z };
  return clampPointToBoundary(expandBoundaryForCamera(boundary, margin), x, z);
}
