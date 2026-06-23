// Pure, deterministic helpers for the "quick-direct" fire-team gesture: while the
// player holds the Left Bumper, each of the acting player's fire teams is bound to a
// face button. Tapping that button arms an aim arrow anchored on the team; the right
// stick rotates the arrow a full 360°, and the right trigger sends the team that way.
// It is a fast, on-the-fly alternative to opening the Directing wheel.
//
// Everything here is side-effect-free so it can be unit-tested directly and reused by
// the controller poll loop (GamepadController) without pulling in Three.js or the DOM.
// Headings follow the same convention as FireTeamState.facing / formations.worldSlot:
// the forward axis is (sin h, cos h), so a ground vector (x, z) has heading atan2(x, z).

import type { FireTeamState, Position3D, Unit } from '../../game/types';

/** A button a fire team can be bound to while the Left Bumper is held. */
export interface ButtonSlot {
  token: string;
  glyph: string;
}

// Every controller button that can be assigned to a fire team while LB is held, in
// assignment order. The right trigger (send) and B (cancel) are deliberately NOT
// here — they keep their fixed roles during the gesture — and the right stick aims
// the arrow rather than selecting. Everything else is fair game: the face buttons
// first (most reachable), then the remaining shoulders/sticks, then the D-pad. Tokens
// are read physically (Standard Gamepad indices), like the Directing wheel's page-flip
// bumpers, so the gesture is independent of the remappable action bindings.
export const FIRE_TEAM_BUTTON_SLOTS: readonly ButtonSlot[] = [
  { token: 'button:0', glyph: 'A' },
  { token: 'button:2', glyph: 'X' },
  { token: 'button:3', glyph: 'Y' },
  { token: 'button:5', glyph: 'RB' },
  { token: 'button:6', glyph: 'LT' },
  { token: 'button:10', glyph: 'L3' },
  { token: 'button:11', glyph: 'R3' },
  { token: 'button:12', glyph: '↑' },
  { token: 'button:13', glyph: '↓' },
  { token: 'button:14', glyph: '←' },
  { token: 'button:15', glyph: '→' },
];

// The right trigger sends the armed team along the arrow; B cancels the pick. Both are
// read physically so the gesture's fixed verbs never collide with a remapped binding.
export const FIRE_TEAM_SEND_BUTTON = 'button:7'; // RT
export const FIRE_TEAM_CANCEL_BUTTON = 'button:1'; // B

/** A fire team bound to a button for the duration of a Left-Bumper hold. */
export interface FireTeamButtonAssignment {
  teamId: string;
  token: string;
  glyph: string;
}

/**
 * The acting player's directable fire teams: every team id with at least one living
 * owned army Unit AND a live formation entry, sorted by id. Sorting makes the button
 * assignment stable across frames (and identical on both lockstep peers), so a team
 * keeps the same button for the whole hold and the badges never reshuffle.
 */
export function directableFireTeamIds(
  units: readonly Unit[],
  fireTeams: Record<string, FireTeamState>,
  ownerId: string | null,
): string[] {
  if (!ownerId) return [];
  const ids = new Set<string>();
  for (const unit of units) {
    const teamId = unit.fireTeamId;
    if (teamId === undefined) continue;
    if (unit.ownerId !== ownerId || unit.kind !== 'Unit' || unit.hp <= 0) continue;
    if (!fireTeams[teamId]) continue;
    ids.add(teamId);
  }
  return [...ids].sort();
}

/**
 * Bind already-sorted team ids to buttons, up to the available slots. With more teams
 * than buttons the extras are not reachable by this quick gesture (they remain
 * directable through the Directing wheel), so the slice is deliberate, not lossy.
 */
export function assignFireTeamButtons(teamIds: readonly string[]): FireTeamButtonAssignment[] {
  const count = Math.min(teamIds.length, FIRE_TEAM_BUTTON_SLOTS.length);
  const assignments: FireTeamButtonAssignment[] = [];
  for (let index = 0; index < count; index++) {
    const slot = FIRE_TEAM_BUTTON_SLOTS[index];
    assignments.push({ teamId: teamIds[index], token: slot.token, glyph: slot.glyph });
  }
  return assignments;
}

/**
 * Heading (radians) for a ground vector, or null when the vector is within
 * `epsilon` of zero (the stick is centered) — the caller then keeps the prior aim
 * rather than snapping the arrow to an arbitrary direction.
 */
export function headingForGroundVector(x: number, z: number, epsilon = 1e-4): number | null {
  if (Math.hypot(x, z) <= epsilon) return null;
  return Math.atan2(x, z);
}

/** Unit ground direction (x, z) the arrow points for a heading. */
export function directionForHeading(heading: number): { x: number; z: number } {
  return { x: Math.sin(heading), z: Math.cos(heading) };
}

/**
 * The move target a quick-direct issues: `distance` world units from the team's
 * anchor along `heading`. The arrow is drawn to this same point, so the gesture is
 * what-you-see-is-where-they-go. y is 0 to match moveCommand's ground target.
 */
export function directMoveTarget(anchor: Position3D, heading: number, distance: number): Position3D {
  const direction = directionForHeading(heading);
  return {
    x: anchor.x + direction.x * distance,
    y: 0,
    z: anchor.z + direction.z * distance,
  };
}

/**
 * The living owned members of a team — the unit ids the move command is issued to.
 * moveCommand redirects a formed team by its anchor, so any one member would do, but
 * passing the full set keeps the command self-describing and robust to mid-frame
 * membership changes.
 */
export function fireTeamMemberIds(
  units: readonly Unit[],
  teamId: string,
  ownerId: string | null,
): string[] {
  if (!ownerId) return [];
  return units
    .filter((unit) => unit.fireTeamId === teamId && unit.ownerId === ownerId && unit.kind === 'Unit' && unit.hp > 0)
    .map((unit) => unit.id);
}
