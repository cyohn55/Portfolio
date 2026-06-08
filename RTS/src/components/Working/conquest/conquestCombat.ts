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

/** Combat-relevant, globe-scaled stats for one animal. */
export interface ConquestCombatStats {
  maxHp: number;
  damage: number;
  /** Distance within which this unit can land a hit, in globe units. */
  attackRange: number;
  attackCooldownMs: number;
}

/** Derive an animal's Conquest combat stats from the shared RTS balance table. */
export function conquestStatsFor(animal: AnimalId): ConquestCombatStats {
  const base = ANIMALS[animal];
  return {
    maxHp: base.baseHp,
    damage: base.dmg,
    attackRange: base.range * RANGE_BATTLEMAP_TO_GLOBE,
    attackCooldownMs: base.attackCooldownMs,
  };
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
