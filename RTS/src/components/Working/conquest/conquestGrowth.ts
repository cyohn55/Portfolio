// Conquest Increment 5/6 — Queen unit growth + occupation tile claiming (pure rules).
//
// Single responsibility: the side-effect-free arithmetic behind a nation's growth and
// its hold on the planet. Three rules live here, split across two kinds of territory:
//
//   1. Claiming  — a unit standing on any *claimable* tile (every biome except the
//      impassable mountains) flips that tile to its controller. This is full
//      territory control: forest, desert, snow, and water count toward the map a
//      nation holds, not just the grassland it farms (Increment 6 widened this from
//      the grassland-only claiming Increment 5 shipped).
//   2. Growth    — a controller's population CAP is two units per *farmable* tile it
//      owns (grassland only), so the planet's total farmland is the absolute ceiling.
//      A Queen only grows another unit while her controller is under that cap, making
//      expansion onto grassland the engine of army growth — non-farmable territory
//      widens the map a nation holds but never lifts its population ceiling.
//   3. Dominance — a controller's share of the claimable planet, surfaced to the HUD
//      as territory pressure (and the foundation a domination victory could read).
//
// Keeping this module pure (no THREE, no store, no React) lets the field sim and the
// HUD share one definition of "how big can this nation get / how much does it hold?"
// and lets the unit tests assert the rules directly. The geometric placement of a
// spawned unit stays in the field, which owns the sphere math.

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

/**
 * A tile a nation can take and hold by occupation: every biome except the impassable
 * mountains. Water counts (only water/air animals can stand on it, but holding the
 * seas is still territory). This is the broad territory rule; farmland (above) is the
 * narrower slice that also feeds growth.
 */
export function isClaimableTile(tileBiome: TileBiome | undefined): boolean {
  if (!tileBiome) return false;
  return BIOMES[tileBiome.biome].claimable;
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

/**
 * Count every claimable tile a controller currently holds — its full territory, not
 * just its farmland. `tileOwners` only ever records claimed (claimable) tiles, but we
 * re-check the biome so a future ownership source with stray entries can't inflate the
 * count.
 */
export function countOwnedTiles(
  tileOwners: Record<number, string>,
  biomes: TileBiome[],
  controllerId: string,
): number {
  let owned = 0;
  for (const [tileIdKey, ownerId] of Object.entries(tileOwners)) {
    if (ownerId !== controllerId) continue;
    if (isClaimableTile(biomes[Number(tileIdKey)])) owned += 1;
  }
  return owned;
}

/** Total claimable tiles on the planet — the denominator for any territory share. */
export function countClaimableTiles(biomes: TileBiome[]): number {
  let claimable = 0;
  for (const tileBiome of biomes) if (isClaimableTile(tileBiome)) claimable += 1;
  return claimable;
}

/**
 * A controller's share of the claimable planet, as a whole-number percent (0..100).
 * Returns 0 when there is no claimable land at all, so the HUD never divides by zero.
 */
export function territoryPercent(ownedTiles: number, claimableTiles: number): number {
  if (claimableTiles <= 0) return 0;
  return Math.round((ownedTiles / claimableTiles) * 100);
}
