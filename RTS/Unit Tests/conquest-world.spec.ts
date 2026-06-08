import { test, expect } from '@playwright/test';
import { buildGoldbergWorld } from '../src/components/Working/conquest/goldbergWorld';
import {
  classifyWorld,
  BIOMES,
  DEFAULT_WORLDGEN,
} from '../src/components/Working/conquest/conquestBiomes';
import { SeededNoise } from '../src/components/Working/conquest/seededNoise';

/**
 * Unit tests for the Conquest world-generation pipeline (geometry, seeded noise,
 * biome classification). These run purely in the Playwright/Node process — they
 * never touch the browser `page`, because none of these modules depend on the DOM
 * or a WebGL context, only on three.js math.
 *
 * The assertions validate structural invariants the game relies on (a Goldberg
 * polyhedron always has exactly 12 pentagons, adjacency is symmetric, a tile's
 * neighbor count equals its side count) and the determinism contract that lets a
 * seed reproduce a planet — never magic numbers copied from the implementation,
 * so they stay valid if the tuning constants change.
 */

// GP(2^s, 0) face count: F = 10 * 4^s + 2. Verified independently of the builder.
function expectedFaceCount(subdivisions: number): number {
  return 10 * Math.pow(4, subdivisions) + 2;
}

test.describe('Goldberg world geometry', () => {
  for (const subdivisions of [1, 2, 3, 4]) {
    test(`level ${subdivisions}: exactly 12 pentagons and correct face count`, () => {
      const world = buildGoldbergWorld(subdivisions);

      expect(world.tiles.length).toBe(expectedFaceCount(subdivisions));
      expect(world.pentagonIds.length).toBe(12);

      const pentagons = world.tiles.filter((tile) => tile.sides === 5);
      const hexagons = world.tiles.filter((tile) => tile.sides === 6);
      expect(pentagons.length).toBe(12);
      expect(hexagons.length).toBe(world.tiles.length - 12);
    });
  }

  test('every tile center lies on the unit sphere', () => {
    const world = buildGoldbergWorld(3);
    for (const tile of world.tiles) {
      expect(tile.center.length()).toBeCloseTo(1, 5);
    }
  });

  test('a tile has exactly one neighbor per side', () => {
    const world = buildGoldbergWorld(3);
    for (const tile of world.tiles) {
      expect(tile.neighbors.length).toBe(tile.sides);
    }
  });

  test('adjacency is symmetric and non-self-referential', () => {
    const world = buildGoldbergWorld(3);
    for (const tile of world.tiles) {
      expect(tile.neighbors).not.toContain(tile.id);
      for (const neighborId of tile.neighbors) {
        expect(world.tiles[neighborId].neighbors).toContain(tile.id);
      }
    }
  });

  test('subdivision is clamped to a sane range', () => {
    expect(buildGoldbergWorld(0).subdivisions).toBe(1);
    expect(buildGoldbergWorld(99).subdivisions).toBe(6);
  });
});

test.describe('Seeded noise determinism', () => {
  test('same seed reproduces the same field; different seed diverges', () => {
    const first = new SeededNoise(12345);
    const second = new SeededNoise(12345);
    const other = new SeededNoise(54321);

    let divergedFromOther = false;
    for (let i = 0; i < 32; i++) {
      const x = i * 0.37;
      const sampleA = first.fbm(x, x * 1.1, x * 0.9, 4);
      const sampleB = second.fbm(x, x * 1.1, x * 0.9, 4);
      expect(sampleB).toBe(sampleA);

      const sampleOther = other.fbm(x, x * 1.1, x * 0.9, 4);
      if (sampleOther !== sampleA) divergedFromOther = true;
    }
    expect(divergedFromOther).toBe(true);
  });

  test('fbm output stays within the normalized [0, 1] band', () => {
    const noise = new SeededNoise(777);
    for (let i = 0; i < 64; i++) {
      const value = noise.fbm(i * 0.5, i * -0.3, i * 0.21, 5);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

test.describe('Biome classification', () => {
  test('same seed reproduces the same planet', () => {
    const world = buildGoldbergWorld(3);
    const first = classifyWorld(world.tiles, 2024, DEFAULT_WORLDGEN);
    const second = classifyWorld(world.tiles, 2024, DEFAULT_WORLDGEN);

    expect(second.map((b) => b.biome)).toEqual(first.map((b) => b.biome));
  });

  test('a different seed produces a different planet', () => {
    const world = buildGoldbergWorld(3);
    const first = classifyWorld(world.tiles, 1, DEFAULT_WORLDGEN);
    const second = classifyWorld(world.tiles, 2, DEFAULT_WORLDGEN);

    const differs = first.some((biome, index) => biome.biome !== second[index].biome);
    expect(differs).toBe(true);
  });

  test('all twelve spawn pentagons are forced to claimable grassland', () => {
    const world = buildGoldbergWorld(3);
    const biomes = classifyWorld(world.tiles, 999, DEFAULT_WORLDGEN);

    for (const pentagonId of world.pentagonIds) {
      const tileBiome = biomes[pentagonId];
      expect(tileBiome.biome).toBe('grassland');
      expect(BIOMES.grassland.claimable).toBe(true);
      expect(BIOMES.grassland.farmable).toBe(true);
    }
  });

  test('mountains are impassable to ground units; water bars ground too', () => {
    expect(BIOMES.mountain.claimable).toBe(false);
    expect(BIOMES.mountain.passableBy.has('ground')).toBe(false);
    expect(BIOMES.mountain.passableBy.has('air')).toBe(true);

    expect(BIOMES.ocean.passableBy.has('ground')).toBe(false);
    expect(BIOMES.ocean.passableBy.has('water')).toBe(true);
  });
});
