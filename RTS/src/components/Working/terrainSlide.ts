/**
 * terrainSlide — slide a blocked ground step along an obstacle boundary.
 *
 * Ground units are confined to walkable terrain (everything but the water moat, unless a
 * bridge is lowered). When a unit's intended step lands on forbidden water — usually
 * because the crowd or a spacing push nudged it off its route toward the bank — the mover
 * must not simply dead-stall: a stalled unit jams the units behind it and reads to the
 * player as "stuck where the land meets the water."
 *
 * The previous fix tried only two recovery moves: slide along pure +X, then along pure +Z.
 * That frees a unit pressed against an axis-aligned bank, but the moat and coastline run at
 * arbitrary angles, and against a diagonal bank neither pure-axis slide stays on land — so
 * the unit holds and the pile-up persists. This module instead deflects the intended step
 * by a fan of increasing angles to either side and keeps the first heading that stays on
 * walkable ground, so a unit meeting a bank at any angle glides along it.
 *
 * It is deliberately free of THREE and of the game store (mirroring pathfinder.ts and
 * movementSteering.ts): the caller supplies a pure `isWalkable` predicate, so the geometry
 * can be unit-tested against synthetic terrain. Because it uses only fixed arithmetic and
 * the caller's deterministic terrain query — no RNG, no wall-clock — it is safe to call on
 * the multiplayer lockstep tick path.
 */

import type { Position3D } from '../../game/types';

/** Whether a ground unit may stand at `position`. Supplied by the caller. */
export type WalkableProbe = (position: Position3D) => boolean;

/**
 * Deflection angles (radians) tried in order when the straight step is blocked. The
 * straight step itself is omitted because the caller only invokes the slide once it has
 * confirmed the step is blocked. Angles grow from a gentle nudge to a full right-angle
 * tangent and alternate sides at each magnitude, so the unit takes the smallest deflection
 * that frees it and ties break to the same side on both peers (determinism). Nothing beyond
 * ±90° is tried: a larger turn would carry the unit backward, losing progress, so holding
 * is preferable to reversing.
 */
export const SHORE_SLIDE_ANGLES: readonly number[] = [
  Math.PI / 12, -Math.PI / 12, // ±15°
  Math.PI / 6, -Math.PI / 6, // ±30°
  Math.PI / 4, -Math.PI / 4, // ±45°
  Math.PI / 3, -Math.PI / 3, // ±60°
  (5 * Math.PI) / 12, -(5 * Math.PI) / 12, // ±75°
  Math.PI / 2, -Math.PI / 2, // ±90° (pure tangent — the old pure-axis slide's best case)
];

/**
 * Resolve a ground unit's blocked step by sliding along the obstacle boundary.
 *
 * @param from       The unit's current (walkable) position.
 * @param to         The intended step, which the caller has found lands on forbidden terrain.
 * @param isWalkable Predicate deciding whether a candidate position is walkable.
 * @param angles     Deflection fan to probe; defaults to {@link SHORE_SLIDE_ANGLES}.
 * @returns The walkable position nearest the intended heading, or `from` (hold this tick)
 *          when every probed heading is blocked. The returned y is always `from.y` — height
 *          is owned by the deck-elevation pass, not the slide.
 */
export function slideAlongObstacle(
  from: Position3D,
  to: Position3D,
  isWalkable: WalkableProbe,
  angles: readonly number[] = SHORE_SLIDE_ANGLES,
): Position3D {
  const stepX = to.x - from.x;
  const stepZ = to.z - from.z;
  if (stepX === 0 && stepZ === 0) return { x: from.x, y: from.y, z: from.z };

  for (const angle of angles) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Rotate the intended displacement about the unit, preserving its length so the unit
    // keeps its speed while skimming the bank.
    const candidate: Position3D = {
      x: from.x + stepX * cos - stepZ * sin,
      y: from.y,
      z: from.z + stepX * sin + stepZ * cos,
    };
    if (isWalkable(candidate)) return candidate;
  }

  return { x: from.x, y: from.y, z: from.z }; // boxed in on every probed heading — hold
}
