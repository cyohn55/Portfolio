// Worker-offload Phase 1 (P1-2) — the serializable terrain oracle.
//
// The simulation's tick queries terrain constantly (canAnimalMoveTo, bridgeAt,
// getBridgeSurfaceY, nearestTraversable) and routes ground units with the A* `pathfinder`.
// On the main thread those answers come from the THREE-raycast-backed `terrainValidator`
// and the `pathfinder` grid it builds — neither of which can exist in a Web Worker (no
// scene, no raycaster). So before the sim moves into the worker we capture the terrain as
// PLAIN DATA on the main thread (`serializeTerrain`) and reinstall it worker-side
// (`installTerrainOracle`): a grid-backed object that answers the exact query surface the
// sim uses, with no THREE.
//
// Two grids travel together:
//   • the pathfinder's already-built cell grid (exportGrid) — reimported verbatim so the
//     worker's A* is byte-identical to the main thread's, no re-classification.
//   • an oracle grid sampled from `terrainValidator` at the pathfinder's cell geometry —
//     drives the sim's per-position terrain queries.
//
// The dynamic part (which side bridges are crossable) is NOT baked in: it is derived each
// tick from the sim's own `bridgeState` via updateBridgeState, exactly as the main thread
// re-derives it for `terrainValidator` (see HexGrid's updateBridgeVisibility).

import type { Position3D, AnimalId } from '../../../game/types';
import { ANIMAL_MOVEMENT_TYPES } from '../../../game/types';
import type { BridgeSide } from '../../../utils/TerrainValidator';
import { terrainValidator } from '../../../utils/TerrainValidator';
import type { TerrainQuery } from '../bridgeNavigator';
import { nearestWalkableCell } from '../terrainSlide';
import { pathfinder, type GridSnapshot } from '../pathfinder';
import { setActiveTerrain } from '../../../game/state';

// The terrain methods the simulation (`state.ts`) calls on `terrainValidator`. The real
// validator satisfies this structurally; the worker-side oracle implements it from the
// serialized grid. Kept minimal — exactly the sim's read surface — so the indirection seam
// in state.ts (`activeTerrain`) stays tight.
export interface SimTerrain {
  canAnimalMoveTo(animal: AnimalId, position: Position3D): boolean;
  bridgeAt(position: Position3D): { onBridge: boolean; side: BridgeSide | null };
  getBridgeSurfaceY(position: Position3D): number | null;
  nearestTraversable(animal: AnimalId, position: Position3D, maxRingRadius: number): Position3D | null;
}

// The bridge raise/lower frames the validator gates crossability on (right/left only; the
// center bridge is static and always crossable). Matches `terrainValidator`'s own shape so
// the worker host can map the sim's bridgeState onto the oracle identically to HexGrid.
export interface OracleBridgeFrames {
  right: 'Fully_Up' | 'Almost_Up' | 'Almost_Down' | 'Fully_Down';
  left: 'Fully_Up' | 'Almost_Up' | 'Almost_Down' | 'Fully_Down';
}

// Side packed into a byte so the snapshot stays a plain transferable. 0 = none.
const SIDE_NONE = 0;
const SIDE_RIGHT = 1;
const SIDE_LEFT = 2;
const SIDE_CENTER = 3;

// The grid cell size the validator memoizes ground-traversability at (TERRAIN_CELL_SIZE in
// TerrainValidator). nearestTraversable's rescue search steps in these units, so the oracle
// matches it to reproduce the same rescue targets.
const RESCUE_CELL_SIZE = 1;

function sideToByte(side: BridgeSide | null): number {
  if (side === 'right') return SIDE_RIGHT;
  if (side === 'left') return SIDE_LEFT;
  if (side === 'center') return SIDE_CENTER;
  return SIDE_NONE;
}

function byteToSide(byte: number): BridgeSide | null {
  if (byte === SIDE_RIGHT) return 'right';
  if (byte === SIDE_LEFT) return 'left';
  if (byte === SIDE_CENTER) return 'center';
  return null;
}

