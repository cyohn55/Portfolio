// Pure pose-selection logic for Conquest unit animation.
//
// Single responsibility: given an animal, whether it's moving, and the elapsed
// render time, decide which authored pose frame to display — plus how high air
// units hover. Kept free of any three.js / loader imports so it is pure and
// node-testable; the baking that actually produces those frames lives in
// conquestAnimation.ts. The timing mirrors UnitsLayer so Conquest reads like the
// main game.

import type { AnimalId } from '../../../game/types';

// Authored pose-frame counts, mirroring the constants in ModelPreloader. Held
// locally so this module stays import-light and testable; they describe the GLB
// assets, which do not change.
const TURTLE_FRAMES = 6; // F0 shell-lock + F1..F5 walk
const FOX_FRAMES = 3;
const BEE_FRAMES = 2;

// Pose cadence (ms) per animal, mirroring UnitsLayer.
const TURTLE_WALK_MS = 100;
const FOX_WALK_MS = 100;
const YETI_WALK_MS = 100;
const CAT_WALK_MS = 200;
const BEE_FLAP_MS = 50;
const FROG_HOP_MS = 150;
const CHICKEN_WALK_MS = 100;

// Owl flight: 4 wing-flap frames (the separate Owl_Wings_* GLBs) cycled at 4 full
// flaps/sec, mirroring Quick Play's OWL_WING_FLAP_PER_SEC so the swoop reads the same.
const OWL_FRAMES = 4;
const OWL_FLAP_MS = 1000 / (OWL_FRAMES * 4); // 62.5ms per frame -> 4 flaps/sec

/**
 * Choose which pose frame index to display for an animal. Index meanings match
 * the order `buildPoseVariants` bakes (index i = authored frame i). Single-pose
 * animals always return 0.
 */
export function selectPoseIndex(animal: AnimalId, isMoving: boolean, elapsedMs: number): number {
  switch (animal) {
    case 'Turtle':
      if (!isMoving) return 1; // idle holds F1
      return 1 + (Math.floor(elapsedMs / TURTLE_WALK_MS) % (TURTLE_FRAMES - 1)); // F1..F5
    case 'Fox':
      if (!isMoving) return FOX_FRAMES - 1; // idle holds F2
      return Math.floor(elapsedMs / FOX_WALK_MS) % FOX_FRAMES; // F0,F1,F2
    case 'Yetti':
      if (!isMoving) return 0; // idle holds F0
      return 1 + (Math.floor(elapsedMs / YETI_WALK_MS) % 2); // alternate F1,F2
    case 'Cat':
      if (!isMoving) return 0; // idle holds F0
      return Math.floor(elapsedMs / CAT_WALK_MS) % 2; // alternate F0,F1
    case 'Bee':
      // Always airborne: flap continuously, moving or not.
      return Math.floor(elapsedMs / BEE_FLAP_MS) % BEE_FRAMES; // F0,F1
    case 'Owl':
      // Always airborne: cycle the four wing-flap frames continuously.
      return Math.floor(elapsedMs / OWL_FLAP_MS) % OWL_FRAMES;
    case 'Frog':
      if (!isMoving) return 0; // grounded crouch
      return Math.floor(elapsedMs / FROG_HOP_MS) % 2; // F0 (grounded) <-> F1 (leap)
    case 'Chicken':
      if (!isMoving) return 0; // idle holds F0
      return 1 + (Math.floor(elapsedMs / CHICKEN_WALK_MS) % 2); // alternate F1,F2
    default:
      return 0; // single-pose animals
  }
}

/**
 * Radial hover height for air units, as a multiple of the unit's model scale, so
 * fliers float above the surface instead of standing on it. 0 keeps a unit
 * grounded.
 */
export function airLiftFactor(animal: AnimalId): number {
  if (animal === 'Bee') return 3.5;
  if (animal === 'Owl') return 2.0;
  return 0;
}

// Bear walk rock: a moving Bear sways on its local x-axis, peaking at ±10° with one
// full sway every 700ms (350ms each way) — mirroring UnitsLayer's bearTiltPitch. The
// Bear ships a single body model, so this procedural tilt is its only walk motion.
const BEAR_TILT_RAD = (10 * Math.PI) / 180;
const BEAR_TILT_PERIOD_MS = 700;

// Bunny hop: a moving Bunny rises and falls along a sine arch, ~3.7 hops/sec (Quick
// Play drives the Bunny's hop at moveSpeed/5 ≈ 3.7Hz for its speed), peaking at 0.25×
// its own size — the same hop-height ratio Quick Play uses (1.5 world units on a
// 6-unit-tall bunny). Like the Bear, the Bunny is single-pose, so the bob is its walk.
const BUNNY_HOP_PERIOD_MS = 270;
const BUNNY_HOP_LIFT_FACTOR = 0.25;

/**
 * Local-x pitch (radians) for a walking animal's body rock this frame. Only the Bear
 * rocks; every other animal (and any idle Bear) stays level (returns 0). Mirrors the
 * main game so a Conquest bear reads the same as a Quick-Play one.
 */
export function walkTiltPitch(animal: AnimalId, isMoving: boolean, elapsedMs: number): number {
  if (animal !== 'Bear' || !isMoving) return 0;
  const phase = (elapsedMs / BEAR_TILT_PERIOD_MS) * Math.PI * 2;
  return Math.sin(phase) * BEAR_TILT_RAD;
}

/**
 * Vertical hop lift for a moving animal this frame, as a multiple of the unit's model
 * scale (so it scales with the unit like `airLiftFactor`). Only the Bunny hops; every
 * other animal (and any idle Bunny) returns 0. The arch is always non-negative — the
 * unit springs up and lands rather than dipping below the ground.
 */
export function hopLiftFactor(animal: AnimalId, isMoving: boolean, elapsedMs: number): number {
  if (animal !== 'Bunny' || !isMoving) return 0;
  const phase = (elapsedMs % BUNNY_HOP_PERIOD_MS) / BUNNY_HOP_PERIOD_MS;
  return Math.sin(phase * Math.PI) * BUNNY_HOP_LIFT_FACTOR;
}
