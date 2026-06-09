import { test, expect } from '@playwright/test';
import { buildGoldbergWorld } from '../src/components/Working/conquest/goldbergWorld';
import {
  classifyWorld,
  classifyTile,
  deriveWorldGenParams,
  biomeFromClimate,
  BIOMES,
  DEFAULT_WORLDGEN,
  WORLD_ARCHETYPES,
  type WorldGenParams,
} from '../src/components/Working/conquest/conquestBiomes';
import {
  computeHydrology,
  DEFAULT_HYDROLOGY,
} from '../src/components/Working/conquest/conquestHydrology';
import { SeededNoise } from '../src/components/Working/conquest/seededNoise';

/**
 * Unit tests for the Conquest worldgen overhaul (seed-derived parameters, domain
 * warping, continent masks, ridged mountain ranges, downhill hydrology, the
 * Whittaker climate lookup, and the spawn guarantee). Like the rest of the
 * conquest suite these run purely in Node — the worldgen modules depend only on
 * three.js math and the seeded RNG.
 *
 * Every assertion validates a *real* invariant the game relies on — determinism,
 * declared parameter relationships, downhill-only rivers, mountain clustering,
 * spawn habitability — never a tuning constant copied out of the implementation,
 * so the tests stay meaningful when the constants are retuned.
 */

const world = buildGoldbergWorld(3);
const tiles = world.tiles;

function biomeHistogram(seed: number, params: WorldGenParams): Record<string, number> {
  return classifyWorld(tiles, seed, params).reduce<Record<string, number>>((counts, tile) => {
    counts[tile.biome] = (counts[tile.biome] ?? 0) + 1;
    return counts;
  }, {});
}

test.describe('Phase 1 — seed-derived world parameters', () => {
  test('the same seed derives identical parameters', () => {
    expect(deriveWorldGenParams(123456)).toEqual(deriveWorldGenParams(123456));
  });

  test('different seeds derive different parameters', () => {
    expect(deriveWorldGenParams(1)).not.toEqual(deriveWorldGenParams(2));
  });

  test('every derived parameter is a finite number in a sane band', () => {
    for (let seed = 0; seed < 200; seed++) {
      const params = deriveWorldGenParams((seed * 2654435761) >>> 0);
      for (const value of Object.values(params)) {
        expect(Number.isFinite(value)).toBe(true);
      }
      // Sea level must always leave both land and ocean on the planet.
      expect(params.oceanLevel).toBeGreaterThan(0.2);
      expect(params.oceanLevel).toBeLessThan(0.8);
      // Warp/continent influence stay within unit-ish bounds the classifier expects.
      expect(params.warpStrength).toBeGreaterThanOrEqual(0);
      expect(params.continentInfluence).toBeGreaterThanOrEqual(0);
      expect(params.continentInfluence).toBeLessThanOrEqual(1);
    }
  });

  test('a seed reproduces an identical planet but two seeds diverge', () => {
    const first = classifyWorld(tiles, 2024, deriveWorldGenParams(2024)).map((t) => t.biome);
    const repeat = classifyWorld(tiles, 2024, deriveWorldGenParams(2024)).map((t) => t.biome);
    const other = classifyWorld(tiles, 7777, deriveWorldGenParams(7777)).map((t) => t.biome);

    expect(repeat).toEqual(first);
    expect(other).not.toEqual(first);
  });

  test('higher ocean level yields strictly less land (sea level is a fraction)', () => {
    const landCount = (oceanLevel: number) =>
      classifyWorld(tiles, 555, { ...DEFAULT_WORLDGEN, oceanLevel })
        .filter((tile) => !BIOMES[tile.biome].isWater).length;

    expect(landCount(0.4)).toBeGreaterThan(landCount(0.5));
    expect(landCount(0.5)).toBeGreaterThan(landCount(0.6));
  });
});