/**
 * The plain-data terrain the worker installs. `grid` is the pathfinder's exported A* grid
 * (reimported verbatim); the parallel `water`/`bridgeSide`/`deckSide` arrays — sampled at
 * the SAME cell geometry — answer the sim's per-position terrain queries. `deckSurfaceY`
 * holds the lowered walking height per side (already including the center deck's headroom,
 * since it is sampled through getBridgeSurfaceY). Every field is structured-cloneable.
 */
export interface TerrainSnapshot {
  grid: GridSnapshot;
  // Sampled at the grid cells (same minX/minZ/step/cols/rows as `grid`).
  water: Uint8Array; // 1 = position is over (non-deck) water
  bridgeSide: Uint8Array; // broad bridge membership (bridgeAt) as a side byte
  deckSide: Uint8Array; // walkable-deck membership (deckAt) as a side byte
  deckSurfaceY: { right: number | null; left: number | null; center: number | null };
}

/**
 * Capture the live terrain as a serializable snapshot. MAIN THREAD ONLY — reads the built
 * `pathfinder` and the initialized `terrainValidator`. Call once at match start, after both
 * are ready (HexGrid builds them on scene load), and ship the result to the worker.
 *
 * Deck walking heights come from terrainValidator.getDeckSurfaceYs (static once meshes are
 * found), so capture is independent of whether the bridges are raised or lowered right now;
 * the oracle re-gates crossability per tick on the sim's live bridgeState.
 */
export function serializeTerrain(): TerrainSnapshot {
  const grid = pathfinder.exportGrid();
  const { minX, minZ, step, cols, rows } = grid;
  const count = cols * rows;

  const water = new Uint8Array(count);
  const bridgeSide = new Uint8Array(count);
  const deckSide = new Uint8Array(count);

  for (let cx = 0; cx < cols; cx++) {
    for (let cz = 0; cz < rows; cz++) {
      const index = cx * rows + cz;
      const center: Position3D = { x: minX + cx * step, y: 0, z: minZ + cz * step };
      water[index] = terrainValidator.isPositionOverWater(center) ? 1 : 0;
      bridgeSide[index] = sideToByte(terrainValidator.bridgeAt(center).side);
      deckSide[index] = sideToByte(terrainValidator.deckAt(center).side);
    }
  }

  return {
    grid,
    water,
    bridgeSide,
    deckSide,
    deckSurfaceY: terrainValidator.getDeckSurfaceYs(),
  };
}

/**
 * Grid-backed terrain that answers the simulation's queries and the pathfinder's
 * `TerrainQuery` from a `TerrainSnapshot` — no THREE, fully deterministic. Crossability of
 * the raise/lower side bridges tracks the sim's live state via updateBridgeState, mirroring
 * how the main thread feeds `terrainValidator`.
 */
export class TerrainOracle implements SimTerrain, TerrainQuery {
  private readonly minX: number;
  private readonly minZ: number;
  private readonly step: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly water: Uint8Array;
  private readonly bridgeSide: Uint8Array;
  private readonly deckSide: Uint8Array;
  private readonly deckSurfaceY: { right: number | null; left: number | null; center: number | null };

  // Live side-bridge frames; both default fully lowered (match-start state), matching the
  // validator's default. Updated each tick from the sim's bridgeState.
  private bridgeFrames: OracleBridgeFrames = { right: 'Fully_Down', left: 'Fully_Down' };

  constructor(snapshot: TerrainSnapshot) {
    const { minX, minZ, step, cols, rows } = snapshot.grid;
    this.minX = minX;
    this.minZ = minZ;
    this.step = step;
    this.cols = cols;
    this.rows = rows;
    this.water = snapshot.water;
    this.bridgeSide = snapshot.bridgeSide;
    this.deckSide = snapshot.deckSide;
    this.deckSurfaceY = snapshot.deckSurfaceY;
  }

  // --- lifecycle (mirrors TerrainValidator) -----------------------------------------

  public isInitialized(): boolean {
    return true;
  }

