import { test, expect } from '@playwright/test';
import type { Position3D } from '../src/game/types';
import {
  BLOCKER_LOOKAHEAD,
  BLOCKER_DEFLECT_STRENGTH,
  deflectAroundBlockers,
  type SteerBlocker,
} from '../src/components/Working/movementSteering';

/**
 * Pure-logic tests for the look-ahead obstacle-avoidance steering. They feed the real
 * helper real blocker geometry (no values are hard-coded into the module under test) and
 * assert the resulting heading actually leads around the blockers, which is the behaviour
 * the moving-unit branch of the game tick relies on to route selected units around a clump
 * of stationary teammates instead of ramming them head-on.
 *
 * Run with: npx playwright test --config "Unit Tests/playwright.config.ts"
 */

const ORIGIN: Position3D = { x: 0, y: 0, z: 0 };

// Default lane half-width used by most cases; matches the game's minimum unit spacing scale.
const LANE = 3.75;

function blocker(x: number, z: number, laneHalfWidth: number = LANE): SteerBlocker {
  return { position: { x, y: 0, z }, laneHalfWidth };
}

// Heading magnitude check: the helper always returns a unit-length XZ vector (or the input
// when nothing deflects), so callers can scale it by move speed directly.
function magnitudeXZ(v: Position3D): number {
  return Math.hypot(v.x, v.z);
}

test.describe('deflectAroundBlockers — when to steer', () => {
  test('returns the desired direction unchanged when no blocker is in the lane', () => {
    const desired: Position3D = { x: 0, y: 0, z: 1 }; // travelling +Z
    const result = deflectAroundBlockers(ORIGIN, desired, []);
    expect(result).toEqual(desired);
  });

  test('ignores a blocker behind the mover', () => {
    const desired: Position3D = { x: 0, y: 0, z: 1 };
    // Blocker is directly behind (-Z): forward projection is negative.
    const result = deflectAroundBlockers(ORIGIN, desired, [blocker(0, -2)]);
    expect(result).toEqual(desired);
  });

  test('ignores a blocker beyond the look-ahead distance', () => {
    const desired: Position3D = { x: 0, y: 0, z: 1 };
    const result = deflectAroundBlockers(ORIGIN, desired, [blocker(0, BLOCKER_LOOKAHEAD + 2)]);
    expect(result).toEqual(desired);
  });

  test('ignores a blocker outside the travel lane', () => {
    const desired: Position3D = { x: 0, y: 0, z: 1 };
    // Ahead in Z, but laterally far enough out that it does not block the lane.
    const result = deflectAroundBlockers(ORIGIN, desired, [blocker(LANE + 1, 2)]);
    expect(result).toEqual(desired);
  });
});

test.describe('deflectAroundBlockers — which way to steer', () => {
  test('steers right (negative X) around a dead-centre blocker', () => {
    const desired: Position3D = { x: 0, y: 0, z: 1 }; // travelling +Z
    const result = deflectAroundBlockers(ORIGIN, desired, [blocker(0, 2)]);
    // A centred blocker is the ambiguous case; the helper commits to the mover's right so it
    // never dithers. For +Z travel the right-hand side is -X.
    expect(result.x).toBeLessThan(0);
    expect(result.z).toBeGreaterThan(0); // still making forward progress
  });

  test('steers away from a blocker offset to the left', () => {
    const desired: Position3D = { x: 0, y: 0, z: 1 };
    // Blocker slightly to the mover's left (+X is left for +Z travel): steer right (-X).
    const result = deflectAroundBlockers(ORIGIN, desired, [blocker(1, 2)]);
    expect(result.x).toBeLessThan(0);
  });

  test('steers away from a blocker offset to the right', () => {
    const desired: Position3D = { x: 0, y: 0, z: 1 };
    // Blocker slightly to the mover's right (-X): steer left (+X).
    const result = deflectAroundBlockers(ORIGIN, desired, [blocker(-1, 2)]);
    expect(result.x).toBeGreaterThan(0);
  });

  test('picks the nearest blocker when several share the lane', () => {
    const desired: Position3D = { x: 0, y: 0, z: 1 };
    // Far blocker is to the left, near blocker is to the right. The nearer one wins, so the
    // mover steers left (away from the near right-side blocker).
    const far = blocker(2, 5);
    const near = blocker(-1.5, 1.5);
    const result = deflectAroundBlockers(ORIGIN, desired, [far, near]);
    expect(result.x).toBeGreaterThan(0);
  });
});

test.describe('deflectAroundBlockers — steering shape', () => {
  test('returns a normalized heading so speed is preserved when scaled', () => {
    const desired: Position3D = { x: 0, y: 0, z: 1 };
    const result = deflectAroundBlockers(ORIGIN, desired, [blocker(0.5, 2)]);
    expect(magnitudeXZ(result)).toBeCloseTo(1, 5);
  });

  test('a nearer blocker deflects harder than a distant one', () => {
    const desired: Position3D = { x: 0, y: 0, z: 1 };
    // Same lateral offset, different forward distance: proximity scales the deflection.
    const nearHeading = deflectAroundBlockers(ORIGIN, desired, [blocker(0.5, 1)]);
    const farHeading = deflectAroundBlockers(ORIGIN, desired, [blocker(0.5, BLOCKER_LOOKAHEAD - 1)]);
    // Larger |x| means a sharper turn off the original +Z course.
    expect(Math.abs(nearHeading.x)).toBeGreaterThan(Math.abs(farHeading.x));
  });

  test('never reverses the mover — forward progress is retained even at contact', () => {
    const desired: Position3D = { x: 0, y: 0, z: 1 };
    // Blocker essentially at contact, dead centre: the strongest deflection the helper makes.
    const result = deflectAroundBlockers(ORIGIN, desired, [blocker(0, 0.2)]);
    // Forward component stays positive (the unit keeps advancing while it slides around),
    // confirming BLOCKER_DEFLECT_STRENGTH stays in the "slide", not "back up", regime.
    expect(result.z).toBeGreaterThan(0);
    expect(BLOCKER_DEFLECT_STRENGTH).toBeLessThan(2); // a turn, never a reversal
  });
});

test.describe('deflectAroundBlockers — diagonal travel', () => {
  test('measures the lane relative to the actual heading, not the world axes', () => {
    // Travelling diagonally (+X, +Z). A blocker straight ahead along that diagonal should
    // still register and deflect the heading off the diagonal.
    const desired: Position3D = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 };
    const aheadOnDiagonal = blocker(Math.SQRT1_2 * 3, Math.SQRT1_2 * 3);
    const result = deflectAroundBlockers(ORIGIN, desired, [aheadOnDiagonal]);
    // The heading must change (it was deflected) but stay unit length.
    expect(magnitudeXZ(result)).toBeCloseTo(1, 5);
    const unchanged = Math.abs(result.x - desired.x) < 1e-6 && Math.abs(result.z - desired.z) < 1e-6;
    expect(unchanged).toBe(false);
  });
});
