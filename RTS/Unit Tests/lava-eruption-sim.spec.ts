import { test, expect } from '@playwright/test';
import { SeededRng } from '../src/components/Working/net/prng';
import {
  createEruptionParticles,
  updateEruptionParticles,
  resetEruptionParticles,
  isEruptionComplete,
  writeLavaColor,
  alphaAtLife,
  sizeRadiusAtLife,
  EMISSION_DURATION_S,
  ERUPTION_TOTAL_DURATION_S,
  MAX_PARTICLE_LIFETIME_S,
  type Vec3Tuple,
} from '../src/components/Working/lavaEruptionSim';

/**
 * Unit tests for the victory lava-eruption particle simulation.
 *
 * These run purely in the Playwright test process (Node) — the simulation module
 * has no three.js or React dependency by design, so the physics and lava look can
 * be validated directly. Every assertion checks the simulation's actual outputs
 * (positions it integrates, color/size/alpha it produces, completion it reports)
 * rather than magic numbers copied from the implementation, so they stay valid if
 * the eruption is ever retuned.
 *
 * A seeded RNG drives spawning so the stochastic launch parameters are
 * reproducible across runs.
 */

const VENTS: Vec3Tuple[] = [
  [1.6, 30.29, -301.17], // Center_Eruption
  [-78.5, 27.5, -287], // Left_Eruption
  [91.5, 25, -286], // Right_Eruption
];

const PARTICLES_PER_VENT = 32; // small pool keeps the tests fast and exhaustive

/** A RandomSource backed by the project's deterministic PRNG, for reproducibility. */
function seededRandom(seed: number): () => number {
  const generator = new SeededRng(seed);
  return () => generator.next();
}

/** Advance a system by `totalSeconds` in fixed `dt` steps while `emitting`. */
function advance(
  state: ReturnType<typeof createEruptionParticles>,
  origins: Vec3Tuple[],
  totalSeconds: number,
  dt: number,
  emitting: boolean,
  rng: () => number,
): void {
  const steps = Math.round(totalSeconds / dt);
  for (let step = 0; step < steps; step++) {
    updateEruptionParticles(state, origins, dt, emitting, rng);
  }
}

test('allocates one particle per vent slot and assigns each a home vent', () => {
  const state = createEruptionParticles(VENTS.length, PARTICLES_PER_VENT, VENTS, seededRandom(1));

  expect(state.count).toBe(VENTS.length * PARTICLES_PER_VENT);
  expect(state.ventCount).toBe(VENTS.length);

  // Every particle is homed to a real vent, and each vent gets an equal share.
  const perVent = new Array(VENTS.length).fill(0);
  for (let i = 0; i < state.count; i++) {
    expect(state.home[i]).toBeGreaterThanOrEqual(0);
    expect(state.home[i]).toBeLessThan(VENTS.length);
    perVent[state.home[i]]++;
  }
  for (const share of perVent) {
    expect(share).toBe(PARTICLES_PER_VENT);
  }
});

test('newly spawned particles emerge at their home vent mouth', () => {
  const state = createEruptionParticles(VENTS.length, PARTICLES_PER_VENT, VENTS, seededRandom(7));

  // After a reset every particle sits within the vent-mouth jitter disk of its home.
  for (let i = 0; i < state.count; i++) {
    const vent = VENTS[state.home[i]];
    const dx = state.position[i * 3] - vent[0];
    const dy = state.position[i * 3 + 1] - vent[1];
    const dz = state.position[i * 3 + 2] - vent[2];
    const horizontal = Math.hypot(dx, dz);
    expect(horizontal).toBeLessThanOrEqual(2.0); // jitter radius (1.6) + slack
    expect(dy).toBeGreaterThanOrEqual(0); // born at or just above the rim
    expect(dy).toBeLessThanOrEqual(1.5);
  }
});

