// Biome taxonomy and per-tile classification for Conquest.
//
// Single responsibility: decide what each Goldberg tile *is* (mountain, water,
// grassland, …) from the seeded noise field, and expose the gameplay rules each
// biome implies — who can move through it, whether it can be claimed, and
// whether it grows units. The renderer reads colors from here; the simulation
// reads passability/farmable from here. One source of truth for both.
//
// The classifier is a small pipeline run once per match in `classifyWorld`:
//   A. Sample seeded fields per tile — elevation (domain-warped, continent-
//      masked), moisture, a ridged field for mountain spines, latitude warmth.
//   B. Trace rivers/lakes downhill across the neighbor graph (conquestHydrology).
//   C. Measure continentality (graph distance from water) so interiors dry out.
//   D. Assign each tile a biome from elevation + a Whittaker climate lookup.
//   E. Smooth single-tile speckle, ring oceans with beaches.
//   F. Force the 12 pentagon spawns habitable and reachable.
// Every step is deterministic in (seed, params) so a seed reproduces a planet.

import * as THREE from 'three';
import type { MovementType } from '../../../game/types';
import type { GoldbergTile } from './goldbergWorld';
import { SeededNoise } from './seededNoise';
import { SeededRng } from '../net/prng';
import { computeHydrology } from './conquestHydrology';

export type BiomeId =
  | 'ocean'
  | 'lake'
  | 'beach'
  | 'grassland'
  | 'savanna'
  | 'shrubland'
  | 'forest'
  | 'rainforest'
  | 'taiga'
  | 'tundra'
  | 'desert'
  | 'snow'
  | 'mountain';

export interface BiomeDefinition {
  id: BiomeId;
  label: string;
  /** sRGB hex used by the renderer for this biome's tiles. */
  color: number;
  /** True for ocean/lake — only water- and air-movement units may enter. */
  isWater: boolean;
  /** An occupying queen grows units on these grassy tiles each cycle. */
  farmable: boolean;
  /** Mountains can never be occupied/claimed (impassable terrain). */
  claimable: boolean;
  /** Movement types that may enter a tile of this biome. */
  passableBy: ReadonlySet<MovementType>;
  /** Outward radial offset applied by the renderer (mountains stand proud). */
  elevationOffset: number;
}

// Land (non-mountain) tiles take any land-capable unit. "water" units are
// amphibious in the RTS — the type means they can ALSO cross water, not that
// they're confined to it — so they roam land freely too. Ground units cannot
// enter water; only air clears mountains.
const LAND: ReadonlySet<MovementType> = new Set<MovementType>(['ground', 'water', 'air']);
const WATER_AIR: ReadonlySet<MovementType> = new Set<MovementType>(['water', 'air']);
const AIR_ONLY: ReadonlySet<MovementType> = new Set<MovementType>(['air']);

