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

// --- Chicken "Eggs" (projectile) -------------------------------------------
// A thrown projectile: each chicken lobs an egg along the surface toward its
// nearest enemy, and the first enemy the egg passes within EGG_HIT_RADIUS of takes
// EGG_DAMAGE and pops the egg. Eggs that fly EGG_MAX_RANGE (an arc length) without
// a hit expire. Speed is a multiple of the chase speed (a brisk throw), the hit
// radius a fraction of a tile (a near miss whiffs), range a few tiles of reach.
export const EGG_DAMAGE = 10;                          // hp removed from the first enemy an egg hits
export const EGG_SPEED = CHASE_SPEED * 4.5;            // globe units/sec the egg flies
export const EGG_HIT_RADIUS = AGGRO_RANGE * 0.18;      // an egg hits an enemy whose center passes within this
export const EGG_MAX_RANGE = AGGRO_RANGE * 4;          // arc length an egg travels before expiring
export const EGG_COOLDOWN_MS = 700;                    // minimum time between a chicken's egg throws
export const EGG_THROW_POSE_MS = 600;                  // how long the egg-throw pose stays up
export const EGG_LIFT = AGGRO_RANGE * 0.06;            // radial height the egg rides above the surface

// --- Frog "Tongue" (beam) ---------------------------------------------------
// A grab beam: each frog shoots its tongue along the surface toward its nearest
// enemy, latches on contact (dealing the frog's attack damage once), then reels
// that enemy back to the frog. A whiff (no enemy in reach) extends to full length
// and retracts empty. The frog is pinned for the whole grab so the beam reads
// cleanly. Reach is a little over the aggro bubble; extend/retract are multiples
// of the chase speed; the hit radius is near-contact.
export const TONGUE_RANGE = AGGRO_RANGE * 1.4;         // reach + full extension length (globe units)
export const TONGUE_EXTEND_SPEED = CHASE_SPEED * 6;    // globe units/sec the tip reaches out
export const TONGUE_RETRACT_SPEED = CHASE_SPEED * 3.5; // globe units/sec the tongue (and catch) reels back
export const TONGUE_HIT_RADIUS = AGGRO_RANGE * 0.12;   // the tongue latches an enemy whose center is within this of the tip
export const TONGUE_WINDUP_MS = 100;                   // mouth-open beat before the tongue shoots out
export const TONGUE_COOLDOWN_MS = 1500;                // minimum time between a frog's tongue grabs
export const TONGUE_DRAG_STOP_DIST = AGGRO_RANGE * 0.15; // a dragged enemy stops once this close to the frog

// --- Owl "Pickup" (carry) ---------------------------------------------------
// A sky abduction: each owl swoops to its nearest enemy ground/water unit (air
// units can't be plucked from flight), grabs it, carries it up to OWL_FLIGHT_LIFT
// for OWL_CARRY_DURATION_MS, then drops it for OWL_FALL_DAMAGE. Lifts are radial
// heights above the surface in globe units; the carried unit dangles a hang offset
// below the owl. Swoop/ascent speeds are multiples of the chase speed.
export const OWL_FLIGHT_LIFT = AGGRO_RANGE * 0.32;     // cruising radial height an owl carries its catch to
export const OWL_PLUCK_LIFT = AGGRO_RANGE * 0.08;      // radial height the owl swoops down to over the target
export const OWL_CARRY_HANG = AGGRO_RANGE * 0.06;      // how far the catch dangles below the owl
export const OWL_SWOOP_SPEED = CHASE_SPEED * 4;        // globe units/sec the owl closes on its target along the surface
export const OWL_DESCENT_SPEED = OWL_FLIGHT_LIFT * 2.5; // globe units/sec the owl's lift drops while swooping
export const OWL_ASCENT_SPEED = OWL_FLIGHT_LIFT * 1.8;  // globe units/sec the owl's lift rises while carrying
export const OWL_GRAB_RANGE = AGGRO_RANGE * 0.2;       // surface distance at which the owl reaches its target and grabs
export const OWL_CARRY_DURATION_MS = 2500;             // how long a catch is held aloft before being dropped
export const OWL_FALL_DAMAGE = 25;                     // hp removed from a dropped enemy on impact
export const OWL_PICKUP_COOLDOWN_MS = 1200;            // minimum time between an owl's abductions

/** The minimal shape the ability helpers read from a live unit (keeps them pure). */
export interface AbilityActor {
  id: string;
  controllerId: string;
  position: THREE.Vector3;
  dead: boolean;
  /** A downed monarch (hp 0, not removed) is skipped by enemy-targeting abilities. */
  downed?: boolean;
}

/**
 * Live state of a Frog's tongue grab while it animates, a small state machine the
 * field advances each frame (mirroring Quick Play's FrogTongueState, sphere-native):
 *   windup     — a mouth-open beat; then fizzles if its claimed enemy left reach, else extends.
 *   extending  — the tip reaches out along `direction`; on contact it latches, deals
 *                damage once, and retracts. A whiff extends to `maxLength` then retracts.
 *   retracting — reels back; a latched, living catch is dragged along to the frog.
 */
export interface ConquestTongue {
  phase: 'windup' | 'extending' | 'retracting';
  /** The claimed enemy's id, or null for a whiff (no enemy was in reach at fire time). */
  targetId: string | null;
  /** Surface-tangent aim heading from the frog's mouth (re-aimed at a moving target). */
  direction: THREE.Vector3;
  length: number;
  maxLength: number;
  grabbed: boolean;
  phaseUntilMs: number;
  damageDealt: boolean;
}

