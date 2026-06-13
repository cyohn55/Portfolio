/**
 * Lava-eruption particle simulation.
 *
 * A self-contained, framework-free CPU particle system that drives the victory
 * eruption bursting from the Battle_Map's Center/Left/Right "Eruption" vents.
 * It owns only the physics and the lava look (color/size/opacity over a
 * particle's life); the renderer (`LavaEruption.tsx`) owns the Three.js plumbing
 * and simply uploads the output buffers this module fills. Keeping the math here
 * — with no Three.js or React imports — makes the eruption behavior unit-testable
 * in plain Node against real outputs.
 *
 * Coordinates are world units, matching the Battle_Map scale (vents sit ~25-30
 * units up). Time is in seconds. This effect is purely cosmetic and runs off the
 * render clock, so it is intentionally outside the deterministic sim tick and may
 * use a normal RNG.
 */

/** Random source contract: returns a float in [0, 1). Defaults to Math.random. */
export type RandomSource = () => number;

// ---------------------------------------------------------------------------
// Tunable constants — the whole feel of the eruption lives here.
// ---------------------------------------------------------------------------

/** Particles allocated per vent. Three vents => 3x this many points total. */
export const PARTICLES_PER_VENT = 240;

/** How long each vent actively emits new lava after the win (seconds). */
export const EMISSION_DURATION_S = 3.0;

/** Longest a single particle can live, so the renderer knows when the last
 *  emitted particle has surely died and the whole effect can be retired. */
export const MAX_PARTICLE_LIFETIME_S = 2.0;

/** Total wall-clock span from ignition to the last particle fading out. */
export const ERUPTION_TOTAL_DURATION_S = EMISSION_DURATION_S + MAX_PARTICLE_LIFETIME_S;

/**
 * Delay before the post-game "Winner" screen is revealed, so the eruption plays
 * in full view first. Sits just past peak emission while particles are still
 * arcing, giving a dramatic finale before the overlay covers the field.
 */
export const ERUPTION_REVEAL_DELAY_MS = 3500;

/** Downward acceleration pulling launched lava back toward the vent. */
const GRAVITY = 30;

/** Upward launch speed range — the vertical "kick" out of the vent. */
const MIN_UPWARD_SPEED = 30;
const MAX_UPWARD_SPEED = 48;

/** Sideways spread speed, giving the plume its cone shape. */
const MAX_LATERAL_SPEED = 11;

/** Radius of the disk at the vent mouth particles are born within. */
const ORIGIN_JITTER_RADIUS = 1.6;
/** Small extra upward offset at birth so particles emerge from the rim, not under it. */
const ORIGIN_RISE = 1.0;

/** Particle lifetime range (seconds). Max must equal MAX_PARTICLE_LIFETIME_S. */
const MIN_LIFETIME_S = 1.0;
const MAX_LIFETIME_S = MAX_PARTICLE_LIFETIME_S;

/** When recycling a live particle, stagger its rebirth by up to this many seconds
 *  (as a negative "wait") so recycled lava doesn't visibly pop in lockstep. */
const MAX_RESPAWN_STAGGER_S = 0.28;
/** Initial burst is staggered across this window so the plume ramps up, not pops. */
const MAX_INITIAL_STAGGER_S = 0.5;

/** World-space blob radius range at birth, shrinking toward END_SIZE_FACTOR as it cools. */
const MIN_BLOB_RADIUS = 1.4;
const MAX_BLOB_RADIUS = 3.4;
const END_SIZE_FACTOR = 0.28;

/** Peak particle opacity (additive-blended, so this scales glow intensity). */
const PEAK_ALPHA = 0.9;
/** Fraction of life spent fading in / out. */
const FADE_IN_FRACTION = 0.08;
const FADE_OUT_FRACTION = 0.35;

/**
 * Lava color ramp by normalized life t in [0, 1]: bright yellow-white at birth,
 * cooling through orange to a dark ember. Each stop is [t, r, g, b].
 */
const COLOR_STOPS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.0, 1.0, 0.96, 0.7],
  [0.22, 1.0, 0.62, 0.18],
  [0.55, 0.96, 0.26, 0.05],
  [1.0, 0.32, 0.04, 0.02],
];

