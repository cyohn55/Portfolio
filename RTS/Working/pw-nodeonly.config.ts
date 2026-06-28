// Dev-only Playwright config for running pure-logic (Node-only) specs from the
// Unit Tests folder WITHOUT spinning up the Vite dev server (the main config's
// webServer block adds a 120s startup that these DOM-free specs don't need).
//
// Usage: npx playwright test --config Working/pw-nodeonly.config.ts <spec-name>
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../Unit Tests',
  fullyParallel: true,
  reporter: 'line',
});