export const BIOMES: Record<BiomeId, BiomeDefinition> = {
  // Water sits slightly below the land shell for relief, but the offset is kept
  // above `bevelDrop - 2·thickness` (~ -0.017 at default options) so the beveled
  // rim never sinks past the crust's bottom cap and inverts the side wall.
  ocean: {
    id: 'ocean', label: 'Ocean', color: 0x0a1e3f,
    isWater: true, farmable: false, claimable: true,
    passableBy: WATER_AIR, elevationOffset: -0.006,
  },
  lake: {
    id: 'lake', label: 'Lake & River', color: 0x0d5c75,
    isWater: true, farmable: false, claimable: true,
    passableBy: WATER_AIR, elevationOffset: -0.003,
  },
  beach: {
    id: 'beach', label: 'Beach', color: 0xe6d6a8,
    isWater: false, farmable: false, claimable: true,
    passableBy: LAND, elevationOffset: 0.004,
  },
  grassland: {
    id: 'grassland', label: 'Grassland', color: 0x4e9f3d,
    isWater: false, farmable: true, claimable: true,
    passableBy: LAND, elevationOffset: 0.01,
  },
  savanna: {
    id: 'savanna', label: 'Savanna', color: 0xb7a13c,
    isWater: false, farmable: true, claimable: true,
    passableBy: LAND, elevationOffset: 0.012,
  },
  shrubland: {
    id: 'shrubland', label: 'Shrubland', color: 0x9aa45a,
    isWater: false, farmable: false, claimable: true,
    passableBy: LAND, elevationOffset: 0.01,
  },
  forest: {
    id: 'forest', label: 'Forest', color: 0x13543d,
    isWater: false, farmable: false, claimable: true,
    passableBy: LAND, elevationOffset: 0.02,
  },
  rainforest: {
    id: 'rainforest', label: 'Rainforest', color: 0x0a6e3b,
    isWater: false, farmable: false, claimable: true,
    passableBy: LAND, elevationOffset: 0.024,
  },
  taiga: {
    id: 'taiga', label: 'Taiga', color: 0x2f5d4a,
    isWater: false, farmable: false, claimable: true,
    passableBy: LAND, elevationOffset: 0.018,
  },
  tundra: {
    id: 'tundra', label: 'Tundra', color: 0x8fa39a,
    isWater: false, farmable: false, claimable: true,
    passableBy: LAND, elevationOffset: 0.008,
  },
  desert: {
    id: 'desert', label: 'Desert', color: 0xd69f44,
    isWater: false, farmable: false, claimable: true,
    passableBy: LAND, elevationOffset: 0.0,
  },
  snow: {
    id: 'snow', label: 'Snow & Ice', color: 0xecf3f9,
    isWater: false, farmable: false, claimable: true,
    passableBy: LAND, elevationOffset: 0.01,
  },
  mountain: {
    id: 'mountain', label: 'Mountain', color: 0x5c5b73,
    isWater: false, farmable: false, claimable: false,
    passableBy: AIR_ONLY, elevationOffset: 0.06,
  },
};

/**
 * Tunable world-generation parameters; all derived deterministically from a seed
 * by `deriveWorldGenParams`. Together they decide a planet's *character* — sea
 * level, climate balance, coastline roughness, continent layout, and rockiness —
 * so two seeds feel like genuinely different worlds rather than reshuffled noise.
 */
export interface WorldGenParams {
  /** Elevation below which a tile is sea (0..1). Higher = more ocean. */
  oceanLevel: number;
  /** Overall moisture multiplier — higher means more forest, less desert. */
  moistureScale: number;
  /** Mountain elevation cutoff as a fraction of the land band above sea (0..1). */
  mountainBias: number;
  /** Latitude exponent for the pole-to-equator warmth falloff. */
  temperatureFalloff: number;
  /** Global warmth shift applied everywhere (negative = an icebound world). */
  temperatureBias: number;
  /** Base sampling frequency of the elevation/moisture fields. */
  noiseFrequency: number;
  /** Domain-warp amplitude in unit-sphere space (0 = no warp / blobby coasts). */
  warpStrength: number;
  /** Continent-mask frequency multiplier — small = pangaea, large = archipelago. */
  continentScale: number;
  /** How strongly the continent mask carves oceans into the detail field (0..1). */
  continentInfluence: number;
}

export const DEFAULT_WORLDGEN: WorldGenParams = {
  oceanLevel: 0.48,
  moistureScale: 1.0,
  mountainBias: 0.65,
  temperatureFalloff: 1.6,
  temperatureBias: 0.0,
  noiseFrequency: 1.5,
  warpStrength: 0.0,
  continentScale: 1.0,
  // Default leaves the detail field untouched so the baseline (and the Phase-2
  // regression tests) match raw fBm; seed-derived worlds dial this up.
  continentInfluence: 0.0,
};

/** Named world flavors the lobby can pick to bias `deriveWorldGenParams`. */
export type WorldArchetype =
  | 'continents'
  | 'islands'
  | 'pangaea'
  | 'frozen'
  | 'arid';

