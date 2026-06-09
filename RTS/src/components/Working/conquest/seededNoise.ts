// Seeded 3D Perlin noise + fractional Brownian motion for Conquest worldgen.
//
// Single responsibility: produce a reproducible, smoothly-varying scalar field
// over the sphere from a numeric seed. The biome classifier samples this field
// for elevation and moisture, so seeding it deterministically is what makes a
// Conquest seed reproduce the exact same planet for every player (and for the
// determinism tests).
//
// The classic Perlin permutation table is shuffled with the project's SeededRng
// (Fisher–Yates) instead of Math.random(), so two instances built from the same
// seed yield identical noise everywhere.

import { SeededRng } from '../net/prng';

const PERMUTATION_SIZE = 256;
const PERMUTATION_MASK = PERMUTATION_SIZE - 1;

export class SeededNoise {
  // Doubled permutation table (512 entries) to avoid index wrapping in noise().
  private readonly permutation: Uint8Array;

  constructor(seed: number) {
    this.permutation = SeededNoise.buildPermutation(seed);
  }

  private static buildPermutation(seed: number): Uint8Array {
    const rng = new SeededRng(seed);
    const base = new Uint8Array(PERMUTATION_SIZE);
    for (let i = 0; i < PERMUTATION_SIZE; i++) base[i] = i;

    // Fisher–Yates shuffle driven by the seeded generator.
    for (let i = PERMUTATION_SIZE - 1; i > 0; i--) {
      const j = rng.nextInt(i + 1);
      const swap = base[i];
      base[i] = base[j];
      base[j] = swap;
    }

    const doubled = new Uint8Array(PERMUTATION_SIZE * 2);
    for (let i = 0; i < doubled.length; i++) doubled[i] = base[i & PERMUTATION_MASK];
    return doubled;
  }

  private static fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  private static lerp(t: number, a: number, b: number): number {
    return a + t * (b - a);
  }

  private static grad(hash: number, x: number, y: number, z: number): number {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }

  /** Raw Perlin noise in roughly [-1, 1]. */
  noise(x: number, y: number, z: number): number {
    const xi = Math.floor(x) & PERMUTATION_MASK;
    const yi = Math.floor(y) & PERMUTATION_MASK;
    const zi = Math.floor(z) & PERMUTATION_MASK;

    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const zf = z - Math.floor(z);

    const u = SeededNoise.fade(xf);
    const v = SeededNoise.fade(yf);
    const w = SeededNoise.fade(zf);

    const p = this.permutation;
    const a = p[xi] + yi;
    const aa = p[a] + zi;
    const ab = p[a + 1] + zi;
    const b = p[xi + 1] + yi;
    const ba = p[b] + zi;
    const bb = p[b + 1] + zi;

    const { grad, lerp } = SeededNoise;
    return lerp(w,
      lerp(v,
        lerp(u, grad(p[aa], xf, yf, zf), grad(p[ba], xf - 1, yf, zf)),
        lerp(u, grad(p[ab], xf, yf - 1, zf), grad(p[bb], xf - 1, yf - 1, zf))),
      lerp(v,
        lerp(u, grad(p[aa + 1], xf, yf, zf - 1), grad(p[ba + 1], xf - 1, yf, zf - 1)),
        lerp(u, grad(p[ab + 1], xf, yf - 1, zf - 1), grad(p[bb + 1], xf - 1, yf - 1, zf - 1))));
  }

  /**
   * Fractional Brownian motion: layered octaves of noise normalized to [0, 1].
   * This is the field the biome classifier actually samples.
   *
   * `gain` controls how fast amplitude decays per octave (roughness) and
   * `lacunarity` how fast frequency grows (detail spacing). They default to the
   * classic 0.5 / 2, so an unparameterized call is byte-identical to the original
   * fBm — new behavior is strictly opt-in.
   */
  fbm(
    x: number,
    y: number,
    z: number,
    octaves = 4,
    gain = 0.5,
    lacunarity = 2,
  ): number {
    let value = 0;
    let amplitude = 0.5;
    let frequency = 1;
    for (let octave = 0; octave < octaves; octave++) {
      value += amplitude * this.noise(x * frequency, y * frequency, z * frequency);
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return (value + 1) / 2;
  }

  /**
   * Ridged fractional Brownian motion: accumulates `1 - |noise|` (squared to
   * sharpen the creases) so the field peaks along thin ridge lines instead of
   * rounded hills. Normalized to [0, 1] by the total octave amplitude, so it is a
   * total function the mountain-range pass can threshold directly. Sharing the
   * permutation table with `fbm` keeps every field on one seeded source.
   */
  ridgedFbm(
    x: number,
    y: number,
    z: number,
    octaves = 4,
    gain = 0.5,
    lacunarity = 2,
  ): number {
    let value = 0;
    let amplitude = 0.5;
    let frequency = 1;
    let totalAmplitude = 0;
    for (let octave = 0; octave < octaves; octave++) {
      const ridge = 1 - Math.abs(this.noise(x * frequency, y * frequency, z * frequency));
      value += amplitude * ridge * ridge;
      totalAmplitude += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return totalAmplitude > 0 ? value / totalAmplitude : 0;
  }
}
