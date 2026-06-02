/**
 * monarchPilot — shared, framework-free helpers and runtime state for the
 * "direct pilot" feature, where the player drives a King or Queen with the
 * ESDF keys (or the controller's left stick) instead of issuing mouse orders.
 *
 * This module is intentionally free of React and Three.js so its pure helpers
 * can be unit tested in isolation and reused by both the input layer (which
 * writes the per-frame movement vector) and the game tick (which reads it to
 * move the piloted unit). It owns:
 *   - the `pilotInput` singleton: a single mutable XZ movement vector written
 *     each frame by the camera/input layer and read by the game tick,
 *   - pure helpers for resolving which monarch a slot/toggle targets and for
 *     deciding when rallying followers should keep chasing the monarch.
 */

import type { AnimalId, Unit, UnitKind } from '../../game/types';

/**
 * How close (world units) a rallying follower must get to its monarch before it
 * stops actively re-pathing toward it and idles nearby. Without a stop band the
 * followers would jitter against the monarch every tick trying to occupy the
 * exact same spot.
 */
export const MONARCH_FOLLOW_STOP_DISTANCE = 6;

/**
 * The hard minimum distance (world units) a rallying follower is allowed to sit from the
 * monarch it is trailing. The piloted monarch is driven by the player and is immovable by
 * the spacing passes, so without this floor the follow chase and crowd relaxation would let
 * front-rank followers drift right up against it (and, before the monarch was made immovable,
 * shove it around). It is kept below MONARCH_FOLLOW_STOP_DISTANCE so followers settle into the
 * stop band rather than fighting this floor every tick — the floor only bites when the monarch
 * reverses into the crowd or a rear rank presses a front rank inward.
 */
export const MONARCH_FOLLOW_GAP = 5;

/**
 * How long (milliseconds) the player must keep the rally key held to designate
 * one more unit for a placement order. Holding for N * this interval designates
 * N units; the on-screen teardrop indicator increments once per interval. Kept
 * here (rather than in the input layer) so the constant is unit-testable and the
 * "750ms per placed unit" rule has a single source of truth.
 */
export const UNIT_PLACEMENT_INTERVAL_MS = 750;

/** The two pilotable monarch kinds, in the order the toggle cycles them. */
export type MonarchKind = Extract<UnitKind, 'King' | 'Queen'>;

/**
 * A camera-relative movement vector on the XZ plane. Components are already in
 * world space (the input layer rotates raw key presses into the camera's frame)
 * and the magnitude is in [0, 1] so analog sticks can drive partial speed.
 */
export interface PilotMoveVector {
  x: number;
  z: number;
}

/**
 * The single source of truth for the piloted unit's current movement intent.
 * The camera/input layer writes it every frame; the game tick reads it when it
 * processes the piloted unit. A mutable singleton (mirroring `gamepadInput` and
 * `keyboardCoordinator`) keeps this off the React/Zustand path so a 60 Hz input
 * stream never triggers store updates or re-renders.
 */
class PilotInput {
  private moveX = 0;
  private moveZ = 0;

  /** Record this frame's camera-relative movement intent. */
  setMove(x: number, z: number): void {
    this.moveX = x;
    this.moveZ = z;
  }

  /** Read the current movement intent (a fresh object so callers can't mutate state). */
  getMove(): PilotMoveVector {
    return { x: this.moveX, z: this.moveZ };
  }

  /** Clear the intent so the piloted unit holds position (e.g. on blur or unpilot). */
  reset(): void {
    this.moveX = 0;
    this.moveZ = 0;
  }
}

export const pilotInput = new PilotInput();

/** Given one monarch kind, return the other so a toggle swaps King <-> Queen. */
export function otherMonarchKind(kind: MonarchKind): MonarchKind {
  return kind === 'King' ? 'Queen' : 'King';
}

/**
 * Find a living monarch (King or Queen) of the given owner, animal, and kind.
 * Returns null when that monarch is dead or was never present, so callers can
 * decline to start (or silently drop) a pilot request.
 */
export function findMonarch(
  units: readonly Unit[],
  ownerId: string,
  animal: AnimalId,
  kind: MonarchKind
): Unit | null {
  for (const unit of units) {
    if (
      unit.ownerId === ownerId &&
      unit.animal === animal &&
      unit.kind === kind &&
      unit.hp > 0
    ) {
      return unit;
    }
  }
  return null;
}

/**
 * A rallying follower keeps chasing its monarch only while it is farther than
 * the stop band; once inside it idles. Kept as a pure predicate so the rally
 * behaviour is testable without the whole tick.
 */
export function shouldChaseMonarch(
  distanceToMonarch: number,
  stopDistance: number = MONARCH_FOLLOW_STOP_DISTANCE
): boolean {
  return distanceToMonarch > stopDistance;
}

/** A point on the XZ plane. Kept local so this geometry helper stays framework-free. */
export interface PointXZ {
  x: number;
  z: number;
}

/**
 * The XZ position a follower must move to so it sits no closer than `gap` to its monarch,
 * pushing it straight out along the monarch->follower direction. Returns `null` when the
 * follower is already at or beyond the gap (nothing to do). A follower coincident with the
 * monarch is pushed out along +X so the result is deterministic (and unit-testable) rather
 * than random. Pure geometry: the caller applies terrain/arena constraints to the result.
 */
export function followGapClearance(
  follower: PointXZ,
  monarch: PointXZ,
  gap: number
): PointXZ | null {
  const dx = follower.x - monarch.x;
  const dz = follower.z - monarch.z;
  const distanceSquared = dx * dx + dz * dz;
  if (distanceSquared >= gap * gap) return null; // already outside the gap

  const distance = Math.sqrt(distanceSquared);
  // Coincident with the monarch: choose a fixed escape heading so the push is deterministic.
  const directionX = distance < 1e-6 ? 1 : dx / distance;
  const directionZ = distance < 1e-6 ? 0 : dz / distance;
  return {
    x: monarch.x + directionX * gap,
    z: monarch.z + directionZ * gap,
  };
}

/** Squared XZ distance between two points (cheaper than the rooted distance for sorting). */
function squaredDistanceXZ(a: PointXZ, b: PointXZ): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/**
 * Clamp a requested placement count to what the rally can actually honor: never
 * negative and never more followers than are currently trailing the monarch. The
 * hold indicator uses this so the teardrop stops climbing once every available
 * follower has been designated.
 */
export function clampPlacementCount(requested: number, availableFollowers: number): number {
  if (requested < 0) return 0;
  if (availableFollowers < 0) return 0;
  return Math.min(requested, availableFollowers);
}

/**
 * Pick which followers peel off to a placement point: the `count` followers
 * nearest the destination, so the units closest to where the player wants them
 * break formation first (the rest keep trailing the monarch). Pure selection so
 * the placement rule is testable without the tick; the caller issues the orders.
 */
export function selectFollowersForPlacement(
  followers: readonly Unit[],
  destination: PointXZ,
  count: number
): Unit[] {
  if (count <= 0) return [];
  return [...followers]
    .sort(
      (first, second) =>
        squaredDistanceXZ(first.position, destination) -
        squaredDistanceXZ(second.position, destination)
    )
    .slice(0, count);
}
