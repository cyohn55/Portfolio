// Pure geometry for the two-ring combat-posture radial (see BehaviorRadial.tsx).
//
// This module owns the math that turns a controller right-stick vector into the
// ring + wedge it addresses, with no React / Three.js / DOM imports so it can be
// unit-tested directly and reused identically by the on-screen radial and the
// gamepad poller. The radial lays out two concentric rings around a center toggle:
//   - center  → the fire-mode toggle (addressed when the stick is near rest)
//   - inner   → posture wedges       (addressed at a half-push)
//   - outer   → target-priority wedges (addressed at a full push)
// so the stick's deflection MAGNITUDE selects the ring and its ANGLE selects the
// wedge within that ring.

export type RadialRing = 'fire' | 'posture' | 'priority';

export interface RadialHover {
  ring: RadialRing;
  /** Wedge index within the ring; ignored for the single-target fire ring. */
  index: number;
}

// Right-stick deflection bands that pick which ring the aim addresses. Below
// FIRE_BAND the stick is "at rest" and the center fire toggle is addressed;
// between the bands the inner posture ring; at/above POSTURE_BAND the outer
// priority ring. A full deflection is magnitude 1, so POSTURE_BAND < 1 leaves
// headroom for the outer ring.
export const FIRE_BAND = 0.4;
export const POSTURE_BAND = 0.75;

// Which wedge (of `count`, placed at angle_i = -90 + i*(360/count) degrees in
// screen space, x right / y down) a right-stick vector points at. The stick uses
// the same x-right / y-down convention (up is negative), so the aim angle maps
// straight onto the wedge angles. Returns the index whose angle is closest,
// wrapping correctly across the ±180° seam. `count` must be >= 1.
export function wedgeFromVector(x: number, y: number, count: number): number {
  const aimDeg = Math.atan2(y, x) * (180 / Math.PI);
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < count; i++) {
    const wedgeDeg = -90 + i * (360 / count);
    const diff = Math.abs(((aimDeg - wedgeDeg + 540) % 360) - 180);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

// Resolve a raw right-stick vector into the ring + wedge it addresses. The
// deflection magnitude selects the ring (rest = fire center, mid = posture ring,
// full = priority ring); the angle selects the wedge within a ring. The wedge
// counts are passed in so this stays decoupled from the radial's option lists.
export function hoverFromVector(
  x: number,
  y: number,
  postureCount: number,
  priorityCount: number,
): RadialHover {
  const magnitude = Math.hypot(x, y);
  if (magnitude < FIRE_BAND) return { ring: 'fire', index: 0 };
  if (magnitude < POSTURE_BAND) return { ring: 'posture', index: wedgeFromVector(x, y, postureCount) };
  return { ring: 'priority', index: wedgeFromVector(x, y, priorityCount) };
}