export const WORLD_ARCHETYPES: readonly WorldArchetype[] = [
  'continents', 'islands', 'pangaea', 'frozen', 'arid',
];

/** Per-tile classification result, cached on the tile for inspection + rules. */
export interface TileBiome {
  biome: BiomeId;
  elevation: number;
  moisture: number;
  temperature: number;
}

// Fixed sample offsets keep the moisture, continent, and warp fields decorrelated
// from the elevation field (so wet/high/warped regions don't coincide). The exact
// values are arbitrary but fixed for determinism.
const MOISTURE_SAMPLE_OFFSET = 50.0;
const CONTINENT_SAMPLE_OFFSET = 17.3;
const WARP_OFFSET_X = 31.7;
const WARP_OFFSET_Y = 64.1;
const WARP_OFFSET_Z = 12.9;

// Continent mask runs at a fraction of the detail frequency so its features span
// many tiles (whole landmasses) rather than single tiles.
const CONTINENT_FREQUENCY_SCALE = 0.4;
// How much warmth is lost climbing from sea level to the highest land.
const ALTITUDE_COOLING = 0.5;
// How much drier a deep continental interior runs versus the coast.
const CONTINENTAL_DRYNESS = 0.3;
// Graph hops from water past which a tile counts as fully "interior".
const CONTINENTALITY_CAP = 6;
// Ridge strength a high tile also needs to read as a mountain spine (vs a lone
// peak); the ridged field forms thin lines, so this gates ranges into arcs.
const MOUNTAIN_RIDGE_THRESHOLD = 0.52;
// XOR constant decorrelating the param rolls from the noise permutation seed.
const PARAM_SEED_SALT = 0x9e3779b9;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Derive a world's parameters from its seed (optionally biased by an archetype).
 * Uses a SeededRng salted off the seed so the parameter rolls don't move in
 * lockstep with the terrain noise (which seeds its permutation from the raw seed).
 */
export function deriveWorldGenParams(
  seed: number,
  archetype?: WorldArchetype,
): WorldGenParams {
  const rng = new SeededRng((seed ^ PARAM_SEED_SALT) >>> 0);
  const inRange = (min: number, max: number) => min + rng.next() * (max - min);
  const bands = archetypeBands(archetype);

  return {
    oceanLevel: inRange(bands.oceanLevel[0], bands.oceanLevel[1]),
    moistureScale: inRange(bands.moistureScale[0], bands.moistureScale[1]),
    mountainBias: inRange(0.6, 0.85),
    temperatureFalloff: inRange(1.2, 2.2),
    temperatureBias: inRange(bands.temperatureBias[0], bands.temperatureBias[1]),
    noiseFrequency: inRange(1.2, 2.2),
    warpStrength: inRange(0.15, 0.6),
    continentScale: inRange(bands.continentScale[0], bands.continentScale[1]),
    continentInfluence: inRange(bands.continentInfluence[0], bands.continentInfluence[1]),
  };
}

interface ArchetypeBands {
  oceanLevel: [number, number];
  moistureScale: [number, number];
  temperatureBias: [number, number];
  continentScale: [number, number];
  continentInfluence: [number, number];
}

/** Parameter bands per archetype; the default ("continents") is a balanced world. */
function archetypeBands(archetype?: WorldArchetype): ArchetypeBands {
  switch (archetype) {
    case 'islands':
      return {
        oceanLevel: [0.55, 0.66], moistureScale: [0.9, 1.3], temperatureBias: [-0.05, 0.1],
        continentScale: [1.6, 2.4], continentInfluence: [0.6, 0.85],
      };
    case 'pangaea':
      return {
        oceanLevel: [0.36, 0.44], moistureScale: [0.8, 1.2], temperatureBias: [-0.05, 0.1],
        continentScale: [0.45, 0.8], continentInfluence: [0.55, 0.8],
      };
    case 'frozen':
      return {
        oceanLevel: [0.45, 0.58], moistureScale: [0.7, 1.1], temperatureBias: [-0.45, -0.25],
        continentScale: [0.9, 1.6], continentInfluence: [0.4, 0.7],
      };
    case 'arid':
      return {
        oceanLevel: [0.4, 0.5], moistureScale: [0.35, 0.6], temperatureBias: [0.05, 0.2],
        continentScale: [0.9, 1.6], continentInfluence: [0.4, 0.7],
      };
    case 'continents':
    default:
      return {
        oceanLevel: [0.46, 0.56], moistureScale: [0.8, 1.2], temperatureBias: [-0.08, 0.08],
        continentScale: [0.9, 1.5], continentInfluence: [0.45, 0.7],
      };
  }
}