export type Vec3Tuple = readonly [number, number, number];

/**
 * The particle pool. Physics arrays (position/velocity/age/...) are the
 * simulation's own state; the trailing buffers (color/size/alpha) are outputs
 * the renderer uploads verbatim each frame.
 */
export interface EruptionParticles {
  /** Total particle count across all vents (ventCount * particlesPerVent). */
  readonly count: number;
  readonly ventCount: number;
  /** Flat xyz positions, length count*3. Bound directly as the geometry's `position`. */
  readonly position: Float32Array;
  readonly velocity: Float32Array;
  /** Seconds since (re)birth; negative means "waiting to emit" (not yet visible). */
  readonly age: Float32Array;
  readonly lifetime: Float32Array;
  /** Per-particle birth blob radius (world units), shrunk over life for the size output. */
  readonly blobRadius: Float32Array;
  /** Vent index each particle belongs to, so it always reignites from its own vent. */
  readonly home: Int32Array;
  /** Output: flat rgb per particle, length count*3. */
  readonly color: Float32Array;
  /** Output: current world-space blob radius per particle (0 when dead/waiting). */
  readonly size: Float32Array;
  /** Output: current opacity per particle (0 when dead/waiting). */
  readonly alpha: Float32Array;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Lava color at normalized life t, written into `out` at offset `off`. */
export function writeLavaColor(t: number, out: Float32Array, off: number): void {
  const life = clamp01(t);
  for (let stop = 1; stop < COLOR_STOPS.length; stop++) {
    const [endT, endR, endG, endB] = COLOR_STOPS[stop];
    if (life <= endT || stop === COLOR_STOPS.length - 1) {
      const [startT, startR, startG, startB] = COLOR_STOPS[stop - 1];
      const span = endT - startT;
      const k = span > 0 ? clamp01((life - startT) / span) : 0;
      out[off] = lerp(startR, endR, k);
      out[off + 1] = lerp(startG, endG, k);
      out[off + 2] = lerp(startB, endB, k);
      return;
    }
  }
}

/** Opacity envelope at normalized life t: fade in fast, hold, fade out. */
export function alphaAtLife(t: number): number {
  if (t < 0 || t > 1) return 0;
  const fadeIn = clamp01(t / FADE_IN_FRACTION);
  const fadeOut = clamp01((1 - t) / FADE_OUT_FRACTION);
  return Math.min(fadeIn, fadeOut) * PEAK_ALPHA;
}

/** Blob radius at normalized life t given its birth radius: cools/shrinks over life. */
export function sizeRadiusAtLife(birthRadius: number, t: number): number {
  return birthRadius * lerp(1, END_SIZE_FACTOR, clamp01(t));
}

/**
 * (Re)launch particle `i` from its home vent: fresh position at the vent mouth,
 * an upward-and-outward velocity, a new lifetime and blob radius, and a (usually
 * negative) starting age so its appearance is staggered.
 */
export function spawnParticle(
  state: EruptionParticles,
  i: number,
  origins: ReadonlyArray<Vec3Tuple>,
  rng: RandomSource,
  initialAge: number,
): void {
  const vent = origins[state.home[i]];
  const p3 = i * 3;

  // Birth position: a small disk at the vent mouth (sqrt for area-uniform spread).
  const birthAngle = rng() * Math.PI * 2;
  const birthRadius = Math.sqrt(rng()) * ORIGIN_JITTER_RADIUS;
  state.position[p3] = vent[0] + Math.cos(birthAngle) * birthRadius;
  state.position[p3 + 1] = vent[1] + rng() * ORIGIN_RISE;
  state.position[p3 + 2] = vent[2] + Math.sin(birthAngle) * birthRadius;

  // Velocity: strong upward kick plus a lateral spread cone.
  const spreadAngle = rng() * Math.PI * 2;
  const lateralSpeed = Math.sqrt(rng()) * MAX_LATERAL_SPEED;
  state.velocity[p3] = Math.cos(spreadAngle) * lateralSpeed;
  state.velocity[p3 + 1] = lerp(MIN_UPWARD_SPEED, MAX_UPWARD_SPEED, rng());
  state.velocity[p3 + 2] = Math.sin(spreadAngle) * lateralSpeed;

  state.age[i] = initialAge;
  state.lifetime[i] = lerp(MIN_LIFETIME_S, MAX_LIFETIME_S, rng());
  state.blobRadius[i] = lerp(MIN_BLOB_RADIUS, MAX_BLOB_RADIUS, rng());

  // A waiting particle is invisible until its age crosses zero.
  state.size[i] = 0;
  state.alpha[i] = 0;
}

/** Allocate a particle pool spread evenly across `ventCount` vents and arm it. */
export function createEruptionParticles(
  ventCount: number,
  particlesPerVent: number,
  origins: ReadonlyArray<Vec3Tuple>,
  rng: RandomSource = Math.random,
): EruptionParticles {
  const count = Math.max(0, ventCount) * Math.max(0, particlesPerVent);
  const state: EruptionParticles = {
    count,
    ventCount,
    position: new Float32Array(count * 3),
    velocity: new Float32Array(count * 3),
    age: new Float32Array(count),
    lifetime: new Float32Array(count),
    blobRadius: new Float32Array(count),
    home: new Int32Array(count),
    color: new Float32Array(count * 3),
    size: new Float32Array(count),
    alpha: new Float32Array(count),
  };
  for (let i = 0; i < count; i++) {
    state.home[i] = Math.floor(i / particlesPerVent);
  }
  resetEruptionParticles(state, origins, rng);
  return state;
}

/** Re-arm an existing pool for a fresh eruption (used when a new win fires). */
export function resetEruptionParticles(
  state: EruptionParticles,
  origins: ReadonlyArray<Vec3Tuple>,
  rng: RandomSource = Math.random,
): void {
  if (origins.length === 0) return;
  for (let i = 0; i < state.count; i++) {
    spawnParticle(state, i, origins, rng, -rng() * MAX_INITIAL_STAGGER_S);
  }
}

/**
 * Advance the simulation by `dt` seconds.
 *
 * Integrates gravity for live particles, recycles spent ones while `emitting`,
 * and refreshes the color/size/alpha output buffers. When `emitting` is false,
 * spent particles are left dead (size 0) so the plume tails off naturally.
 */
export function updateEruptionParticles(
  state: EruptionParticles,
  origins: ReadonlyArray<Vec3Tuple>,
  dt: number,
  emitting: boolean,
  rng: RandomSource = Math.random,
): void {
  if (origins.length === 0) return;
  for (let i = 0; i < state.count; i++) {
    state.age[i] += dt;

    if (state.age[i] >= state.lifetime[i]) {
      if (emitting) {
        // Recycle from the same vent, staggered so reignition isn't synchronized.
        spawnParticle(state, i, origins, rng, -rng() * MAX_RESPAWN_STAGGER_S);
      } else {
        state.size[i] = 0;
        state.alpha[i] = 0;
        continue;
      }
    }

    const age = state.age[i];
    if (age < 0) {
      // Still waiting to emit — invisible and inert.
      state.size[i] = 0;
      state.alpha[i] = 0;
      continue;
    }

    // Ballistic integration: gravity bends the upward launch into an arc.
    const p3 = i * 3;
    state.velocity[p3 + 1] -= GRAVITY * dt;
    state.position[p3] += state.velocity[p3] * dt;
    state.position[p3 + 1] += state.velocity[p3 + 1] * dt;
    state.position[p3 + 2] += state.velocity[p3 + 2] * dt;

    const t = state.lifetime[i] > 0 ? age / state.lifetime[i] : 1;
    writeLavaColor(t, state.color, p3);
    state.size[i] = sizeRadiusAtLife(state.blobRadius[i], t);
    state.alpha[i] = alphaAtLife(t);
  }
}

/** True once every particle has gone dark — the effect can be retired. */
export function isEruptionComplete(state: EruptionParticles): boolean {
  for (let i = 0; i < state.count; i++) {
    if (state.size[i] > 0) return false;
  }
  return true;
}
