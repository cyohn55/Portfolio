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
 * How long (milliseconds) the player must hold the rally key before the FIRST
 * unit is designated (and the teardrop indicator appears). Kept here (rather
 * than in the input layer) so the timing is unit-testable and has a single
 * source of truth.
 */
export const UNIT_PLACEMENT_INTERVAL_MS = 750;

/**
 * How long (milliseconds) each SUBSEQUENT unit takes once the first has been
 * designated — shorter than the initial hold so designating a large group ramps
 * up quickly. Tunable independently of the initial delay.
 */
export const UNIT_PLACEMENT_REPEAT_INTERVAL_MS = 500;

/**
 * The deployment ladder: the sequence of designated-unit counts the Deploy hold
 * steps through as it is held (instead of climbing one unit at a time). Each
 * placement interval advances to the next rung, so the teardrop reads 1, 5, 10,
 * 15, 25 — designating a meaningful batch quickly while still letting a quick hold
 * peel just a few. The final rung's stride (here 10) continues the ladder past 25
 * (35, 45, …) so an oversized rally can still be claimed in full. Always clamped to
 * the followers actually available (see clampPlacementCount).
 */
export const PLACEMENT_LADDER: readonly number[] = [1, 5, 10, 15, 25];

/**
 * Given the count designated so far, the next rung the Deploy hold should climb
 * to. Returns the smallest ladder value strictly greater than `current`; past the
 * top rung it keeps climbing by the final stride so very large rallies still ramp.
 * Pure and monotonic (always > current) so the hold cannot stall mid-climb.
 */
export function nextPlacementStep(current: number): number {
  for (const rung of PLACEMENT_LADDER) {
    if (rung > current) return rung;
  }
  const top = PLACEMENT_LADDER[PLACEMENT_LADDER.length - 1];
  const finalStride = top - PLACEMENT_LADDER[PLACEMENT_LADDER.length - 2];
  const stepsPastTop = Math.floor((current - top) / finalStride) + 1;
  return top + stepsPastTop * finalStride;
}

/**
 * Two presses of the Select All / Rally input within this window count as a
 * "double tap" that escalates from rallying one animal's army to selecting every
 * unit. Shared by both input layers (keyboard Space and the controller's bound
 * button) so the tap / double-tap / hold gesture behaves identically on each.
 */
export const DOUBLE_PRESS_WINDOW_MS = 350;

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
 * The selection to apply when a monarch becomes the piloted/selected unit: the
 * monarch itself plus every army Unit currently following it (followMonarchId ===
 * monarchId). Any unit trailing a King must be selected alongside him so the
 * player can immediately command the band — otherwise reselecting a King that
 * already has followers (e.g. cycling back to him with "A") would leave those
 * followers trailing but unselected and unorderable. The monarch leads the list
 * so its gold piloting ring / HUD highlight stays anchored to it.
 */
export function selectionForMonarch(units: readonly Unit[], monarchId: string): string[] {
  const followerIds = units
    .filter((unit) => unit.kind === 'Unit' && unit.followMonarchId === monarchId)
    .map((unit) => unit.id);
  return [monarchId, ...followerIds];
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

// --- Fire teams --------------------------------------------------------------
// A "fire team" is the group of units dropped in a single Deploy. Each deploy
// mints one shared fireTeamId on the units it places, and the player can hand a
// piloted monarch's drive control onto a whole team to steer all of its members
// at once from across the map. These pure helpers resolve the team list and the
// cycle order; the store owns the live driven-team state and the tick the steering.

/**
 * Parse the trailing integer of a deterministically-minted fire-team id (e.g.
 * "FT-7" -> 7) so teams cycle in creation order regardless of how the units array
 * is currently ordered. Ids without a numeric suffix sort first (order 0).
 */
function fireTeamCreationOrder(fireTeamId: string): number {
  const match = /(\d+)$/.exec(fireTeamId);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * The distinct fire-team ids an owner currently fields, in creation order. Only
 * teams with at least one living member are listed, so a wiped-out team drops out
 * of the cycle automatically. Pure so the cycle order is testable without the store.
 */
export function listFireTeamIds(units: readonly Unit[], ownerId: string): string[] {
  const teamIds = new Set<string>();
  for (const unit of units) {
    if (unit.ownerId === ownerId && unit.fireTeamId !== undefined && unit.hp > 0) {
      teamIds.add(unit.fireTeamId);
    }
  }
  return [...teamIds].sort((first, second) => fireTeamCreationOrder(first) - fireTeamCreationOrder(second));
}

/**
 * The next team the cycle key should drive, given the ordered team list and the
 * team being driven now (or null when none). Advances to the next team, and from
 * the last team wraps back to null (release) so the key toggles fire-team driving
 * off after the final team. Returns null when there are no teams. Pure selection;
 * the caller issues the (routed) drive-switch.
 */
export function nextFireTeamInCycle(teamIds: readonly string[], current: string | null): string | null {
  if (teamIds.length === 0) return null;
  if (current === null) return teamIds[0];
  const currentIndex = teamIds.indexOf(current);
  if (currentIndex === -1) return teamIds[0];
  // Past the last team, fall back to "no team" so the cycle key releases control.
  return currentIndex + 1 < teamIds.length ? teamIds[currentIndex + 1] : null;
}
