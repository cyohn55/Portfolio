import { test, expect } from '@playwright/test';
import {
  activeConquestGamepad,
  axisWithDeadzone,
} from '../src/components/Working/conquest/conquestGamepad';
import { CONTROLLER_DEADZONE, type GamepadLike } from '../src/components/Working/controlBindings';

/**
 * Unit tests for Conquest's shared gamepad primitives — the seam that gives the
 * Conquest field (which mounts no GamepadController) its own controller support.
 * All pure Node: `navigator.getGamepads` is stubbed on globalThis so the tests
 * drive the REAL functions with real pad shapes, asserting their actual outputs
 * (deadzone gating, first-connected-pad selection) rather than copied constants.
 */

/** Build a minimal Standard-mapping pad with the given axis deflections. */
function padWithAxes(axes: number[], connected = true): GamepadLike {
  return { connected, axes, buttons: [] } as unknown as GamepadLike;
}

/** Run `body` with `navigator.getGamepads` returning `pads`, then restore. */
function withGamepads(pads: (GamepadLike | null)[], body: () => void): void {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'navigator');
  const previous = (globalThis as { navigator?: unknown }).navigator;
  (globalThis as { navigator?: unknown }).navigator = { getGamepads: () => pads };
  try {
    body();
  } finally {
    if (had) (globalThis as { navigator?: unknown }).navigator = previous;
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

test.describe('axisWithDeadzone', () => {
  test('snaps a resting stick inside the deadzone to zero', () => {
    const restingDeflection = CONTROLLER_DEADZONE / 2; // unambiguously inside the band
    const pad = padWithAxes([restingDeflection, -restingDeflection]);
    expect(axisWithDeadzone(pad, 0)).toBe(0);
    expect(axisWithDeadzone(pad, 1)).toBe(0);
  });

  test('passes a deflection beyond the deadzone through unchanged (both signs)', () => {
    const beyond = Math.min(1, CONTROLLER_DEADZONE + 0.3);
    const pad = padWithAxes([beyond, -beyond]);
    expect(axisWithDeadzone(pad, 0)).toBeCloseTo(beyond, 6);
    expect(axisWithDeadzone(pad, 1)).toBeCloseTo(-beyond, 6);
  });

  test('treats a missing axis as zero (never NaN)', () => {
    const pad = padWithAxes([]); // no axes reported
    expect(axisWithDeadzone(pad, 3)).toBe(0);
  });

  test('honors a caller-supplied deadzone override', () => {
    const deflection = CONTROLLER_DEADZONE + 0.1; // beyond the default band...
    const pad = padWithAxes([deflection]);
    // ...but inside a wider custom band, so the override must gate it to zero.
    expect(axisWithDeadzone(pad, 0, deflection + 0.05)).toBe(0);
    expect(axisWithDeadzone(pad, 0)).toBeCloseTo(deflection, 6);
  });
});

test.describe('activeConquestGamepad', () => {
  test('returns the first CONNECTED pad, skipping empty and disconnected slots', () => {
    const connected = padWithAxes([0, 0], true);
    withGamepads([null, padWithAxes([0, 0], false), connected], () => {
      expect(activeConquestGamepad()).toBe(connected);
    });
  });

  test('returns null when no pad is connected', () => {
    withGamepads([null, padWithAxes([0, 0], false)], () => {
      expect(activeConquestGamepad()).toBeNull();
    });
  });

  test('returns null when the platform exposes no gamepad API', () => {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'navigator');
    const previous = (globalThis as { navigator?: unknown }).navigator;
    (globalThis as { navigator?: unknown }).navigator = {}; // no getGamepads
    try {
      expect(activeConquestGamepad()).toBeNull();
    } finally {
      if (had) (globalThis as { navigator?: unknown }).navigator = previous;
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
});
