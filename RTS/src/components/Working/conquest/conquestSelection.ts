// Conquest pointer-selection geometry: the pure math behind picking points and
// units on the globe through the third-person chase camera.
//
// Single responsibility: own the side-effect-free geometry the pointer UI needs —
// where a screen ray meets the planet (for move/attack orders) and whether a
// projected unit falls inside a drag box (for box-select). Keeping these pure lets
// ConquestField own all the DOM/event wiring while this module stays node-testable,
// exactly as conquestCombat / conquestAbilities do for the simulation.
//
// Why this mirrors Quick Play: the player commands their armies with the same
// pointer model as the battlemap (left-click / drag-box to select, right-click to
// order), so Conquest reuses that feel. The difference is purely geometric — orders
// land on a sphere instead of a flat plane — so only the ray hit-test changes.

import * as THREE from 'three';

/**
 * The point where a ray first meets a sphere of `radius` centered at the origin, or
 * null if it misses (or only meets it behind the ray). Used to turn a screen-space
 * pointer ray into a spot on the planet for a move order. Pure: solves the quadratic
 * |origin + t·direction|² = radius² for the smallest t ≥ 0.
 */
export function raySphereHit(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  radius: number,
): THREE.Vector3 | null {
  const dir = direction.clone().normalize();
  // |o + t d|² = r²  →  t² + 2(o·d)t + (o·o − r²) = 0  (d is unit length).
  const b = 2 * origin.dot(dir);
  const c = origin.dot(origin) - radius * radius;
  const discriminant = b * b - 4 * c;
  if (discriminant < 0) return null;
  const sqrtDiscriminant = Math.sqrt(discriminant);
  const tNear = (-b - sqrtDiscriminant) / 2;
  const tFar = (-b + sqrtDiscriminant) / 2;
  // Prefer the near hit; if the camera sits inside the sphere take the far one.
  const t = tNear >= 0 ? tNear : tFar;
  if (t < 0) return null;
  return origin.clone().addScaledVector(dir, t);
}

/** An axis-aligned screen rectangle in pixels (order-independent corners). */
export interface ScreenBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Normalize two drag corners into a min/max screen box. */
export function screenBoxFromDrag(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): ScreenBox {
  return {
    minX: Math.min(startX, endX),
    minY: Math.min(startY, endY),
    maxX: Math.max(startX, endX),
    maxY: Math.max(startY, endY),
  };
}

/** True when a projected screen point lies inside the drag box. */
export function pointInScreenBox(x: number, y: number, box: ScreenBox): boolean {
  return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
}

/** The squared pixel distance between two screen points (cheap nearest-pick test). */
export function screenDistanceSquared(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}
