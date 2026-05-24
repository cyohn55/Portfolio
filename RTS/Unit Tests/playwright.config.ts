import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the dynamics/balance unit tests in this folder.
 *
 * These tests drive the real Zustand game store exposed on `window.__rtsStore`
 * (dev-only) rather than the rendered 3D scene, so they validate game logic
 * directly. They reuse an already-running `npm run dev` server on port 3000.
 *
 * Run from the RTS project root:
 *   npx playwright test --config="Unit Tests/playwright.config.ts"
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    trace: 'on-first-retry',
  },
  projects: [
    {
      // Uses Playwright's bundled Chromium (no `channel`), which is installed in
      // this environment; the Google Chrome channel is not.
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: undefined },
    },
  ],
  webServer: {
    command: 'npm run dev',
    cwd: '..',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