  /** Set the live side-bridge frames. Only right/left raise/lower; center is static. */
  public updateBridgeState(frames: OracleBridgeFrames): void {
    this.bridgeFrames = frames;
  }

  // --- TerrainQuery (consumed by the pathfinder) ------------------------------------

  public isPositionOverWater(position: Position3D): boolean {
    return this.water[this.cellIndexAt(position)] === 1;
  }

  public bridgeAt(position: Position3D): { onBridge: boolean; side: BridgeSide | null } {
    const side = byteToSide(this.bridgeSide[this.cellIndexAt(position)]);
    return { onBridge: side !== null, side };
  }

  public deckAt(position: Position3D): { onDeck: boolean; side: BridgeSide | null } {
    const side = byteToSide(this.deckSide[this.cellIndexAt(position)]);
    return { onDeck: side !== null, side };
  }

  public isSideOpen(side: BridgeSide): boolean {
    return this.isBridgeTraversable(side);
  }

  // --- SimTerrain (consumed by state.ts) --------------------------------------------

  public canAnimalMoveTo(animal: AnimalId, position: Position3D): boolean {
    const movementType = ANIMAL_MOVEMENT_TYPES[animal];
    // Air flies over anything; water animals cross water and land — never blocked.
    if (movementType === 'air' || movementType === 'water') return true;
    return this.isGroundTraversable(position);
  }

  public getBridgeSurfaceY(position: Position3D): number | null {
    const side = byteToSide(this.deckSide[this.cellIndexAt(position)]);
    if (!side) return null;
    if (!this.isBridgeTraversable(side)) return null; // raised — no walking surface
    return this.deckSurfaceY[side];
  }

  public nearestTraversable(animal: AnimalId, position: Position3D, maxRingRadius: number): Position3D | null {
    // Air/water animals are never blocked, so never stranded.
    if (ANIMAL_MOVEMENT_TYPES[animal] !== 'ground') {
      return { x: position.x, y: position.y, z: position.z };
    }
    return nearestWalkableCell(
      position,
      (candidate) => this.isGroundTraversable(candidate),
      maxRingRadius,
      RESCUE_CELL_SIZE,
    );
  }

  // --- internals --------------------------------------------------------------------

  // Ground units are blocked by water unless on a currently-lowered bridge deck — the same
  // rule as TerrainValidator.isGroundTraversable, read from the grid.
  private isGroundTraversable(position: Position3D): boolean {
    const index = this.cellIndexAt(position);
    if (this.water[index] !== 1) return true; // on land
    const side = byteToSide(this.bridgeSide[index]);
    return side ? this.isBridgeTraversable(side) : false;
  }

  // The center bridge is static and always crossable; right/left must be fully lowered.
  private isBridgeTraversable(side: BridgeSide): boolean {
    if (side === 'center') return true;
    return this.bridgeFrames[side] === 'Fully_Down';
  }

  // Nearest grid cell, clamped to the grid edge — matches GridPathfinder.cellIndexAt so the
  // oracle and the A* grid agree on which cell a position falls in.
  private cellIndexAt(position: Position3D): number {
    let cx = Math.round((position.x - this.minX) / this.step);
    let cz = Math.round((position.z - this.minZ) / this.step);
    cx = Math.min(this.cols - 1, Math.max(0, cx));
    cz = Math.min(this.rows - 1, Math.max(0, cz));
    return cx * this.rows + cz;
  }
}

/**
 * Install a serialized terrain snapshot as the active terrain. WORKER SIDE — swaps the
 * sim's `activeTerrain` seam (state.ts) to the oracle and reimports the A* grid into the
 * shared `pathfinder` singleton (with the oracle as its TerrainQuery, so refresh() can
 * re-poll side openness). After this the worker's sim queries terrain with no THREE.
 * Returns the oracle so the host can feed it the live bridge state each tick.
 */
export function installTerrainOracle(snapshot: TerrainSnapshot): TerrainOracle {
  const oracle = new TerrainOracle(snapshot);
  setActiveTerrain(oracle);
  pathfinder.importGrid(snapshot.grid, oracle);
  return oracle;
}