interface RawTileFields {
  elevation: number;
  moisture: number;
  ridge: number;
  latitudeTemp: number;
}

/**
 * Sample the seeded scalar fields for one tile: domain-warped, continent-masked
 * elevation; decorrelated moisture; a ridged field for mountain spines; and the
 * raw latitude warmth (altitude/continentality cooling is applied later, once the
 * world's water layout is known).
 */
function sampleTileFields(
  center: THREE.Vector3,
  noise: SeededNoise,
  params: WorldGenParams,
): RawTileFields {
  const frequency = params.noiseFrequency;
  const baseX = center.x * frequency;
  const baseY = center.y * frequency;
  const baseZ = center.z * frequency;

  // Domain warp: nudge the elevation sample point by a low-amplitude noise vector
  // so coastlines meander. warpStrength 0 leaves the sample point untouched, which
  // is exactly the pre-warp behavior (Phase-2 regression lock).
  let sampleX = baseX;
  let sampleY = baseY;
  let sampleZ = baseZ;
  if (params.warpStrength !== 0) {
    const warpX = noise.fbm(baseX + WARP_OFFSET_X, baseY + WARP_OFFSET_X, baseZ + WARP_OFFSET_X, 3) * 2 - 1;
    const warpY = noise.fbm(baseX + WARP_OFFSET_Y, baseY + WARP_OFFSET_Y, baseZ + WARP_OFFSET_Y, 3) * 2 - 1;
    const warpZ = noise.fbm(baseX + WARP_OFFSET_Z, baseY + WARP_OFFSET_Z, baseZ + WARP_OFFSET_Z, 3) * 2 - 1;
    sampleX += params.warpStrength * warpX;
    sampleY += params.warpStrength * warpY;
    sampleZ += params.warpStrength * warpZ;
  }

  const detail = noise.fbm(sampleX, sampleY, sampleZ, 5);

  // Continent mask: a very-low-frequency field that clumps land into a few
  // masses. Blending detail toward detail*mask carves real ocean basins between
  // continents; continentInfluence 0 leaves detail untouched (reduces to Phase 2).
  const continentFrequency = frequency * CONTINENT_FREQUENCY_SCALE * params.continentScale;
  const continentMask = noise.fbm(
    center.x * continentFrequency + CONTINENT_SAMPLE_OFFSET,
    center.y * continentFrequency + CONTINENT_SAMPLE_OFFSET,
    center.z * continentFrequency + CONTINENT_SAMPLE_OFFSET,
    3,
  );
  // Blend the detail field toward the continent mask (not detail*mask), so high-
  // mask regions rise into continents and low-mask regions sink into oceans while
  // the field's overall mean is preserved — land/water balance stays governed by
  // the sea-level quantile, not pushed all-ocean. influence 0 leaves detail alone.
  const elevation = clamp01(
    detail * (1 - params.continentInfluence) + continentMask * params.continentInfluence,
  );

  const moisture = clamp01(
    noise.fbm(baseX + MOISTURE_SAMPLE_OFFSET, baseY + MOISTURE_SAMPLE_OFFSET, baseZ + MOISTURE_SAMPLE_OFFSET, 4)
      * params.moistureScale,
  );

  const ridge = noise.ridgedFbm(sampleX, sampleY, sampleZ, 4);

  const latitudeTemp = 1 - Math.pow(Math.abs(center.y), params.temperatureFalloff);

  return { elevation, moisture, ridge, latitudeTemp };
}

