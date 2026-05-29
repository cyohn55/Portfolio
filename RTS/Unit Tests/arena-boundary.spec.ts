import { test, expect } from '@playwright/test';
import {
  clampPointToBoundary,
  registerArenaBoundary,
  clampToArena,
  getArenaBoundary,
  type ArenaBoundary,
} from '../src/components/Working/arenaBoundary';
import type { Position3D } from '../src/game/types';

/**
 * Pure-logic tests for the Arena off-map boundary. They confirm that the oriented-box clamp
 * confines positions to the slab the way the real game uses it: a unit can never end a step
 * past the outermost edge, points already inside are left untouched, and the rotated geometry
 * is handled (an axis-aligned clamp would wrongly admit corner-void positions).
 *
 * No Three.js scene or browser is involved — the boundary is plain numbers, mirroring how the
 * game registers it once at load and then reads it every tick.
 */

// An axis-aligned 20 x 20 square centered at the origin (axes along world X and Z).
const AXIS_ALIGNED: ArenaBoundary = {
  centerX: 0,
  centerZ: 0,
  axisUx: 1,
  axisUz: 0,
  axisVx: 0,
  axisVz: 1,
  halfU: 10,
  halfV: 10,
};

// The real map's slab orientation: a square rotated 45° about Y. Its axes are the unit
// diagonals, so the box's true edges run diagonally while its bounding box is axis-aligned.
const HALF = 10;
const DIAGONAL = Math.SQRT1_2; // cos(45°) = sin(45°)
const ROTATED_45: ArenaBoundary = {
  centerX: 5,
  centerZ: -3,
  axisUx: DIAGONAL,
  axisUz: DIAGONAL,
  axisVx: -DIAGONAL,
  axisVz: DIAGONAL,
  halfU: HALF,
  halfV: HALF,
};

function distanceFromCenterAlongAxis(
  boundary: ArenaBoundary,
  point: { x: number; z: number },
): { alongU: number; alongV: number } {
  const offsetX = point.x - boundary.centerX;
  const offsetZ = point.z - boundary.centerZ;
  return {
    alongU: offsetX * boundary.axisUx + offsetZ * boundary.axisUz,
    alongV: offsetX * boundary.axisVx + offsetZ * boundary.axisVz,
  };
}

test('leaves a point already inside the boundary unchanged', () => {
  const inside = clampPointToBoundary(AXIS_ALIGNED, 3, -4);
  expect(inside.x).toBeCloseTo(3, 6);
  expect(inside.z).toBeCloseTo(-4, 6);
});

test('pulls a point past one edge back onto that edge', () => {
  // x is well past the +U (x) edge; z is in range and must be preserved.
  const clamped = clampPointToBoundary(AXIS_ALIGNED, 50, 2);
  expect(clamped.x).toBeCloseTo(10, 6);
  expect(clamped.z).toBeCloseTo(2, 6);
});

test('pulls a far diagonal point onto the corner of the box', () => {
  const clamped = clampPointToBoundary(AXIS_ALIGNED, 1000, -1000);
  expect(clamped.x).toBeCloseTo(10, 6);
  expect(clamped.z).toBeCloseTo(-10, 6);
});

test('never returns a position outside the half-extents along either axis', () => {
  const farPoints = [
    { x: 500, z: 500 },
    { x: -500, z: 500 },
    { x: 500, z: -500 },
    { x: -500, z: -500 },
    { x: 0, z: 999 },
  ];
  for (const point of farPoints) {
    const clamped = clampPointToBoundary(ROTATED_45, point.x, point.z);
    const { alongU, alongV } = distanceFromCenterAlongAxis(ROTATED_45, clamped);
    // A tiny epsilon above the half-extent accommodates floating-point round-trip error.
    expect(Math.abs(alongU)).toBeLessThanOrEqual(ROTATED_45.halfU + 1e-6);
    expect(Math.abs(alongV)).toBeLessThanOrEqual(ROTATED_45.halfV + 1e-6);
  }
});

test('rotated box rejects an axis-aligned-corner point that a naive AABB clamp would admit', () => {
  // Centered rotated box for a clean geometric check.
  const centeredRotated: ArenaBoundary = { ...ROTATED_45, centerX: 0, centerZ: 0 };

  // (HALF, HALF) sits at a corner of the AABB but OUTSIDE the diagonal box: its projection
  // onto axis U is HALF * sqrt(2) > HALF. The clamp must move it inward, proving the boundary
  // follows the rotated edges rather than the bounding box.
  const corner = clampPointToBoundary(centeredRotated, HALF, HALF);
  const distanceFromCenter = Math.hypot(corner.x, corner.z);
  expect(distanceFromCenter).toBeLessThan(Math.hypot(HALF, HALF) - 1e-3);

  // The clamped point lies on the +U edge (alongU == halfU) at the U-axis tip.
  const { alongU } = distanceFromCenterAlongAxis(centeredRotated, corner);
  expect(alongU).toBeCloseTo(HALF, 5);
});

test('clampToArena mutates a position in place using the registered boundary', () => {
  registerArenaBoundary(AXIS_ALIGNED);
  const position: Position3D = { x: 100, y: 7, z: -3 };
  clampToArena(position);
  expect(position.x).toBeCloseTo(10, 6);
  expect(position.z).toBeCloseTo(-3, 6);
  // Y (terrain height) is intentionally left untouched by the XZ boundary.
  expect(position.y).toBe(7);
  registerArenaBoundary(null);
});

test('clampToArena is a no-op when no boundary is registered', () => {
  registerArenaBoundary(null);
  expect(getArenaBoundary()).toBeNull();
  const position: Position3D = { x: 9999, y: 0, z: -9999 };
  clampToArena(position);
  expect(position.x).toBe(9999);
  expect(position.z).toBe(-9999);
});
