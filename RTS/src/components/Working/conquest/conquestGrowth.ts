// Conquest Increment 5/6 — Queen unit growth + occupation tile claiming (pure rules).
//
// Single responsibility: the side-effect-free arithmetic behind a nation's growth and
// its hold on the planet. Three rules live here, split across two kinds of territory:
//
//   1. Claiming  — a single controller captures any *claimable* tile (every biome
//      except the impassable mountains) by occupying it continuously for 15 seconds
//      with no enemy on the same tile, then holds it only while it keeps a unit there
//      (stepTileClaims). This is full territory control: forest, desert, snow, and
//      water count toward the map a nation holds, not just the grassland it farms.
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
 * How often the occupation-claim pass runs, in milliseconds. Claiming accrues over
 * time (see CLAIM_CAPTURE_DURATION_MS), so the scan must run steadily rather than only
 * on tile-crossings; throttling the O(units) scan to a few times a second keeps it off
 * the hot path while still measuring occupation closely enough for a 15s timer.
 */
export const CLAIM_SCAN_INTERVAL_MS = 300;

/**
 * How long a single controller must occupy an unowned tile — continuously, with no
 * enemy controller standing on it — before the tile is captured. After capture the
 * tile is held only while that controller keeps at least one unit on it (see
 * {@link stepTileClaims}); walking away releases it. This is the core territory rule.
 */
export const CLAIM_CAPTURE_DURATION_MS = 15000;

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

/** Capture progress carried between scans for one tile being taken (controller + elapsed ms). */
export interface TileClaimProgress {
  controllerId: string;
  elapsedMs: number;
}

/** Inputs to one occupation-claim step. The caller supplies sphere-derived occupancy. */
export interface TileClaimInput {
  /**
   * For each claimable tile that has at least one eligible (alive, not downed/carried)
   * unit on it, the set of *controller* ids occupying it. A tile absent from the map is
   * unoccupied; a set of size one is uncontested; size two or more is contested.
   */
  occupantsByTile: Map<number, Set<string>>;
  /** The currently committed owners (tileId → controllerId). */
  tileOwners: Record<number, string>;
  /** Capture progress carried forward from the previous scan (tileId → progress). */
  progress: Map<number, TileClaimProgress>;
  /** Wall-clock milliseconds elapsed since the previous scan. */
  deltaMs: number;
  /** Continuous occupation needed to capture an unowned tile (defaults to 15s). */
  captureDurationMs?: number;
}

/** The owner changes to commit and the capture progress to carry into the next scan. */
export interface TileClaimOutcome {
  /** Tiles whose owner changed: a controllerId to claim, or null to release. */
  ownerChanges: Map<number, string | null>;
  /** Capture progress to carry into the next scan (tiles mid-capture only). */
  progress: Map<number, TileClaimProgress>;
}

/**
 * Resolve one occupation-claim step (pure). Two rules, faithful to the design:
 *
 *   1. Capture — an unowned tile is taken by a single uncontested controller only after
 *      it has occupied the tile continuously for {@link CLAIM_CAPTURE_DURATION_MS} with
 *      no enemy controller present. Any contest (a second controller arrives) or vacancy
 *      resets the timer, and a different sole occupant restarts it from zero.
 *   2. Hold — a captured tile stays owned only while its owner keeps at least one unit on
 *      it. The moment the owner has no unit there, the claim lapses back to unowned; the
 *      next sole occupant must earn it afresh. Presence is what holds territory.
 *
 * An owner standing on its own tile holds it even when an enemy shares the tile
 * (defender's presence wins the contest), and no capture timer advances while a tile is
 * held. Keeping this pure lets the field feed in occupancy and apply the resulting owner
 * changes, while the unit tests assert the timer and hold rules directly.
 */
export function stepTileClaims(input: TileClaimInput): TileClaimOutcome {
  const { occupantsByTile, tileOwners, progress, deltaMs } = input;
  const captureDurationMs = input.captureDurationMs ?? CLAIM_CAPTURE_DURATION_MS;
  const ownerChanges = new Map<number, string | null>();
  const nextProgress = new Map<number, TileClaimProgress>();

  // Evaluate every tile that could change state: those currently owned (may lapse),
  // those occupied this scan (may capture/hold), and those mid-capture (carry the timer).
  const tilesToCheck = new Set<number>();
  for (const tileIdKey of Object.keys(tileOwners)) tilesToCheck.add(Number(tileIdKey));
  for (const tileId of occupantsByTile.keys()) tilesToCheck.add(tileId);
  for (const tileId of progress.keys()) tilesToCheck.add(tileId);

  for (const tileId of tilesToCheck) {
    const occupants = occupantsByTile.get(tileId);
    const owner = tileOwners[tileId];
    const soleOccupant = occupants && occupants.size === 1 ? [...occupants][0] : null;

    // Rule 2 (hold): an owned tile is retained only while its owner stands on it.
    if (owner) {
      if (occupants && occupants.has(owner)) continue; // held — no capture timer runs
      ownerChanges.set(tileId, null);                  // owner left → release the tile
      // fall through: a sole enemy on the freed tile may now begin a fresh capture
    }

    // Rule 1 (capture): a sole uncontested occupant accrues the continuous-occupation
    // timer; contest or vacancy keeps no progress, and a new claimant restarts it.
    if (!soleOccupant) continue;

    const carried = progress.get(tileId);
    const elapsedMs =
      carried && carried.controllerId === soleOccupant ? carried.elapsedMs + deltaMs : deltaMs;

    if (elapsedMs >= captureDurationMs) {
      ownerChanges.set(tileId, soleOccupant); // captured — timer satisfied
    } else {
      nextProgress.set(tileId, { controllerId: soleOccupant, elapsedMs });
    }
  }

  return { ownerChanges, progress: nextProgress };
}
