import { test, expect } from '@playwright/test';
import {
  useUiSettingsStore,
  DEFAULT_LIGHTING_SETTINGS,
  DEFAULT_CONTROL_SPEEDS,
  UI_SETTINGS_STORAGE_KEYS,
} from '../src/game/uiSettingsStore';
import { getDefaultBindings } from '../src/components/Working/controlBindings';

/**
 * Unit tests for the extracted UI settings store (src/game/uiSettingsStore.ts),
 * the first slice peeled off the monolithic game store in the worker-offload
 * refactor (Working/worker-offload-phase0.md, task T1).
 *
 * These run purely in the Playwright Node process — the store has no DOM or
 * three.js dependency, only `localStorage`, which Node lacks. We install a faithful
 * in-memory `Storage` polyfill BEFORE importing the store so its load-time defaults
 * resolve against known-empty storage, then drive the store's real setters and
 * assert against its actual outputs (store state AND what landed in storage). No
 * magic numbers are copied from the implementation: every expectation is derived
 * from the store's own exported defaults, so the tests stay valid if a default is
 * ever retuned.
 *
 * Serial mode guarantees the pristine-defaults case observes the freshly-imported
 * state before any setter mutates the shared singleton.
 */

test.describe.configure({ mode: 'serial' });

// --- In-memory localStorage polyfill (installed before the store is imported) ---

class InMemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

const memoryStorage = new InMemoryStorage();
// The store module is imported statically (above), so its load-time loaders have
// already run against an absent `localStorage` and resolved to their defaults via
// the catch path — exactly the values the "defaults" case below asserts. Installing
// the polyfill now makes the setters (invoked inside tests) read/write real storage.
(globalThis as unknown as { localStorage: InMemoryStorage }).localStorage = memoryStorage;

test.describe('UI settings store', () => {
  test('loads documented defaults when storage holds no saved value', () => {
    const state = useUiSettingsStore.getState();
    expect(state.lightingSettings).toEqual(DEFAULT_LIGHTING_SETTINGS);
    expect(state.controlSpeeds).toEqual(DEFAULT_CONTROL_SPEEDS);
    // Shadows default OFF; the three feedback toggles default ON.
    expect(state.shadowsEnabled).toBe(false);
    expect(state.healthBarsEnabled).toBe(true);
    expect(state.unitAurasEnabled).toBe(true);
    expect(state.musicEnabled).toBe(true);
  });

  test('boolean setters update state and persist the new value', () => {
    const { setShadowsEnabled, setHealthBarsEnabled, setUnitAurasEnabled, setMusicEnabled } =
      useUiSettingsStore.getState();

    setShadowsEnabled(true);
    expect(useUiSettingsStore.getState().shadowsEnabled).toBe(true);
    expect(memoryStorage.getItem(UI_SETTINGS_STORAGE_KEYS.shadows)).toBe('true');

    setHealthBarsEnabled(false);
    expect(useUiSettingsStore.getState().healthBarsEnabled).toBe(false);
    expect(memoryStorage.getItem(UI_SETTINGS_STORAGE_KEYS.healthBars)).toBe('false');

    setUnitAurasEnabled(false);
    expect(useUiSettingsStore.getState().unitAurasEnabled).toBe(false);
    expect(memoryStorage.getItem(UI_SETTINGS_STORAGE_KEYS.unitAuras)).toBe('false');

    setMusicEnabled(false);
    expect(useUiSettingsStore.getState().musicEnabled).toBe(false);
    expect(memoryStorage.getItem(UI_SETTINGS_STORAGE_KEYS.music)).toBe('false');
  });

  test('updateControlSpeeds merges a partial change and persists the merged object', () => {
    const before = useUiSettingsStore.getState().controlSpeeds;
    const bumped = before.keyboardScroll + 1.5;

    useUiSettingsStore.getState().updateControlSpeeds({ keyboardScroll: bumped });
    const after = useUiSettingsStore.getState().controlSpeeds;

    // Changed field takes the new value; untouched fields are preserved (merge, not replace).
    expect(after.keyboardScroll).toBe(bumped);
    expect(after.controllerCursor).toBe(before.controllerCursor);

    const persisted = JSON.parse(memoryStorage.getItem(UI_SETTINGS_STORAGE_KEYS.controlSpeeds)!);
    expect(persisted).toEqual(after);
  });

  test('updateLightingSettings updates state but does NOT persist (owned by Settings video tab)', () => {
    memoryStorage.removeItem(UI_SETTINGS_STORAGE_KEYS.lighting);
    const newExposure = useUiSettingsStore.getState().lightingSettings.exposure + 0.3;

    useUiSettingsStore.getState().updateLightingSettings({ exposure: newExposure });

    expect(useUiSettingsStore.getState().lightingSettings.exposure).toBe(newExposure);
    // The store deliberately leaves the localStorage write to components/Settings.tsx,
    // mirroring the original monolithic store — so the key stays untouched here.
    expect(memoryStorage.getItem(UI_SETTINGS_STORAGE_KEYS.lighting)).toBeNull();
  });

  test('setBinding rebinds the chosen action, resetBindings restores the device defaults', () => {
    // Pick a real action id from the live binding map rather than hard-coding one,
    // so the test tracks whatever actions the control scheme actually defines.
    const actionId = Object.keys(useUiSettingsStore.getState().keyboardBindings)[0] as Parameters<
      ReturnType<typeof useUiSettingsStore.getState>['setBinding']
    >[1];
    const freshToken = 'key:F13'; // unlikely to collide with an existing default

    useUiSettingsStore.getState().setBinding('keyboard', actionId, freshToken);
    expect(useUiSettingsStore.getState().keyboardBindings[actionId]).toBe(freshToken);

    useUiSettingsStore.getState().resetBindings('keyboard');
    expect(useUiSettingsStore.getState().keyboardBindings).toEqual(getDefaultBindings('keyboard'));
  });

  test('a localStorage failure never throws — the setting still applies in-session', () => {
    const original = (globalThis as unknown as { localStorage: unknown }).localStorage;
    // Simulate private-mode / disabled storage: setItem throws.
    (globalThis as unknown as { localStorage: { setItem: () => void } }).localStorage = {
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    try {
      expect(() => useUiSettingsStore.getState().setMusicEnabled(true)).not.toThrow();
      expect(useUiSettingsStore.getState().musicEnabled).toBe(true);
    } finally {
      (globalThis as unknown as { localStorage: unknown }).localStorage = original;
    }
  });
});
