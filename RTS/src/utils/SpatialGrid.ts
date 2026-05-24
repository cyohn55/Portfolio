import type { Unit, Position3D } from '../game/types';

export class SpatialGrid {
  private gridSize: number;
  private cellSize: number;
  private grid: Map<string, Unit[]>;

  constructor(worldSize: number = 1000, cellSize: number = 50) {
    this.gridSize = Math.ceil(worldSize / cellSize);
    this.cellSize = cellSize;
    this.grid = new Map();
  }

  // Convert world position to grid coordinates
  private getGridCoords(position: Position3D): { x: number, z: number } {
    return {
      x: Math.floor((position.x + this.gridSize * this.cellSize / 2) / this.cellSize),
      z: Math.floor((position.z + this.gridSize * this.cellSize / 2) / this.cellSize)
    };
  }

  // Convert grid coordinates to key
  private getKey(gridX: number, gridZ: number): string {
    return `${gridX},${gridZ}`;
  }

  // Empty every cell while keeping the cell arrays (and Map keys) allocated.
  // The grid is rebuilt every tick; units occupy a bounded, stable set of cells,
  // so reusing the arrays avoids reallocating one array per occupied cell each
  // tick — a major source of GC churn (and frame-time spikes) at high unit counts.
  clear(): void {
    for (const cellUnits of this.grid.values()) {
      cellUnits.length = 0;
    }
  }

  // Add unit to grid
  addUnit(unit: Unit): void {
    const coords = this.getGridCoords(unit.position);
    const key = this.getKey(coords.x, coords.z);

    if (!this.grid.has(key)) {
      this.grid.set(key, []);
    }
    this.grid.get(key)!.push(unit);
  }

  // Build grid from units array
  buildFromUnits(units: Unit[]): void {
    this.clear();
    units.forEach(unit => this.addUnit(unit));
  }

  // Get nearby units within radius. This is the single distance gate — callers
  // refine by ownership/kind without recomputing distance.
  getNearbyUnits(position: Position3D, radius: number): Unit[] {
    const nearbyUnits: Unit[] = [];
    const coords = this.getGridCoords(position);
    const radiusSquared = radius * radius;

    // Calculate how many cells to check based on radius
    const cellRadius = Math.ceil(radius / this.cellSize);

    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      for (let dz = -cellRadius; dz <= cellRadius; dz++) {
        const key = this.getKey(coords.x + dx, coords.z + dz);
        const cellUnits = this.grid.get(key);
        if (!cellUnits) continue;

        // Filter by actual (squared) distance — avoids Math.sqrt per unit.
        for (const unit of cellUnits) {
          if (this.distanceSquared3D(position, unit.position) <= radiusSquared) {
            nearbyUnits.push(unit);
          }
        }
      }
    }

    return nearbyUnits;
  }

  // Find closest enemy within radius
  findClosestEnemy(unit: Unit, radius: number = 50): Unit | null {
    const nearbyUnits = this.getNearbyUnits(unit.position, radius);

    let closestEnemy: Unit | null = null;
    let closestDistanceSquared = Infinity;

    for (const otherUnit of nearbyUnits) {
      // Skip same unit and allies
      if (otherUnit.id === unit.id || otherUnit.ownerId === unit.ownerId) {
        continue;
      }

      const distanceSquared = this.distanceSquared3D(unit.position, otherUnit.position);
      if (distanceSquared < closestDistanceSquared) {
        closestDistanceSquared = distanceSquared;
        closestEnemy = otherUnit;
      }
    }

    return closestEnemy;
  }

  // Find all enemies within attack range (already distance-gated by getNearbyUnits)
  findEnemiesInRange(unit: Unit, range: number): Unit[] {
    const nearbyUnits = this.getNearbyUnits(unit.position, range);

    return nearbyUnits.filter(otherUnit =>
      otherUnit.id !== unit.id && otherUnit.ownerId !== unit.ownerId
    );
  }

  // Find nearby queens for regeneration (already distance-gated by getNearbyUnits)
  findNearbyQueens(unit: Unit, radius: number): Unit[] {
    const nearbyUnits = this.getNearbyUnits(unit.position, radius);

    return nearbyUnits.filter(otherUnit =>
      otherUnit.kind === 'Queen' && otherUnit.ownerId === unit.ownerId
    );
  }

  // Helper method for squared 3D distance (no Math.sqrt)
  private distanceSquared3D(a: Position3D, b: Position3D): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
  }

  // Debug: Get grid statistics
  getStats(): { totalCells: number, occupiedCells: number, totalUnits: number } {
    let totalUnits = 0;
    this.grid.forEach(units => totalUnits += units.length);

    return {
      totalCells: this.gridSize * this.gridSize,
      occupiedCells: this.grid.size,
      totalUnits
    };
  }
}
