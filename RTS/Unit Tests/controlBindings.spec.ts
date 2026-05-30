import { test, expect } from '@playwright/test';
import {
  type ControlBindings,
  type GamepadLike,
  CONTROL_ACTIONS,
  DEFAULT_KEYBOARD_BINDINGS,
  DEFAULT_CONTROLLER_BINDINGS,
  UNBOUND_TOKEN,
  applyBinding,
  controllerTokenMagnitude,
  findConflict,
  formatControllerToken,
  formatKeyboardToken,
  getDefaultBindings,
  isControllerTokenActive,
  keyboardEventToToken,
  loadBindings,
  mergeWithDefaults,
  mouseButtonToToken,
  saveBindings,
  scanGamepadToken,
  tokenToMouseButton,
  wheelDeltaToToken,
} from '../src/components/Working/controlBindings';

/**
 * These tests exercise the real controlBindings module against real inputs and
 * outputs: no values are hard-coded into the module under test, and the storage
 * round-trip uses an injected localStorage stub so persistence is validated end
 * to end. Run with: npx playwright test --config "Unit Tests/playwright.config.ts"
 */

// Minimal in-memory localStorage so save/load can be validated without a browser.
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

function buildGamepad(overrides: { buttons?: number[]; axes?: number[] } = {}): GamepadLike {
  const buttonValues = overrides.buttons ?? new Array(16).fill(0);
  const axes = overrides.axes ?? new Array(4).fill(0);
  return {
    buttons: buttonValues.map((value) => ({ pressed: value > 0.5, value })),
    axes,
  };
}

function actionIds(): string[] {
  return CONTROL_ACTIONS.map((action) => action.id);
}

