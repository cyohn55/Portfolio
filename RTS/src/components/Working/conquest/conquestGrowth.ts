// Conquest Increment 5 — Queen unit growth + farmable-tile claiming (pure rules).
//
// Single responsibility: the side-effect-free arithmetic behind a Queen growing
// her nation. Two intertwined rules live here, both keyed off *farmable territory*:
//
//   1. Claiming — a unit standing on a farmable, claimable tile (grassland) flips
//      that tile to its controller. This is the farmable slice of territory control
//      (the broader tile-claiming of a later increment); only grassland is grown on.
//   2. Growth   — a controller's population CAP is two units per farmable tile it
//      owns (so the planet's total farmland is the absolute ceiling). A Queen only
//      grows another unit while her controller is under that cap, making expansion
//      onto grassland the engine of army growth.
//
// Keeping this module pure (no THREE, no store, no React) lets the field sim and the
// HUD share one definition of "how big can this nation get?" and lets the unit tests
// assert the rules directly. The geometric placement of a spawned unit stays in the
// field, which owns the sphere math.

import { BIOMES, type TileBiome } from './conquestBiomes';

/** Each owned farmable tile lifts a controller's population ceiling by this many units. */
export const POPULATION_PER_FARM_TILE = 2;

/**
 * How often a Queen grows a unit, in milliseconds. Mirrors Quick Play's ~10s queen
 * spawn cadence (state.ts) so Conquest growth feels familiar, slightly quicker to
 * reward holding farmland.
 */
export const QUEEN_GROWTH_INTERVAL_MS = 9000;

/**
 * How often the occupation-claim pass runs, in milliseconds. Claiming only matters
 * when a unit crosses onto a new farmable tile (rare relative to the frame rate), so
 * throttling the O(units) scan keeps it off the hot path without feeling laggy.
 */
export const CLAIM_SCAN_INTERVAL_MS = 300;

/**
 * A tile both worth growing on AND ownable: grassland is the only farmable biome,
 * and farmable biomes are claimable, but we check both so the rule survives any
 * future biome whose flags diverge.
 */
export function isFarmableTile(tileBiome: TileBiome | undefined): boolean {
  if (!tileBiome) return false;
  const definition = BIOMES[tileBiome.biome];
  return definition.farmable && definition.claimable;
}

/** Count the farmable tiles a given controller currently owns. */
export function countOwnedFarmTiles(
  tileOwners: Record<number, string>,
  biomes: TileBiome[],
  controllerId: string,
): number {
  let owned = 0;
  for (const [tileIdKey, ownerId] of Object.entries(tileOwners)) {
    if (ownerId !== controllerId) continue;
    if (isFarmableTile(biomes[Number(tileIdKey)])) owned += 1;
  }
  return owned;
}

/**
 * A controller's population ceiling: two units per owned farmable tile. With no
 * farmland a controller cannot grow at all (cap 0), so losing all grassland stalls
 * an army's reinforcements — the pressure the conquest loop is built around.
 */
export function populationCap(ownedFarmTiles: number): number {
  return ownedFarmTiles * POPULATION_PER_FARM_TILE;
}

/**
 * The planet-wide population ceiling: two units per farmable tile in existence. The
 * HUD shows this as the theoretical maximum a single nation could ever field.
 */
export function planetPopulationCeiling(biomes: TileBiome[]): number {
  let farmable = 0;
  for (const tileBiome of biomes) if (isFarmableTile(tileBiome)) farmable += 1;
  return farmable * POPULATION_PER_FARM_TILE;
}

/**
 * Whether a controller may grow one more unit: strictly under its territory-derived
 * cap. A controller exactly at (or over) its cap holds station until it claims more
 * farmland — or, having lost farmland, until attrition brings it back under.
 */
export function canGrowUnit(controlledUnitCount: number, cap: number): boolean {
  return controlledUnitCount < cap;
}
