import { test, expect } from '@playwright/test';
import {
  isFarmableTile,
  isClaimableTile,
  countOwnedFarmTiles,
  countOwnedTiles,
  countClaimableTiles,
  territoryPercent,
  populationCap,
  planetPopulationCeiling,
  canGrowUnit,
  stepTileClaims,
  POPULATION_PER_FARM_TILE,
  CLAIM_CAPTURE_DURATION_MS,
  type TileClaimProgress,
} from '../src/components/Working/conquest/conquestGrowth';
import type { TileBiome, BiomeId } from '../src/components/Working/conquest/conquestBiomes';

/**
 * Unit tests for the Conquest Increment 5/6 growth + territory rules (pure Node). The
 * arithmetic behind a Queen growing her nation and a nation holding the planet — which
 * tiles are farmable vs. merely claimable, how much territory a controller owns, the
 * population cap that farmland buys, and a controller's share of the map — is
 * side-effect-free, so we assert it directly against real biome definitions rather
 * than driving the field sim.
 */

// Minimal TileBiome whose only field the growth rules read is `biome`.
function tileOf(biome: BiomeId): TileBiome {
  return { biome, elevation: 0.5, moisture: 0.5, temperature: 0.6 };
}

test.describe('Farmable-tile predicate', () => {
  test('only grassland is farmable (and claimable)', () => {
    expect(isFarmableTile(tileOf('grassland'))).toBe(true);
    expect(isFarmableTile(tileOf('forest'))).toBe(false);
    expect(isFarmableTile(tileOf('desert'))).toBe(false);
    expect(isFarmableTile(tileOf('ocean'))).toBe(false);
    expect(isFarmableTile(tileOf('mountain'))).toBe(false); // not claimable either
  });

  test('an undefined tile is never farmable', () => {
    expect(isFarmableTile(undefined)).toBe(false);
  });
});

test.describe('Claimable-tile predicate (increment 6)', () => {
  test('every biome but the impassable mountains is claimable', () => {
    expect(isClaimableTile(tileOf('grassland'))).toBe(true);
    expect(isClaimableTile(tileOf('forest'))).toBe(true);
    expect(isClaimableTile(tileOf('desert'))).toBe(true);
    expect(isClaimableTile(tileOf('snow'))).toBe(true);
    expect(isClaimableTile(tileOf('ocean'))).toBe(true);
    expect(isClaimableTile(tileOf('lake'))).toBe(true);
    expect(isClaimableTile(tileOf('mountain'))).toBe(false);
  });

  test('an undefined tile is never claimable', () => {
    expect(isClaimableTile(undefined)).toBe(false);
  });

  test('non-farmable terrain is claimable but never farmable', () => {
    for (const biome of ['forest', 'desert', 'snow', 'ocean', 'lake'] as BiomeId[]) {
      expect(isClaimableTile(tileOf(biome))).toBe(true);
      expect(isFarmableTile(tileOf(biome))).toBe(false);
    }
  });
});

test.describe('Owned farmland count', () => {
  const biomes = [
    tileOf('grassland'), // 0
    tileOf('grassland'), // 1
    tileOf('forest'),    // 2 — owned but not farmable
    tileOf('grassland'), // 3 — owned by a rival
    tileOf('ocean'),     // 4
  ];

  test('counts only the farmable tiles a controller owns', () => {
    const owners: Record<number, string> = { 0: 'p0', 1: 'p0', 2: 'p0', 3: 'ai1' };
    expect(countOwnedFarmTiles(owners, biomes, 'p0')).toBe(2); // tiles 0 and 1 only
    expect(countOwnedFarmTiles(owners, biomes, 'ai1')).toBe(1); // tile 3
    expect(countOwnedFarmTiles(owners, biomes, 'ai2')).toBe(0);
  });

  test('an empty ownership map yields no farmland', () => {
    expect(countOwnedFarmTiles({}, biomes, 'p0')).toBe(0);
  });
});

test.describe('Owned territory count (increment 6)', () => {
  const biomes = [
    tileOf('grassland'), // 0 — p0, farmable
    tileOf('forest'),    // 1 — p0, claimable not farmable
    tileOf('ocean'),     // 2 — p0, claimable not farmable
    tileOf('mountain'),  // 3 — p0 in map, but NOT claimable
    tileOf('desert'),    // 4 — rival
  ];

  test('counts every claimable tile a controller owns, not just farmland', () => {
    const owners: Record<number, string> = { 0: 'p0', 1: 'p0', 2: 'p0', 3: 'p0', 4: 'ai1' };
    // p0 holds grassland + forest + ocean (3); the mountain entry is not claimable.
    expect(countOwnedTiles(owners, biomes, 'p0')).toBe(3);
    expect(countOwnedFarmTiles(owners, biomes, 'p0')).toBe(1); // only the grassland feeds growth
    expect(countOwnedTiles(owners, biomes, 'ai1')).toBe(1);
  });

  test('counts every claimable tile on the planet', () => {
    expect(countClaimableTiles(biomes)).toBe(4); // all but the mountain
  });
});

test.describe('Territory share (increment 6)', () => {
  test('share is a whole-number percent of the claimable planet', () => {
    expect(territoryPercent(0, 200)).toBe(0);
    expect(territoryPercent(50, 200)).toBe(25);
    expect(territoryPercent(200, 200)).toBe(100);
    expect(territoryPercent(1, 3)).toBe(33); // rounds 33.33 → 33
    expect(territoryPercent(2, 3)).toBe(67); // rounds 66.66 → 67
  });

  test('a planet with no claimable land never divides by zero', () => {
    expect(territoryPercent(0, 0)).toBe(0);
  });
});