test.describe('default binding maps', () => {
  test('every action has a default on both devices', () => {
    for (const id of actionIds()) {
      expect(DEFAULT_KEYBOARD_BINDINGS[id as keyof ControlBindings]).toBeDefined();
      expect(DEFAULT_CONTROLLER_BINDINGS[id as keyof ControlBindings]).toBeDefined();
    }
  });

  test('default keyboard tokens are unique (no accidental conflicts)', () => {
    const tokens = actionIds().map((id) => DEFAULT_KEYBOARD_BINDINGS[id as keyof ControlBindings]);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  test('default controller tokens are unique (no accidental conflicts)', () => {
    const tokens = actionIds().map((id) => DEFAULT_CONTROLLER_BINDINGS[id as keyof ControlBindings]);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  test('getDefaultBindings returns an independent copy', () => {
    const a = getDefaultBindings('keyboard');
    a.cameraForward = 'z';
    expect(getDefaultBindings('keyboard').cameraForward).toBe('w');
  });
});

test.describe('mergeWithDefaults', () => {
  test('fills missing keys from defaults and applies stored overrides', () => {
    const merged = mergeWithDefaults('keyboard', { cameraForward: 'i' });
    expect(merged.cameraForward).toBe('i');
    expect(merged.cameraBackward).toBe(DEFAULT_KEYBOARD_BINDINGS.cameraBackward);
  });

  test('ignores unknown keys and null input', () => {
    const merged = mergeWithDefaults('keyboard', { bogus: 'x' } as any);
    expect((merged as any).bogus).toBeUndefined();
    expect(mergeWithDefaults('keyboard', null)).toEqual(getDefaultBindings('keyboard'));
  });
});

test.describe('persistence round-trip', () => {
  test('saveBindings then loadBindings returns the same map', () => {
    (globalThis as any).localStorage = new MemoryStorage();
    const custom = applyBinding(getDefaultBindings('keyboard'), 'cameraForward', 'arrowup');
    saveBindings('keyboard', custom);
    expect(loadBindings('keyboard')).toEqual(custom);
    delete (globalThis as any).localStorage;
  });

  test('loadBindings falls back to defaults on corrupt JSON', () => {
    const storage = new MemoryStorage();
    storage.setItem('rts-keyboard-bindings', '{not valid json');
    (globalThis as any).localStorage = storage;
    expect(loadBindings('keyboard')).toEqual(getDefaultBindings('keyboard'));
    delete (globalThis as any).localStorage;
  });
});

test.describe('applyBinding and findConflict', () => {
  test('assigning an in-use token transfers it and unbinds the previous owner', () => {
    const base = getDefaultBindings('keyboard'); // cameraForward 'w', cameraBackward 's'
    const next = applyBinding(base, 'cameraBackward', 'w');
    expect(next.cameraBackward).toBe('w');
    expect(next.cameraForward).toBe(UNBOUND_TOKEN);
    expect(base.cameraForward).toBe('w'); // original not mutated
  });

  test('unbinding an action does not disturb others', () => {
    const base = getDefaultBindings('keyboard');
    const next = applyBinding(base, 'cameraForward', UNBOUND_TOKEN);
    expect(next.cameraForward).toBe(UNBOUND_TOKEN);
    expect(next.cameraBackward).toBe('s');
  });

  test('findConflict detects the holder, skips the excepted action, ignores unbound', () => {
    const base = getDefaultBindings('keyboard');
    expect(findConflict(base, 'w', 'cameraBackward')).toBe('cameraForward');
    expect(findConflict(base, 'w', 'cameraForward')).toBeNull();
    expect(findConflict(base, UNBOUND_TOKEN, 'cameraForward')).toBeNull();
  });
});

test.describe('keyboard token capture and formatting', () => {
  test('keyboardEventToToken encodes modifiers, normalizes space, ignores bare modifiers', () => {
    expect(keyboardEventToToken({ key: 'A', shiftKey: true })).toBe('shift+a');
    expect(keyboardEventToToken({ key: ' ' })).toBe('space');
    expect(keyboardEventToToken({ key: 'Shift', shiftKey: true })).toBe(UNBOUND_TOKEN);
    expect(keyboardEventToToken({ key: 'w' })).toBe('w');
  });

  test('mouse and wheel token helpers round-trip', () => {
    expect(mouseButtonToToken(0)).toBe('mouse:left');
    expect(mouseButtonToToken(2)).toBe('mouse:right');
    expect(tokenToMouseButton('mouse:right')).toBe(2);
    expect(tokenToMouseButton('w')).toBeNull();
    expect(wheelDeltaToToken(120)).toBe('wheeldown');
    expect(wheelDeltaToToken(-120)).toBe('wheelup');
  });

  test('formatKeyboardToken is human readable', () => {
    expect(formatKeyboardToken('shift+a')).toBe('Shift + A');
    expect(formatKeyboardToken('mouse:left')).toBe('Left Click');
    expect(formatKeyboardToken('wheelup')).toBe('Scroll Up');
    expect(formatKeyboardToken('space')).toBe('Space');
    expect(formatKeyboardToken(UNBOUND_TOKEN)).toBe('Unbound');
  });
});

test.describe('controller token formatting', () => {
  test('buttons, axes and chords format with Xbox labels', () => {
    expect(formatControllerToken('button:0')).toBe('A');
    expect(formatControllerToken('button:9')).toBe('Start');
    expect(formatControllerToken('axis:1-')).toBe('Left Stick ↑');
    expect(formatControllerToken('axis:0+')).toBe('Left Stick →');
    expect(formatControllerToken('button:4+button:0')).toBe('LB + A');
    expect(formatControllerToken(UNBOUND_TOKEN)).toBe('Unbound');
  });
});

test.describe('controller runtime evaluation', () => {
  test('isControllerTokenActive reads buttons, axes and chords', () => {
    const aPressed = buildGamepad({ buttons: setIndex(0, 1) });
    expect(isControllerTokenActive(aPressed, 'button:0')).toBe(true);
    expect(isControllerTokenActive(aPressed, 'button:1')).toBe(false);

    const stickDown = buildGamepad({ axes: [0, 0.9, 0, 0] });
    expect(isControllerTokenActive(stickDown, 'axis:1+')).toBe(true);
    expect(isControllerTokenActive(stickDown, 'axis:1-')).toBe(false);

    const lbAndA = buildGamepad({ buttons: setIndices([4, 0], 1) });
    expect(isControllerTokenActive(lbAndA, 'button:4+button:0')).toBe(true);
    expect(isControllerTokenActive(aPressed, 'button:4+button:0')).toBe(false);
  });

  test('controllerTokenMagnitude returns analog strength and chord minimum', () => {
    const halfStick = buildGamepad({ axes: [0.6, 0, 0, 0] });
    expect(controllerTokenMagnitude(halfStick, 'axis:0+')).toBeCloseTo(0.6, 5);
    expect(controllerTokenMagnitude(halfStick, 'axis:0-')).toBe(0);
    expect(controllerTokenMagnitude(buildGamepad(), UNBOUND_TOKEN)).toBe(0);
  });

  test('values inside the deadzone read as inactive', () => {
    const tiny = buildGamepad({ axes: [0.2, 0, 0, 0] });
    expect(isControllerTokenActive(tiny, 'axis:0+')).toBe(false);
  });

  test('scanGamepadToken prefers buttons, then axis deflection', () => {
    expect(scanGamepadToken(buildGamepad({ buttons: setIndex(3, 1) }))).toBe('button:3');
    expect(scanGamepadToken(buildGamepad({ axes: [0, 0, -0.8, 0] }))).toBe('axis:2-');
    expect(scanGamepadToken(buildGamepad())).toBeNull();
  });
});

function setIndex(index: number, value: number): number[] {
  const arr = new Array(16).fill(0);
  arr[index] = value;
  return arr;
}

function setIndices(indices: number[], value: number): number[] {
  const arr = new Array(16).fill(0);
  for (const index of indices) arr[index] = value;
  return arr;
}
