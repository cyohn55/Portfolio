import type { Position3D } from '../../game/types';
import type { BridgeSide } from '../../utils/TerrainValidator';

/**
 * Region + portal navigation for ground units.
 *
 * Ground units move in a straight line toward their target and simply stop when the
 * next step would enter water (see checkCollision in state.ts). The battle map is a
 * set of landmasses separated by a water moat and joined only by narrow bridges, so a
 * unit whose beeline does not happen to line up with a bridge piles up at the shore
 * and never crosses. This navigator gives ground units just enough routing to funnel
 * onto the correct bridge:
 *
 *   1. Rasterize the play area into a coarse grid, classifying each cell as land,
 *      water, or bridge deck (done once at load — land/water geometry is static).
 *   2. Flood-fill the land cells into connected regions.
 *   3. Each run of bridge-deck cells that touches two land regions is a portal
 *      between them. The center bridge is always open; the raise/lower side bridges
 *      are open only while lowered, so the open portal set is refreshed when the
 *      bridge state changes.
 *   4. Precompute, for every ordered pair of regions, the first portal to head for.
 *      Steering a unit then costs an O(1) grid lookup plus a table lookup per tick.
 *
 * The result is a steering waypoint (not a full path): aim the unit at the entrance
 * of the next bridge on its own side until it steps onto the deck, then at the far
 * entrance to cross. Crossing one bridge lands it in the next region, where the same
 * logic picks the following bridge — so multi-hop routes (region -> island -> region)
 * emerge without storing per-unit path state.
 */

// Cell classification on the navigation grid.
const CELL_WATER = 0; // over water, no bridge deck -> impassable for ground
const CELL_LAND = 1; // not over water -> walkable
const CELL_BRIDGE = 2; // over water but on a bridge deck -> walkable when the bridge is open

// regionAt sentinels (distinct from real land-region ids, which are >= 0).
const REGION_OUTSIDE = -1; // outside the rasterized grid, or on water
const REGION_BRIDGE = -2; // standing on a bridge deck (between regions)

// Region-pair distance for "no route over the currently open bridges".
const UNREACHABLE = 1 << 29;

/**
 * The slice of terrain queries the navigator depends on. Keeping this narrow lets the
 * navigator be tested against a synthetic terrain without a THREE scene, and keeps it
 * decoupled from TerrainValidator's internals. `deckAt` restricts the bridge detection
 * to the walkable deck primitive (so rails/walls/posts don't count as walkable cells);
 * `bridgeAt` is kept available for callers that need broad bridge-volume detection.
 */
export interface TerrainQuery {
  isPositionOverWater(position: Position3D): boolean;
  bridgeAt(position: Position3D): { onBridge: boolean; side: BridgeSide | null };
  deckAt(position: Position3D): { onDeck: boolean; side: BridgeSide | null };
  isSideOpen(side: BridgeSide): boolean;
}

export interface NavBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

// A bridge crossing between two land regions, formed by one contiguous run of bridge
// cells. mouthA/mouthB are the deck points where the run meets regionA/regionB; a unit
// heads for the mouth on its own side to get onto the deck, then the far mouth to cross.
interface Portal {
  regionA: number;
  regionB: number;
  side: BridgeSide;
  mouthA: Position3D;
  mouthB: Position3D;
}

export class BridgeNavigator {
  private ready = false;
  private terrain: TerrainQuery | null = null;

  // Grid geometry.
  private minX = 0;
  private minZ = 0;
  private step = 2;
  private cols = 0;
  private rows = 0;

  private cellType: Int8Array = new Int8Array(0);
  private cellRegion: Int32Array = new Int32Array(0); // land region id per cell, or -1
  private cellRun: Int32Array = new Int32Array(0); // bridge run id per cell, or -1
  private regionCount = 0;

  private portals: Portal[] = [];
  // Maps a bridge run id to the portal it produced (runs that bridge two regions).
  private runToPortal = new Map<number, number>();

  // Routing tables, rebuilt whenever the open portal set changes. hopDist holds the
  // bridge-count distance between every region pair over currently open portals
  // (UNREACHABLE when no route exists); regionPortals lists each region's incident
  // open portals so a unit can pick the nearest one that makes progress.
  private hopDist: Int32Array = new Int32Array(0);
  private regionPortals: number[][] = [];
  // Last computed open/closed state per portal, so refreshPortals can no-op when the
  // bridge state has not actually changed (it is polled every frame).
  private lastOpen: boolean[] = [];