/**
 * Cool a land tile's latitude warmth by altitude (snow caps) and a global bias.
 * `altitudeFraction` is the tile's height within the land band [0,1] (0 at the
 * coast, 1 at the highest peak), so cooling is relative to the actual relief of
 * this particular world rather than an absolute elevation number.
 */
function landTemperature(
  latitudeTemp: number,
  altitudeFraction: number,
  temperatureBias: number,
): number {
  return clamp01(latitudeTemp + temperatureBias - altitudeFraction * ALTITUDE_COOLING);
}

/**
 * Whittaker-style climate lookup: pick a land biome from temperature × moisture.
 * A total function over the unit climate square — every branch returns a BiomeId
 * present in BIOMES — so callers never need a fallback.
 */
export function biomeFromClimate(temperature: number, moisture: number): BiomeId {
  const temp = clamp01(temperature);
  const wet = clamp01(moisture);

  if (temp < 0.18) return wet < 0.5 ? 'snow' : 'tundra';
  if (temp < 0.38) return wet < 0.33 ? 'tundra' : 'taiga';
  if (temp < 0.66) {
    if (wet < 0.25) return 'shrubland';
    if (wet < 0.55) return 'grassland';
    return 'forest';
  }
  if (wet < 0.25) return 'desert';
  if (wet < 0.5) return 'savanna';
  return 'rainforest';
}

/** Pick a land biome, promoting high + ridged tiles to impassable mountains. */
function pickLandBiome(
  elevation: number,
  moisture: number,
  temperature: number,
  ridge: number,
  mountainThreshold: number,
): BiomeId {
  if (elevation > mountainThreshold && ridge > MOUNTAIN_RIDGE_THRESHOLD) return 'mountain';
  return biomeFromClimate(temperature, moisture);
}

/**
 * Classify one tile in isolation (no world passes), using `params.oceanLevel` as
 * a direct elevation threshold. Used for single-tile checks and the warp/fBm
 * regression tests; `classifyWorld` is the real entry point and additionally
 * derives sea level from the world's elevation quantile and layers hydrology,
 * continentality, smoothing, and coastlines.
 */
export function classifyTile(
  center: THREE.Vector3,
  noise: SeededNoise,
  params: WorldGenParams,
): TileBiome {
  const fields = sampleTileFields(center, noise, params);
  if (fields.elevation < params.oceanLevel) {
    const biome: BiomeId = fields.elevation < params.oceanLevel - 0.1 ? 'ocean' : 'lake';
    return { biome, elevation: fields.elevation, moisture: fields.moisture, temperature: clamp01(fields.latitudeTemp) };
  }
  const landBand = Math.max(1e-3, 1 - params.oceanLevel);
  const altitudeFraction = Math.max(0, fields.elevation - params.oceanLevel) / landBand;
  const temperature = landTemperature(fields.latitudeTemp, altitudeFraction, params.temperatureBias);
  const mountainThreshold = params.oceanLevel + (1 - params.oceanLevel) * params.mountainBias;
  const biome = pickLandBiome(fields.elevation, fields.moisture, temperature, fields.ridge, mountainThreshold);
  return { biome, elevation: fields.elevation, moisture: fields.moisture, temperature };
}

/** Value at quantile `q` (0..1) of an ascending-sorted array (nearest-rank). */
function quantile(sortedAscending: number[], q: number): number {
  if (sortedAscending.length === 0) return 0;
  const index = Math.min(
    sortedAscending.length - 1,
    Math.max(0, Math.floor(q * sortedAscending.length)),
  );
  return sortedAscending[index];
}

/**
 * Continentality per tile: normalized graph distance from the nearest water, so
 * coastal tiles read ~0 and deep interiors ~1. A multi-source BFS over the
 * neighbor graph, seeded from every sea / river / lake tile.
 */
