import type { Position3D } from '../../game/types';
import type { BridgeSide } from '../../utils/TerrainValidator';
import type { TerrainQuery } from './bridgeNavigator';
import { bridgeNavigator } from './bridgeNavigator';

/**
 * Grid A* pathfinding for ground units.
 *
 * Ground units are blocked by the water moat and may only cross it on the bridges, so a
 * straight-line "beeline and stop at water" mover piles up at the shore or stalls partway
 * across. This pathfinder replaces that heuristic with a real route:
 *
 *   1. Rasterize the whole playable map into a grid, classifying each cell as land, open
 *      water, or bridge deck (with which side, since the side bridges raise and lower).
 *   2. Run A* over the walkable cells to produce a cell path from a unit to its target.
 *   3. String-pull the path against line-of-sight so open ground collapses to a straight
 *      line and only genuine corners (bridge mouths, headlands) remain as waypoints.
 *
 * The result is a list of waypoints a unit follows in order. Because every waypoint and
 * every segment between consecutive waypoints lies over walkable terrain, a unit that
 * follows them reaches its destination whenever a route exists — it cannot beeline into
 * the water. Paths are cached on the unit and recomputed only when the destination moves
 * far enough, the path is exhausted, or a bridge opens/closes; a per-tick compute budget
 * smooths the cost of many units receiving cross-map orders at once.
 *
 * The navigator is decoupled from THREE: it consumes only the TerrainQuery interface, so
 * it can be unit-tested against synthetic terrain.
 */

// Cell classification.
const CELL_WATER = 0; // impassable for ground
const CELL_LAND = 1; // always walkable
const CELL_DECK = 2; // bridge deck — walkable only while that bridge is open

// Bridge side packed into a byte for deck cells (center is always open).
const SIDE_CENTER = 0;
const SIDE_RIGHT = 1;
const SIDE_LEFT = 2;

const SQRT2 = Math.SQRT2;

// Safety bound on a single A* search so an unreachable goal can't scan forever and hitch
// a frame; a reachable goal on this map settles in far fewer expansions.
const MAX_EXPANSIONS = 60_000;

// Extra cost (in cell-steps) for stepping onto a deck cell that sits at the water's edge.
// High enough to keep routes off the rails of a wide deck, low enough that a narrow deck
// (all edge cells) is still crossed rather than treated as impassable.
const EDGE_DECK_PENALTY = 2.5;

// How many A* searches may run in one tick. Units that need a path but miss the budget
// follow a stale path or a coarse fallback this tick and get a real path within a few.
// Kept low so a whole group ordered across the map at once spreads its routing cost over
// several ticks rather than hitching one frame.
const MAX_PATHS_PER_TICK = 4;

// Consecutive ticks of no progress toward the current waypoint before a unit re-paths
// from where it actually is. Units get shoved off their route by the crowd at chokepoints
// and can end up beelining a stale waypoint straight into water; re-routing from the
// displaced position frees them. (Game ticks at 60 Hz, so this is well under a second.)
const STALL_LIMIT = 45;

/**
 * The per-unit state the pathfinder reads and writes. `Unit` satisfies this structurally,
 * so the pathfinder never depends on the full game type.
 */
export interface PathAgent {
  position: Position3D;
  pathWaypoints?: Position3D[];
  pathIndex?: number;
  pathDestX?: number;
  pathDestZ?: number;
  pathVersion?: number;
  pathStall?: number; // consecutive non-progress ticks toward the current waypoint
  pathProgressDist?: number; // best (smallest) distance to the current waypoint so far
  pathStuckTicks?: number; // consecutive ticks the unit barely moved (survives re-paths)
  pathLastX?: number;
  pathLastZ?: number;
}

export interface PathBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export class GridPathfinder {
  private ready = false;
  private terrain: TerrainQuery | null = null;

  // Grid geometry.
  private minX = 0;
  private minZ = 0;
  private step = 3;
  private cols = 0;
  private rows = 0;

