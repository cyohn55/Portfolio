import { test, expect } from '@playwright/test';
import type { Position3D } from '../src/game/types';
import { nearestWalkableCell, type WalkableProbe } from '../src/components/Working/terrainSlide';

/**
 * Pure-logic tests for nearestWalkableCell, the grid search that rescues a ground unit a
 * chain of crowd/knockback shoves has stranded on forbidden water. The movement tick uses
 * it to march such a unit back to the nearest shore each tick so it stops freezing offshore
 * and ignoring orders. The tests feed the real helper real synthetic terrain (water shapes
 * decided by the test's own predicate); no walkability is hard-coded inside the module under
 * test, so they validate its true input/output behaviour.
 *
 * Run with: npx playwright test --config "Unit Tests/playwright.config.ts"
 */

/** Everything strictly on the +X side of `bankX` is water; the rest is walkable land. */
function landWestOf(bankX: number): WalkableProbe {
  return (position: Position3D) => position.x < bankX;
}

/** A circular lake of `radius` centered at the origin — inside is water, outside is land. */
function lakeProbe(radius: number): WalkableProbe {
  return (position: Position3D) => Math.hypot(position.x, position.z) > radius;
}

test.describe('nearestWalkableCell — rescuing a stranded ground unit', () => {
  test('returns the unit position itself when it is already on land', () => {
    // A bank at x = 0 (land to the west). A unit standing on land still resolves to a nearby
    // walkable cell, so the rescue is a no-op that keeps it on solid ground.
    const probe = landWestOf(0);
    const onLand: Position3D = { x: -5, y: 2, z: 0 };
    const result = nearestWalkableCell(onLand, probe, 32);
    expect(result).not.toBeNull();
    expect(probe(result!)).toBe(true);
  });

  test('pulls a unit stranded over water back toward the nearest shore', () => {
    // Land lies west of x = 0; the unit has been shoved to x = +4 (well into the water).
    // The nearest walkable cell must be just west of the bank and closer in x than the unit.
    const probe = landWestOf(0);
    const stranded: Position3D = { x: 4, y: 2, z: 0 };
    expect(probe(stranded)).toBe(false); // precondition: genuinely stranded

    const result = nearestWalkableCell(stranded, probe, 32);
    expect(result).not.toBeNull();
    expect(probe(result!)).toBe(true);               // landed on walkable ground
    expect(result!.x).toBeLessThan(stranded.x);      // moved back toward the shore
    // The shoreline cell nearest the unit is the one just inside the bank, ~1 cell away in x.
    expect(stranded.x - result!.x).toBeLessThan(6);
  });

  test('chooses the geometrically closest shore, not merely the first cell scanned', () => {
    // Unit stranded just inside a circular lake. Every direction off-center is shorter than
    // crossing the lake, so the chosen cell must be markedly closer to the unit than the
    // far rim, and it must be on land.
    const radius = 5;
    const probe = lakeProbe(radius);
    const stranded: Position3D = { x: 3, y: 2, z: 0 }; // inside the lake, off-center toward +X
    expect(probe(stranded)).toBe(false);

    const result = nearestWalkableCell(stranded, probe, 32);
    expect(result).not.toBeNull();
    expect(probe(result!)).toBe(true);
    // Closest escape is toward +X (the near rim), so the rescued x should increase, not flip
    // to the far -X rim.
    expect(result!.x).toBeGreaterThan(stranded.x);
    const distance = Math.hypot(result!.x - stranded.x, result!.z - stranded.z);
    expect(distance).toBeLessThan(radius); // never further than crossing to the far side
  });

  test('returns null when no walkable cell lies within the search radius', () => {
    // The whole searched neighbourhood is water (land only beyond 1000 cells), so a small
    // search radius finds nothing and the caller is told to leave the unit where it is.
    const probe = landWestOf(-1000);
    const stranded: Position3D = { x: 0, y: 2, z: 0 };
    expect(probe(stranded)).toBe(false);
    expect(nearestWalkableCell(stranded, probe, 8)).toBeNull();
  });

  test('is deterministic — identical inputs yield identical output (lockstep safety)', () => {
    const probe = lakeProbe(4);
    const stranded: Position3D = { x: 1, y: 2, z: 2 };
    const first = nearestWalkableCell(stranded, probe, 32);
    const second = nearestWalkableCell(stranded, probe, 32);
    expect(first).toEqual(second);
  });

  test('respects a non-default cell size', () => {
    // With 2-unit cells the candidate centers fall on a coarser grid; the helper must still
    // return a walkable, sensibly-placed shore cell rather than off-grid coordinates.
    const probe = landWestOf(0);
    const stranded: Position3D = { x: 6, y: 2, z: 0 };
    const cellSize = 2;
    const result = nearestWalkableCell(stranded, probe, 32, cellSize);
    expect(result).not.toBeNull();
    expect(probe(result!)).toBe(true);
    expect(result!.x).toBeLessThan(stranded.x);
    // Cell centers sit at (index + 0.5) * cellSize, i.e. odd multiples of 1 for cellSize 2.
    expect(((result!.x / cellSize) - 0.5) % 1).toBeCloseTo(0, 6);
  });
});
