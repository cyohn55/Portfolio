import { test, expect } from '@playwright/test';
import { walkTiltPitch, hopLiftFactor } from '../src/components/Working/conquest/conquestPose';

/**
 * Unit tests for the Conquest Bear walk-rock and Bunny hop animations.
 *
 * Both animals ship a single body GLB (no pose-swap frames), so Quick Play animates
 * their locomotion procedurally: a moving Bear rocks on its local x-axis (±10°, one
 * full sway per 700ms), and a moving Bunny springs along a non-negative sine arch
 * peaking at 0.25× its own size. The Conquest renderer reads the same two pure
 * helpers — `walkTiltPitch` feeds the body quaternion, `hopLiftFactor` feeds the
 * radial lift — so a Conquest bear/bunny moves like its Quick-Play counterpart.
 *
 * Pure Node tests (no three.js / loader imports). They assert the real motion
 * contract — gating by animal + movement, the sine shape, peak magnitudes, bounds,
 * and periodicity — against the functions' own output. The cycle period is *derived*
 * by sampling rather than copied from the implementation; tight assertions are made
 * only at the flat extrema (insensitive to that sampling error), while steep
 * zero-crossings are checked by sign change and bounds instead of exact magnitude.
 */

const RAD_TO_DEG = 180 / Math.PI;
const SCAN_STEP_MS = 0.05;
const SCAN_SPAN_MS = 2000;

/** Sample one animation curve across the scan span at a fine step. */
function sampleCurve(at: (t: number) => number): { t: number; v: number }[] {
  const samples: { t: number; v: number }[] = [];
  for (let t = 0; t <= SCAN_SPAN_MS; t += SCAN_STEP_MS) samples.push({ t, v: at(t) });
  return samples;
}

/** Time of the first local maximum strictly inside the scan (a flat peak). */
function firstPeakMs(samples: { t: number; v: number }[]): number {
  for (let i = 1; i < samples.length - 1; i++) {
    if (samples[i].v > samples[i - 1].v && samples[i].v >= samples[i + 1].v) return samples[i].t;
  }
  throw new Error('no peak found in scan');
}

test.describe('Conquest Bear walk-rock animation', () => {
  test('only a moving Bear rocks; idle bears and other animals stay level', () => {
    expect(walkTiltPitch('Bear', false, 175)).toBe(0); // idle bear is upright
    expect(walkTiltPitch('Bunny', true, 175)).toBe(0); // non-bears never use this tilt
    expect(walkTiltPitch('Cat', true, 175)).toBe(0);
  });

  test('the rock starts level and reaches a +10° / -10° peak', () => {
    const samples = sampleCurve((t) => walkTiltPitch('Bear', true, t));
    const peakUpMs = firstPeakMs(samples);

    // Opens level (exact, sin(0) = 0), then swings up to +10° a quarter-sway in.
    expect(walkTiltPitch('Bear', true, 0)).toBeCloseTo(0, 9);
    expect(walkTiltPitch('Bear', true, peakUpMs) * RAD_TO_DEG).toBeCloseTo(10, 3);

    // The full extremes over the scan are symmetric ±10° (flat peaks, sampling-robust).
    const degrees = samples.map((s) => s.v * RAD_TO_DEG);
    const maxDeg = Math.max(...degrees);
    const minDeg = Math.min(...degrees);
    expect(maxDeg).toBeCloseTo(10, 3);
    expect(minDeg).toBeCloseTo(-10, 3);
    expect(maxDeg).toBeCloseTo(-minDeg, 3);
  });

  test('the rock stays within ±10°, sways through level both ways, and repeats each sway', () => {
    const samples = sampleCurve((t) => walkTiltPitch('Bear', true, t));

    // Never tips past the ±10° design limit, and genuinely rocks to both sides
    // (passing through the upright pose between swings).
    let sawUp = false;
    let sawDown = false;
    for (const { v } of samples) {
      const deg = v * RAD_TO_DEG;
      expect(Math.abs(deg)).toBeLessThanOrEqual(10 + 1e-6);
      if (deg > 1e-3) sawUp = true;
      if (deg < -1e-3) sawDown = true;
    }
    expect(sawUp && sawDown).toBe(true);

    // One full sway later the pose repeats: compare at the flat peak (robust to the
    // sampling-derived period) rather than at a steep zero-crossing.
    const peakUpMs = firstPeakMs(samples);
    const swayPeriodMs = firstPeakMs(samples.filter((s) => s.t > peakUpMs + 1)) - peakUpMs;
    expect(swayPeriodMs).toBeGreaterThan(0);
    expect(walkTiltPitch('Bear', true, peakUpMs + swayPeriodMs))
      .toBeCloseTo(walkTiltPitch('Bear', true, peakUpMs), 4);
  });
});

test.describe('Conquest Bunny hop animation', () => {
  test('only a moving Bunny hops; idle bunnies and other animals stay grounded', () => {
    expect(hopLiftFactor('Bunny', false, 90)).toBe(0); // idle bunny is planted
    expect(hopLiftFactor('Bear', true, 90)).toBe(0); // non-bunnies never use this lift
    expect(hopLiftFactor('Frog', true, 90)).toBe(0);
  });

  test('the hop launches from the ground and arcs to a 0.25× peak', () => {
    const samples = sampleCurve((t) => hopLiftFactor('Bunny', true, t));
    const apexMs = firstPeakMs(samples);

    // Starts on the ground (exact), then springs to its apex of 0.25× the unit scale.
    expect(hopLiftFactor('Bunny', true, 0)).toBeCloseTo(0, 9);
    expect(hopLiftFactor('Bunny', true, apexMs)).toBeCloseTo(0.25, 3);
  });

  test('the hop never dips below the ground, is bounded by its peak, and lands again', () => {
    const samples = sampleCurve((t) => hopLiftFactor('Bunny', true, t));
    const lifts = samples.map((s) => s.v);
    const minLift = Math.min(...lifts);
    const maxLift = Math.max(...lifts);

    // A hop springs up and lands — it must never push the bunny below the surface …
    expect(minLift).toBeGreaterThanOrEqual(0);
    // … it returns to the ground between hops …
    expect(minLift).toBeLessThan(1e-3);
    // … and tops out at the 0.25 peak (reached, not exceeded).
    expect(maxLift).toBeCloseTo(0.25, 3);
    expect(maxLift).toBeLessThanOrEqual(0.25 + 1e-6);
  });
});