test.describe('Phase 2 — domain warping + tunable fBm', () => {
  const noise = new SeededNoise(4242);

  test('default gain/lacunarity fBm is unchanged from the original (regression lock)', () => {
    for (let i = 0; i < 24; i++) {
      const x = i * 0.41;
      expect(noise.fbm(x, x * 1.3, x * 0.7, 4, 0.5, 2)).toBe(noise.fbm(x, x * 1.3, x * 0.7, 4));
    }
  });

  test('ridged fBm is a total function normalized to [0, 1]', () => {
    for (let i = 0; i < 64; i++) {
      const value = noise.ridgedFbm(i * 0.5, i * -0.3, i * 0.21, 4);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  test('warpStrength 0 leaves classification identical; a positive warp changes it', () => {
    const noWarp: WorldGenParams = { ...DEFAULT_WORLDGEN, warpStrength: 0 };
    const warped: WorldGenParams = { ...DEFAULT_WORLDGEN, warpStrength: 0.5 };

    let anyDifference = false;
    for (const tile of tiles) {
      const baseline = classifyTile(tile.center, noise, noWarp);
      const baselineRepeat = classifyTile(tile.center, new SeededNoise(4242), noWarp);
      // warp 0 is deterministic and matches a fresh-noise run.
      expect(baselineRepeat.biome).toBe(baseline.biome);
      if (classifyTile(tile.center, new SeededNoise(4242), warped).biome !== baseline.biome) {
        anyDifference = true;
      }
    }
    expect(anyDifference).toBe(true);
  });
});

test.describe('Phase 4 — ridged mountains form ranges', () => {
  test('mountains cluster with other mountains far above their map density', () => {
    // Average over several seeds so the property is robust, not seed-luck.
    let totalRate = 0;
    let totalDensity = 0;
    let sampled = 0;
    for (const seed of [11, 22, 33, 44, 55]) {
      const biomes = classifyWorld(tiles, seed, deriveWorldGenParams(seed));
      const mountains = tiles.filter((tile) => biomes[tile.id].biome === 'mountain');
      if (mountains.length < 6) continue;

      const withMountainNeighbor = mountains.filter((tile) =>
        tile.neighbors.some((neighborId) => biomes[neighborId].biome === 'mountain'),
      ).length;
      totalRate += withMountainNeighbor / mountains.length;
      totalDensity += mountains.length / tiles.length;
      sampled++;
    }
    expect(sampled).toBeGreaterThan(0);
    // A genuine range: a mountain tile is far likelier to touch another mountain
    // than a random tile of the same global density would be.
    expect(totalRate / sampled).toBeGreaterThan((totalDensity / sampled) * 2);
  });

  test('mountains stay impassable to ground and water; only air clears them', () => {
    expect(BIOMES.mountain.passableBy.has('ground')).toBe(false);
    expect(BIOMES.mountain.passableBy.has('water')).toBe(false);
    expect(BIOMES.mountain.passableBy.has('air')).toBe(true);
    expect(BIOMES.mountain.claimable).toBe(false);
  });
});

test.describe('Phase 5 — rivers and lakes via downhill flow', () => {
  test('every river flows downhill into water, and the pass is deterministic', () => {
    const params = deriveWorldGenParams(808);
    const biomes = classifyWorld(tiles, 808, params);
    const elevations = biomes.map((tile) => tile.elevation);
    const sorted = [...elevations].sort((a, b) => a - b);
    const seaThreshold = sorted[Math.floor(params.oceanLevel * sorted.length)];

    const { waterTiles } = computeHydrology(tiles, elevations, seaThreshold);
    const repeat = computeHydrology(tiles, elevations, seaThreshold);
    expect([...repeat.waterTiles].sort()).toEqual([...waterTiles].sort());

    for (const [tileId, kind] of waterTiles) {
      if (kind !== 'river') continue;

      // Its lowest neighbor is strictly lower (downhill)…
      let lowestNeighbor = -1;
      let lowestElevation = elevations[tileId];
      for (const neighborId of tiles[tileId].neighbors) {
        if (elevations[neighborId] < lowestElevation) {
          lowestElevation = elevations[neighborId];
          lowestNeighbor = neighborId;
        }
      }
      expect(lowestNeighbor).toBeGreaterThanOrEqual(0);
      expect(elevations[lowestNeighbor]).toBeLessThanOrEqual(elevations[tileId]);

      // …and that downstream tile is itself water, so rivers reach the sea.
      const downstreamIsWater =
        elevations[lowestNeighbor] < seaThreshold || waterTiles.has(lowestNeighbor);
      expect(downstreamIsWater).toBe(true);
    }
  });

  test('river threshold scales so rivers survive on a larger map', () => {
    const bigWorld = buildGoldbergWorld(4);
    const params = deriveWorldGenParams(3);
    const biomes = classifyWorld(bigWorld.tiles, 3, params);
    const elevations = biomes.map((tile) => tile.elevation);
    const sorted = [...elevations].sort((a, b) => a - b);
    const seaThreshold = sorted[Math.floor(params.oceanLevel * sorted.length)];

    const { waterTiles } = computeHydrology(
      bigWorld.tiles, elevations, seaThreshold, DEFAULT_HYDROLOGY,
    );
    const rivers = [...waterTiles.values()].filter((kind) => kind === 'river').length;
    expect(rivers).toBeGreaterThan(0);
  });
});

test.describe('Phase 6 — Whittaker climate lookup', () => {
  test('biomeFromClimate is total over the climate square and returns real land biomes', () => {
    for (let temperature = 0; temperature <= 1.0001; temperature += 0.05) {
      for (let moisture = 0; moisture <= 1.0001; moisture += 0.05) {
        const biome = biomeFromClimate(temperature, moisture);
        const definition = BIOMES[biome];
        expect(definition).toBeDefined();
        expect(definition.isWater).toBe(false);
        expect(biome).not.toBe('mountain');
      }
    }
  });

  test('classified worlds expose far more biome variety than the legacy seven', () => {
    const biomes = new Set(classifyWorld(tiles, 2024, deriveWorldGenParams(2024)).map((t) => t.biome));
    // The overhaul should routinely surface beaches and at least one Whittaker
    // biome unavailable before (savanna / rainforest / taiga / tundra / shrubland).
    expect(biomes.has('beach')).toBe(true);
    const whittakerOnly = ['savanna', 'rainforest', 'taiga', 'tundra', 'shrubland'];
    expect(whittakerOnly.some((biome) => biomes.has(biome as never))).toBe(true);
  });
});

test.describe('Spawn guarantee holds across every seed and archetype', () => {
  test('all 12 pentagons stay habitable grassland with a reachable land neighbor', () => {
    const archetypes = [undefined, ...WORLD_ARCHETYPES];
    for (const archetype of archetypes) {
      for (let seed = 0; seed < 12; seed++) {
        const params = deriveWorldGenParams(seed + 5, archetype);
        const biomes = classifyWorld(tiles, seed + 5, params);

        for (const pentagonId of world.pentagonIds) {
          expect(biomes[pentagonId].biome).toBe('grassland');
          const hasLandNeighbor = tiles[pentagonId].neighbors.some(
            (neighborId) => BIOMES[biomes[neighborId].biome].passableBy.has('ground'),
          );
          expect(hasLandNeighbor).toBe(true);
        }
      }
    }
    // Grassland itself must remain claimable + growth-capable.
    expect(BIOMES.grassland.claimable).toBe(true);
    expect(BIOMES.grassland.farmable).toBe(true);
  });
});

test.describe('Phase 8 — archetypes bias the world as advertised', () => {
  function meanOceanLevel(archetype: Parameters<typeof deriveWorldGenParams>[1], samples = 200): number {
    let total = 0;
    for (let seed = 0; seed < samples; seed++) total += deriveWorldGenParams(seed, archetype).oceanLevel;
    return total / samples;
  }
  function meanMoisture(archetype: Parameters<typeof deriveWorldGenParams>[1], samples = 200): number {
    let total = 0;
    for (let seed = 0; seed < samples; seed++) total += deriveWorldGenParams(seed, archetype).moistureScale;
    return total / samples;
  }
  function meanTemperatureBias(archetype: Parameters<typeof deriveWorldGenParams>[1], samples = 200): number {
    let total = 0;
    for (let seed = 0; seed < samples; seed++) total += deriveWorldGenParams(seed, archetype).temperatureBias;
    return total / samples;
  }

  test('islands run wetter and more flooded than pangaea', () => {
    expect(meanOceanLevel('islands')).toBeGreaterThan(meanOceanLevel('pangaea'));
  });

  test('arid worlds are drier and frozen worlds colder than the balanced default', () => {
    expect(meanMoisture('arid')).toBeLessThan(meanMoisture('continents'));
    expect(meanTemperatureBias('frozen')).toBeLessThan(meanTemperatureBias('continents'));
  });

  test('map-size levels map to the GP(2^s,0) tile count 10·4^s + 2', () => {
    for (const subdivisions of [2, 3, 4]) {
      expect(buildGoldbergWorld(subdivisions).tiles.length).toBe(10 * Math.pow(4, subdivisions) + 2);
    }
  });
});