test.describe('Population cap', () => {
  test('cap is two units per owned farmable tile', () => {
    expect(populationCap(0)).toBe(0);
    expect(populationCap(1)).toBe(POPULATION_PER_FARM_TILE);
    expect(populationCap(5)).toBe(10);
  });

  test('planet ceiling is two per farmable tile in existence', () => {
    const biomes = [tileOf('grassland'), tileOf('grassland'), tileOf('forest'), tileOf('grassland')];
    expect(planetPopulationCeiling(biomes)).toBe(3 * POPULATION_PER_FARM_TILE);
  });
});

test.describe('Growth gate', () => {
  test('a controller may grow only while strictly under its cap', () => {
    expect(canGrowUnit(4, 6)).toBe(true);
    expect(canGrowUnit(5, 6)).toBe(true);
    expect(canGrowUnit(6, 6)).toBe(false); // at cap — holds station
    expect(canGrowUnit(8, 6)).toBe(false); // over cap (lost farmland) — no growth
  });

  test('with no farmland (cap 0) a controller can never grow', () => {
    expect(canGrowUnit(0, populationCap(0))).toBe(false);
  });
});

test.describe('Timed-occupation claiming (stepTileClaims)', () => {
  // Helper: occupancy map from tileId → controllers standing on it.
  function occ(entries: Record<number, string[]>): Map<number, Set<string>> {
    const map = new Map<number, Set<string>>();
    for (const [tileId, controllers] of Object.entries(entries)) {
      map.set(Number(tileId), new Set(controllers));
    }
    return map;
  }
  const HALF = CLAIM_CAPTURE_DURATION_MS / 2;

  test('a sole occupant captures only after the full continuous duration', () => {
    // First scan: progress begins, nothing claimed yet.
    let progress = new Map<number, TileClaimProgress>();
    let step = stepTileClaims({ occupantsByTile: occ({ 5: ['p0'] }), tileOwners: {}, progress, deltaMs: HALF });
    expect(step.ownerChanges.size).toBe(0);
    expect(step.progress.get(5)?.elapsedMs).toBe(HALF);
    progress = step.progress;

    // Second scan reaches the threshold: the tile is captured.
    step = stepTileClaims({ occupantsByTile: occ({ 5: ['p0'] }), tileOwners: {}, progress, deltaMs: HALF });
    expect(step.ownerChanges.get(5)).toBe('p0');
    expect(step.progress.has(5)).toBe(false); // timer cleared on capture
  });

  test('an enemy sharing the tile resets the capture timer', () => {
    const progress = new Map<number, TileClaimProgress>([[5, { controllerId: 'p0', elapsedMs: HALF }]]);
    // Contested this scan (p0 and ai1 both present): no capture, progress dropped.
    const step = stepTileClaims({ occupantsByTile: occ({ 5: ['p0', 'ai1'] }), tileOwners: {}, progress, deltaMs: HALF });
    expect(step.ownerChanges.size).toBe(0);
    expect(step.progress.has(5)).toBe(false);
  });

  test('a different claimant restarts the timer from zero', () => {
    const progress = new Map<number, TileClaimProgress>([[5, { controllerId: 'p0', elapsedMs: HALF }]]);
    // ai1 alone now: its clock starts fresh at deltaMs, not inheriting p0's progress.
    const step = stepTileClaims({ occupantsByTile: occ({ 5: ['ai1'] }), tileOwners: {}, progress, deltaMs: 1000 });
    expect(step.progress.get(5)).toEqual({ controllerId: 'ai1', elapsedMs: 1000 });
  });

  test('an owner holds its tile while present and accrues no new timer', () => {
    const step = stepTileClaims({
      occupantsByTile: occ({ 5: ['p0'] }),
      tileOwners: { 5: 'p0' },
      progress: new Map(),
      deltaMs: HALF,
    });
    expect(step.ownerChanges.size).toBe(0); // unchanged
    expect(step.progress.has(5)).toBe(false);
  });

  test('an owner holds its tile even when an enemy shares it', () => {
    const step = stepTileClaims({
      occupantsByTile: occ({ 5: ['p0', 'ai1'] }),
      tileOwners: { 5: 'p0' },
      progress: new Map(),
      deltaMs: HALF,
    });
    expect(step.ownerChanges.size).toBe(0); // defender's presence wins the contest
  });

  test('an owner that walks off releases the tile to unowned', () => {
    const step = stepTileClaims({
      occupantsByTile: occ({}), // nobody on tile 5 this scan
      tileOwners: { 5: 'p0' },
      progress: new Map(),
      deltaMs: HALF,
    });
    expect(step.ownerChanges.get(5)).toBe(null); // claim lapses
  });

  test('an enemy alone on a vacated tile begins a fresh capture', () => {
    // p0 owned tile 5 but is gone; ai1 alone there now → released AND timer starts.
    const step = stepTileClaims({
      occupantsByTile: occ({ 5: ['ai1'] }),
      tileOwners: { 5: 'p0' },
      progress: new Map(),
      deltaMs: 1000,
    });
    expect(step.ownerChanges.get(5)).toBe(null); // p0's claim lapses
    expect(step.progress.get(5)).toEqual({ controllerId: 'ai1', elapsedMs: 1000 });
  });
});
