import { test, expect } from '@playwright/test';
import {
  clampPointToBoundary,
  confineBoundaryToPoints,
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

// An axis-aligned 20 x 20 square centered at the origin (axes along world X and Z, no corner cut).
const AXIS_ALIGNED: ArenaBoundary = {
  centerX: 0,
  centerZ: 0,
  axisUx: 1,
  axisUz: 0,
  axisVx: 0,
  axisVz: 1,
  halfU: 10,
  halfV: 10,
  diagLimit: Infinity,
  minX: -Infinity,
  maxX: Infinity,
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
  diagLimit: Infinity,
  minX: -Infinity,
  maxX: Infinity,
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

test('corner cut trims the box corner that lies past the diagonal limit', () => {
  // Box of half 10, but a diagonal cap of 12 lops the corners (a corner sits at |U|+|V| = 20).
  const octagon: ArenaBoundary = { ...AXIS_ALIGNED, diagLimit: 12 };

  // A point driven toward the +U/+V corner: box clamp pins it to (10, 10), then the corner cut
  // pulls it onto the line U + V = 12 (orthogonally, so symmetrically to (6, 6)).
  const clamped = clampPointToBoundary(octagon, 1000, 1000);
  const alongU = clamped.x; // axes are world X/Z here
  const alongV = clamped.z;
  expect(alongU + alongV).toBeCloseTo(12, 6);
  expect(alongU).toBeCloseTo(6, 6);
  expect(alongV).toBeCloseTo(6, 6);

  // A point near an edge midpoint (well inside the corner cut) is unaffected by it.
  const edge = clampPointToBoundary(octagon, 1000, 1);
  expect(edge.x).toBeCloseTo(10, 6);
  expect(edge.z).toBeCloseTo(1, 6);
});

// A large rotated slab (half-extents 100) for confinement tests, so the points sit well inside it.
const BIG_ROTATED: ArenaBoundary = { ...ROTATED_45, halfU: 100, halfV: 100 };

test('confineBoundaryToPoints shrinks a slab to just past the confinement points', () => {
  const slab = BIG_ROTATED; // halfU = halfV = 100
  // Two points at ±40 along axis U and ±30 along axis V (relative to the slab center).
  const u = (n: number) => ({
    x: slab.centerX + n * slab.axisUx,
    z: slab.centerZ + n * slab.axisUz,
  });
  const points = [u(40), u(-40), { x: slab.centerX + 30 * slab.axisVx, z: slab.centerZ + 30 * slab.axisVz }];

  const tightened = confineBoundaryToPoints(slab, points, 25, 25);
  expect(tightened.halfU).toBeCloseTo(40 + 25, 4); // max |U| + axis margin
  expect(tightened.halfV).toBeCloseTo(30 + 25, 4); // max |V| + axis margin
  // The confinement is strictly smaller than the slab it came from.
  expect(tightened.halfU).toBeLessThan(slab.halfU);
  expect(tightened.halfV).toBeLessThan(slab.halfV);

  // Every confinement point is inside the tightened boundary (clamping leaves it unchanged).
  for (const point of points) {
    const clamped = clampPointToBoundary(tightened, point.x, point.z);
    expect(clamped.x).toBeCloseTo(point.x, 4);
    expect(clamped.z).toBeCloseTo(point.z, 4);
  }
});

test('minX/maxX walls cap the left/right extent asymmetrically without moving z', () => {
  // Rotated octagon (half 100) with asymmetric world-x walls: left -40, right +25.
  const walled: ArenaBoundary = { ...BIG_ROTATED, diagLimit: 160, minX: -40, maxX: 25 };

  // A point pushed far to the +x side is pulled back exactly to the right wall.
  const right = clampPointToBoundary(walled, 10000, walled.centerZ);
  expect(right.x).toBeCloseTo(25, 6);

  // A point pushed far to the -x side is pulled back exactly to the left wall.
  const left = clampPointToBoundary(walled, -10000, walled.centerZ);
  expect(left.x).toBeCloseTo(-40, 6);

  // A point already between the walls keeps its x.
  const inside = clampPointToBoundary(walled, 10, walled.centerZ);
  expect(inside.x).toBeCloseTo(10, 6);
});

test('confineBoundaryToPoints never grows the boundary beyond the slab', () => {
  const slab = BIG_ROTATED; // halfU = halfV = 100
  // A point far outside the slab plus a huge margin would exceed it; the result must be capped.
  const farPoint = { x: slab.centerX + 1000 * slab.axisUx, z: slab.centerZ + 1000 * slab.axisUz };
  const tightened = confineBoundaryToPoints(slab, [farPoint], 9999, 9999);
  expect(tightened.halfU).toBeLessThanOrEqual(slab.halfU);
  expect(tightened.halfV).toBeLessThanOrEqual(slab.halfV);
  expect(tightened.diagLimit).toBeLessThanOrEqual(slab.halfU + slab.halfV);
});