  private cellType: Int8Array = new Int8Array(0);
  private cellSide: Int8Array = new Int8Array(0);
  // Deck cells touching the water's edge. A* pays a surcharge to use these so routes run
  // down the middle of a deck rather than hugging the shortest-side rail — which would
  // funnel a whole group onto one edge and jam there. See EDGE_DECK_PENALTY.
  private cellDeckEdge: Uint8Array = new Uint8Array(0);

  // Live side-bridge openness, refreshed when the bridge state changes. `version` bumps
  // on any change so cached unit paths computed under the old openness are recomputed.
  private rightOpen = false;
  private leftOpen = false;
  private version = 1;

  // A* working memory, sized to the grid. gScore is validated by a per-search stamp so a
  // new search needs no O(cells) clear; `closedStamp` marks settled (optimal) cells.
  private gScore: Float32Array = new Float32Array(0);
  private gStamp: Int32Array = new Int32Array(0);
  private closedStamp: Int32Array = new Int32Array(0);
  private cameFrom: Int32Array = new Int32Array(0);
  private searchId = 0;

  // Binary min-heap of cell indices keyed by parallel priorities.
  private heapCell: Int32Array = new Int32Array(0);
  private heapKey: Float32Array = new Float32Array(0);
  private heapSize = 0;

  // Per-tick compute budget.
  private budget = MAX_PATHS_PER_TICK;
  private lastTickId = -1;

  public isReady(): boolean {
    return this.ready;
  }

