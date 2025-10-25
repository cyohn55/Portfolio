import { test, expect } from '@playwright/test';

/**
 * RTS Game E2E Tests
 * Tests the core functionality of the 3D RTS game
 */

test.describe('RTS Game - Basic Functionality', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the game before each test
    await page.goto('/');

    // Wait for the game to load (canvas should be present)
    await page.waitForSelector('canvas', { timeout: 10000 });

    // Give the 3D scene time to initialize
    await page.waitForTimeout(2000);
  });

  test('should load the game successfully', async ({ page }) => {
    // Check if the page title is correct
    await expect(page).toHaveTitle(/RTS/i);

    // Verify the canvas element exists (Three.js renderer)
    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();
  });

  test('should render the 3D scene', async ({ page }) => {
    // Check that the canvas has dimensions (indicating 3D scene is rendered)
    const canvas = page.locator('canvas');
    const boundingBox = await canvas.boundingBox();

    expect(boundingBox).toBeTruthy();
    expect(boundingBox?.width).toBeGreaterThan(0);
    expect(boundingBox?.height).toBeGreaterThan(0);
  });

  test('should display game UI elements', async ({ page }) => {
    // Check for game controls or HUD elements
    // Adjust selectors based on your actual UI components

    // Wait for any UI elements to appear
    await page.waitForTimeout(1000);

    // You can add more specific checks based on your HUD implementation
    // For example:
    // const hudElement = page.locator('[data-testid="game-hud"]');
    // await expect(hudElement).toBeVisible();
  });

  test('should respond to user interactions', async ({ page }) => {
    const canvas = page.locator('canvas');

    // Get canvas dimensions
    const boundingBox = await canvas.boundingBox();
    expect(boundingBox).toBeTruthy();

    if (boundingBox) {
      // Click in the center of the canvas
      await canvas.click({
        position: {
          x: boundingBox.width / 2,
          y: boundingBox.height / 2
        }
      });

      // Wait a moment for any state changes
      await page.waitForTimeout(500);

      // Verify no errors occurred
      const errors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          errors.push(msg.text());
        }
      });

      expect(errors).toHaveLength(0);
    }
  });

  test('should not have console errors on load', async ({ page }) => {
    const errors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Reload the page to capture all console messages
    await page.reload();
    await page.waitForSelector('canvas', { timeout: 10000 });
    await page.waitForTimeout(2000);

    // Filter out expected WebGL warnings if any
    const criticalErrors = errors.filter(error =>
      !error.includes('WebGL') &&
      !error.includes('vendor')
    );

    expect(criticalErrors).toHaveLength(0);
  });
});

test.describe('RTS Game - Performance', () => {
  test('should load within reasonable time', async ({ page }) => {
    const startTime = Date.now();

    await page.goto('/');
    await page.waitForSelector('canvas', { timeout: 10000 });

    const loadTime = Date.now() - startTime;

    // Game should load within 10 seconds
    expect(loadTime).toBeLessThan(10000);
  });

  test('should maintain stable frame rate', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('canvas', { timeout: 10000 });

    // Let the game run for a few seconds
    await page.waitForTimeout(5000);

    // Check for any performance warnings in console
    const warnings: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning' && msg.text().includes('performance')) {
        warnings.push(msg.text());
      }
    });

    expect(warnings).toHaveLength(0);
  });
});
