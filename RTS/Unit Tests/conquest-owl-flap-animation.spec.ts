import { test, expect } from '@playwright/test';
import { selectPoseIndex, airLiftFactor } from '../src/components/Working/conquest/conquestPose';

/**
 * Unit tests for the Conquest Owl's flight animation.
 *
 * In Quick Play an Owl flies by swapping between four dedicated wing-flap GLBs
 * (Owl_Wings_Up/Almost_Down/Down/Glide). The Conquest renderer animates by toggling
 * which baked pose variant is visible each frame, choosing the index from the pure
 * `selectPoseIndex`. Previously the Owl was treated as single-pose, so it held a
 * static body and never flapped.
 *
 * These are pure Node tests against `selectPoseIndex` / `airLiftFactor` (both
 * side-effect-free, no three.js or loader imports), so they assert the real animation
 * contract — an always-on flap cycle, contiguous in-range frames, the Quick-Play flap
 * rate, and airborne lift — with no browser and no hard-coded frame table. The frame
 * count and cadence are *derived* from the function's own output.
 */

// Mirrors Quick Play's OWL_WING_FLAP_PER_SEC (state.ts): the wing cycle completes this
// many times per second. The frame count is intentionally NOT hard-coded here — it is
// discovered from selectPoseIndex so the test tracks the asset set, not a copied number.
const EXPECTED_FLAPS_PER_SEC = 4;
const MS_PER_SEC = 1000;

/**
 * Discover the Owl's flap cycle straight from the function under test: sample the pose
 * index across a wide time span at fine resolution and read back the set of frames it
 * visits and the millisecond boundary at which it first advances off frame 0.
 */
function discoverFlapCycle(): { frames: number[]; frameMs: number } {
  const SPAN_MS = 2000;
  const STEP_MS = 0.5;
  const frames = new Set<number>();
  let frameMs = 0;
  for (let t = 0; t <= SPAN_MS; t += STEP_MS) {
    const index = selectPoseIndex('Owl', true, t);
    frames.add(index);
    if (frameMs === 0 && index === 1) frameMs = t; // first step off the opening frame
  }
  return { frames: Array.from(frames).sort((a, b) => a - b), frameMs };
}

test.describe('Conquest Owl flight animation', () => {
  test('the Owl cycles a contiguous set of multiple wing frames', () => {
    const { frames } = discoverFlapCycle();
    // It flaps through more than one pose (not stuck on a static body) …
    expect(frames.length).toBeGreaterThan(1);
    // … and the frames are 0..N-1 with no gaps, so each maps to a real baked variant.
    frames.forEach((frame, position) => expect(frame).toBe(position));
  });

  test('the Owl flaps whether moving or idle (always airborne)', () => {
    const { frames, frameMs } = discoverFlapCycle();
    const frameCount = frames.length;
    // Sample across several full cycles; a hovering (idle) Owl must flap identically to
    // a travelling one — movement state may not stall the wings.
    for (let i = 0; i < frameCount * 4; i++) {
      const elapsedMs = i * frameMs;
      expect(selectPoseIndex('Owl', false, elapsedMs)).toBe(selectPoseIndex('Owl', true, elapsedMs));
    }
  });

  test('the flap advances one frame per step, wraps cleanly, and matches the Quick-Play rate', () => {
    const { frames, frameMs } = discoverFlapCycle();
    const frameCount = frames.length;

    // Starts on frame 0, steps up one frame per cadence, then wraps back to 0 after a
    // full cycle — the exact swap pattern the renderer toggles between pose groups.
    expect(selectPoseIndex('Owl', true, 0)).toBe(0);
    for (let frame = 0; frame < frameCount; frame++) {
      expect(selectPoseIndex('Owl', true, frame * frameMs)).toBe(frame);
    }
    expect(selectPoseIndex('Owl', true, frameCount * frameMs)).toBe(0);

    // The derived cadence reproduces the Quick-Play flap rate (full cycle per
    // 1/EXPECTED_FLAPS_PER_SEC second), so the swoop reads the same in both modes.
    const cyclePeriodMs = frameMs * frameCount;
    expect(MS_PER_SEC / cyclePeriodMs).toBeCloseTo(EXPECTED_FLAPS_PER_SEC, 5);
  });

  test('the Owl hovers above the surface while grounded walkers do not', () => {
    expect(airLiftFactor('Owl')).toBeGreaterThan(0);
    expect(airLiftFactor('Bear')).toBe(0);
  });
});