  /** Build the grid from the terrain. Call once after the terrain validator is ready. */
  public build(terrain: TerrainQuery, bounds: PathBounds, step = 3): void {
    this.terrain = terrain;
    this.step = step;
    this.minX = bounds.minX;
    this.minZ = bounds.minZ;
    this.cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / step) + 1);
    this.rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / step) + 1);

    const count = this.cols * this.rows;
    this.cellType = new Int8Array(count);
    this.cellSide = new Int8Array(count);
    this.cellDeckEdge = new Uint8Array(count);
    this.classifyCells();
    this.markDeckEdges();

    this.gScore = new Float32Array(count);
    this.gStamp = new Int32Array(count); // 0 = "no search has touched this cell"
    this.closedStamp = new Int32Array(count);
    this.cameFrom = new Int32Array(count);
    this.heapCell = new Int32Array(count + 1);
    this.heapKey = new Float32Array(count + 1);

    this.rightOpen = terrain.isSideOpen('right');
    this.leftOpen = terrain.isSideOpen('left');
    this.ready = true;
  }

  /** Re-poll side-bridge openness; bump the version (invalidating cached paths) on change. */
  public refresh(): void {
    if (!this.terrain) return;
    const right = this.terrain.isSideOpen('right');
    const left = this.terrain.isSideOpen('left');
    if (right !== this.rightOpen || left !== this.leftOpen) {
      this.rightOpen = right;
      this.leftOpen = left;
      this.version++;
    }
  }

  /** Reset the per-tick path-compute budget. Call once at the start of each game tick. */
  public beginTick(tickId: number): void {
    if (tickId !== this.lastTickId) {
      this.lastTickId = tickId;
      this.budget = MAX_PATHS_PER_TICK;
    }
  }

  /**
   * The point a ground unit should steer toward to reach `dest`. Returns `dest` directly
   * when the straight line to it is walkable (open ground — the common case), otherwise
   * the next waypoint of a cached A* route around the water. Mutates the agent's path
   * cache. Falls back gracefully (stale path, then bridge funnel, then `dest`) when a
   * fresh path can't be computed this tick.
   */
  public nextWaypoint(agent: PathAgent, dest: Position3D): Position3D {
    if (!this.ready) return dest;

    // Track real movement between ticks so a unit that is wedged (not just off-route but
    // physically unable to move) can be detected and let through the crowd by the mover.
    // Unlike pathStall this is not reset by re-pathing — only by actually moving.
    if (agent.pathLastX !== undefined) {
      const moved = Math.hypot(agent.position.x - agent.pathLastX, agent.position.z - (agent.pathLastZ ?? 0));
      agent.pathStuckTicks = moved < 0.05 ? (agent.pathStuckTicks ?? 0) + 1 : 0;
    }
    agent.pathLastX = agent.position.x;
    agent.pathLastZ = agent.position.z;

    // Fast path: a clear straight shot needs no route. Drop any cached path so the unit
    // doesn't keep chasing stale waypoints once the way is open.
    if (this.lineOfSight(agent.position, dest)) {
      agent.pathWaypoints = undefined;
      return dest;
    }

    // Follow an existing path unless it is stale or the unit has stalled against it (shoved
    // off route into a dead end). A stalled path falls through to a recompute below.
    if (this.hasUsablePath(agent, dest) && (agent.pathStall ?? 0) < STALL_LIMIT) {
      return this.followPath(agent);
    }

    if (this.budget <= 0) {
      // Out of compute this tick: keep following a stale path if we have one, else funnel
      // toward the nearest bridge so the unit still advances toward the crossing.
      if (agent.pathWaypoints && agent.pathWaypoints.length > 0) return this.followPath(agent);
      return this.fallback(agent.position, dest);
    }

    this.budget--;
    const waypoints = this.computeWaypoints(agent.position, dest);
    if (!waypoints) {
      agent.pathWaypoints = undefined;
      return this.fallback(agent.position, dest);
    }
    agent.pathWaypoints = waypoints;
    agent.pathIndex = 0;
    agent.pathDestX = dest.x;
    agent.pathDestZ = dest.z;
    agent.pathVersion = this.version;
    agent.pathStall = 0;
    agent.pathProgressDist = Infinity;
    return this.followPath(agent);
  }

  // ---- path cache / following -------------------------------------------------

  // A cached path is reusable if it was built for the current bridge openness and its
  // goal is still close to the requested destination (so a slowly-moving combat target
  // doesn't force a recompute every tick — only once it drifts more than a few cells).
  private hasUsablePath(agent: PathAgent, dest: Position3D): boolean {
    if (!agent.pathWaypoints || agent.pathWaypoints.length === 0) return false;
    if (agent.pathVersion !== this.version) return false;
    const tolerance = this.step * 4;
    return (
      Math.abs((agent.pathDestX ?? Infinity) - dest.x) <= tolerance &&
      Math.abs((agent.pathDestZ ?? Infinity) - dest.z) <= tolerance
    );
  }

  private followPath(agent: PathAgent): Position3D {
    const waypoints = agent.pathWaypoints!;
    const startIndex = agent.pathIndex ?? 0;
    let index = startIndex;
    const arriveRadius = this.step;
    // Advance one waypoint at a time, and only to a waypoint the unit has actually reached
    // or moved closer to than the current one. Crucially we never skip a waypoint just
    // because a later one is in sight: the kept waypoints mark the deck cells and the
    // corners where a straight line would leave walkable ground, so cutting to a far
    // waypoint (e.g. an off-axis destination while still on the deck) drives the unit into
    // the water. The "closer to the next" test lets a fast unit that overshot still move on
    // without needing a large arrive radius.
    while (index < waypoints.length - 1) {
      const here = this.distanceXZ(agent.position, waypoints[index]);
      const closerToNext = this.distanceXZ(agent.position, waypoints[index + 1]) <= here;
      if (here > arriveRadius && !closerToNext) break;
      index++;
    }
    agent.pathIndex = index;

    // Track progress toward the active waypoint so a unit wedged against terrain (pushed
    // off its route by the crowd) is detected and re-pathed by nextWaypoint. Advancing to
    // a new waypoint resets the baseline.
    const distance = this.distanceXZ(agent.position, waypoints[index]);
    if (index !== startIndex || agent.pathProgressDist === undefined) {
      agent.pathProgressDist = distance;
      agent.pathStall = 0;
    } else if (distance + 0.05 < agent.pathProgressDist) {
      agent.pathProgressDist = distance;
      agent.pathStall = 0;
    } else {
      agent.pathStall = (agent.pathStall ?? 0) + 1;
    }
    return waypoints[index];
  }

  private fallback(from: Position3D, dest: Position3D): Position3D {
    if (bridgeNavigator.isReady()) return bridgeNavigator.nextWaypoint(from, dest);
    return dest;
  }

  // ---- path computation -------------------------------------------------------

  private computeWaypoints(start: Position3D, dest: Position3D): Position3D[] | null {
    const startCell = this.nearestPassable(this.cellIndexAt(start));
    const goalCell = this.nearestPassable(this.cellIndexAt(dest));
    if (startCell < 0 || goalCell < 0) return null;
    if (startCell === goalCell) return [dest];

    const cells = this.findPath(startCell, goalCell);
    if (!cells) return null;
    return this.smooth(cells, start, dest);
  }

  // A* over the 8-connected grid. Returns the cell path from start to goal, or null.
  private findPath(start: number, goal: number): number[] | null {
    const sid = ++this.searchId;
    this.heapSize = 0;

    this.setG(start, sid, 0);
    this.cameFrom[start] = -1;
    this.heapPush(start, this.heuristic(start, goal));

    let expansions = 0;
    while (this.heapSize > 0) {
      const current = this.heapPop();
      if (current === goal) return this.reconstruct(start, goal);
      if (this.closedStamp[current] === sid) continue; // stale heap duplicate
      this.closedStamp[current] = sid;
      if (++expansions > MAX_EXPANSIONS) return null;

      const g = this.gScore[current];
      const cx = Math.floor(current / this.rows);
      const cz = current % this.rows;

      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dz === 0) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= this.cols || nz >= this.rows) continue;
          const neighbor = nx * this.rows + nz;
          if (!this.passable(neighbor)) continue;

          const diagonal = dx !== 0 && dz !== 0;
          if (diagonal) {
            // No cutting a corner through water: both shared orthogonal cells must be open.
            if (!this.passable(cx * this.rows + nz) || !this.passable(nx * this.rows + cz)) {
              continue;
            }
          }
          if (this.closedStamp[neighbor] === sid) continue;

          let tentative = g + (diagonal ? SQRT2 : 1);
          if (this.cellDeckEdge[neighbor]) tentative += EDGE_DECK_PENALTY;
          if (this.gStamp[neighbor] === sid && tentative >= this.gScore[neighbor]) continue;
          this.setG(neighbor, sid, tentative);
          this.cameFrom[neighbor] = current;
          this.heapPush(neighbor, tentative + this.heuristic(neighbor, goal));
        }
      }
    }
    return null;
  }

  private reconstruct(start: number, goal: number): number[] {
    const cells: number[] = [];
    let cell = goal;
    while (cell !== -1) {
      cells.push(cell);
      if (cell === start) break;
      cell = this.cameFrom[cell];
    }
    cells.reverse();
    return cells;
  }

  // Greedy string-pull: keep only the cells where the straight line bends, so open ground
  // becomes one straight leg. Anchored at the unit's true position; ends at the exact
  // destination so the final approach is precise rather than to a cell center.
  private smooth(cells: number[], start: Position3D, dest: Position3D): Position3D[] {
    const points: Position3D[] = cells.map((c) => this.cellCenter(c));
    points[points.length - 1] = dest;

    const waypoints: Position3D[] = [];
    let anchor = start;
    let i = 0;
    while (i < points.length) {
      let farthest = i;
      for (let k = i; k < points.length; k++) {
        if (this.lineOfSight(anchor, points[k])) farthest = k;
        else break;
      }
      waypoints.push(points[farthest]);
      anchor = points[farthest];
      i = farthest + 1;
    }
    return waypoints;
  }

  // ---- terrain / grid queries -------------------------------------------------

  private classifyCells(): void {
    // Classify each cell conservatively from five probes: its centre and the midpoints
    // toward its four orthogonal neighbours. A cell counts as open water if ANY probe is
    // over (non-deck) water. Because neighbouring cells' probes meet at the shared edge,
    // two cells that both come out walkable are guaranteed to have walkable ground all the
    // way between them — so A* can never connect two cells across a thin water sliver that
    // the per-step collision check would block (which would deadlock a unit). This erodes
    // walkable strips by about half a cell, which the bridges (several cells wide) tolerate.
    const half = this.step / 2;
    for (let cx = 0; cx < this.cols; cx++) {
      for (let cz = 0; cz < this.rows; cz++) {
        const index = cx * this.rows + cz;
        const c = this.cellCenter(index);
        const probes = [
          c,
          { x: c.x - half, y: 0, z: c.z },
          { x: c.x + half, y: 0, z: c.z },
          { x: c.x, y: 0, z: c.z - half },
          { x: c.x, y: 0, z: c.z + half },
        ];
        let anyWater = false;
        let deckSide: BridgeSide | null = null;
        for (const p of probes) {
          if (!this.terrain!.isPositionOverWater(p)) continue; // land probe
          const bridge = this.terrain!.bridgeAt(p);
          if (bridge.onBridge && bridge.side) {
            deckSide = deckSide ?? bridge.side; // over a deck — walkable when that side is open
          } else {
            anyWater = true; // open water touches this cell
            break;
          }
        }
        if (anyWater) {
          this.cellType[index] = CELL_WATER;
        } else if (deckSide) {
          this.cellType[index] = CELL_DECK;
          this.cellSide[index] = this.sideToByte(deckSide);
        } else {
          this.cellType[index] = CELL_LAND;
        }
      }
    }
  }

  // A deck cell is an "edge" cell if any orthogonal neighbour is open water or off-grid,
  // i.e. a unit standing there is one step from the drink. Used to bias routes to the
  // deck interior so groups don't all crowd the same rail.
  private markDeckEdges(): void {
    for (let index = 0; index < this.cellType.length; index++) {
      if (this.cellType[index] !== CELL_DECK) continue;
      const cx = Math.floor(index / this.rows);
      const cz = index % this.rows;
      const offGridOrWater = (nx: number, nz: number): boolean => {
        if (nx < 0 || nz < 0 || nx >= this.cols || nz >= this.rows) return true;
        return this.cellType[nx * this.rows + nz] === CELL_WATER;
      };
      if (
        offGridOrWater(cx - 1, cz) ||
        offGridOrWater(cx + 1, cz) ||
        offGridOrWater(cx, cz - 1) ||
        offGridOrWater(cx, cz + 1)
      ) {
        this.cellDeckEdge[index] = 1;
      }
    }
  }

  private passable(index: number): boolean {
    const type = this.cellType[index];
    if (type === CELL_LAND) return true;
    if (type !== CELL_DECK) return false;
    const side = this.cellSide[index];
    if (side === SIDE_CENTER) return true;
    if (side === SIDE_RIGHT) return this.rightOpen;
    return this.leftOpen;
  }

  // Whether the straight segment a->b stays over open *land*, sampled finely enough (half
  // a cell) that a thin water gap between cells is not stepped over. Bridge decks count as
  // blocking here even though they are walkable: a deck is only a few cells wide, so a
  // straight line may clip its cell centers yet still run off the side into the water.
  // Treating decks as opaque keeps the open-ground fast path and the string-pull from
  // short-cutting across a crossing, so units instead follow the A* deck cells one by one
  // (tracking the centerline) and don't drift off the edge. Used as the open-ground fast
  // path and to smooth A* output.
  private lineOfSight(a: Position3D, b: Position3D): boolean {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const distance = Math.hypot(dx, dz);
    const samples = Math.max(1, Math.ceil((distance * 2) / this.step));
    for (let s = 0; s <= samples; s++) {
      const t = s / samples;
      const index = this.cellIndexAt({ x: a.x + dx * t, y: 0, z: a.z + dz * t });
      if (this.cellType[index] !== CELL_LAND) return false;
    }
    return true;
  }

  // Nearest passable cell to `index` by outward ring search, for snapping a start or goal
  // that lands on water (e.g. a target at the very shoreline). -1 if none is near.
  private nearestPassable(index: number): number {
    if (index < 0) return -1;
    if (this.passable(index)) return index;
    const cx = Math.floor(index / this.rows);
    const cz = index % this.rows;
    const maxRadius = 24;
    for (let radius = 1; radius <= maxRadius; radius++) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue; // ring perimeter only
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= this.cols || nz >= this.rows) continue;
          const candidate = nx * this.rows + nz;
          if (this.passable(candidate)) return candidate;
        }
      }
    }
    return -1;
  }

  private cellIndexAt(position: Position3D): number {
    let cx = Math.round((position.x - this.minX) / this.step);
    let cz = Math.round((position.z - this.minZ) / this.step);
    cx = Math.min(this.cols - 1, Math.max(0, cx));
    cz = Math.min(this.rows - 1, Math.max(0, cz));
    return cx * this.rows + cz;
  }

  private cellCenter(index: number): Position3D {
    const cx = Math.floor(index / this.rows);
    const cz = index % this.rows;
    return { x: this.minX + cx * this.step, y: 0, z: this.minZ + cz * this.step };
  }

  private heuristic(cell: number, goal: number): number {
    const dx = Math.abs(Math.floor(cell / this.rows) - Math.floor(goal / this.rows));
    const dz = Math.abs((cell % this.rows) - (goal % this.rows));
    // Octile distance: straight + diagonal moves, in cell units.
    return dx + dz + (SQRT2 - 2) * Math.min(dx, dz);
  }

  private sideToByte(side: BridgeSide): number {
    if (side === 'right') return SIDE_RIGHT;
    if (side === 'left') return SIDE_LEFT;
    return SIDE_CENTER;
  }

  private distanceXZ(a: Position3D, b: Position3D): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
  }

  private setG(index: number, sid: number, value: number): void {
    this.gStamp[index] = sid;
    this.gScore[index] = value;
  }

  // ---- binary min-heap (1-indexed) -------------------------------------------

  private heapPush(cell: number, key: number): void {
    let i = ++this.heapSize;
    this.heapCell[i] = cell;
    this.heapKey[i] = key;
    while (i > 1) {
      const parent = i >> 1;
      if (this.heapKey[parent] <= this.heapKey[i]) break;
      this.heapSwap(parent, i);
      i = parent;
    }
  }

  private heapPop(): number {
    const top = this.heapCell[1];
    const lastKey = this.heapKey[this.heapSize];
    const lastCell = this.heapCell[this.heapSize];
    this.heapSize--;
    if (this.heapSize > 0) {
      this.heapCell[1] = lastCell;
      this.heapKey[1] = lastKey;
      let i = 1;
      for (;;) {
        const left = i << 1;
        const right = left + 1;
        let smallest = i;
        if (left <= this.heapSize && this.heapKey[left] < this.heapKey[smallest]) smallest = left;
        if (right <= this.heapSize && this.heapKey[right] < this.heapKey[smallest]) smallest = right;
        if (smallest === i) break;
        this.heapSwap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private heapSwap(a: number, b: number): void {
    const cell = this.heapCell[a];
    this.heapCell[a] = this.heapCell[b];
    this.heapCell[b] = cell;
    const key = this.heapKey[a];
    this.heapKey[a] = this.heapKey[b];
    this.heapKey[b] = key;
  }
}

// Singleton used by the game movement code; built once in HexGrid after terrain init.
export const pathfinder = new GridPathfinder();