function computeContinentality(
  tiles: GoldbergTile[],
  isWater: boolean[],
): number[] {
  const distance = new Array<number>(tiles.length).fill(Infinity);
  const queue: number[] = [];
  for (const tile of tiles) {
    if (isWater[tile.id]) {
      distance[tile.id] = 0;
      queue.push(tile.id);
    }
  }

  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const nextDistance = distance[id] + 1;
    for (const neighborId of tiles[id].neighbors) {
      if (nextDistance < distance[neighborId]) {
        distance[neighborId] = nextDistance;
        queue.push(neighborId);
      }
    }
  }

  return distance.map((d) => (Number.isFinite(d) ? Math.min(1, d / CONTINENTALITY_CAP) : 1));
}

const SMOOTHABLE = new Set<BiomeId>([
  'grassland', 'savanna', 'shrubland', 'forest', 'rainforest', 'taiga', 'tundra', 'desert', 'snow',
]);

/**
 * Remove single-tile speckle: a land tile completely surrounded by a different
 * land biome adopts the strict majority. Reads a snapshot so the pass is
 * order-independent (hence deterministic) and never disturbs water, beaches, or
 * mountain spines.
 */
function smoothLandSpeckle(tiles: GoldbergTile[], result: TileBiome[]): void {
  const snapshot = result.map((tile) => tile.biome);
  for (const tile of tiles) {
    if (!SMOOTHABLE.has(snapshot[tile.id])) continue;

    const neighborCounts = new Map<BiomeId, number>();
    let landNeighbors = 0;
    let sameAsTile = 0;
    for (const neighborId of tile.neighbors) {
      const neighborBiome = snapshot[neighborId];
      if (!SMOOTHABLE.has(neighborBiome)) continue;
      landNeighbors++;
      neighborCounts.set(neighborBiome, (neighborCounts.get(neighborBiome) ?? 0) + 1);
      if (neighborBiome === snapshot[tile.id]) sameAsTile++;
    }
    // Only rewrite a genuine lone speckle (no neighbor shares its biome).
    if (landNeighbors < 3 || sameAsTile > 0) continue;

    let majorityBiome: BiomeId | null = null;
    let majorityCount = 0;
    for (const [biome, count] of neighborCounts) {
      if (count > majorityCount) {
        majorityCount = count;
        majorityBiome = biome;
      }
    }
    if (majorityBiome && majorityCount * 2 > landNeighbors) {
      result[tile.id] = { ...result[tile.id], biome: majorityBiome };
    }
  }
}

/** Ring oceans with beaches: any land tile edge-adjacent to ocean becomes coast. */
function applyCoastalBeaches(tiles: GoldbergTile[], result: TileBiome[]): void {
  const snapshot = result.map((tile) => tile.biome);
  for (const tile of tiles) {
    const biome = snapshot[tile.id];
    if (biome === 'ocean' || biome === 'lake' || biome === 'mountain') continue;
    const touchesOcean = tile.neighbors.some((neighborId) => snapshot[neighborId] === 'ocean');
    if (touchesOcean) result[tile.id] = { ...result[tile.id], biome: 'beach' };
  }
}

/**
 * Guarantee all 12 pentagon spawns stay playable: force each to grassland (land,
 * claimable, growth-capable) lifted above sea level, and ensure at least one
 * neighbor is ground-passable so a spawn is never a one-tile island.
 */
function enforceSpawnHabitability(
  tiles: GoldbergTile[],
  result: TileBiome[],
  seaThreshold: number,
): void {
  const minLandElevation = Math.min(1, seaThreshold + 0.05);
  for (const tile of tiles) {
    if (tile.sides !== 5) continue;

    const current = result[tile.id];
    result[tile.id] = {
      biome: 'grassland',
      elevation: Math.max(current.elevation, minLandElevation),
      moisture: current.moisture,
      temperature: current.temperature,
    };

    const hasLandNeighbor = tile.neighbors.some(
      (neighborId) => BIOMES[result[neighborId].biome].passableBy.has('ground'),
    );
    if (hasLandNeighbor) continue;

    // Reclaim the highest neighbor as a land bridge so the army can march out.
    let bridgeId = -1;
    let bridgeElevation = -Infinity;
    for (const neighborId of tile.neighbors) {
      if (result[neighborId].elevation > bridgeElevation) {
        bridgeElevation = result[neighborId].elevation;
        bridgeId = neighborId;
      }
    }
    if (bridgeId >= 0) {
      result[bridgeId] = {
        ...result[bridgeId],
        biome: 'grassland',
        elevation: Math.max(result[bridgeId].elevation, minLandElevation),
      };
    }
  }
}

