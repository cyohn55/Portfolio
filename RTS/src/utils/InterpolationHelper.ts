import type { Position3D } from '../game/types';

// Smooth movement interpolation for visual rendering
// Allows 60+ FPS rendering while game logic runs at 30 FPS

export class InterpolationHelper {
  private previousPositions = new Map<string, Position3D>();
  private currentPositions = new Map<string, Position3D>();
  private lastUpdateTime = 0;

  updatePositions(unitPositions: Record<string, Position3D>): void {
    // Store previous positions for interpolation
    this.previousPositions = new Map(this.currentPositions);

    // Update current positions
    this.currentPositions.clear();
    Object.entries(unitPositions).forEach(([id, pos]) => {
      this.currentPositions.set(id, { ...pos });
    });

    this.lastUpdateTime = performance.now();
  }

  getInterpolatedPosition(unitId: string, alpha: number): Position3D | null {
    const current = this.currentPositions.get(unitId);
    const previous = this.previousPositions.get(unitId);

    if (!current) return null;
    if (!previous) return current;

    // Linear interpolation between previous and current position
    return {
      x: previous.x + (current.x - previous.x) * alpha,
      y: previous.y + (current.y - previous.y) * alpha,
      z: previous.z + (current.z - previous.z) * alpha
    };
  }

  // Calculate interpolation alpha based on time since last logic update
  getInterpolationAlpha(gameLogicTimestep: number): number {
    const timeSinceUpdate = performance.now() - this.lastUpdateTime;
    return Math.min(timeSinceUpdate / gameLogicTimestep, 1.0);
  }
}

// Global interpolation helper
export const interpolationHelper = new InterpolationHelper();