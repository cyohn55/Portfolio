import { test, expect } from '@playwright/test';
import * as THREE from 'three';
import {
  makePatrolRoute,
  patrolTarget,
  advancePatrol,
} from '../src/components/Working/conquest/conquestPatrol';

/**
 * Unit tests for the Conquest Queen patrol model. Pure Node — the helpers describe
 * the back-and-forth oscillation between two fixed endpoints, so we assert the
 * heading flips on arrival and the route value is decoupled from its source vectors.
 */

test.describe('makePatrolRoute', () => {
  test('starts heading from the anchor toward the destination', () => {
    const anchor = new THREE.Vector3(1, 0, 0);
    const destination = new THREE.Vector3(0, 1, 0);
    const route = makePatrolRoute(anchor, destination);
    expect(route.towardB).toBe(true);
    expect(patrolTarget(route).equals(destination)).toBe(true);
  });

  test('clones its endpoints so later source mutation cannot disturb the route', () => {
    const anchor = new THREE.Vector3(1, 0, 0);
    const destination = new THREE.Vector3(0, 1, 0);
    const route = makePatrolRoute(anchor, destination);
    anchor.set(9, 9, 9);
    destination.set(-9, -9, -9);
    expect(route.a.equals(new THREE.Vector3(1, 0, 0))).toBe(true);
    expect(route.b.equals(new THREE.Vector3(0, 1, 0))).toBe(true);
  });
});

test.describe('advancePatrol oscillation', () => {
  test('keeps the current heading until the target is reached', () => {
    expect(advancePatrol(true, false)).toBe(true);
    expect(advancePatrol(false, false)).toBe(false);
  });

  test('flips heading on arrival, producing a → b → a → b cycle', () => {
    const route = makePatrolRoute(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0));
    // Heading to b; arrive → now heading back to a.
    route.towardB = advancePatrol(route.towardB, true);
    expect(route.towardB).toBe(false);
    expect(patrolTarget(route).equals(route.a)).toBe(true);
    // Heading to a; arrive → heading to b again.
    route.towardB = advancePatrol(route.towardB, true);
    expect(route.towardB).toBe(true);
    expect(patrolTarget(route).equals(route.b)).toBe(true);
  });
});
