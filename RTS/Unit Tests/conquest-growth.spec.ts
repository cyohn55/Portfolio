import { test, expect } from '@playwright/test';
import {
  isFarmableTile,
  countOwnedFarmTiles,
  populationCap,
  planetPopulationCeiling,
  canGrowUnit,
  POPULATION_PER_FARM_TILE,
} from '../src/components/Working/conquest/conquestGrowth';
import type { TileBiome, BiomeId } from '../src/components/Working/conquest/conquestBiomes';

/**
 * Unit tests for the Conquest Increment 5 growth rules (pure Node). The arithmetic
 * behind a Queen growing her nation — which tiles are farmable, how much territory a
 * controller owns, the population cap that territory buys, and whether another unit
 * may be grown — is side-effect-free, so we assert it directly against real biome
 * definitions rather than driving the field sim.
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