/**
 * Live state of an Owl's abduction while it animates (sphere-native carry):
 *   swooping — the owl flies to its claimed enemy while descending, then grabs it.
 *   carrying — the owl rises to flight height with the catch dangling beneath, then
 *              drops it (fall damage) once the carry timer elapses at cruising height.
 */
export interface ConquestPickup {
  phase: 'swooping' | 'carrying';
  targetId: string;
  grabbed: boolean;
  carryUntilMs: number;
}

/** An in-flight Chicken egg traveling the surface (the field owns the pool). */
export interface ConquestEgg {
  id: number;
  controllerId: string;
  position: THREE.Vector3;
  direction: THREE.Vector3;
  traveled: number;
  damage: number;
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

// --- Surface projectile/beam/carry helpers (increment 3 part 2) -------------

/** A point advanced along its great circle, with the carried-forward heading. */
export interface SurfaceStep {
  position: THREE.Vector3;
  direction: THREE.Vector3;
}

/**
 * Advance a surface traveler `distance` along the great circle it is heading down,
 * keeping it on its own sphere (radius preserved) and returning the heading carried
 * around the curve. Both the position and the tangent heading are rotated by
 * angle = distance / radius about the axis normal to the plane of travel, so an egg
 * (or any surface projectile) curves with the planet instead of flying off the
 * tangent. A degenerate heading (parallel to the surface normal) is returned
 * unchanged so the caller can drop the projectile.
 */
export function stepGreatCircle(
  position: THREE.Vector3,
  direction: THREE.Vector3,
  distance: number,
): SurfaceStep {
  const radius = position.length();
  if (radius < 1e-9) return { position: position.clone(), direction: direction.clone() };
  const up = position.clone().multiplyScalar(1 / radius);
  const heading = direction.clone();
  heading.addScaledVector(up, -heading.dot(up)); // tangent component of the heading
  if (heading.lengthSq() < 1e-12) return { position: position.clone(), direction: direction.clone() };
  heading.normalize();
  const axis = new THREE.Vector3().crossVectors(up, heading).normalize();
  const rotation = new THREE.Quaternion().setFromAxisAngle(axis, distance / radius);
  return {
    position: position.clone().applyQuaternion(rotation),
    direction: heading.applyQuaternion(rotation).normalize(),
  };
}

/**
 * The unit surface-tangent heading from `fromPos` toward `toPos` — the initial
 * great-circle direction a thrown egg (or any aimed surface traveler) sets out on.
 * Returns a stable fallback tangent when the two points coincide.
 */
export function surfaceAimDirection(fromPos: THREE.Vector3, toPos: THREE.Vector3): THREE.Vector3 {
  const up = fromPos.clone().normalize();
  const toward = toPos.clone().sub(fromPos);
  toward.addScaledVector(up, -toward.dot(up)); // tangent at the launch point
  if (toward.lengthSq() < 1e-12) {
    return new THREE.Vector3().crossVectors(up, Math.abs(up.x) < 0.9 ? X_AXIS : Y_AXIS).normalize();
  }
  return toward.normalize();
}

/**
 * The nearest living enemy whose center lies within `hitRadius` of `eggPos`, or
 * null — the egg's per-step collision test. Pure so the field consumes the verdict
 * and tests can assert it in isolation.
 */
export function eggHitTarget<T extends AbilityActor>(
  eggPos: THREE.Vector3,
  eggControllerId: string,
  candidates: readonly T[],
  hitRadius: number,
): T | null {
  const hitRadiusSq = hitRadius * hitRadius;
  let nearest: T | null = null;
  let nearestDistanceSq = hitRadiusSq;
  for (const candidate of candidates) {
    if (candidate.dead || candidate.downed) continue;
    if (candidate.controllerId === eggControllerId) continue; // enemies only
    const distanceSq = eggPos.distanceToSquared(candidate.position);
    if (distanceSq <= nearestDistanceSq) {
      nearestDistanceSq = distanceSq;
      nearest = candidate;
    }
  }
  return nearest;
}

/**
 * The nearest living enemy within `range` of `self` that no other actor has already
 * claimed — the shared targeting for the tongue grab and the owl abduction, so a
 * line of frogs (or a flight of owls) spreads its catches across distinct enemies
 * rather than piling onto one. Pure; returns null when none qualifies.
 */
export function selectNearestUnclaimedEnemy<T extends AbilityActor>(
  self: AbilityActor,
  candidates: readonly T[],
  claimedTargetIds: ReadonlySet<string>,
  range: number,
): T | null {
  const rangeSq = range * range;
  let nearest: T | null = null;
  let nearestDistanceSq = rangeSq;
  for (const candidate of candidates) {
    if ((candidate as AbilityActor) === self || candidate.dead || candidate.downed) continue;
    if (candidate.controllerId === self.controllerId) continue; // enemies only
    if (claimedTargetIds.has(candidate.id)) continue;           // one claimant per enemy
    const distanceSq = self.position.distanceToSquared(candidate.position);
    if (distanceSq <= nearestDistanceSq) {
      nearestDistanceSq = distanceSq;
      nearest = candidate;
    }
  }
  return nearest;
}