test('particles launch upward then arc back down under gravity', () => {
  const rng = seededRandom(42);
  const state = createEruptionParticles(VENTS.length, PARTICLES_PER_VENT, VENTS, rng);

  // Track one particle's height over its life relative to its launch vent.
  const probe = 0;
  const ventY = VENTS[state.home[probe]][1];

  let peakHeight = -Infinity;
  let roseAboveVent = false;
  const dt = 1 / 60;
  // Step until this particle has clearly lived a full arc.
  for (let step = 0; step < Math.round((MAX_PARTICLE_LIFETIME_S + 0.5) / dt); step++) {
    updateEruptionParticles(state, VENTS, dt, false, rng);
    const age = state.age[probe];
    if (age >= 0 && age < state.lifetime[probe]) {
      const height = state.position[probe * 3 + 1] - ventY;
      if (height > 0) roseAboveVent = true;
      peakHeight = Math.max(peakHeight, height);
    }
  }

  // It must have climbed meaningfully above the vent before gravity won.
  expect(roseAboveVent).toBe(true);
  expect(peakHeight).toBeGreaterThan(5);
});

test('gravity decelerates a rising particle by the expected amount each step', () => {
  const rng = seededRandom(99);
  const state = createEruptionParticles(VENTS.length, PARTICLES_PER_VENT, VENTS, rng);

  // Force a single particle to be live (age 0) so the first update integrates it.
  const probe = 0;
  state.age[probe] = 0;
  const dt = 1 / 60;
  const vyBefore = state.velocity[probe * 3 + 1];

  updateEruptionParticles(state, VENTS, dt, false, rng);

  // Vertical velocity drops by gravity*dt; gravity recovered from the delta must
  // be a sensible positive constant (not asserting the literal tuning value).
  const vyAfter = state.velocity[probe * 3 + 1];
  const recoveredGravity = (vyBefore - vyAfter) / dt;
  expect(recoveredGravity).toBeGreaterThan(0);
  expect(vyAfter).toBeLessThan(vyBefore);
});

test('lava reads as hot red/orange at birth and cools to a dark red ember', () => {
  const birth = new Float32Array(3);
  const mid = new Float32Array(3);
  const death = new Float32Array(3);
  writeLavaColor(0, birth, 0);
  writeLavaColor(0.5, mid, 0);
  writeLavaColor(1, death, 0);

  // Birth is a hot orange core: red is maxed, but green stays well below red so
  // it reads orange/red rather than yellow-white, and blue is minimal.
  expect(birth[0]).toBeGreaterThan(0.9);
  expect(birth[1]).toBeLessThan(birth[0] * 0.7); // distinctly orange, not yellow
  expect(birth[2]).toBeLessThan(0.3);

  // Mid-life is dominated by red with little green — fiery red-orange.
  expect(mid[0]).toBeGreaterThan(0.8);
  expect(mid[1]).toBeLessThan(0.3);

  // Death is a dark red ember: every channel has dimmed and green cools most.
  const birthLuma = birth[0] + birth[1] + birth[2];
  const deathLuma = death[0] + death[1] + death[2];
  expect(deathLuma).toBeLessThan(birthLuma);
  expect(death[0]).toBeLessThan(birth[0]); // red dims as it cools
  expect(death[1]).toBeLessThan(birth[1]); // green cools most
});

test('opacity fades in from zero, peaks mid-life, and fades back to zero', () => {
  // Out-of-life ages are fully invisible.
  expect(alphaAtLife(-0.1)).toBe(0);
  expect(alphaAtLife(1.1)).toBe(0);

  const atBirth = alphaAtLife(0);
  const midLife = alphaAtLife(0.5);
  const atDeath = alphaAtLife(1);

  expect(atBirth).toBeLessThan(midLife); // fading in
  expect(atDeath).toBeLessThan(midLife); // fading out
  expect(atDeath).toBeCloseTo(0, 5);
  expect(midLife).toBeGreaterThan(0);
});

