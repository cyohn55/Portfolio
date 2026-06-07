// Pure, deterministic logic for the unit combat-posture system.
//
// This module owns every decision the stance engine makes that does NOT mutate
// game state: what a unit's default posture is, how each stance resolves into
// concrete engagement parameters, and which enemy a unit picks given a target
// priority. Keeping it side-effect-free means it can be unit-tested directly with
// real Unit inputs and reused identically by both lockstep peers — the tick in
// state.ts is the only place these results are applied to the draft.
//
// Determinism contract: nothing here may read wall-clock time or Math.random, and
// every "pick one of several" result must break ties on a stable key (entity id)
// so two peers that see the same candidates always choose the same unit.

import type {
  AnimalId,
  FireMode,
  Position3D,
  TargetPriority,
  Unit,
  UnitBehavior,
  UnitKind,
  UnitStance,
} from '../../game/types';

// --- Tuning constants -------------------------------------------------------
// World-unit radii per stance. These are deliberately gathered here (not buried
// in the tick) so balance passes have one place to tune. Values are starting
// points expected to move with playtesting, not hard contracts.

const DEFENSIVE_LEASH = 12; // close to the original hard-coded 10u idle scan
const DEFENSIVE_CHASE = 16;
const AGGRESSIVE_VISION = 45;
const AGGRESSIVE_CHASE = 75;
const SKIRMISH_MIN_DETECT = 22;
const PATROL_DETECT = 18;
const PATROL_CHASE = 22;
const GUARD_DETECT = 16;
const GUARD_CHASE = 18;

// A unit within this distance of its anchor is treated as "home" and will not
// issue a return order — prevents jitter from chasing a sub-unit residual.
export const RETURN_DEADBAND = 4;

// How far a fleeing unit aims to put between itself and the threat when it has no
// anchor to run to.
export const RETREAT_DISTANCE = 30;

// Low-HP survival reflex: a regular Unit below this fraction of max HP retreats
// regardless of its stance (monarchs/bases are excluded — see shouldFleeLowHp).
export const FLEE_HP_FRACTION = 0.2;

// --- Defaults ---------------------------------------------------------------

// The posture a freshly created unit starts with. Every kind defaults to a
// cautious, weapons-free Defensive/nearest stance, which reproduces the game's
// original "engage nearby enemies, otherwise stay put" feel — because a default
// unit has no anchor, Defensive does not pull it home until the player commands
// it (giving it an anchor). Per-animal smart defaults (e.g. ranged → skirmish)
// are intentionally deferred to a tuning pass so this change is regression-free.
export function defaultBehaviorFor(_animal: AnimalId, _kind: UnitKind): UnitBehavior {
  return { stance: 'defensive', fire: 'free', priority: 'nearest' };
}

// Returns the unit's behavior, falling back to the default when absent so the
// tick never has to null-check.
export function behaviorOf(unit: Unit): UnitBehavior {
  return unit.behavior ?? defaultBehaviorFor(unit.animal, unit.kind);
}

// --- Stance resolution ------------------------------------------------------

// Concrete engagement parameters a stance resolves into for a specific unit.
export interface StanceParams {
  detectionRadius: number; // how far from the UNIT it auto-acquires a target
  chaseRadius: number; // how far from its ANCHOR it will pursue before giving up
  engages: boolean; // false → never auto-acquires (flee)
  returnsToAnchor: boolean; // walks back to anchor when it has nothing to fight
  movesToEngage: boolean; // false → hold ground: only strike what is already in range
}

// Resolve a stance into numeric engagement parameters for this unit. HoldGround
// keys its detection to the unit's own attack range so any target it acquires is
// already in range — that alone keeps the combat-advance step from moving it.
export function stanceParams(stance: UnitStance, unit: Unit): StanceParams {
  switch (stance) {
    case 'aggressive':
      return { detectionRadius: AGGRESSIVE_VISION, chaseRadius: AGGRESSIVE_CHASE, engages: true, returnsToAnchor: true, movesToEngage: true };
    case 'holdGround':
      return { detectionRadius: unit.attackRange, chaseRadius: unit.attackRange, engages: true, returnsToAnchor: false, movesToEngage: false };
    case 'skirmish': {
      const detect = Math.max(SKIRMISH_MIN_DETECT, unit.attackRange * 1.25);
      return { detectionRadius: detect, chaseRadius: detect + 4, engages: true, returnsToAnchor: true, movesToEngage: true };
    }
    case 'flee':
      return { detectionRadius: 0, chaseRadius: 0, engages: false, returnsToAnchor: true, movesToEngage: false };
    case 'patrol':
      return { detectionRadius: PATROL_DETECT, chaseRadius: PATROL_CHASE, engages: true, returnsToAnchor: true, movesToEngage: true };
    case 'guard':
    case 'escort':
      return { detectionRadius: GUARD_DETECT, chaseRadius: GUARD_CHASE, engages: true, returnsToAnchor: true, movesToEngage: true };
    case 'defensive':
    default:
      return { detectionRadius: DEFENSIVE_LEASH, chaseRadius: DEFENSIVE_CHASE, engages: true, returnsToAnchor: true, movesToEngage: true };
  }
}

