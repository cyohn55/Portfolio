// Pure, globe-native combat-posture logic for Conquest — the sphere-space analogue
// of Quick Play's unitBehavior.ts.
//
// Single responsibility: own every stance decision that does NOT mutate game
// state — a unit's default posture, how each stance resolves into concrete
// engagement radii (in GLOBE units, not battlemap units), whether it may move to
// engage, and which enemy it picks under a target priority. The field component
// (ConquestField) owns all mutation; this module stays side-effect-free so it can
// be unit-tested directly with real unit inputs.
//
// Why a separate module instead of importing unitBehavior.ts: that module measures
// distance on the flat battlemap XZ plane and authors its radii in battlemap world
// units (a defensive leash of 12, an aggressive vision of 45). Conquest fights on a
// unit-radius sphere where one tile spans ~0.18 units and positions are full 3D
// points, so the radii are re-derived for globe space and the geometry uses true
// 3D distance. The stance *ratios* (aggressive sees ~4× farther than defensive,
// etc.) are preserved from Quick Play so the postures keep their identity.

import * as THREE from 'three';
import type { FireMode, TargetPriority, UnitBehavior, UnitStance } from '../../../game/types';
import { AGGRO_RANGE } from './conquestCombat';
import type { ConquestUnitKind } from './conquestState';

// --- Tuning: globe-space stance radii ---------------------------------------
// Conquest's prior universal auto-engage range (AGGRO_RANGE ≈ one tile) is adopted
// as the cautious "defensive" detection baseline, and every other stance is scaled
// off it using the same proportions Quick Play's unitBehavior.ts uses between its
// battlemap radii (defensive leash 12 / aggressive vision 45, etc.). Gathering them
// here — not in the per-frame field loop — gives balance passes one place to tune.

const DEFENSIVE_DETECT = AGGRO_RANGE; // ≈ one tile: the baseline cautious leash
const BATTLEMAP_DEFENSIVE_LEASH = 12; // unitBehavior.ts DEFENSIVE_LEASH, the anchor ratio
// Map a Quick Play battlemap detection radius onto globe space, anchored so the
// defensive leash lands on DEFENSIVE_DETECT and the others keep their relative reach.
const RADIUS_BATTLEMAP_TO_GLOBE = DEFENSIVE_DETECT / BATTLEMAP_DEFENSIVE_LEASH;

const DEFENSIVE_CHASE = 16 * RADIUS_BATTLEMAP_TO_GLOBE;
const AGGRESSIVE_VISION = 45 * RADIUS_BATTLEMAP_TO_GLOBE;
const AGGRESSIVE_CHASE = 75 * RADIUS_BATTLEMAP_TO_GLOBE;
const SKIRMISH_MIN_DETECT = 22 * RADIUS_BATTLEMAP_TO_GLOBE;
const SKIRMISH_CHASE_MARGIN = 4 * RADIUS_BATTLEMAP_TO_GLOBE;
const PATROL_DETECT = 18 * RADIUS_BATTLEMAP_TO_GLOBE;
const PATROL_CHASE = 22 * RADIUS_BATTLEMAP_TO_GLOBE;
const GUARD_DETECT = 16 * RADIUS_BATTLEMAP_TO_GLOBE;
const GUARD_CHASE = 18 * RADIUS_BATTLEMAP_TO_GLOBE;

// --- Defaults ---------------------------------------------------------------

// The posture a freshly spawned Conquest unit starts with. Mirrors Quick Play:
// every unit begins Defensive / weapons-free / nearest, which reproduces the prior
// Conquest feel (engage enemies that come within ~a tile, otherwise stay with the
// army) now expressed through the stance engine. Per-animal smart defaults
// (e.g. snipers → skirmish) are deferred to a tuning pass, so this is regression-safe.
export function defaultBehaviorFor(_animal: string, _kind: ConquestUnitKind): UnitBehavior {
  return { stance: 'defensive', fire: 'free', priority: 'nearest' };
}

// --- Stance resolution ------------------------------------------------------

// Concrete, globe-scaled engagement parameters a stance resolves into for a unit.
export interface StanceParams {
  /** How far from the UNIT it auto-acquires a target, in globe units. */
  detectionRadius: number;
  /** How far from its ANCHOR (the army leader) it will pursue before being leashed home. */
  chaseRadius: number;
  /** false → never auto-acquires (flee): the unit fights nothing on its own. */
  engages: boolean;
  /** false → hold ground: only strike what is already in range, never advance. */
  movesToEngage: boolean;
}

// Resolve a stance into numeric engagement parameters for a unit with `attackRange`
// (in globe units). HoldGround keys both radii to the unit's own reach so any target
// it acquires is already strikeable — that alone keeps the chase step from moving it.
export function stanceParams(stance: UnitStance, attackRange: number): StanceParams {
  switch (stance) {
    case 'aggressive':
      return { detectionRadius: AGGRESSIVE_VISION, chaseRadius: AGGRESSIVE_CHASE, engages: true, movesToEngage: true };
    case 'holdGround':
      return { detectionRadius: attackRange, chaseRadius: attackRange, engages: true, movesToEngage: false };
    case 'skirmish': {
      const detect = Math.max(SKIRMISH_MIN_DETECT, attackRange * 1.25);
      return { detectionRadius: detect, chaseRadius: detect + SKIRMISH_CHASE_MARGIN, engages: true, movesToEngage: true };
    }
    case 'flee':
      return { detectionRadius: 0, chaseRadius: 0, engages: false, movesToEngage: false };
    case 'patrol':
      return { detectionRadius: PATROL_DETECT, chaseRadius: PATROL_CHASE, engages: true, movesToEngage: true };
    case 'guard':
    case 'escort':
      return { detectionRadius: GUARD_DETECT, chaseRadius: GUARD_CHASE, engages: true, movesToEngage: true };
    case 'defensive':
    default:
      return { detectionRadius: DEFENSIVE_DETECT, chaseRadius: DEFENSIVE_CHASE, engages: true, movesToEngage: true };
  }
}

