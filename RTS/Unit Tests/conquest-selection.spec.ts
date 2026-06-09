import { test, expect } from '@playwright/test';
import * as THREE from 'three';
import {
  raySphereHit,
  screenBoxFromDrag,
  pointInScreenBox,
  screenDistanceSquared,
} from '../src/components/Working/conquest/conquestSelection';

/**
 * Unit tests for the Conquest pointer-selection geometry (Increment 4). Pure Node —
 * the ray/sphere hit and the screen-box helpers are side-effect-free, so we assert
 * real geometry (a ray meeting the planet, a projected unit falling inside a drag
 * box) rather than DOM behavior, which ConquestField owns.
 */

test.describe('Ray/sphere order placement', () => {
  test('a ray pointing at the planet center hits the near face', () => {
    // Camera out on +Z looking toward the origin; the near hit is at z = radius.
    const origin = new THREE.Vector3(0, 0, 5);
    const direction = new THREE.Vector3(0, 0, -1);
    const hit = raySphereHit(origin, direction, 1);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(0, 6);
    expect(hit!.y).toBeCloseTo(0, 6);
    expect(hit!.z).toBeCloseTo(1, 6); // the near intersection, not the far one
    expect(hit!.length()).toBeCloseTo(1, 6); // lands on the sphere
  });

  test('a ray aimed past the planet misses', () => {
    const origin = new THREE.Vector3(0, 0, 5);
    const direction = new THREE.Vector3(0, 1, 0); // tangent-ish, never crosses the sphere
    expect(raySphereHit(origin, direction, 1)).toBeNull();
  });

  test('an unnormalized direction still resolves the correct hit', () => {
    const origin = new THREE.Vector3(0, 0, 5);
    const direction = new THREE.Vector3(0, 0, -3); // magnitude 3, same heading
    const hit = raySphereHit(origin, direction, 1);
    expect(hit!.z).toBeCloseTo(1, 6);
  });

  test('a ray from inside the sphere takes the far (forward) exit', () => {
    const hit = raySphereHit(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1), 1);
    expect(hit!.z).toBeCloseTo(-1, 6);
  });
});

test.describe('Drag-box selection', () => {
  test('a box is built order-independently from its two corners', () => {
    const a = screenBoxFromDrag(100, 80, 40, 200);
    const b = screenBoxFromDrag(40, 200, 100, 80);
    expect(a).toEqual(b);
    expect(a).toEqual({ minX: 40, minY: 80, maxX: 100, maxY: 200 });
  });

  test('points inside the box are selected, points outside are not', () => {
    const box = screenBoxFromDrag(0, 0, 100, 100);
    expect(pointInScreenBox(50, 50, box)).toBe(true);
    expect(pointInScreenBox(0, 100, box)).toBe(true);   // on the edge counts
    expect(pointInScreenBox(150, 50, box)).toBe(false);
    expect(pointInScreenBox(50, -1, box)).toBe(false);
  });
});

test.describe('Nearest-pick distance', () => {
  test('squared screen distance is the plain pixel distance squared', () => {
    expect(screenDistanceSquared(0, 0, 3, 4)).toBeCloseTo(25, 9);
    expect(screenDistanceSquared(10, 10, 10, 10)).toBe(0);
  });
});
