import { test, expect } from '@playwright/test';
import type { Position3D } from '../src/game/types';
import {
  SHORE_SLIDE_ANGLES,
  slideAlongObstacle,
  type WalkableProbe,
} from '../src/components/Working/terrainSlide';

/**
 * Pure-logic tests for the shore-slide recovery used when a ground unit's step lands on
 * forbidden water. They feed the real helper real synthetic banks (a half-plane of water
 * at various orientations) and assert the unit glides ALONG the bank rather than freezing
 * against it — the behaviour the movement tick relies on to keep crowds from piling up
 * where the land meets the water. No values are hard-coded into the module under test; the
 * walkability of each probed candidate is decided by the geometry the test supplies.
 *
 * Run with: npx playwright test --config "Unit Tests/playwright.config.ts"
 */

const ORIGIN: Position3D = { x: 0, y: 5, z: 0 };

/** A half-plane of water: everything on the far side of the line through the origin whose
 *  outward normal is (normalX, normalZ) is water. The boundary itself counts as land. */
function bankProbe(normalX: number, normalZ: number): WalkableProbe {
  const length = Math.hypot(normalX, normalZ);
  const nx = normalX / length;
  const nz = normalZ / length;
  return (position: Position3D) => position.x * nx + position.z * nz <= 1e-9;
}

function isWater(probe: WalkableProbe, position: Position3D): boolean {
  return !probe(position);
}

test.describe('slideAlongObstacle — recovering a blocked step', () => {
  test('keeps a heading walkable when the way is already open', () => {
    // A bank to the east (+X is water). A step heading away from the bank (due west) stays
    // on land under the smallest deflection, so the helper returns a walkable position close
    // to the intended one rather than holding.
    const probe = bankProbe(1, 0);
    const intended: Position3D = { x: -3, y: 5, z: 0 };
    const result = slideAlongObstacle(ORIGIN, intended, probe);
    expect(probe(result)).toBe(true);
    expect(result.x).toBeLessThan(0); // still travelling away from the bank
  });

  test('slides along an axis-aligned bank (the old two-axis case still works)', () => {
    // Bank to the east (+X water). A unit driving due east (straight into the bank) should
    // be deflected to travel along the bank (±Z), not held in place.
    const probe = bankProbe(1, 0);
    const intoBank: Position3D = { x: 3, y: 5, z: 0 };
    expect(isWater(probe, intoBank)).toBe(true); // precondition: the intended step is blocked

    const result = slideAlongObstacle(ORIGIN, intoBank, probe);
    expect(probe(result)).toBe(true); // on land
    expect(Math.abs(result.z)).toBeGreaterThan(0.5); // actually moved along the bank
    expect(result.x).toBeLessThanOrEqual(1e-6); // did not advance into the water
  });

  test('slides along a DIAGONAL bank where pure-axis sliding would freeze', () => {
    // Bank running NW–SE with water to the north-east (normal (1,1)). A unit driving
    // straight into it (north-east) cannot escape by a pure +X or +Z move — both stay in
    // water — so the old slide would hold. The angular fan must find a tangent heading.
    const probe = bankProbe(1, 1);
    const intoBank: Position3D = { x: 3, y: 5, z: 3 };
    expect(isWater(probe, intoBank)).toBe(true);
    // Demonstrate the pure-axis slides both fail here (the bug the fan fixes).
    expect(isWater(probe, { x: intoBank.x, y: 5, z: ORIGIN.z })).toBe(true);
    expect(isWater(probe, { x: ORIGIN.x, y: 5, z: intoBank.z })).toBe(true);

    const result = slideAlongObstacle(ORIGIN, intoBank, probe);
    expect(probe(result)).toBe(true); // found a walkable tangent
    const moved = Math.hypot(result.x - ORIGIN.x, result.z - ORIGIN.z);
    expect(moved).toBeGreaterThan(0.5); // it actually moved instead of holding
  });

  test('preserves the step length while sliding (the unit keeps its speed)', () => {
    const probe = bankProbe(1, 1);
    const intoBank: Position3D = { x: 4, y: 5, z: 4 };
    const intendedLength = Math.hypot(intoBank.x - ORIGIN.x, intoBank.z - ORIGIN.z);

    const result = slideAlongObstacle(ORIGIN, intoBank, probe);
    const resultLength = Math.hypot(result.x - ORIGIN.x, result.z - ORIGIN.z);
    expect(resultLength).toBeCloseTo(intendedLength, 6);
  });

  test('holds (returns the start) when every probed heading is blocked', () => {
    // A unit completely surrounded by water on all sides has no walkable candidate.
    const allWater: WalkableProbe = () => false;
    const intended: Position3D = { x: 2, y: 5, z: 1 };
    const result = slideAlongObstacle(ORIGIN, intended, allWater);
    expect(result).toEqual(ORIGIN);
  });

  test('holds on a zero-length step (no spurious motion)', () => {
    const probe = bankProbe(1, 0);
    const result = slideAlongObstacle(ORIGIN, { ...ORIGIN }, probe);
    expect(result).toEqual(ORIGIN);
  });

  test('never changes the y coordinate (height is owned by the deck-elevation pass)', () => {
    const probe = bankProbe(1, 1);
    const result = slideAlongObstacle(ORIGIN, { x: 3, y: 99, z: 3 }, probe);
    expect(result.y).toBe(ORIGIN.y);
  });

  test('is deterministic: identical inputs yield identical output (lockstep safety)', () => {
    const probe = bankProbe(0.3, 1);
    const intended: Position3D = { x: 2, y: 5, z: 5 };
    const first = slideAlongObstacle(ORIGIN, intended, probe);
    const second = slideAlongObstacle(ORIGIN, intended, probe);
    expect(first).toEqual(second);
  });

  test('breaks ties to the same side at each magnitude (deterministic ordering)', () => {
    // With a symmetric obstacle (water dead ahead, both sides equally open), the fan must
    // pick the same side every time. The fan lists +angle before -angle at each magnitude;
    // a positive rotation of a +Z step turns it toward -X, so the -X escape wins.
    const intoBank: Position3D = { x: 0, y: 5, z: 4 };
    // Water only directly ahead within a narrow wedge; both ±X escapes are land.
    const wedgeProbe: WalkableProbe = (p) => Math.abs(p.x) >= 0.5 || p.z <= 0;
    const result = slideAlongObstacle(ORIGIN, intoBank, wedgeProbe);
    expect(result.x).toBeLessThan(0); // deflected to -X (the first-listed positive rotation)
  });

  test('exposes a fan spanning ±90° and nothing beyond (no backward motion)', () => {
    for (const angle of SHORE_SLIDE_ANGLES) {
      expect(Math.abs(angle)).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
      expect(Math.abs(angle)).toBeGreaterThan(0);
    }
  });
});
