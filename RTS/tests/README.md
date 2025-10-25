# Playwright Testing Guide

This directory contains end-to-end tests for the RTS game using Playwright.

## Prerequisites

Playwright has been installed and configured for this project. The browsers (Chromium, Firefox, and WebKit) have been downloaded.

## Running Tests

### Basic Test Commands

```bash
# Run all tests in headless mode
npm test

# Run tests with UI mode (interactive)
npm run test:ui

# Run tests in headed mode (see the browser)
npm run test:headed

# Run tests in debug mode (step through tests)
npm run test:debug

# View the last test report
npm run test:report
```

### Advanced Usage

```bash
# Run tests in a specific browser
npx playwright test --project=chromium
npx playwright test --project=firefox
npx playwright test --project=webkit

# Run a specific test file
npx playwright test tests/game.spec.ts

# Run tests matching a pattern
npx playwright test --grep "should load"

# Run tests with trace
npx playwright test --trace on
```

## Test Configuration

The Playwright configuration is defined in `playwright.config.ts` at the root of the RTS directory.

Key configuration details:
- **Base URL**: http://localhost:5173
- **Web Server**: Automatically starts dev server before tests
- **Browsers**: Chromium, Firefox, and WebKit
- **Screenshots**: Captured on test failure
- **Videos**: Recorded on test failure
- **Traces**: Collected on first retry

## Writing Tests

Tests are written using the Playwright Test framework. Example structure:

```typescript
import { test, expect } from '@playwright/test';

test.describe('Feature Name', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Setup code
  });

  test('should do something', async ({ page }) => {
    // Test code
    await expect(page.locator('selector')).toBeVisible();
  });
});
```

## Test Structure

Current test files:
- `game.spec.ts` - Basic game functionality and performance tests

## Tips for Testing 3D Games

1. **Wait for Scene Initialization**: Always wait for the canvas element and give time for 3D scene to load
2. **Use Timeouts Wisely**: 3D rendering can be slower, adjust timeouts accordingly
3. **Check Console Errors**: Monitor console for WebGL or Three.js errors
4. **Performance Testing**: Test load times and frame rates
5. **Interaction Testing**: Verify mouse clicks and keyboard inputs work correctly

## Troubleshooting

### Browser Dependencies

If you encounter issues with missing system dependencies on Linux/WSL, you may need to install them:

```bash
sudo npx playwright install-deps
```

### Port Already in Use

If the dev server port (5173) is already in use, the tests will fail. Make sure to stop any running dev servers before testing.

### WebGL Context Issues

On some systems (especially WSL), WebGL may not work properly. You may need to:
1. Use headed mode to see actual rendering
2. Check if hardware acceleration is enabled
3. Use Chromium which has better WebGL support in WSL

## CI/CD Integration

The configuration is CI-ready with the following features:
- Fails build if `test.only` is accidentally left in code
- Retries failed tests twice on CI
- Runs tests sequentially on CI for stability
- Uses environment variable `CI=true` to enable CI mode

## Resources

- [Playwright Documentation](https://playwright.dev)
- [Playwright Test API](https://playwright.dev/docs/api/class-test)
- [Best Practices](https://playwright.dev/docs/best-practices)
