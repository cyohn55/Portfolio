import { test, expect } from '@playwright/test';
import { BridgeNavigator, type TerrainQuery, type NavBounds } from '../src/components/Working/bridgeNavigator';
import type { BridgeSide } from '../src/utils/TerrainValidator';
import type { Position3D } from '../src/game/types';

/**
 * Pure-logic tests for region+portal routing. They build a synthetic terrain whose
 * shape mirrors the real battle map at a small scale: two landmasses ("west" x<=-4 and
 * "east" x>=4) split by a north-south water channel (|x|<4), joined by an always-open
 * center bridge (z near 0) and a raise/lower side bridge (z near 16). No THREE scene is
 * needed — the navigator only consumes the TerrainQuery interface.
 */

const CHANNEL_HALF_WIDTH = 4; // |x| < 4 is the water channel; |x| >= 4 is land
const CENTER_BAND = (z: number) => z >= -3 && z <= 3; // always-open crossing
const SIDE_BAND = (z: number) => z >= 13 && z <= 19; // raise/lower crossing

// Synthetic terrain with a toggleable side bridge.
function makeTerrain(initialSideOpen: boolean): TerrainQuery & { setSideOpen(open: boolean): void } {
  let sideOpen = initialSideOpen;
  return {
    setSideOpen(open: boolean) {
      sideOpen = open;
    },
    isPositionOverWater(p: Position3D): boolean {
      return Math.abs(p.x) < CHANNEL_HALF_WIDTH; // decks sit over the channel too
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

const BOUNDS: NavBounds = { minX: -20, minZ: -20, maxX: 20, maxZ: 20 };

function freshNavigator(sideOpen = true): BridgeNavigator & { terrain: ReturnType<typeof makeTerrain> } {
  const terrain = makeTerrain(sideOpen);
  const nav = new BridgeNavigator() as BridgeNavigator & { terrain: ReturnType<typeof makeTerrain> };
  nav.build(terrain, BOUNDS, 2);
  nav.terrain = terrain;
  return nav;
}

const at = (x: number, z: number): Position3D => ({ x, y: 0, z });
const onCenterBridge = (p: Position3D) => Math.abs(p.x) < CHANNEL_HALF_WIDTH && p.z >= -4 && p.z <= 4;

test.describe('region detection', () => {
  test('the two landmasses are distinct regions; the channel splits them', () => {
    const nav = freshNavigator();
    const west = nav.regionAt(at(-10, 0));
    const east = nav.regionAt(at(10, 0));
    expect(west).toBeGreaterThanOrEqual(0);
    expect(east).toBeGreaterThanOrEqual(0);
    expect(west).not.toBe(east);
  });
});

test.describe('routing onto a bridge', () => {
  test('a unit targeting the far landmass is steered to the bridge, not the target', () => {
    const nav = freshNavigator();
    const target = at(10, 0);
    const wp = nav.nextWaypoint(at(-10, 0), target);
    // Not a straight beeline to the target...
    expect(wp).not.toEqual(target);
    // ...but the entrance of the (nearest, here center) bridge on the unit's side.
    expect(onCenterBridge(wp)).toBe(true);
  });

  test('a unit already in the destination region beelines (waypoint == target)', () => {
    const nav = freshNavigator();
    const target = at(-6, 8);
    expect(nav.nextWaypoint(at(-14, -8), target)).toEqual(target);
  });

  test('once on the deck, the unit is steered to the far side to cross', () => {
    const nav = freshNavigator();
    const wp = nav.nextWaypoint(at(0, 0), at(10, 0)); // standing on the center deck
    expect(wp.x).toBeGreaterThan(0); // far (east) mouth
  });
});

test.describe('nearest open bridge is chosen', () => {
  test('a unit near the side bridge uses it when open', () => {
    const nav = freshNavigator(true);
    const wp = nav.nextWaypoint(at(-10, 16), at(10, 16));
    expect(wp.z).toBeGreaterThan(10); // routed to the side bridge (z ~16), not center (z ~0)
  });

  test('when the side bridge is raised, the same unit is rerouted to the center bridge', () => {
    const nav = freshNavigator(true);
    nav.terrain.setSideOpen(false);
    nav.refreshPortals();
    const wp = nav.nextWaypoint(at(-10, 16), at(10, 16));
    expect(onCenterBridge(wp)).toBe(true); // only the center crossing remains open
  });

  test('reopening the side bridge restores its use (dynamic portals)', () => {
    const nav = freshNavigator(false);
    // Closed: must detour to center.
    expect(onCenterBridge(nav.nextWaypoint(at(-10, 16), at(10, 16)))).toBe(true);
    nav.terrain.setSideOpen(true);
    nav.refreshPortals();
    expect(nav.nextWaypoint(at(-10, 16), at(10, 16)).z).toBeGreaterThan(10);
  });
});

test.describe('targets and units beyond the grid', () => {
  // Units and their targets spawn far past the moat, so the moat-focused grid does not
  // contain them; out-of-grid points must resolve to the landmass on their side.
  test('a far target across the water still routes the unit onto a bridge', () => {
    const nav = freshNavigator();
    const farEast = at(500, 0); // east landmass, well beyond the grid
    const wp = nav.nextWaypoint(at(-10, 0), farEast);
    expect(wp).not.toEqual(farEast);
    expect(onCenterBridge(wp)).toBe(true);
  });

  test('a far target on the same side beelines (no needless crossing)', () => {
    const nav = freshNavigator();
    const farWest = at(-500, 0);
    expect(nav.nextWaypoint(at(-10, 0), farWest)).toEqual(farWest);
  });

  test('a unit starting beyond the grid still routes toward the crossing', () => {
    const nav = freshNavigator();
    const wp = nav.nextWaypoint(at(-500, 0), at(500, 0));
    expect(onCenterBridge(wp)).toBe(true);
  });
});

test.describe('graceful degradation', () => {
  test('an unbuilt navigator returns the target unchanged', () => {
    const nav = new BridgeNavigator();
    const target = at(5, 5);
    expect(nav.nextWaypoint(at(0, 0), target)).toEqual(target);
  });
});
