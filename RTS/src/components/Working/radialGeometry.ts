// Pure geometry for the combat-posture radial (see BehaviorRadial.tsx).
//
// This module owns the math that turns a controller right-stick vector into the
// option it addresses, with no React / Three.js / DOM imports so it can be
// unit-tested directly and reused identically by the on-screen radial and the
// gamepad poller. The radial is a single ring of option circles around a center
// toggle:
//   - center      → the fire-mode toggle (addressed when the stick is near rest)
//   - TOP half     → the posture options   (upper semicircle)
//   - BOTTOM half  → the target-priority options (lower semicircle)
// so the stick's deflection MAGNITUDE chooses center-vs-ring and its ANGLE chooses
// the option (a top-half angle resolves to a posture, a bottom-half angle to a
// priority).

export type RadialRing = 'fire' | 'posture' | 'priority';

export interface RadialHover {
  ring: RadialRing;
  /** Option index within its group; ignored for the single-target fire ring. */
  index: number;
}

// Right-stick deflection below which the stick is "at rest" and the center fire
// toggle is addressed; any larger push selects a ring option by angle.
export const FIRE_BAND = 0.4;

// Placement angle (screen degrees: 0°=right, 90°=down, 270°=up) for the index-th
// option in a half-ring of `count` items. 'top' fills the upper semicircle
// (180°→360°), used by the posture circles; 'bottom' fills the lower semicircle
// (0°→180°), used by the priority circles. Each item is centered in an equal
// sub-arc so its group is evenly spread and the two halves meet at clean gaps on
// the horizontal split — no circle lands on the dividing line. With equal group
// counts this places all options at one uniform angular step around the ring.
export function semicircleAngleDeg(half: 'top' | 'bottom', index: number, count: number): number {
  const base = half === 'top' ? 180 : 0;
  return base + (180 / count) * (index + 0.5);
}

// Smallest absolute difference between two angles (degrees), wrapping across the
// ±180° seam so e.g. 350° and 10° are 20° apart.
function angleDiffDeg(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

// --- Full-ring radial (the formation play wheel) ----------------------------
// A single FULL ring of N equal options with no center action — used by the
// formation wheel rather than the posture radial's split top/bottom layout. Index
// 0 sits at the top (12 o'clock) and the rest run clockwise, so the wheel reads
// like a clock face.

// Screen-degree placement (0°=right, 90°=down) of the index-th option in a full
// ring of `count` items, starting at the top (270°/−90°) and stepping clockwise.
export function fullRingAngleDeg(index: number, count: number): number {
  return -90 + (360 / count) * index;
}

// Resolve a raw stick vector into the full-ring option it addresses: the option
// whose placement angle is closest to the aim. Returns null when the stick is
// within FIRE_BAND of rest (no option addressed) so an at-rest stick highlights
// nothing rather than snapping to index 0, and null for an empty ring.
export function ringIndexFromVector(x: number, y: number, count: number): number | null {
  if (count <= 0) return null;
  if (Math.hypot(x, y) < FIRE_BAND) return null;
  const aimDeg = Math.atan2(y, x) * (180 / Math.PI);
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < count; i++) {
    const diff = angleDiffDeg(aimDeg, fullRingAngleDeg(i, count));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

// Resolve a raw right-stick vector into the option it addresses. A near-rest stick
// (magnitude below FIRE_BAND) addresses the center fire toggle; any larger push
// selects the single ring option whose placement angle is closest to the aim — the
// top half resolves to a posture, the bottom half to a priority. The group counts
// are passed in so this stays decoupled from the radial's option lists.
export function hoverFromVector(
  x: number,
  y: number,
  postureCount: number,
  priorityCount: number,
): RadialHover {
  if (Math.hypot(x, y) < FIRE_BAND) return { ring: 'fire', index: 0 };

  const aimDeg = Math.atan2(y, x) * (180 / Math.PI);
  let best: RadialHover = { ring: 'posture', index: 0 };
  let bestDiff = Infinity;
  for (let i = 0; i < postureCount; i++) {
    const diff = angleDiffDeg(aimDeg, semicircleAngleDeg('top', i, postureCount));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = { ring: 'posture', index: i };
    }
  }
  for (let j = 0; j < priorityCount; j++) {
    const diff = angleDiffDeg(aimDeg, semicircleAngleDeg('bottom', j, priorityCount));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = { ring: 'priority', index: j };
    }
  }
  return best;
}