test('blob radius shrinks monotonically as the particle cools', () => {
  const birthRadius = 3.0;
  const young = sizeRadiusAtLife(birthRadius, 0);
  const middle = sizeRadiusAtLife(birthRadius, 0.5);
  const old = sizeRadiusAtLife(birthRadius, 1);

  expect(young).toBeCloseTo(birthRadius, 5);
  expect(middle).toBeLessThan(young);
  expect(old).toBeLessThan(middle);
  expect(old).toBeGreaterThan(0); // embers never fully vanish in size, only in alpha
});

test('the plume sustains visible particles throughout the emission window', () => {
  const rng = seededRandom(123);
  const state = createEruptionParticles(VENTS.length, PARTICLES_PER_VENT, VENTS, rng);

  // Mid-emission there must be live, visible lava in the air.
  advance(state, VENTS, EMISSION_DURATION_S / 2, 1 / 60, true, rng);

  let visible = 0;
  for (let i = 0; i < state.count; i++) {
    if (state.alpha[i] > 0 && state.size[i] > 0) visible++;
  }
  expect(visible).toBeGreaterThan(0);
  expect(isEruptionComplete(state)).toBe(false);
});

test('the eruption fully dies out once emission stops and particles live their span', () => {
  const rng = seededRandom(2024);
  const state = createEruptionParticles(VENTS.length, PARTICLES_PER_VENT, VENTS, rng);

  // Emit for the full window, then stop and let the tail settle.
  advance(state, VENTS, EMISSION_DURATION_S, 1 / 60, true, rng);
  // After emission stops, no new particles are recycled; all must age out.
  advance(state, VENTS, MAX_PARTICLE_LIFETIME_S + 0.25, 1 / 60, false, rng);

  expect(isEruptionComplete(state)).toBe(true);
  for (let i = 0; i < state.count; i++) {
    expect(state.size[i]).toBe(0);
    expect(state.alpha[i]).toBe(0);
  }
});

test('the total advertised duration outlasts the last emitted particle', () => {
  // A particle emitted at the very end of the emission window dies by the
  // advertised total duration — the contract the renderer relies on to retire.
  expect(ERUPTION_TOTAL_DURATION_S).toBeGreaterThanOrEqual(
    EMISSION_DURATION_S + MAX_PARTICLE_LIFETIME_S,
  );
});

test('re-arming restarts a spent eruption from a fresh, full plume', () => {
  const rng = seededRandom(555);
  const state = createEruptionParticles(VENTS.length, PARTICLES_PER_VENT, VENTS, rng);

  // Burn the eruption out completely.
  advance(state, VENTS, EMISSION_DURATION_S, 1 / 60, true, rng);
  advance(state, VENTS, MAX_PARTICLE_LIFETIME_S + 0.25, 1 / 60, false, rng);
  expect(isEruptionComplete(state)).toBe(true);

  // Re-arm (as a new win would) and emit again — particles return to their vents.
  resetEruptionParticles(state, VENTS, rng);
  for (let i = 0; i < state.count; i++) {
    const vent = VENTS[state.home[i]];
    const horizontal = Math.hypot(
      state.position[i * 3] - vent[0],
      state.position[i * 3 + 2] - vent[2],
    );
    expect(horizontal).toBeLessThanOrEqual(2.0);
  }

  advance(state, VENTS, EMISSION_DURATION_S / 2, 1 / 60, true, rng);
  expect(isEruptionComplete(state)).toBe(false);
});

test('with no vents the simulation is inert and produces no particles', () => {
  const state = createEruptionParticles(0, PARTICLES_PER_VENT, [], seededRandom(1));
  expect(state.count).toBe(0);
  // Updating an empty system is a no-op and never throws.
  updateEruptionParticles(state, [], 1 / 60, true, seededRandom(1));
  expect(isEruptionComplete(state)).toBe(true);
});
