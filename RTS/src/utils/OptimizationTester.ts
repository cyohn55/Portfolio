import { performanceMonitor } from './PerformanceMonitor';

// Systematic optimization testing framework
export class OptimizationTester {
  private baselineFPS = 0;
  private testResults: Array<{name: string, improvement: number, enabled: boolean}> = [];

  async measureBaseline(): Promise<number> {
    // Wait for stable FPS measurement
    await this.waitForStableFPS(3000); // 3 seconds
    this.baselineFPS = performanceMonitor.getAverageFPS();
    console.log(`🎯 Baseline FPS established: ${this.baselineFPS.toFixed(1)}`);
    return this.baselineFPS;
  }

  async testOptimization(
    name: string,
    enableFn: () => void,
    disableFn: () => void
  ): Promise<number> {
    console.log(`🧪 Testing optimization: ${name}`);

    // Measure with optimization disabled
    disableFn();
    await this.waitForStableFPS(2000);
    const disabledFPS = performanceMonitor.getAverageFPS();

    // Measure with optimization enabled
    enableFn();
    await this.waitForStableFPS(2000);
    const enabledFPS = performanceMonitor.getAverageFPS();

    const improvement = enabledFPS - disabledFPS;
    this.testResults.push({ name, improvement, enabled: true });

    console.log(`📊 ${name}: ${disabledFPS.toFixed(1)} → ${enabledFPS.toFixed(1)} FPS (+${improvement.toFixed(1)})`);
    return improvement;
  }

  private async waitForStableFPS(duration: number): Promise<void> {
    performanceMonitor.reset();
    return new Promise(resolve => {
      setTimeout(resolve, duration);
    });
  }

  generateReport(): string {
    const totalImprovement = this.testResults.reduce((sum, result) =>
      sum + (result.enabled ? result.improvement : 0), 0);

    let report = `\n🔬 OPTIMIZATION PERFORMANCE REPORT\n`;
    report += `═══════════════════════════════════════\n`;
    report += `Baseline FPS: ${this.baselineFPS.toFixed(1)}\n`;
    report += `Current FPS: ${performanceMonitor.getAverageFPS().toFixed(1)}\n`;
    report += `Total Improvement: +${totalImprovement.toFixed(1)} FPS\n\n`;

    report += `Individual Optimizations:\n`;
    this.testResults.forEach(result => {
      const status = result.enabled ? '✅' : '❌';
      report += `${status} ${result.name}: +${result.improvement.toFixed(1)} FPS\n`;
    });

    const remaining = 60 - performanceMonitor.getAverageFPS();
    report += `\n🎯 Target: 60 FPS (${remaining.toFixed(1)} FPS remaining)\n`;

    return report;
  }

  // Quick bottleneck identification
  identifyBottlenecks(): Array<{area: string, severity: 'HIGH' | 'MEDIUM' | 'LOW', description: string}> {
    const currentFPS = performanceMonitor.getAverageFPS();
    const bottlenecks = [];

    if (currentFPS < 30) {
      bottlenecks.push({
        area: 'Critical Performance',
        severity: 'HIGH' as const,
        description: 'FPS below 30 indicates major bottlenecks in game loop or rendering'
      });
    }

    if (currentFPS < 45) {
      bottlenecks.push({
        area: 'Rendering Pipeline',
        severity: 'HIGH' as const,
        description: 'Likely GPU-bound: too many draw calls or complex shaders'
      });
    }

    if (currentFPS < 50) {
      bottlenecks.push({
        area: 'Game Logic',
        severity: 'MEDIUM' as const,
        description: 'CPU-bound: expensive calculations in game tick'
      });
    }

    return bottlenecks;
  }
}

// Global tester instance
export const optimizationTester = new OptimizationTester();