/**
 * Classify every tile in a world. Runs the full pipeline (fields → hydrology →
 * continentality → biomes → smoothing/coast → spawn guarantee) so the same
 * (seed, params) always reproduces the same planet. Pentagons (the 12 spawn
 * nodes) are always left habitable grassland.
 */
export function classifyWorld(
  tiles: GoldbergTile[],
  seed: number,
  params: WorldGenParams = DEFAULT_WORLDGEN,
): TileBiome[] {
  const noise = new SeededNoise(seed);

  // A. Raw seeded fields per tile.
  const fields = tiles.map((tile) => sampleTileFields(tile.center, noise, params));
  const elevations = fields.map((field) => field.elevation);

  // Derive thresholds from the world's own elevation distribution so the params
  // mean what they say regardless of how the noise field happened to compress:
  //   oceanLevel  = fraction of the planet that is sea,
  //   mountainBias = fraction of LAND that sits below the mountain line.
  // This keeps land/water balance and mountain coverage predictable per seed.
  const sortedElevations = [...elevations].sort((first, second) => first - second);
  const seaThreshold = quantile(sortedElevations, params.oceanLevel);
  const deepThreshold = quantile(sortedElevations, params.oceanLevel * 0.8);
  const maxElevation = sortedElevations[sortedElevations.length - 1] ?? 1;
  const landBand = Math.max(1e-3, maxElevation - seaThreshold);
  const landElevations = elevations.filter((e) => e >= seaThreshold).sort((a, b) => a - b);
  const mountainThreshold = quantile(landElevations, params.mountainBias);

  // B. Rivers & lakes from downhill flow across the neighbor graph.
  const { waterTiles } = computeHydrology(tiles, elevations, seaThreshold);

  // C. Continentality: interiors (far from any water) dry out into deserts.
  const isWater = tiles.map(
    (tile) => elevations[tile.id] < seaThreshold || waterTiles.has(tile.id),
  );
  const continentality = computeContinentality(tiles, isWater);

  // D. Assign each tile its biome.
  const result: TileBiome[] = tiles.map((tile, index) => {
    const field = fields[index];

    if (field.elevation < seaThreshold) {
      const biome: BiomeId = field.elevation < deepThreshold ? 'ocean' : 'lake';
      return { biome, elevation: field.elevation, moisture: field.moisture, temperature: clamp01(field.latitudeTemp) };
    }

    const moisture = clamp01(field.moisture - continentality[index] * CONTINENTAL_DRYNESS);
    const altitudeFraction = clamp01((field.elevation - seaThreshold) / landBand);
    const temperature = landTemperature(field.latitudeTemp, altitudeFraction, params.temperatureBias);

    // Hydrology water overrides the land biome — rivers/lakes are water corridors.
    if (waterTiles.has(tile.id)) {
      return { biome: 'lake', elevation: field.elevation, moisture, temperature };
    }

    const biome = pickLandBiome(field.elevation, moisture, temperature, field.ridge, mountainThreshold);
    return { biome, elevation: field.elevation, moisture, temperature };
  });

  // E. Coherence polish.
  smoothLandSpeckle(tiles, result);
  applyCoastalBeaches(tiles, result);

  // F. Spawn guarantee (overrides every prior pass on the pentagons).
  enforceSpawnHabitability(tiles, result, seaThreshold);

  return result;
}
