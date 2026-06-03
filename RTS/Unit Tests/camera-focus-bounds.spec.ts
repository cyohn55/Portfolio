import { test, expect } from '@playwright/test';
import { type ArenaBoundary, clampPointToBoundary } from '../src/components/Working/arenaBoundary';
import {
  CAMERA_FOCUS_MARGIN,
  clampCameraFocus,
  expandBoundaryForCamera,
} from '../src/components/Working/cameraFocusBounds';

/**
 * Pure-logic tests for the camera-focus clamp. They confirm the behaviour the game relies on:
 * a focus point far off the map (as a drifting controller stick would push it) is pulled back onto
 * the expanded boundary, a focus already inside the play area is left untouched, the camera margin
 * grants exactly the intended extra reach past the unit edge, and an unregistered boundary is a
 * no-op (so the camera behaves as it did before clamping existed).
 *
 * Assertions are derived from the boundary's own geometry rather than hard-coded coordinates, so
 * they validate the real contract between {@link clampCameraFocus} and {@link clampPointToBoundary}.
 */

// An axis-aligned 200 x 160 rectangle offset from the origin, with finite side walls — the same
// shape family the real map registers (an oriented box with optional walls), but axis-aligned so
// the expected projections are easy to reason about independently of the rotation maths.
const BOUNDARY: ArenaBoundary = {
  centerX: 10,
  centerZ: -20,
  axisUx: 1,
  axisUz: 0,
  axisVx: 0,
  axisVz: 1,
  halfU: 100,
  halfV: 80,
  diagLimit: Infinity,
  minX: -70,
  maxX: 90,
  // Note: with finite walls the world-x extent is governed by minX/maxX, not halfU.
};

function projectOntoAxes(boundary: ArenaBoundary, x: number, z: number) {
  const offsetX = x - boundary.centerX;
  const offsetZ = z - boundary.centerZ;
  return {
    alongU: offsetX * boundary.axisUx + offsetZ * boundary.axisUz,
    alongV: offsetX * boundary.axisVx + offsetZ * boundary.axisVz,
  };
}

test('expandBoundaryForCamera grows every finite extent by the margin', () => {
  const margin = 25;
  const expanded = expandBoundaryForCamera(BOUNDARY, margin);

  expect(expanded.halfU).toBe(BOUNDARY.halfU + margin);
  expect(expanded.halfV).toBe(BOUNDARY.halfV + margin);
  // The corner cut caps |U| + |V|, so growing each axis by `margin` grows the cap by 2 * margin.
  expect(expanded.minX).toBe(BOUNDARY.minX - margin);
  expect(expanded.maxX).toBe(BOUNDARY.maxX + margin);
});

test('expandBoundaryForCamera grows a finite corner cut by twice the margin and leaves infinities alone', () => {
  const margin = 30;
  const withCut: ArenaBoundary = { ...BOUNDARY, diagLimit: 150 };

  expect(expandBoundaryForCamera(withCut, margin).diagLimit).toBe(150 + 2 * margin);
  // Infinite limits (no corner cut, no wall) must stay infinite, never become NaN/finite.
  expect(expandBoundaryForCamera(BOUNDARY, margin).diagLimit).toBe(Infinity);
});

test('a focus point inside the unit boundary is returned unchanged', () => {
  const insideX = BOUNDARY.centerX + 30;
  const insideZ = BOUNDARY.centerZ - 25;

  const result = clampCameraFocus(BOUNDARY, insideX, insideZ);

  expect(result.x).toBeCloseTo(insideX, 6);
  expect(result.z).toBeCloseTo(insideZ, 6);
});

test('a focus point far off the map is pulled onto the expanded boundary edge', () => {
  // Push the focus well past the front edge along axis V, as runaway stick drift would.
  const farX = BOUNDARY.centerX;
  const farZ = BOUNDARY.centerZ + 10_000;

  const result = clampCameraFocus(BOUNDARY, farX, farZ);
  const { alongV } = projectOntoAxes(BOUNDARY, result.x, result.z);

  // It must land exactly on the camera-expanded edge: the unit half-extent plus the camera margin.
  expect(alongV).toBeCloseTo(BOUNDARY.halfV + CAMERA_FOCUS_MARGIN, 6);
});

test('the camera margin grants strictly more reach than the bare unit boundary', () => {
  const farX = BOUNDARY.centerX;
  const farZ = BOUNDARY.centerZ + 10_000;

  const cameraEdge = clampCameraFocus(BOUNDARY, farX, farZ);
  const unitEdge = clampPointToBoundary(BOUNDARY, farX, farZ);

  const cameraReach = projectOntoAxes(BOUNDARY, cameraEdge.x, cameraEdge.z).alongV;
  const unitReach = projectOntoAxes(BOUNDARY, unitEdge.x, unitEdge.z).alongV;

  expect(cameraReach - unitReach).toBeCloseTo(CAMERA_FOCUS_MARGIN, 6);
});

test('the left/right walls are honoured after expansion', () => {
  // Drive the focus far to the right; world-x must stop at the expanded right wall.
  const result = clampCameraFocus(BOUNDARY, 10_000, BOUNDARY.centerZ);
  expect(result.x).toBeCloseTo(BOUNDARY.maxX + CAMERA_FOCUS_MARGIN, 6);
});

test('a null boundary is a no-op so the camera is unconstrained before the map loads', () => {
  const result = clampCameraFocus(null, 9_999, -9_999);
  expect(result.x).toBe(9_999);
  expect(result.z).toBe(-9_999);
});
