// Performance monitoring and FPS measurement tools
export class PerformanceMonitor {
  private fpsHistory: number[] = [];
  private frameTimes: number[] = [];
  private lastFrameTime = performance.now();
  private frameCount = 0;
  private optimizationResults = new Map<string, number>();

  updateFPS(): number {
    const now = performance.now();
    const deltaTime = now - this.lastFrameTime;
    this.lastFrameTime = now;

    // Calculate current FPS
    const currentFPS = 1000 / deltaTime;
    this.fpsHistory.push(currentFPS);
    this.frameTimes.push(deltaTime);

    // Keep only last 60 frames for rolling average
    if (this.fpsHistory.length > 60) {
      this.fpsHistory.shift();
      this.frameTimes.shift();
    }

    this.frameCount++;
    return currentFPS;
  }

  getAverageFPS(): number {
    if (this.fpsHistory.length === 0) return 0;
    return this.fpsHistory.reduce((sum, fps) => sum + fps, 0) / this.fpsHistory.length;
  }

  getMinFPS(): number {
    return this.fpsHistory.length > 0 ? Math.min(...this.fpsHistory) : 0;
  }

  getMaxFPS(): number {
    return this.fpsHistory.length > 0 ? Math.max(...this.fpsHistory) : 0;
  }

  // Measure optimization impact
  startOptimizationTest(name: string): void {
    this.optimizationResults.set(`${name}_before`, this.getAverageFPS());
  }

  endOptimizationTest(name: string): number {
    const beforeFPS = this.optimizationResults.get(`${name}_before`) || 0;
    const afterFPS = this.getAverageFPS();
    const improvement = afterFPS - beforeFPS;
    this.optimizationResults.set(`${name}_improvement`, improvement);
    return improvement;
  }

  getOptimizationResults(): Record<string, number> {
    const results: Record<string, number> = {};
    this.optimizationResults.forEach((value, key) => {
      results[key] = value;
    });
    return results;
  }

  // Performance profiling
  measureGameLoopTiming() {
    return {
      averageFrameTime: this.frameTimes.reduce((sum, time) => sum + time, 0) / this.frameTimes.length,
      targetFrameTime: 1000 / 60, // 60 FPS target
      efficiency: (1000 / 60) / (this.frameTimes.reduce((sum, time) => sum + time, 0) / this.frameTimes.length)
    };
  }

  // System performance breakdown
  profileFrame(gameLogicTime: number, renderTime: number): void {
    const totalTime = gameLogicTime + renderTime;
    console.log(`Frame Breakdown:
      Game Logic: ${gameLogicTime.toFixed(2)}ms (${((gameLogicTime/totalTime)*100).toFixed(1)}%)
      Rendering: ${renderTime.toFixed(2)}ms (${((renderTime/totalTime)*100).toFixed(1)}%)
      Total: ${totalTime.toFixed(2)}ms
      Theoretical Max FPS: ${(1000/totalTime).toFixed(1)}
    `);
  }

  reset(): void {
    this.fpsHistory = [];
    this.frameTimes = [];
    this.frameCount = 0;
    this.optimizationResults.clear();
  }
}

// Global performance monitor instance
export const performanceMonitor = new PerformanceMonitor();