  public isReady(): boolean {
    return this.ready;
  }

  /**
   * Build the navigation grid and portal graph from the terrain. Call once after the
   * terrain validator is initialized.
   */
  public build(terrain: TerrainQuery, bounds: NavBounds, step = 2): void {
    this.terrain = terrain;
    this.step = step;
    this.minX = bounds.minX;
    this.minZ = bounds.minZ;
    this.cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / step) + 1);
    this.rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / step) + 1);

    this.classifyCells();
    this.fillLandRegions();
    this.buildPortals();
    // Compute routing once unconditionally (refreshPortals's no-op guard must not skip
    // the initial build, e.g. when there are zero portals).
    this.lastOpen = this.portals.map((p) => this.terrain!.isSideOpen(p.side));
    this.computeRouting(this.lastOpen);
    this.ready = true;
  }

  /**
   * Recompute the open portal set and the next-hop table. Cheap (a handful of regions
   * and portals); call whenever a raise/lower bridge changes state.
   */
  public refreshPortals(): void {
    if (!this.terrain) return;
    const open = this.portals.map((p) => this.terrain!.isSideOpen(p.side));
    if (open.length === this.lastOpen.length && open.every((v, i) => v === this.lastOpen[i])) {
      return; // no change since last refresh -> nothing to recompute
    }
    this.lastOpen = open;
    this.computeRouting(open);
  }

  /**
   * The steering waypoint a ground unit should move toward to reach `to`. Returns `to`
   * unchanged when the unit is already in the destination's region (plain beeline) or
   * when routing does not apply, so callers can use it unconditionally for ground units.
   */
  public nextWaypoint(from: Position3D, to: Position3D): Position3D {
    if (!this.ready) return to;

    const rawFromRegion = this.regionAt(from);

    // On a bridge deck: track along it and off the far end toward `to` (see method).
    if (rawFromRegion === REGION_BRIDGE) {
      const wp = this.exitBridgeToward(from, to);
      return wp ?? to;
    }

    // Outside the grid: resolve the unit to the landmass nearest it (units and their
    // targets spawn far beyond the moat, so the grid only covers the crossing area —
    // a position past its edge belongs to whichever region the edge sits on).
    const fromRegion = rawFromRegion === REGION_OUTSIDE ? this.resolveLandRegion(from) : rawFromRegion;
    if (fromRegion < 0) return to;

    return this.routeFromRegion(from, fromRegion, to);
  }

  /**
   * Steering waypoint for a unit standing in land region `fromRegion`. Heads for the
   * nearest incident open portal that strictly reduces the bridge-hop distance to the
   * destination's region; returns `to` (plain beeline) when already in that region or
   * no open route exists. `from` is used only to pick the nearest qualifying portal, so
   * this also serves bridge-exit routing where `from` is the deck mouth being left.
   */
  private routeFromRegion(from: Position3D, fromRegion: number, to: Position3D): Position3D {
    const toRegion = this.resolveLandRegion(to);
    if (toRegion < 0 || toRegion === fromRegion) return to; // same region or unknown -> beeline

    const distFromTarget = this.hopDist[fromRegion * this.regionCount + toRegion];
    if (distFromTarget >= UNREACHABLE) return to; // no open route -> beeline

    // Among our region's open portals, head for the nearest one that gets us strictly
    // closer (in bridge hops) to the destination region. We track both that portal's
    // near mouth (this side) and far mouth (the next region's side).
    let bestNearMouth: Position3D | null = null;
    let bestFarMouth: Position3D | null = null;
    let bestSq = Infinity;
    for (const portalIndex of this.regionPortals[fromRegion]) {
      const portal = this.portals[portalIndex];
      const fromIsA = portal.regionA === fromRegion;
      const otherRegion = fromIsA ? portal.regionB : portal.regionA;
      if (this.hopDist[otherRegion * this.regionCount + toRegion] >= distFromTarget) continue;
      const nearMouth = fromIsA ? portal.mouthA : portal.mouthB;
      const sq = this.sqDist(from, nearMouth);
      if (sq < bestSq) {
        bestSq = sq;
        bestNearMouth = nearMouth;
        bestFarMouth = fromIsA ? portal.mouthB : portal.mouthA;
      }
    }
    if (!bestNearMouth) return to;

    // Aim a short way past the near mouth toward the far mouth — i.e. onto the deck —
    // rather than at the deck-edge mouth itself. A mouth is the centroid of the deck
    // cells touching this region and can sit right at (or just shy of) the deck edge; a
    // unit told to stop there parks at the water's edge because arriving zeroes its
    // steering. Aiming onto the deck makes it step on, after which exitBridgeToward
    // takes over. Decks here are long, so a couple of cells along the axis stays on deck.
    return this.pointToward(bestNearMouth, bestFarMouth!, this.step * 2);
  }

  // A point `distance` from `origin` along the direction toward `target`.
  private pointToward(origin: Position3D, target: Position3D, distance: number): Position3D {
    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    const length = Math.hypot(dx, dz) || 1;
    return { x: origin.x + (dx / length) * distance, y: 0, z: origin.z + (dz / length) * distance };
  }

  /** Land region id at a position, or REGION_BRIDGE / REGION_OUTSIDE. */
  public regionAt(position: Position3D): number {
    const index = this.cellIndexAt(position);
    if (index < 0) return REGION_OUTSIDE;
    const type = this.cellType[index];
    if (type === CELL_BRIDGE) return REGION_BRIDGE;
    if (type === CELL_LAND) return this.cellRegion[index];
    return REGION_OUTSIDE; // water
  }

  // ---- build helpers -------------------------------------------------------

  private classifyCells(): void {
    const terrain = this.terrain!;
    this.cellType = new Int8Array(this.cols * this.rows);
    for (let cx = 0; cx < this.cols; cx++) {
      for (let cz = 0; cz < this.rows; cz++) {
        const position = this.cellCenter(cx, cz);
        if (!terrain.isPositionOverWater(position)) {
          this.cellType[cx * this.rows + cz] = CELL_LAND;
        } else {
          // Restrict bridge cells to the walkable deck primitive, so a rail-cell
          // over water (broader bridge volume but not the surface) is treated as
          // water — preventing a route from corner-cutting onto the deck through
          // the railing.
          const deck = terrain.deckAt(position);
          this.cellType[cx * this.rows + cz] = deck.onDeck ? CELL_BRIDGE : CELL_WATER;
        }
      }
    }
  }

  private fillLandRegions(): void {
    this.cellRegion = new Int32Array(this.cols * this.rows).fill(-1);
    this.regionCount = 0;
    const stack: number[] = [];
    for (let start = 0; start < this.cellType.length; start++) {
      if (this.cellType[start] !== CELL_LAND || this.cellRegion[start] !== -1) continue;
      const regionId = this.regionCount++;
      this.cellRegion[start] = regionId;
      stack.push(start);
      while (stack.length) {
        const cell = stack.pop()!;
        for (const neighbor of this.neighbors4(cell)) {
          if (this.cellType[neighbor] === CELL_LAND && this.cellRegion[neighbor] === -1) {
            this.cellRegion[neighbor] = regionId;
            stack.push(neighbor);
          }
        }
      }
    }
  }

  private buildPortals(): void {
    this.cellRun = new Int32Array(this.cols * this.rows).fill(-1);
    this.portals = [];
    this.runToPortal.clear();
    let runCount = 0;
    const stack: number[] = [];

    for (let start = 0; start < this.cellType.length; start++) {
      if (this.cellType[start] !== CELL_BRIDGE || this.cellRun[start] !== -1) continue;
      const runId = runCount++;
      const runCells: number[] = [];
      this.cellRun[start] = runId;
      stack.push(start);
      while (stack.length) {
        const cell = stack.pop()!;
        runCells.push(cell);
        for (const neighbor of this.neighbors8(cell)) {
          if (this.cellType[neighbor] === CELL_BRIDGE && this.cellRun[neighbor] === -1) {
            this.cellRun[neighbor] = runId;
            stack.push(neighbor);
          }
        }
      }
      this.maybeAddPortal(runId, runCells);
    }
  }

  // Turn a bridge run into a portal if its deck touches exactly the land needed to
  // bridge two regions. Records the mouth (mean deck point) on each region's side.
  private maybeAddPortal(runId: number, runCells: number[]): void {
    // Accumulate, per touching land region, the sum of deck-cell positions adjacent
    // to that region (its mouth) and the count.
    const mouthSum = new Map<number, { x: number; z: number; n: number }>();
    let side: BridgeSide | null = null;

    for (const cell of runCells) {
      if (side === null) {
        const sampled = this.terrain!.deckAt(this.cellCenterOf(cell)).side;
        if (sampled) side = sampled;
      }
      for (const neighbor of this.neighbors8(cell)) {
        if (this.cellType[neighbor] !== CELL_LAND) continue;
        const region = this.cellRegion[neighbor];
        const center = this.cellCenterOf(cell);
        const acc = mouthSum.get(region) ?? { x: 0, z: 0, n: 0 };
        acc.x += center.x;
        acc.z += center.z;
        acc.n += 1;
        mouthSum.set(region, acc);
      }
    }

    if (side === null || mouthSum.size < 2) return; // dead-end deck or undetectable side

    // Use the two regions with the most adjacency as the portal's endpoints (a clean
    // crossing touches exactly two; this is robust if a stray third region grazes it).
    const ranked = [...mouthSum.entries()].sort((a, b) => b[1].n - a[1].n);
    const [regionA, accA] = ranked[0];
    const [regionB, accB] = ranked[1];
    const portalIndex = this.portals.length;
    this.portals.push({
      regionA,
      regionB,
      side,
      mouthA: { x: accA.x / accA.n, y: 0, z: accA.z / accA.n },
      mouthB: { x: accB.x / accB.n, y: 0, z: accB.z / accB.n },
    });
    this.runToPortal.set(runId, portalIndex);
  }

  // ---- routing helpers -----------------------------------------------------

  // All-pairs region hop distances via BFS over the currently open portals, plus each
  // region's list of incident open portals. Region count is tiny, so this is cheap and
  // runs only on bridge-state changes.
  private computeRouting(open: boolean[]): void {
    const n = this.regionCount;
    this.hopDist = new Int32Array(n * n).fill(UNREACHABLE);
    this.regionPortals = Array.from({ length: n }, () => []);

    const adjacency: Array<Array<{ to: number; portal: number }>> = Array.from(
      { length: n },
      () => [],
    );
    this.portals.forEach((portal, index) => {
      if (!open[index]) return;
      adjacency[portal.regionA].push({ to: portal.regionB, portal: index });
      adjacency[portal.regionB].push({ to: portal.regionA, portal: index });
      this.regionPortals[portal.regionA].push(index);
      this.regionPortals[portal.regionB].push(index);
    });

    for (let source = 0; source < n; source++) {
      this.hopDist[source * n + source] = 0;
      const queue: number[] = [source];
      let head = 0;
      while (head < queue.length) {
        const region = queue[head++];
        const here = this.hopDist[source * n + region];
        for (const edge of adjacency[region]) {
          if (this.hopDist[source * n + edge.to] <= here + 1) continue;
          this.hopDist[source * n + edge.to] = here + 1;
          queue.push(edge.to);
        }
      }
    }
  }

  // Distance from a span's far mouth within which a unit is treated as having reached
  // the deck end and should aim onward (past the deck) instead of at the mouth.
  private static readonly EXIT_REACH = 6;

  // While on a bridge deck, steer the unit along the deck to its far end and then off
  // onto the land beyond. The far mouth (the deck end on the side that makes progress
  // toward `to`) sits near the deck centerline, so steering at it keeps the unit tracking
  // down the middle of a narrow deck instead of drifting onto an edge and stalling in the
  // water beside it — which an oblique approach or a distant onward target would cause.
  // Once near that far mouth we aim *past* it (never at it: arriving zeroes steering and
  // would park the unit on the deck): onward to the next span's mouth for a multi-span
  // route, or a few cells onto the destination region's land for the final span.
  private exitBridgeToward(from: Position3D, to: Position3D): Position3D | null {
    const index = this.cellIndexAt(from);
    if (index < 0) return null;
    const runId = this.cellRun[index];
    const portalIndex = this.runToPortal.get(runId);
    if (portalIndex === undefined) return null;
    const portal = this.portals[portalIndex];

    const toRegion = this.resolveLandRegion(to);
    // Pick the portal endpoint whose region is closer to the destination region; if the
    // destination is unknown, fall back to the geometrically farther mouth's region so
    // the unit at least keeps leaving the deck the way it came on.
    const distA = this.regionDistance(portal.regionA, toRegion);
    const distB = this.regionDistance(portal.regionB, toRegion);
    const exitIsA =
      distA !== distB
        ? distA < distB
        : this.sqDist(from, portal.mouthA) > this.sqDist(from, portal.mouthB);
    const exitRegion = exitIsA ? portal.regionA : portal.regionB;
    const exitMouth = exitIsA ? portal.mouthA : portal.mouthB;

    // Mid-deck: track toward the far mouth (deck centerline at the far end).
    const reach = BridgeNavigator.EXIT_REACH;
    if (this.sqDist(from, exitMouth) > reach * reach) {
      return exitMouth;
    }

    // At the deck end. More spans to cross: route on from the far region to the next
    // span's mouth (which sits over land at the deck end, keeping the approach endwise).
    if (exitRegion !== toRegion) {
      return this.routeFromRegion(exitMouth, exitRegion, to);
    }

    // Final span — the far side is the destination region. Aim a few cells past the deck
    // edge, straight along the span axis onto the land, rather than straight at `to`: a
    // narrow deck means beelining toward an off-axis destination would step the unit
    // sideways into the water. Leaving endwise clears the deck first, after which the
    // in-region beeline (next tick, once on land) turns toward `to`.
    const entryMouth = exitIsA ? portal.mouthB : portal.mouthA;
    const beyondExit = { x: 2 * exitMouth.x - entryMouth.x, y: 0, z: 2 * exitMouth.z - entryMouth.z };
    return this.pointToward(exitMouth, beyondExit, this.step * 4); // past the seam, onto solid land
  }

  // Hop count between regions using the precomputed table (0 same, UNREACHABLE if no
  // route exists over the currently open bridges).
  private regionDistance(a: number, b: number): number {
    if (a < 0 || b < 0) return UNREACHABLE;
    return this.hopDist[a * this.regionCount + b];
  }

  // Land region for an arbitrary point. On land -> its own region. On a deck -> the
  // nearest land region of that bridge run (so targets standing on a deck still route).
  // Outside the grid -> the region at the nearest grid cell, since the landmasses
  // extend past the moat-focused grid and a far point belongs to the landmass on that
  // side. Water just inside the grid edge -> nearest land region by short outward scan.
  private resolveLandRegion(position: Position3D): number {
    const region = this.regionAt(position);
    if (region >= 0) return region;
    if (region === REGION_BRIDGE) {
      const index = this.cellIndexAt(position);
      const portalIndex = index >= 0 ? this.runToPortal.get(this.cellRun[index]) : undefined;
      if (portalIndex !== undefined) return this.portals[portalIndex].regionA;
      return -1;
    }
    // Outside the grid: read the land region at the nearest in-bounds cell (computed
    // without allocating — this is on the per-unit, per-tick path).
    const cx = Math.min(this.cols - 1, Math.max(0, Math.round((position.x - this.minX) / this.step)));
    const cz = Math.min(this.rows - 1, Math.max(0, Math.round((position.z - this.minZ) / this.step)));
    const index = cx * this.rows + cz;
    return this.cellType[index] === CELL_LAND ? this.cellRegion[index] : -1;
  }

  // ---- grid math -----------------------------------------------------------

  private cellCenter(cx: number, cz: number): Position3D {
    return { x: this.minX + cx * this.step, y: 0, z: this.minZ + cz * this.step };
  }

  private cellCenterOf(cellIndex: number): Position3D {
    return this.cellCenter(Math.floor(cellIndex / this.rows), cellIndex % this.rows);
  }

  private cellIndexAt(position: Position3D): number {
    const cx = Math.round((position.x - this.minX) / this.step);
    const cz = Math.round((position.z - this.minZ) / this.step);
    if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) return -1;
    return cx * this.rows + cz;
  }

  private neighbors4(cellIndex: number): number[] {
    const cx = Math.floor(cellIndex / this.rows);
    const cz = cellIndex % this.rows;
    const out: number[] = [];
    if (cx > 0) out.push((cx - 1) * this.rows + cz);
    if (cx < this.cols - 1) out.push((cx + 1) * this.rows + cz);
    if (cz > 0) out.push(cx * this.rows + (cz - 1));
    if (cz < this.rows - 1) out.push(cx * this.rows + (cz + 1));
    return out;
  }

  private neighbors8(cellIndex: number): number[] {
    const cx = Math.floor(cellIndex / this.rows);
    const cz = cellIndex % this.rows;
    const out: number[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= this.cols || nz >= this.rows) continue;
        out.push(nx * this.rows + nz);
      }
    }
    return out;
  }

  private sqDist(a: Position3D, b: Position3D): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return dx * dx + dz * dz;
  }
}

// Singleton used by the game movement code; built once in HexGrid after terrain init.
export const bridgeNavigator = new BridgeNavigator();
