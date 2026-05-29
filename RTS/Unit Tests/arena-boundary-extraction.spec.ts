import { test, expect } from '@playwright/test';
import * as THREE from 'three';
import { computeArenaBoundary } from '../src/components/Working/arenaBoundaryScene';
import { clampPointToBoundary } from '../src/components/Working/arenaBoundary';

/**
 * Pure-logic tests for deriving the Arena boundary from a scene object. They mirror how the
 * real GLTF loader represents the map's "Arena" node: a multi-primitive mesh becomes a Group
 * of child meshes under a node carrying the slab's rotation/scale/translation. A regression
 * earlier shipped because the extractor only handled a single Mesh and silently disabled the
 * clamp on the Group — these tests build the Group form and confirm the boundary is produced
 * and actually confines positions. No browser or GLB needed (CPU geometry math).
 */

const SLAB_HALF = 100; // local half-size of each axis before the node's scale
const NODE_SCALE = 0.5;
const ROTATION_Y = Math.PI / 4; // 45°, like the real slab

// Build an "Arena" Group of several child box meshes (the multi-primitive case), placed under a
// node rotated 45° about Y and uniformly scaled — the structure the loader produces on the map.
function buildArenaGroup(): THREE.Object3D {
  const arena = new THREE.Group();
  arena.name = 'Arena';
  arena.position.set(12, 0, -8);
  arena.rotation.set(0, ROTATION_Y, 0);
  arena.scale.setScalar(NODE_SCALE);

  // Four quadrant tiles that together span [-SLAB_HALF, SLAB_HALF] in local X and Z, so the
  // union of their boxes reconstructs the full slab extent (proving the union logic).
  const tile = SLAB_HALF; // each tile is `tile` x `tile`, offset into a quadrant
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(tile, 1, tile));
    mesh.position.set((sx * tile) / 2, 0, (sz * tile) / 2);
    arena.add(mesh);
  }

  const root = new THREE.Group();
  root.add(arena);
  root.updateMatrixWorld(true);
  return root;
}

test('produces a boundary for the multi-mesh Group form of the Arena node', () => {
  const root = buildArenaGroup();
  const arena = root.getObjectByName('Arena')!;

  const boundary = computeArenaBoundary(arena, 0);
  expect(boundary).not.toBeNull();

  // Center maps the node translation; half-extents are local half-size * node scale.
  expect(boundary!.centerX).toBeCloseTo(12, 4);
  expect(boundary!.centerZ).toBeCloseTo(-8, 4);
  expect(boundary!.halfU).toBeCloseTo(SLAB_HALF * NODE_SCALE, 3);
  expect(boundary!.halfV).toBeCloseTo(SLAB_HALF * NODE_SCALE, 3);

  // Axes are the 45°-rotated unit vectors, not world X/Z.
  expect(boundary!.axisUx).toBeCloseTo(Math.cos(ROTATION_Y), 4);
  expect(boundary!.axisUz).toBeCloseTo(-Math.sin(ROTATION_Y), 4);
});

test('the derived boundary confines a far-off point back onto the slab', () => {
  const root = buildArenaGroup();
  const arena = root.getObjectByName('Arena')!;
  const boundary = computeArenaBoundary(arena, 0)!;

  const clamped = clampPointToBoundary(boundary, 100000, 100000);
  const offsetX = clamped.x - boundary.centerX;
  const offsetZ = clamped.z - boundary.centerZ;
  const alongU = offsetX * boundary.axisUx + offsetZ * boundary.axisUz;
  const alongV = offsetX * boundary.axisVx + offsetZ * boundary.axisVz;
  expect(Math.abs(alongU)).toBeLessThanOrEqual(boundary.halfU + 1e-6);
  expect(Math.abs(alongV)).toBeLessThanOrEqual(boundary.halfV + 1e-6);
});

test('applies the edge inset so the usable area is smaller than the raw slab', () => {
  const root = buildArenaGroup();
  const arena = root.getObjectByName('Arena')!;
  const inset = 2.5;

  const withInset = computeArenaBoundary(arena, inset)!;
  const noInset = computeArenaBoundary(arena, 0)!;
  expect(noInset.halfU - withInset.halfU).toBeCloseTo(inset, 4);
  expect(noInset.halfV - withInset.halfV).toBeCloseTo(inset, 4);
});

test('returns null for an object with no mesh geometry', () => {
  const empty = new THREE.Group();
  empty.name = 'Arena';
  empty.updateMatrixWorld(true);
  expect(computeArenaBoundary(empty, 2.5)).toBeNull();
});
