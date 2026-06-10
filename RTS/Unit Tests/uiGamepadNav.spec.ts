import { test, expect } from '@playwright/test';
import {
  type GamepadSnapshot,
  type NavRect,
  NAV_DEADZONE,
  chooseNextIndex,
  createRepeatState,
  isBackPressed,
  isConfirmPressed,
  readNavDirection,
  rectCenter,
  stepRepeat,
} from '../src/components/Working/uiGamepadNav';

/**
 * These tests exercise the real uiGamepadNav module against real inputs and
 * outputs. The module is DOM-free by design, so the spatial-navigation geometry
 * and the held-direction repeat timing are validated directly — no jsdom and no
 * Gamepad API stand-in beyond a plain object shaped like a Gamepad.
 *
 * Run from the RTS project root:
 *   npx playwright test --config="Unit Tests/playwright.config.ts"
 */

// Build a minimal Gamepad-shaped snapshot. Buttons/axes default to neutral so a
// test only states the inputs it cares about.
function makePad(options: { pressed?: number[]; axes?: number[] } = {}): GamepadSnapshot {
  const pressedSet = new Set(options.pressed ?? []);
  const buttons = Array.from({ length: 16 }, (_, index) => ({
    pressed: pressedSet.has(index),
    value: pressedSet.has(index) ? 1 : 0,
  }));
  const axes = options.axes ?? [0, 0, 0, 0];
  return { buttons, axes };
}

// A simple two-row, two-column grid of equal tiles for spatial-nav assertions.
//   index 0 (top-left)    index 1 (top-right)
//   index 2 (bottom-left) index 3 (bottom-right)
function gridRects(): NavRect[] {
  return [
    { left: 0, top: 0, right: 100, bottom: 50 },
    { left: 200, top: 0, right: 300, bottom: 50 },
    { left: 0, top: 200, right: 100, bottom: 250 },
    { left: 200, top: 200, right: 300, bottom: 250 },
  ];
}

test.describe('rectCenter', () => {
  test('returns the geometric center of a rectangle', () => {
    expect(rectCenter({ left: 10, top: 20, right: 30, bottom: 60 })).toEqual({ x: 20, y: 40 });
  });
});

test.describe('chooseNextIndex spatial navigation', () => {
  test('moves right to the aligned neighbor in the same row', () => {
    expect(chooseNextIndex(gridRects(), 0, 'right')).toBe(1);
    expect(chooseNextIndex(gridRects(), 2, 'right')).toBe(3);
  });

  test('moves left to the aligned neighbor in the same row', () => {
    expect(chooseNextIndex(gridRects(), 1, 'left')).toBe(0);
    expect(chooseNextIndex(gridRects(), 3, 'left')).toBe(2);
  });

  test('moves down to the aligned neighbor in the same column', () => {
    expect(chooseNextIndex(gridRects(), 0, 'down')).toBe(2);
    expect(chooseNextIndex(gridRects(), 1, 'down')).toBe(3);
  });

  test('moves up to the aligned neighbor in the same column', () => {
    expect(chooseNextIndex(gridRects(), 2, 'up')).toBe(0);
    expect(chooseNextIndex(gridRects(), 3, 'up')).toBe(1);
  });

  test('returns null when nothing lies in the pressed direction', () => {
    expect(chooseNextIndex(gridRects(), 0, 'left')).toBeNull();
    expect(chooseNextIndex(gridRects(), 0, 'up')).toBeNull();
    expect(chooseNextIndex(gridRects(), 3, 'right')).toBeNull();
    expect(chooseNextIndex(gridRects(), 3, 'down')).toBeNull();
  });

  test('prefers the on-axis neighbor over a closer but off-axis one', () => {
    // From the origin tile, a slightly-closer tile sits diagonally while a
    // perfectly aligned tile sits a little further right; alignment must win.
    const rects: NavRect[] = [
      { left: 0, top: 0, right: 40, bottom: 40 }, // 0: current
      { left: 60, top: 0, right: 100, bottom: 40 }, // 1: aligned, slightly further
      { left: 50, top: 80, right: 90, bottom: 120 }, // 2: closer center, off-axis
    ];
    expect(chooseNextIndex(rects, 0, 'right')).toBe(1);
  });

  test('returns null for an out-of-range current index', () => {
    expect(chooseNextIndex(gridRects(), 99, 'right')).toBeNull();
  });
});

