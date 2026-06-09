// Conquest per-animal special abilities, sphere-native (increment 3).
//
// Single responsibility: own the *pure* logic of each animal's signature ability
// in globe space — the animal→ability taxonomy, the globe-scaled tuning, and the
// side-effect-free helpers the field simulation drives each frame ("who does this
// hiss shove and which way?", "which enemy does this bee dive at?", "does the
// sting kill?"). Keeping these pure means ConquestField owns all mutation while
// this module stays trivially node-testable, exactly as conquestCombat /
// conquestBehavior do.
//
// Why a separate globe scale (again): Quick Play authors these abilities in flat
// battlemap world units (ranges of 3–20 on a map hundreds of units across) and
// integrates knockback / dives on the XZ plane. Conquest fights on a unit sphere
// where one tile spans ~0.18 units and every distance is a 3D chord, so a literal
// hiss range of 20 would shove the whole planet. We re-derive each radius from the
// shared combat anchors (AGGRO_RANGE / CHASE_SPEED) rather than re-authoring
// numbers, preserving each ability's *relative* feel while fitting the sphere.

import * as THREE from 'three';
import type { AnimalId } from '../../../game/types';
import { AGGRO_RANGE, CHASE_SPEED } from './conquestCombat';

/**
 * The signature ability of each animal that has one. The full taxonomy is defined
 * here so the foundation is complete; ConquestField wires the self / area / dive
 * abilities (`shell`, `hiss`, `swarm`) first because they reuse the existing unit
 * rendering, with the projectile / beam / carry abilities (`eggs`, `tongue`,
 * `pickup`) following as the next increment.
 */
export type ConquestAbility = 'shell' | 'hiss' | 'swarm' | 'eggs' | 'tongue' | 'pickup';

/** Animal → its ability, mirroring Quick Play's per-animal specials. */
const ABILITY_BY_ANIMAL: Partial<Record<AnimalId, ConquestAbility>> = {
  Turtle: 'shell',
  Cat: 'hiss',
  Bee: 'swarm',
  Chicken: 'eggs',
  Frog: 'tongue',
  Owl: 'pickup',
};

/** The ability an animal can fire, or null for animals without a special. */
export function abilityFor(animal: AnimalId): ConquestAbility | null {
  return ABILITY_BY_ANIMAL[animal] ?? null;
}

// --- Turtle "Shell" ---------------------------------------------------------
// A toggle: the turtle pulls into its shell, becoming immovable and invulnerable
// (and unable to attack) until toggled back out. No range or cooldown in Quick
// Play; here a short re-trigger guard stops a held both-button press from
// flickering the shell open/closed every frame.
export const SHELL_RETRIGGER_MS = 350;

// --- Cat "Hiss" -------------------------------------------------------------
// A self-centered burst that shoves every nearby enemy radially outward along the
// surface over a brief window. Range and push distance are anchored to AGGRO_RANGE
// (a hiss clears roughly the cat's own threat bubble); the slide duration matches
// Quick Play so the shove still reads as a sharp impulse, not a constant force.
export const HISS_RANGE = AGGRO_RANGE * 1.25;          // enemies within ~1.25 tiles are shoved
export const HISS_PUSH_DISTANCE = AGGRO_RANGE * 0.9;   // how far outward each is shoved (globe units)
export const HISS_PUSH_MS = 220;                       // duration of the shove slide
export const HISS_PUSH_SPEED = HISS_PUSH_DISTANCE / (HISS_PUSH_MS / 1000); // globe units/sec
export const HISS_POSE_MS = 1000;                      // how long the Kitty_F2 hiss pose stays up
export const HISS_COOLDOWN_MS = 3000;                  // minimum time between a cat's hisses

// --- Bee "Swarm" ------------------------------------------------------------
// A sacrificial dive: each follower bee picks the nearest unclaimed enemy, flies
// straight at it, and on contact stings once — a coin flip that either kills both
// the bee and its target or fizzles. Dive speed is a multiple of the normal chase
// speed (a fast commit), the sting range a fraction of a tile (true contact).
export const SWARM_DIVE_SPEED = CHASE_SPEED * 3;       // globe units/sec (a fast dive)
export const SWARM_STING_RANGE = AGGRO_RANGE * 0.12;   // contact distance at which the bee stings
export const SWARM_STING_KILL_CHANCE = 0.5;            // probability a sting kills both bee and target

/** The minimal shape the ability helpers read from a live unit (keeps them pure). */
export interface AbilityActor {
  id: string;
  controllerId: string;
  position: THREE.Vector3;
  dead: boolean;
}

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * The unit surface-tangent direction to shove `targetPos` radially away from
 * `catPos`. Projecting (target − cat) onto the tangent plane at the target keeps
 * the shove along the sphere instead of driving into / off the surface. Returns a
 * stable fallback tangent when the target sits exactly on the cat (degenerate).
 */
export function hissPushDirection(catPos: THREE.Vector3, targetPos: THREE.Vector3): THREE.Vector3 {
  const up = targetPos.clone().normalize();
  const away = targetPos.clone().sub(catPos);
  away.addScaledVector(up, -away.dot(up)); // drop the radial component → tangent at the target
  if (away.lengthSq() < 1e-12) {
    // Target is on top of the cat: pick any consistent outward tangent.
    return new THREE.Vector3().crossVectors(up, Math.abs(up.x) < 0.9 ? X_AXIS : Y_AXIS).normalize();
  }
  return away.normalize();
}

/** One enemy shoved by a hiss, with the surface-tangent direction to slide it. */
export interface HissPush {
  id: string;
  direction: THREE.Vector3;
}

/**
 * Every living enemy within `range` of `cat`, paired with the surface-tangent
 * direction to shove it radially outward. Pure: the field consumes these to seed
 * each enemy's knockback slide, and tests can assert targeting in isolation.
 */
export function computeHissPushes(
  cat: AbilityActor,
  candidates: readonly AbilityActor[],
  range: number,
): HissPush[] {
  const rangeSq = range * range;
  const pushes: HissPush[] = [];
  for (const candidate of candidates) {
    if (candidate === cat || candidate.dead) continue;
    if (candidate.controllerId === cat.controllerId) continue; // only enemies are shoved
    if (cat.position.distanceToSquared(candidate.position) > rangeSq) continue;
    pushes.push({ id: candidate.id, direction: hissPushDirection(cat.position, candidate.position) });
  }
  return pushes;
}

/**
 * Pick the nearest living enemy not already claimed by another swarming bee, so a
 * cloud of bees spreads its stings across distinct targets. Pure; returns null
 * when every enemy in range has been claimed.
 */
export function selectSwarmTarget<T extends AbilityActor>(
  bee: AbilityActor,
  candidates: readonly T[],
  claimedTargetIds: ReadonlySet<string>,
): T | null {
  let nearest: T | null = null;
  let nearestDistanceSq = Infinity;
  for (const candidate of candidates) {
    if ((candidate as AbilityActor) === bee || candidate.dead) continue;
    if (candidate.controllerId === bee.controllerId) continue; // enemies only
    if (claimedTargetIds.has(candidate.id)) continue;          // one bee per enemy
    const distanceSq = bee.position.distanceToSquared(candidate.position);
    if (distanceSq < nearestDistanceSq) {
      nearestDistanceSq = distanceSq;
      nearest = candidate;
    }
  }
  return nearest;
}

/** Resolve a sting coin flip: `roll` (a uniform [0,1)) under the kill chance kills both. */
export function swarmStingKills(roll: number): boolean {
  return roll < SWARM_STING_KILL_CHANCE;
}
