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
