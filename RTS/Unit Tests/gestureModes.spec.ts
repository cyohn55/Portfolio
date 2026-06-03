import { test, expect } from '@playwright/test';
import {
  type ActivationMode,
  ACTIVATION_MODES,
  DEFAULT_ACTIVATION_MODE,
  buildTokenDispatch,
  createTokenGestureResolver,
  isActivationMode,
} from '../src/components/Working/gestureModes';

/**
 * These tests drive the real gesture state machine through real press/release
 * edges. Timing-sensitive cases inject the clock via the `now` argument or use a
 * tiny real threshold and await, so no behavior is hard-coded or mocked away.
 * Run with: npx playwright test --config "Unit Tests/playwright.config.ts"
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.describe('activation-mode vocabulary', () => {
  test('the four modes are exposed and Tap is the default', () => {
    expect(ACTIVATION_MODES).toEqual(['tap', 'double-tap', 'hold', 'chord']);
    expect(DEFAULT_ACTIVATION_MODE).toBe('tap');
  });

  test('isActivationMode guards persisted/unknown values', () => {
    expect(isActivationMode('hold')).toBe(true);
    expect(isActivationMode('chord')).toBe(true);
    expect(isActivationMode('triple-tap')).toBe(false);
    expect(isActivationMode(undefined)).toBe(false);
  });
});

test.describe('createTokenGestureResolver', () => {
  test('a pure Tap binding fires immediately on press', () => {
    const calls: string[] = [];
    const resolver = createTokenGestureResolver({ onTap: () => calls.push('tap') });
    resolver.press(0);
    expect(calls).toEqual(['tap']); // no release needed for a lone tap
  });

  test('two quick presses within the window fire Double-Tap, not Tap', () => {
    const calls: string[] = [];
    const resolver = createTokenGestureResolver({
      onTap: () => calls.push('tap'),
      onDoubleTap: () => calls.push('double'),
      doubleTapWindowMs: 350,
    });
    resolver.press(0);
    resolver.release(10);
    resolver.press(20); // within 350ms of the first press
    expect(calls).toEqual(['double']);
  });

  test('a single tap (no second press) resolves to Tap after the window', async () => {
    const calls: string[] = [];
    const resolver = createTokenGestureResolver({
      onTap: () => calls.push('tap'),
      onDoubleTap: () => calls.push('double'),
      doubleTapWindowMs: 20,
    });
    resolver.press(0);
    resolver.release(1);
    await sleep(60);
    expect(calls).toEqual(['tap']);
  });

  test('holding past the threshold fires Hold start then end on release', async () => {
    const calls: string[] = [];
    const resolver = createTokenGestureResolver({
      onHoldStart: () => calls.push('hold-start'),
      onHoldEnd: () => calls.push('hold-end'),
      holdActivationMs: 15,
    });
    resolver.press(0);
    await sleep(40);
    expect(calls).toEqual(['hold-start']);
    resolver.release(40);
    expect(calls).toEqual(['hold-start', 'hold-end']);
  });

  test('a release before the threshold does not fire Hold', async () => {
    const calls: string[] = [];
    const resolver = createTokenGestureResolver({
      onHoldStart: () => calls.push('hold-start'),
      onHoldEnd: () => calls.push('hold-end'),
      holdActivationMs: 1000,
    });
    resolver.press(0);
    resolver.release(5); // well before the 1000ms hold threshold
    await sleep(20);
    expect(calls).toEqual([]);
  });

  test('one token carrying tap + double-tap + hold disambiguates each gesture', async () => {
    const calls: string[] = [];
    const resolver = createTokenGestureResolver({
      onTap: () => calls.push('tap'),
      onDoubleTap: () => calls.push('double'),
      onHoldStart: () => calls.push('hold'),
      holdActivationMs: 15,
      doubleTapWindowMs: 20,
    });
    // Hold.
    resolver.press(0);
    await sleep(40);
    resolver.release(40);
    // Double-tap.
    resolver.press(100);
    resolver.release(105);
    resolver.press(110);
    // Single tap (let the window lapse).
    resolver.press(300);
    resolver.release(305);
    await sleep(60);
    expect(calls).toEqual(['hold', 'double', 'tap']);
  });
});

test.describe('buildTokenDispatch', () => {
  test('actions sharing a token merge into one resolver; chords are listed apart', () => {
    const fired: string[] = [];
    const dispatch = buildTokenDispatch({
      bindings: {
        rally: 'space',
        selectAllUnits: 'space',
        deployUnits: 'space',
        useAbility: 'mouse:left+mouse:right',
        deselect: 'escape',
        unbound: '',
      },
      modes: {
        rally: 'tap',
        selectAllUnits: 'double-tap',
        deployUnits: 'hold',
        useAbility: 'chord',
        deselect: 'tap',
        unbound: 'tap',
      },
      actionIds: ['rally', 'selectAllUnits', 'deployUnits', 'useAbility', 'deselect', 'unbound'],
      configFor: (actionId: string, mode: ActivationMode) => {
        if (mode === 'tap') return { onTap: () => fired.push(`${actionId}:tap`) };
        if (mode === 'double-tap') return { onDoubleTap: () => fired.push(`${actionId}:double`) };
        if (mode === 'hold') return { onHoldStart: () => fired.push(`${actionId}:hold`) };
        return undefined;
      },
    });

    // 'space' (rally+selectAll+deploy) and 'escape' (deselect) => two resolvers; the
    // unbound action is skipped and the chord action is split out.
    expect(dispatch.resolvers.size).toBe(2);
    expect(dispatch.chordActions).toEqual([{ token: 'mouse:left+mouse:right', actionId: 'useAbility' }]);

    // The pure-tap 'escape' resolver fires its single action on press.
    dispatch.resolvers.get('escape')!.press(0);
    expect(fired).toContain('deselect:tap');
  });
});