test.describe('readNavDirection', () => {
  test('reads each D-Pad direction with priority over the stick', () => {
    expect(readNavDirection(makePad({ pressed: [12] }))).toBe('up');
    expect(readNavDirection(makePad({ pressed: [13] }))).toBe('down');
    expect(readNavDirection(makePad({ pressed: [14] }))).toBe('left');
    expect(readNavDirection(makePad({ pressed: [15] }))).toBe('right');
    // D-Pad up wins even while the stick points down.
    expect(readNavDirection(makePad({ pressed: [12], axes: [0, 1] }))).toBe('up');
  });

  test('reads the left stick dominant axis past the deadzone', () => {
    expect(readNavDirection(makePad({ axes: [0.9, 0] }))).toBe('right');
    expect(readNavDirection(makePad({ axes: [-0.9, 0] }))).toBe('left');
    expect(readNavDirection(makePad({ axes: [0, 0.9] }))).toBe('down');
    expect(readNavDirection(makePad({ axes: [0, -0.9] }))).toBe('up');
  });

  test('returns null inside the deadzone', () => {
    const belowDeadzone = NAV_DEADZONE - 0.05;
    expect(readNavDirection(makePad({ axes: [belowDeadzone, belowDeadzone] }))).toBeNull();
    expect(readNavDirection(makePad())).toBeNull();
  });
});

test.describe('confirm and back button reads', () => {
  test('detects the confirm (A) button', () => {
    expect(isConfirmPressed(makePad({ pressed: [0] }))).toBe(true);
    expect(isConfirmPressed(makePad())).toBe(false);
  });

  test('detects the back (B) button', () => {
    expect(isBackPressed(makePad({ pressed: [1] }))).toBe(true);
    expect(isBackPressed(makePad())).toBe(false);
  });
});

test.describe('stepRepeat held-direction timing', () => {
  const INITIAL_DELAY_MS = 300;
  const REPEAT_MS = 120;

  test('fires once immediately on a fresh press', () => {
    const result = stepRepeat(createRepeatState(), 'down', 1000, INITIAL_DELAY_MS, REPEAT_MS);
    expect(result.fire).toBe(true);
    expect(result.state.direction).toBe('down');
    expect(result.state.nextFireAtMs).toBe(1000 + INITIAL_DELAY_MS);
  });

  test('suppresses repeats until the initial delay elapses, then auto-repeats', () => {
    const press = stepRepeat(createRepeatState(), 'down', 1000, INITIAL_DELAY_MS, REPEAT_MS);

    // Still within the initial delay: no repeat.
    const held = stepRepeat(press.state, 'down', 1200, INITIAL_DELAY_MS, REPEAT_MS);
    expect(held.fire).toBe(false);

    // Initial delay elapsed: a repeat fires and re-arms at the faster interval.
    const firstRepeat = stepRepeat(press.state, 'down', 1300, INITIAL_DELAY_MS, REPEAT_MS);
    expect(firstRepeat.fire).toBe(true);
    expect(firstRepeat.state.nextFireAtMs).toBe(1300 + REPEAT_MS);

    // Before the repeat interval passes again: no fire.
    const tooSoon = stepRepeat(firstRepeat.state, 'down', 1350, INITIAL_DELAY_MS, REPEAT_MS);
    expect(tooSoon.fire).toBe(false);
  });

  test('a direction change fires immediately and re-arms the initial delay', () => {
    const press = stepRepeat(createRepeatState(), 'down', 1000, INITIAL_DELAY_MS, REPEAT_MS);
    const changed = stepRepeat(press.state, 'right', 1050, INITIAL_DELAY_MS, REPEAT_MS);
    expect(changed.fire).toBe(true);
    expect(changed.state.direction).toBe('right');
    expect(changed.state.nextFireAtMs).toBe(1050 + INITIAL_DELAY_MS);
  });

  test('releasing to neutral disarms without firing', () => {
    const press = stepRepeat(createRepeatState(), 'down', 1000, INITIAL_DELAY_MS, REPEAT_MS);
    const released = stepRepeat(press.state, null, 1100, INITIAL_DELAY_MS, REPEAT_MS);
    expect(released.fire).toBe(false);
    expect(released.state.direction).toBeNull();
  });
});
