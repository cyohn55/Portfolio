// conquestPatrol — pure, framework-free helpers for a Conquest Queen's back-and-forth
// patrol route (the right-hold-on-Queen gesture, mirroring Quick Play's Queen patrol).
//
// Single responsibility: model a two-endpoint patrol and decide, given an "arrived"
// signal, which endpoint the patroller heads to next. Kept free of React, Three.js
// state, and the store so the oscillation rule is unit-testable in isolation; the
// field owns the actual movement (moveToward) and only asks this module which point
// to walk toward and when to turn around.
//
// A route stores both endpoints and a heading flag rather than a single "other end"
// so the patrol is fully described by its own value — no hidden anchor — which keeps
// capture/reset handling a simple `patrol = null`.

import * as THREE from 'three';

/**
 * A committed patrol: two fixed surface endpoints and the current heading. `a` is the
 * anchor (the Queen's position when the route was set) and `b` the cursor endpoint;
 * `towardB` is true while walking from `a` to `b` and false on the return leg.
 */
export interface PatrolRoute {
  a: THREE.Vector3;
  b: THREE.Vector3;
  towardB: boolean;
}

/**
 * Build a route that starts walking from the anchor toward the destination. Clones
 * both points so later mutation of the source vectors can't disturb the route.
 */
export function makePatrolRoute(anchor: THREE.Vector3, destination: THREE.Vector3): PatrolRoute {
  return { a: anchor.clone(), b: destination.clone(), towardB: true };
}

/** The endpoint the patroller is currently heading toward. */
export function patrolTarget(route: PatrolRoute): THREE.Vector3 {
  return route.towardB ? route.b : route.a;
}

/**
 * The heading after a movement step: flip to the opposite endpoint once the current
 * target is reached, otherwise keep the current heading. Pure so the back-and-forth
 * invariant (a → b → a → …) is testable without the tick.
 */
export function advancePatrol(towardB: boolean, arrivedAtTarget: boolean): boolean {
  return arrivedAtTarget ? !towardB : towardB;
}
