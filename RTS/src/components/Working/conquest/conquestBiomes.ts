// Biome taxonomy and per-tile classification for Conquest.
//
// Single responsibility: decide what each Goldberg tile *is* (mountain, water,
// grassland, …) from the seeded noise field, and expose the gameplay rules each
// biome implies — who can move through it, whether it can be claimed, and
// whether it grows units. The renderer reads colors from here; the simulation
// reads passability/farmable from here. One source of truth for both.

import * as THREE from 'three';
import type { MovementType } from '../../../game/types';
import type { GoldbergTile } from './goldbergWorld';
import { SeededNoise } from './seededNoise';

export type BiomeId =
  | 'ocean'
  | 'lake'
  | 'grassland'
  | 'forest'
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
  /** Grassland only: an occupying queen grows units here each cycle. */
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
  ocean: {
    id: 'ocean', label: 'Ocean', color: 0x0a1e3f,
    isWater: true, farmable: false, claimable: true,
    passableBy: WATER_AIR, elevationOffset: -0.02,
  },
  lake: {
    id: 'lake', label: 'Lake & River', color: 0x0d5c75,
    isWater: true, farmable: false, claimable: true,
    passableBy: WATER_AIR, elevationOffset: -0.01,
  },
  grassland: {
    id: 'grassland', label: 'Grassland', color: 0x4e9f3d,
    isWater: false, farmable: true, claimable: true,
    passableBy: LAND, elevationOffset: 0.01,
  },
  forest: {
    id: 'forest', label: 'Forest', color: 0x13543d,
    isWater: false, farmable: false, claimable: true,
    passableBy: LAND, elevationOffset: 0.02,
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

/** Tunable world-generation parameters; all derived deterministically from a seed. */
export interface WorldGenParams {
  /** Fraction of the planet below sea level (0..1). */
  oceanLevel: number;
  /** Overall moisture multiplier — higher means more forest, less desert. */
  moistureScale: number;
}

export const DEFAULT_WORLDGEN: WorldGenParams = {
  oceanLevel: 0.48,
  moistureScale: 1.0,
};

/** Per-tile classification result, cached on the tile for inspection + rules. */
export interface TileBiome {
  biome: BiomeId;
  elevation: number;
  moisture: number;
  temperature: number;
}

// Offsetting the moisture sample keeps it decorrelated from elevation so wet and
// high regions don't coincide; the value is arbitrary but fixed for determinism.
const MOISTURE_SAMPLE_OFFSET = 50.0;
const NOISE_FREQUENCY = 1.5;

/**
 * Classify one tile's biome from the seeded fields. Pure given (noise, params),
 * so the same seed + params reproduce the same planet.
 */
export function classifyTile(
  center: THREE.Vector3,
  noise: SeededNoise,
  params: WorldGenParams,
): TileBiome {
  const x = center.x * NOISE_FREQUENCY;
  const y = center.y * NOISE_FREQUENCY;
  const z = center.z * NOISE_FREQUENCY;

  const elevation = noise.fbm(x, y, z, 5);
  const moisture = noise.fbm(
    x + MOISTURE_SAMPLE_OFFSET,
    y + MOISTURE_SAMPLE_OFFSET,
    z + MOISTURE_SAMPLE_OFFSET,
    4,
  ) * params.moistureScale;
  // Temperature falls off toward the poles (|y| → 1).
  const temperature = 1.0 - Math.pow(Math.abs(center.y), 1.6);

  const biome = pickBiome(elevation, moisture, temperature, params);
  return { biome, elevation, moisture, temperature };
}

function pickBiome(
  elevation: number,
  moisture: number,
  temperature: number,
  params: WorldGenParams,
): BiomeId {
  if (elevation < params.oceanLevel) {
    // Deep water vs. coastal shallows / inland lakes.
    return elevation < params.oceanLevel - 0.1 ? 'ocean' : 'lake';
  }

  // Land. Cold poles freeze over regardless of moisture.
  if (temperature < 0.22) return 'snow';

  // High land becomes impassable mountains.
  const mountainThreshold = params.oceanLevel + (1.0 - params.oceanLevel) * 0.65;
  if (elevation > mountainThreshold) return 'mountain';

  // Remaining land splits on moisture.
  if (moisture < 0.38) return 'desert';
  if (moisture > 0.58) return 'forest';
  return 'grassland';
}

/**
 * Classify every tile in a world. Pentagons (the spawn nodes) are forced to a
 * habitable grassland so all 12 spawn points are always playable, claimable, and
 * able to grow an opening economy regardless of where the noise placed them.
 */
export function classifyWorld(
  tiles: GoldbergTile[],
  seed: number,
  params: WorldGenParams = DEFAULT_WORLDGEN,
): TileBiome[] {
  const noise = new SeededNoise(seed);
  return tiles.map((tile) => {
    if (tile.sides === 5) {
      return { biome: 'grassland', elevation: 0.6, moisture: 0.5, temperature: 0.7 };
    }
    return classifyTile(tile.center, noise, params);
  });
}
