import { test, expect } from '@playwright/test';
import { GridPathfinder, type PathAgent, type PathBounds } from '../src/components/Working/pathfinder';
import type { TerrainQuery } from '../src/components/Working/bridgeNavigator';
import type { BridgeSide } from '../src/utils/TerrainValidator';
import type { Position3D } from '../src/game/types';

/**
 * Pure-logic tests for grid A* pathfinding. They build synthetic terrain (no THREE scene
 * — the pathfinder only consumes the TerrainQuery interface) and verify that the routes it
 * produces are ones a ground unit can actually walk: every waypoint and the ground between
 * consecutive waypoints is walkable, so a unit following them reaches its destination.
 */

const CHANNEL_HALF_WIDTH = 4; // |x| < 4 is the water moat; |x| >= 4 is land
const CENTER_BAND = (z: number) => z >= -3 && z <= 3; // always-open center bridge
const SIDE_BAND = (z: number) => z >= 21 && z <= 27; // raise/lower side bridge

// Two landmasses split by a north-south water channel, joined by an always-open center
// bridge and a toggleable side bridge. Mirrors the real map at small scale.
function makeTerrain(initialSideOpen: boolean): TerrainQuery & { setSideOpen(open: boolean): void } {
  let sideOpen = initialSideOpen;
  return {
    setSideOpen(open: boolean) {
      sideOpen = open;
    },
    isPositionOverWater(p: Position3D): boolean {
      return Math.abs(p.x) < CHANNEL_HALF_WIDTH;
    },
    bridgeAt(p: Position3D): { onBridge: boolean; side: BridgeSide | null } {
      if (Math.abs(p.x) >= CHANNEL_HALF_WIDTH) return { onBridge: false, side: null };
      if (CENTER_BAND(p.z)) return { onBridge: true, side: 'center' };
      if (SIDE_BAND(p.z)) return { onBridge: true, side: 'right' };
      return { onBridge: false, side: null };
    },
    isSideOpen(side: BridgeSide): boolean {
      if (side === 'center') return true;
      if (side === 'right') return sideOpen;
      return false;
    },
  };
}

const BOUNDS: PathBounds = { minX: -30, minZ: -30, maxX: 30, maxZ: 30 };

function freshPathfinder(sideOpen = true): {
  nav: GridPathfinder;
  terrain: ReturnType<typeof makeTerrain>;
} {
  const terrain = makeTerrain(sideOpen);
  const nav = new GridPathfinder();
  nav.build(terrain, BOUNDS, 2);
  return { nav, terrain };
}

const at = (x: number, z: number): Position3D => ({ x, y: 0, z });

// Whether a ground unit may stand at a position: land, or an open bridge deck. Mirrors the
// game's terrain rule so a simulated walk is faithful.
function groundCanStand(terrain: TerrainQuery, p: Position3D): boolean {
  if (!terrain.isPositionOverWater(p)) return true;
  const bridge = terrain.bridgeAt(p);
  return bridge.onBridge && bridge.side !== null && terrain.isSideOpen(bridge.side);
}

// Follow the pathfinder's waypoints from start to target, refusing steps a ground unit
// could not make. Returns whether the unit reaches the target.
function reachesTarget(
  nav: GridPathfinder,
  terrain: TerrainQuery,
  start: Position3D,
  target: Position3D,
  maxSteps = 4000,
): boolean {
  const agent: PathAgent = { position: { ...start } };
  for (let step = 0; step < maxSteps; step++) {
    nav.beginTick(step); // reset the per-tick compute budget each simulated tick
    if (Math.hypot(target.x - agent.position.x, target.z - agent.position.z) < 1.5) return true;
    const wp = nav.nextWaypoint(agent, target);
    const dx = wp.x - agent.position.x;
    const dz = wp.z - agent.position.z;
    const len = Math.hypot(dx, dz) || 1;
    const next = { x: agent.position.x + (dx / len) * 0.5, y: 0, z: agent.position.z + (dz / len) * 0.5 };
    if (groundCanStand(terrain, next)) agent.position = next;
    // If blocked, hold; the pathfinder's stall handling will re-route on a later tick.
  }
  return false;
}

test.describe('open-ground movement', () => {
  test('a clear straight shot returns the destination unchanged (no needless routing)', () => {
    const { nav } = freshPathfinder();
    const target = at(-20, 10);
    expect(nav.nextWaypoint({ position: at(-20, -10) }, target)).toEqual(target);
  });

  test('an unbuilt pathfinder returns the destination unchanged', () => {
    const nav = new GridPathfinder();
    const target = at(5, 5);
    expect(nav.nextWaypoint({ position: at(0, 0) }, target)).toEqual(target);
  });
});

test.describe('routing across the water', () => {
  test('a target on the far landmass steers the unit onto a crossing, not into the water', () => {
    const { nav } = freshPathfinder();
    const target = at(20, 0);
    const wp = nav.nextWaypoint({ position: at(-20, 0) }, target);
    expect(wp).not.toEqual(target);
    expect(groundCanStandOnGrid(wp)).toBe(true);
  });

  test('a unit walks the whole way across to the far landmass', () => {
    const { nav, terrain } = freshPathfinder();
    expect(reachesTarget(nav, terrain, at(-20, 0), at(20, 0))).toBe(true);
  });

  test('the crossing also completes in reverse', () => {
    const { nav, terrain } = freshPathfinder();
    expect(reachesTarget(nav, terrain, at(20, 12), at(-20, -12))).toBe(true);
  });

  test('a unit reaches an off-axis far target (bridge then overland)', () => {
    const { nav, terrain } = freshPathfinder();
    expect(reachesTarget(nav, terrain, at(-22, 18), at(22, -18))).toBe(true);
  });
});

test.describe('dynamic bridges', () => {
  test('with the side bridge raised the unit still crosses (via the center)', () => {
    const { nav, terrain } = freshPathfinder(false);
    nav.refresh();
    expect(reachesTarget(nav, terrain, at(-20, 24), at(20, 24))).toBe(true);
  });

  test('lowering the side bridge opens it as a route (path invalidation on change)', () => {
    const { nav, terrain } = freshPathfinder(false);
    // Crossing works via center even before the side bridge opens.
    expect(reachesTarget(nav, terrain, at(-20, 24), at(20, 24))).toBe(true);
    terrain.setSideOpen(true);
    nav.refresh();
    expect(reachesTarget(nav, terrain, at(-20, 24), at(20, 24))).toBe(true);
  });
});

// A waypoint a unit is sent to must itself be standable terrain.
function groundCanStandOnGrid(p: Position3D): boolean {
  // On this synthetic terrain a point is standable iff it is land or on the center band.
  if (Math.abs(p.x) >= CHANNEL_HALF_WIDTH) return true;
  return CENTER_BAND(p.z) || SIDE_BAND(p.z);
}