// Patrol implies weapons-free regardless of the stored fire mode — a unit told to
// walk a route is expected to deal with whatever it meets. Every other stance
// honors the player's explicit fire setting.
export function resolveFireMode(behavior: UnitBehavior): FireMode {
  return behavior.stance === 'patrol' ? 'free' : behavior.fire;
}

// The low-HP survival reflex (override layer above stance auto-behavior). Only
// regular Units retreat on reflex; monarchs are usually piloted (the pilot block
// runs first) and a fleeing Base is meaningless.
export function shouldFleeLowHp(unit: Unit): boolean {
  return unit.kind === 'Unit' && unit.maxHp > 0 && unit.hp / unit.maxHp < FLEE_HP_FRACTION;
}

// --- Geometry helpers (kept local so this module never imports state.ts) -----

function distSq(a: Position3D, b: Position3D): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

export function distanceXZ(a: Position3D, b: Position3D): number {
  return Math.sqrt(distSq(a, b));
}

// --- Target selection -------------------------------------------------------

// Higher score = more preferred. Ties on the primary score fall through to
// nearest, then to the lexicographically smallest id, so the choice is identical
// on both peers no matter what order candidates arrive in.
function priorityScore(unit: Unit, candidate: Unit, priority: TargetPriority, meleeRange: number): number {
  switch (priority) {
    case 'lowestHp':
      return -candidate.hp; // fewer HP → higher score (finish kills)
    case 'highestThreat':
      // Damage per second as a stable threat proxy; cooldown is fixed per animal.
      return candidate.attackDamage * (1000 / Math.max(1, candidate.attackCooldownMs));
    case 'ranged':
      return candidate.attackRange; // prefer the longest-reach enemy
    case 'monarch':
      // Monarchs and bases first; everything else equal so it falls to nearest.
      return candidate.kind === 'King' || candidate.kind === 'Queen' || candidate.kind === 'Base' ? 1 : 0;
    case 'nearest':
    default:
      return 0; // pure nearest is resolved by the distance tiebreaker below
  }
}

// Pick the best enemy from `candidates` under `priority`, deterministically.
// `candidates` are assumed already filtered (alive, hostile, in range) by the
// caller; this only ranks them. `meleeRange` lets the threat metric stay
// engine-agnostic but is currently informational.
export function pickTargetByPriority(
  unit: Unit,
  candidates: Unit[],
  priority: TargetPriority,
  meleeRange = 4,
): Unit | null {
  let best: Unit | null = null;
  let bestScore = -Infinity;
  let bestDistSq = Infinity;
  for (const candidate of candidates) {
    const score = priorityScore(unit, candidate, priority, meleeRange);
    const dSq = distSq(unit.position, candidate.position);
    let wins = false;
    if (score > bestScore) wins = true;
    else if (score === bestScore) {
      if (dSq < bestDistSq) wins = true;
      else if (dSq === bestDistSq && best !== null && candidate.id < best.id) wins = true;
    }
    if (wins) {
      best = candidate;
      bestScore = score;
      bestDistSq = dSq;
    }
  }
  return best;
}

// Where a fleeing unit should head: its anchor if it has one (always a validated,
// reachable point), otherwise a spot RETREAT_DISTANCE away from the nearest
// threat. Returns null when there is nothing to flee from and nowhere to go.
export function retreatDestination(
  unit: Unit,
  anchor: Position3D | undefined,
  nearestEnemyPos: Position3D | null,
): Position3D | null {
  if (anchor) return { x: anchor.x, y: 0, z: anchor.z };
  if (!nearestEnemyPos) return null;
  const dx = unit.position.x - nearestEnemyPos.x;
  const dz = unit.position.z - nearestEnemyPos.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-6) return null; // on top of the enemy; no meaningful away vector
  return {
    x: unit.position.x + (dx / len) * RETREAT_DISTANCE,
    y: 0,
    z: unit.position.z + (dz / len) * RETREAT_DISTANCE,
  };
}

// Merge a partial axis update onto an existing behavior, preserving untouched
// axes. Used by the setBehavior command so the radial can change one axis.
export function mergeBehavior(current: UnitBehavior, patch: Partial<UnitBehavior>): UnitBehavior {
  return {
    stance: patch.stance ?? current.stance,
    fire: patch.fire ?? current.fire,
    priority: patch.priority ?? current.priority,
  };
}
