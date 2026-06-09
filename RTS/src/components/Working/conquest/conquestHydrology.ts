// River & lake derivation for Conquest worldgen via downhill flow accumulation.
//
// Single responsibility: given each tile's elevation and the Goldberg neighbor
// graph, decide which land tiles carry enough draining water to read as rivers
// (or fill local basins as lakes). This is the one worldgen pass that genuinely
// needs the adjacency graph: water only makes sense as a *path* across tiles, not
// a per-tile noise sample.
//
// The method is the standard terrain-analysis pipeline:
//   1. Point every land tile at its lowest neighbor (its downhill direction).
//   2. Accumulate one unit of rainfall per tile downstream in descending-
//      elevation order, so flow strictly grows toward the sea.
//   3. Tiles whose accumulated flow clears a threshold become water; basins with
//      no downhill outlet (local minima that gathered inflow) become lakes.
//
// Deterministic and pure: no RNG, no DOM — it reads numbers and the graph and
// returns a set of tile ids, so it runs unchanged in the Node test harness.

import type { GoldbergTile } from './goldbergWorld';

/** A tile flagged by the hydrology pass, tagged by how it gathered water. */
export type HydroKind = 'river' | 'lake';

export interface HydrologyResult {
  /** tileId → why it is water (river channel vs. filled basin). */
  waterTiles: Map<number, HydroKind>;
}

export interface HydrologyParams {
  /**
   * Upstream-area scale a channel must gather to surface as a river. The actual
   * threshold grows with the SQUARE ROOT of land-tile count, so rivers stay
   * present at every map size instead of vanishing as a linear fraction would on
   * fine grids (where flow disperses across far more tiles).
   */
  riverFlowScale: number;
  /** Minimum upstream count an outlet-less basin needs before it fills as a lake. */
  lakeMinInflow: number;
}

export const DEFAULT_HYDROLOGY: HydrologyParams = {
  riverFlowScale: 0.4,
  lakeMinInflow: 3,
};

/**
 * Derive river and lake tiles from elevation and adjacency. `elevations[id]` is
 * the tile's elevation in the same [0,1] band the biome classifier uses; only
 * tiles at or above `oceanLevel` (land) participate — the sea is already water.
 */
export function computeHydrology(
  tiles: GoldbergTile[],
  elevations: number[],
  oceanLevel: number,
  params: HydrologyParams = DEFAULT_HYDROLOGY,
): HydrologyResult {
  const tileCount = tiles.length;
  const downhill = new Int32Array(tileCount).fill(-1);
  const isLand = new Array<boolean>(tileCount).fill(false);

  let landCount = 0;
  for (const tile of tiles) {
    if (elevations[tile.id] < oceanLevel) continue;
    isLand[tile.id] = true;
    landCount++;

    // Point at the lowest neighbor strictly below this tile; -1 marks a basin
    // (a local minimum with nowhere downhill to drain).
    let lowestNeighbor = -1;
    let lowestElevation = elevations[tile.id];
    for (const neighborId of tile.neighbors) {
      if (elevations[neighborId] < lowestElevation) {
        lowestElevation = elevations[neighborId];
        lowestNeighbor = neighborId;
      }
    }
    downhill[tile.id] = lowestNeighbor;
  }

  // Accumulate rainfall downstream. Processing land high-to-low guarantees a
  // tile's own inflow is final before it hands flow to its (lower) outlet, so a
  // single linear pass yields exact accumulation with no iteration.
  const landTiles = tiles.filter((tile) => isLand[tile.id]);
  const byElevationDescending = [...landTiles].sort(
    (first, second) => elevations[second.id] - elevations[first.id],
  );

  const flow = new Float64Array(tileCount).fill(1);
  for (const tile of byElevationDescending) {
    const outlet = downhill[tile.id];
    if (outlet >= 0) flow[outlet] += flow[tile.id];
  }

  const riverThreshold = Math.max(
    params.lakeMinInflow,
    params.riverFlowScale * Math.sqrt(landCount),
  );

  const waterTiles = new Map<number, HydroKind>();
  for (const tile of landTiles) {
    const id = tile.id;
    const hasOutlet = downhill[id] >= 0;
    if (hasOutlet) {
      // A draining channel: surface it once it carries enough upstream area.
      if (flow[id] >= riverThreshold) waterTiles.set(id, 'river');
    } else if (flow[id] >= params.lakeMinInflow) {
      // An outlet-less basin that still gathered inflow pools into a lake.
      waterTiles.set(id, 'lake');
    }
  }

  return { waterTiles };
}
