/**
 * movementSteering — local obstacle-avoidance steering for moving ground units.
 *
 * The grid A* pathfinder (see pathfinder.ts) routes ground units around static
 * terrain — the water moat and the bridges — but treats other units as transparent,
 * because they move. A unit ordered through a clump of *stationary* teammates therefore
 * aims straight at its destination and rams the clump head-on: the collision pass ejects
 * it radially, and against a wall of units that ejection points back along its own path,
 * cancelling forward progress so the unit never finds the way around. To the player this
 * reads as "it sometimes goes around, sometimes just stops trying."
 *
 * This module supplies the missing piece: a look-ahead steering bias that detects the
 * nearest blocker sitting in the unit's travel lane and bends the travel direction
 * tangentially past it, so the unit commits to one side and slides by. It is deliberately
 * free of React and THREE (mirroring pathfinder.ts) so the pure geometry can be unit
 * tested in isolation. The caller decides *which* neighbours count as blockers (own side,
 * currently stationary, and how wide a berth each needs); this module only decides *how*
 * to steer around the set it is handed.
 */

import type { Position3D } from '../../game/types';

/**
 * How far ahead (world units) to scan the travel lane for a blocker. Roughly two
 * unit-widths: far enough to begin the turn before contact, short enough that a distant
 * teammate doesn't bend the course.
 */
export const BLOCKER_LOOKAHEAD = 6;

/**
 * Maximum lateral steer blended into the travel direction when a blocker sits right at
 * contact. At ~1.2 the closest blocker bends the heading by a little over 45 degrees —
 * enough to slide decisively around a clump without ever reversing the unit.
 */
export const BLOCKER_DEFLECT_STRENGTH = 1.2;

/**
 * One obstacle in the mover's path: where it stands and how wide a berth (the half-width
 * of the travel lane) the mover must give it. The caller computes `laneHalfWidth` from the
 * pair's minimum spacing so a unit's personal space stays the single source of truth.
 */
export interface SteerBlocker {
  position: Position3D;
  laneHalfWidth: number;
}

/** Normalize an XZ vector; a zero-length vector is returned unchanged (no NaNs). */
function normalizeXZ(x: number, z: number): { x: number; z: number } {
  const length = Math.hypot(x, z);
  if (length === 0) return { x: 0, z: 0 };
  return { x: x / length, z: z / length };
}

/**
 * Bend `desiredDir` tangentially around the nearest blocker that lies ahead in the mover's
 * travel lane, returning a new normalized XZ direction. When no blocker is in the lane the
 * desired direction is returned unchanged.
 *
 * The lane is the strip of width `2 * laneHalfWidth` extending forward from `origin` along
 * `desiredDir`. A blocker counts only if it is ahead (positive forward projection), within
 * `lookAhead`, and within its own lane half-width of the centerline. The mover steers to the
 * side opposite the blocker; a blocker dead-centre defaults to steering right so the unit
 * never dithers. A nearer blocker deflects harder (full strength at contact, easing to zero
 * at the look-ahead edge) so the turn eases in rather than snapping.
 *
 * @param origin     The mover's current XZ position (only x/z are read).
 * @param desiredDir The mover's intended travel direction; expected normalized on XZ.
 * @param blockers   Candidate obstacles the caller has already filtered to "should avoid."
 */
export function deflectAroundBlockers(
  origin: Position3D,
  desiredDir: Position3D,
  blockers: Iterable<SteerBlocker>,
  lookAhead: number = BLOCKER_LOOKAHEAD,
  strength: number = BLOCKER_DEFLECT_STRENGTH
): Position3D {
  // Left-hand normal of the travel direction on the XZ plane: used both to measure how far
  // off the centerline a blocker sits (its signed lateral offset) and to steer sideways.
  const leftX = -desiredDir.z;
  const leftZ = desiredDir.x;

  let nearestForward = Infinity;
  let blockerLateral = 0; // signed lateral offset of the chosen blocker (left is positive)

  for (const blocker of blockers) {
    const toX = blocker.position.x - origin.x;
    const toZ = blocker.position.z - origin.z;

    const forward = toX * desiredDir.x + toZ * desiredDir.z;
    if (forward <= 0 || forward > lookAhead) continue; // behind, beside, or beyond look-ahead

    const lateral = toX * leftX + toZ * leftZ;
    if (Math.abs(lateral) > blocker.laneHalfWidth) continue; // outside the travel lane

    if (forward < nearestForward) {
      nearestForward = forward;
      blockerLateral = lateral;
    }
  }

  if (nearestForward === Infinity) return desiredDir; // lane is clear — keep the heading

  const steerSign = blockerLateral > 0 ? -1 : 1; // steer opposite the blocker (centre -> right)
  const proximity = 1 - nearestForward / lookAhead; // 1 at contact, 0 at the look-ahead edge
  const weight = strength * proximity * steerSign;

  const steered = normalizeXZ(desiredDir.x + leftX * weight, desiredDir.z + leftZ * weight);
  return { x: steered.x, y: desiredDir.y, z: steered.z };
}
