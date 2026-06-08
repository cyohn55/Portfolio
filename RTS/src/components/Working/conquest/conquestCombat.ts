// Conquest combat model: globe-scaled unit stats plus the pure combat helpers
// the field simulation drives each frame.
//
// Single responsibility: translate the shared RTS animal balance (state.ts
// `ANIMALS`, the single source of truth) into the unit-radius globe space
// Conquest plays on, and expose side-effect-free helpers for the two combat
// decisions a unit makes — "who do I fight?" and "can I hit them yet?". Keeping
// these pure means the field component owns all mutation while this module stays
// trivially testable.
//
// Why a separate scale: the RTS battlemap authors ranges as 4–11 world units on
// a map hundreds of units across. Conquest fights on a sphere of radius ~1 where
// one tile spans ~0.18 units, so a literal range of 4 would let every animal hit
// the whole planet. We map battlemap reach into globe units with a single factor
// while preserving each animal's *relative* identity — a Bee still out-ranges a
// Bear, a Turtle still outlives a Cat — because we derive every value from the
// same balance table rather than re-authoring numbers here.

import * as THREE from 'three';
import type { AnimalId } from '../../../game/types';
import { ANIMALS } from '../../../game/state';
import type { ConquestUnitKind } from './conquestState';

/** Battlemap melee reach (state.ts MELEE_RANGE basis); the shortest authored range. */
const BATTLEMAP_MELEE_RANGE = 4;
/** Globe-space distance a melee unit should strike from (a fraction of a tile). */
const GLOBE_MELEE_RANGE = 0.03;
/** Linear map from battlemap range units into globe units, melee-anchored. */
const RANGE_BATTLEMAP_TO_GLOBE = GLOBE_MELEE_RANGE / BATTLEMAP_MELEE_RANGE;

/**
 * How far a unit notices and chases an enemy, in globe units. Independent of
 * weapon reach so even short-range melee armies will close the gap when an enemy
 * army marches into the neighborhood (~one tile of detection).
 */
export const AGGRO_RANGE = 0.16;

/** Chase speed when closing on an enemy (globe units/sec), matched to piloting feel. */
export const CHASE_SPEED = 0.1;

/** Fraction of max HP regenerated per second once a unit has been out of combat. */
export const REGEN_FRACTION_PER_SECOND = 0.12;
/** Time since the last hit dealt or taken before a unit begins regenerating. */
export const OUT_OF_COMBAT_MS = 4000;

// Per-role stat scaling, mirroring Quick Play's createKing / createQueen so a
// monarch in Conquest is as formidable as on the battlemap: the King is a HP/damage
// juggernaut that moves a little slower, the Queen a durable, fleet support unit.
const KIND_SCALING: Record<ConquestUnitKind, { hp: number; damage: number; move: number }> = {
  king: { hp: 3, damage: 3, move: 0.85 },
  queen: { hp: 2, damage: 1, move: 1.53 },
  unit: { hp: 1, damage: 1, move: 1 },
};

// Aura tuning, mirroring Quick Play's DEFAULT_CONFIG. The radius is the battlemap
// regen / king-aura radius mapped into globe space; the King's multiplier matches
// kingDamageMultiplier. The Queen heal is a fraction of max HP per second so it
// scales across the animals' very different HP pools and — unlike the passive
// out-of-combat regen — applies even mid-fight, which is the Queen's whole point.
export const AURA_RADIUS = 8 * RANGE_BATTLEMAP_TO_GLOBE;
export const KING_DAMAGE_MULTIPLIER = 2;
export const QUEEN_HEAL_FRACTION_PER_SECOND = 0.07;

/** Combat-relevant, globe-scaled stats for one unit in a given army role. */
export interface ConquestCombatStats {
  maxHp: number;
  damage: number;
  /** Distance within which this unit can land a hit, in globe units. */
  attackRange: number;
  attackCooldownMs: number;
  /** Per-role movement-speed multiplier applied to piloting / chase / follow. */
  moveMultiplier: number;
}

/**
 * Derive a unit's Conquest combat stats from the shared RTS balance table, scaled
 * by its army role. Defaults to a plain Unit so role-agnostic callers still work.
 */
export function conquestStatsFor(
  animal: AnimalId,
  kind: ConquestUnitKind = 'unit',
): ConquestCombatStats {
  const base = ANIMALS[animal];
  const scale = KIND_SCALING[kind];
  return {
    maxHp: base.baseHp * scale.hp,
    damage: base.dmg * scale.damage,
    attackRange: base.range * RANGE_BATTLEMAP_TO_GLOBE,
    attackCooldownMs: base.attackCooldownMs,
    moveMultiplier: scale.move,
  };
}

/** Damage a unit deals this hit, doubled while inside a friendly King's aura. */
export function kingBuffedDamage(baseDamage: number, buffed: boolean): number {
  return buffed ? baseDamage * KING_DAMAGE_MULTIPLIER : baseDamage;
}

/** HP a friendly unit recovers this frame from a nearby Queen's heal aura. */
export function queenHealAmount(maxHp: number, deltaSeconds: number): number {
  return maxHp * QUEEN_HEAL_FRACTION_PER_SECOND * deltaSeconds;
}

/** True when `target` lies within `radius` of `source` (shared by both auras). */
export function isWithinAura(source: CombatActor, target: CombatActor, radius: number): boolean {
  return source.position.distanceToSquared(target.position) <= radius * radius;
}

/** The minimal shape the combat helpers read from a live unit (keeps them pure). */
export interface CombatActor {
  controllerId: string;
  position: THREE.Vector3;
  hp: number;
  dead: boolean;
}

/**
 * Pick the nearest living enemy (different controller) within `aggroRange` of
 * `self`, or null if none. Pure: it only reads positions and allegiance, never
 * mutating, so the field loop can call it for every unit and tests can assert
 * targeting in isolation.
 */
export function selectNearestEnemy<T extends CombatActor>(
  self: CombatActor,
  candidates: readonly T[],
  aggroRange: number,
): T | null {
  const aggroRangeSq = aggroRange * aggroRange;
  let nearest: T | null = null;
  let nearestDistanceSq = Infinity;
  for (const candidate of candidates) {
    if (candidate === (self as unknown as T)) continue;
    if (candidate.dead || candidate.controllerId === self.controllerId) continue;
    const distanceSq = self.position.distanceToSquared(candidate.position);
    if (distanceSq <= aggroRangeSq && distanceSq < nearestDistanceSq) {
      nearestDistanceSq = distanceSq;
      nearest = candidate;
    }
  }
  return nearest;
}

/** True when `target` is inside `attackRange` of `attacker`. */
export function isWithinAttackRange(
  attacker: CombatActor,
  target: CombatActor,
  attackRange: number,
): boolean {
  return attacker.position.distanceToSquared(target.position) <= attackRange * attackRange;
}

/** True when enough time has elapsed since the unit's last swing to attack again. */
export function isAttackReady(lastAttackMs: number, cooldownMs: number, nowMs: number): boolean {
  return nowMs - lastAttackMs >= cooldownMs;
}

/** HP restored this frame for a unit that has been out of combat long enough. */
export function regenAmount(
  maxHp: number,
  lastCombatMs: number,
  nowMs: number,
  deltaSeconds: number,
): number {
  if (nowMs - lastCombatMs < OUT_OF_COMBAT_MS) return 0;
  return maxHp * REGEN_FRACTION_PER_SECOND * deltaSeconds;
}