// Patrol implies weapons-free regardless of the stored fire mode — a unit told to
// walk a route deals with whatever it meets. Every other stance honors the player's
// explicit fire setting. Mirrors Quick Play's resolveFireMode.
export function resolveFireMode(behavior: UnitBehavior): FireMode {
  return behavior.stance === 'patrol' ? 'free' : behavior.fire;
}

// --- Target selection -------------------------------------------------------

// The minimal shape the target ranker reads from a live unit. Richer than the
// combat helpers' CombatActor because priorities weigh HP, damage, reach and role;
// the weapon stats live under `combat` to match the field's LiveUnit directly.
export interface BehaviorActor {
  id: string;
  controllerId: string;
  position: THREE.Vector3;
  hp: number;
  dead: boolean;
  kind: ConquestUnitKind;
  combat: { damage: number; attackCooldownMs: number; attackRange: number };
}

// Higher score = more preferred. Ties fall through to nearest, then to the smaller
// id, so selection is stable frame-to-frame and never flickers between equals.
function priorityScore(candidate: BehaviorActor, priority: TargetPriority): number {
  switch (priority) {
    case 'lowestHp':
      return -candidate.hp; // fewer HP → higher score (finish kills)
    case 'highestThreat':
      // Damage per second as a stable threat proxy (cooldown is fixed per animal).
      return candidate.combat.damage * (1000 / Math.max(1, candidate.combat.attackCooldownMs));
    case 'ranged':
      return candidate.combat.attackRange; // prefer the longest-reach enemy
    case 'monarch':
      // Kings and Queens first; everything else equal so it falls to nearest.
      return candidate.kind === 'king' || candidate.kind === 'queen' ? 1 : 0;
    case 'nearest':
    default:
      return 0; // pure nearest is resolved by the distance tiebreaker below
  }
}

// Pick the enemy a unit should engage given its behavior and resolved stance.
// Returns null when the unit auto-acquires nothing — because its stance does not
// engage (flee) or its fire mode is hold (weapons-tight). Otherwise it ranks every
// living hostile within the stance's detection radius by the unit's target priority,
// breaking ties on distance then id. Pure: it only reads positions and stats.
export function selectTargetForBehavior<T extends BehaviorActor>(
  self: BehaviorActor,
  candidates: readonly T[],
  behavior: UnitBehavior,
  params: StanceParams,
): T | null {
  if (!params.engages || resolveFireMode(behavior) === 'hold') return null;
  const detectSq = params.detectionRadius * params.detectionRadius;
  let best: T | null = null;
  let bestScore = -Infinity;
  let bestDistSq = Infinity;
  for (const candidate of candidates) {
    if ((candidate as BehaviorActor) === self) continue;
    if (candidate.dead || candidate.controllerId === self.controllerId) continue;
    const distSq = self.position.distanceToSquared(candidate.position);
    if (distSq > detectSq) continue;
    const score = priorityScore(candidate, behavior.priority);
    let wins = false;
    if (score > bestScore) wins = true;
    else if (score === bestScore) {
      if (distSq < bestDistSq) wins = true;
      else if (distSq === bestDistSq && best !== null && candidate.id < best.id) wins = true;
    }
    if (wins) {
      best = candidate;
      bestScore = score;
      bestDistSq = distSq;
    }
  }
  return best;
}

// Merge a partial axis update onto an existing behavior, preserving untouched axes.
// Ready for the Increment 4 selection UI's set-behavior command (radial menu) to
// change one axis at a time. Mirrors Quick Play's mergeBehavior.
export function mergeBehavior(current: UnitBehavior, patch: Partial<UnitBehavior>): UnitBehavior {
  return {
    stance: patch.stance ?? current.stance,
    fire: patch.fire ?? current.fire,
    priority: patch.priority ?? current.priority,
  };
}

// --- Selection summary (radial menu) ----------------------------------------

/** Each behavior axis across a selection, or null on that axis when units disagree. */
export interface BehaviorSummary {
  stance: UnitStance | null;
  fire: FireMode | null;
  priority: TargetPriority | null;
}

/** The single shared value across a list, or null when it is mixed (or empty). */
function uniformAxis<T>(values: readonly T[]): T | null {
  if (values.length === 0) return null;
  const first = values[0];
  return values.every((value) => value === first) ? first : null;
}

/**
 * Summarize a selection's behaviors for the posture radial: each axis is the shared
 * value across the selection, or null ("Mixed") when the units disagree. Pure so the
 * field can compute it from its live units and publish the compact result to the HUD.
 */
export function summarizeBehaviors(behaviors: readonly UnitBehavior[]): BehaviorSummary {
  return {
    stance: uniformAxis(behaviors.map((behavior) => behavior.stance)),
    fire: uniformAxis(behaviors.map((behavior) => behavior.fire)),
    priority: uniformAxis(behaviors.map((behavior) => behavior.priority)),
  };
}
