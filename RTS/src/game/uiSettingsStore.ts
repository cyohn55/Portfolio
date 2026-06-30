// Player-facing UI/settings store, split out of the monolithic game store
// (src/game/state.ts) so the deterministic simulation can later be moved into a
// Web Worker without dragging display/audio/input preferences across the wire
// (see Working/worker-offload-phase0.md).
//
// Everything here is Bucket D — pure main-thread presentation/input settings that
// never enter the tick. A per-tick snapshot from the sim worker can therefore
// replace the sim mirror wholesale without ever clobbering these.
//
// IMPORTANT — deliberately NOT here:
//   • optimizations / ultraPerformanceMode — the tick reads these to gate
//     AI/regen/win-check throttling, so they change sim outcomes and must stay
//     deterministic sim config (a desync source in multiplayer otherwise). They
//     remain in state.ts.
//
// Persistence note: `updateLightingSettings` updates state only — the Settings
// video tab (components/Settings.tsx) owns the localStorage write for lighting.
// This preserves the exact division the original monolithic store had, so the
// cutover is a behaviour-neutral refactor. Binding persistence is delegated to
// controlBindings.ts (save/load helpers), unchanged from the original.

import { create } from 'zustand';
import {
  type ControlActionId,
  type ControlBindings,
  type ControlBindingModes,
  type InputDevice,
  applyBinding,
  applyBindingMode,
  getDefaultBindings,
  getDefaultModes,
  loadBindings,
  loadModes,
  saveBindings,
  saveModes,
} from '../components/Working/controlBindings';
import type { ActivationMode } from '../components/Working/gestureModes';

// --- Lighting -------------------------------------------------------------

const LIGHTING_STORAGE_KEY = 'lightingSettings';

export const DEFAULT_LIGHTING_SETTINGS = {
  sunBrightness: 9.5,
  moonBrightness: 15,
  ambientLight: 5,
  dayNightSpeed: 210,
  exposure: 0.4,
  environmentIntensity: 1.7,
  saturation: 1.5,
  contrast: 1.0,
  brightness: 0.95,
  hue: 0,
};
export type LightingSettings = typeof DEFAULT_LIGHTING_SETTINGS;

const loadLightingSettings = (): LightingSettings => {
  try {
    const raw = localStorage.getItem(LIGHTING_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LIGHTING_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<LightingSettings>;
    // Merge over defaults so a missing/older key never yields NaN or undefined.
    return { ...DEFAULT_LIGHTING_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_LIGHTING_SETTINGS };
  }
};

// --- Boolean toggles (shadows / health bars / unit auras / music) ---------

const SHADOWS_STORAGE_KEY = 'rts-shadows-enabled';
const HEALTH_BARS_STORAGE_KEY = 'rts-health-bars-enabled';
const UNIT_AURAS_STORAGE_KEY = 'rts-unit-auras-enabled';
const MUSIC_STORAGE_KEY = 'rts-music-enabled';

// Shadows default OFF: enabling them adds a full shadow-map render pass that
// hurts FPS most on the low-end / integrated GPUs a portfolio visitor may be on.
const loadShadowsEnabled = (): boolean => {
  try {
    return localStorage.getItem(SHADOWS_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

// Defaults ON: absence of the key (first visit) resolves to the default rather
// than a forced "off". Shared by the three default-on feedback toggles.
const loadBooleanDefaultOn = (storageKey: string): boolean => {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return true;
    return raw === 'true';
  } catch {
    return true;
  }
};

// --- Per-device input speed multipliers -----------------------------------

const CONTROL_SPEEDS_STORAGE_KEY = 'rts-control-speeds';

export const DEFAULT_CONTROL_SPEEDS = {
  keyboardScroll: 1,
  keyboardCursor: 1,
  controllerScroll: 1,
  controllerCursor: 1,
};
export type ControlSpeeds = typeof DEFAULT_CONTROL_SPEEDS;

const loadControlSpeeds = (): ControlSpeeds => {
  try {
    const raw = localStorage.getItem(CONTROL_SPEEDS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONTROL_SPEEDS };
    const parsed = JSON.parse(raw) as Partial<ControlSpeeds>;
    return { ...DEFAULT_CONTROL_SPEEDS, ...parsed };
  } catch {
    return { ...DEFAULT_CONTROL_SPEEDS };
  }
};

// --- Camera framing/feel settings -----------------------------------------

const CAMERA_SETTINGS_STORAGE_KEY = 'rts-camera-settings';

// The full set of live-tunable camera parameters, surfaced through the F5 admin
// panel so the "point of view" can be experimented with on the fly. These are
// pure main-thread presentation (Bucket D): the camera never feeds the
// deterministic tick, so a player tweaking these can never desync multiplayer.
//
// Defaults reproduce the previous hardcoded behaviour exactly: `tiltDegrees` is
// the old CAMERA_ANGLE (Math.PI/10 === 18°), and the speed/zoom values mirror
// what App.tsx used to pass to <CameraController/> as props.
export const DEFAULT_CAMERA_SETTINGS = {
  // Camera pitch above the horizon, in degrees. The single biggest "point of
  // view" knob — low angles give a flat, cinematic battlefield; high angles a
  // top-down tactical view.
  tiltDegrees: 18,
  // Camera azimuth (horizontal rotation) around the focus point, in degrees.
  // 0 = the default straight-down-the-battlefield-axis view; ±90 looks across it.
  yawDegrees: 0,
  // Perspective field of view, in degrees. Low = telephoto/flat (near-orthographic);
  // high = wide-angle/dramatic. Changes the sense of depth independently of zoom.
  fov: 45,
  // Manual nudge of the camera eye, layered on top of the computed orbit
  // position so follow/pan/zoom still work underneath. 0 = no nudge.
  positionOffsetX: 0,
  positionOffsetY: 0,
  positionOffsetZ: 0,
  // When true the X/Y/Z nudge is camera-relative (X = camera-right, Z =
  // camera-forward, Y = world-up) so it rotates with yaw — a truck/dolly/crane.
  // When false the nudge is in fixed world axes.
  positionOffsetCameraRelative: true,
  // How smoothly the eye glides to its computed position, 0..1. 0 = instant snap
  // (the original behaviour); higher = longer catch-up for a cinematic glide.
  positionSmoothing: 0,
  // How fast pan inputs (controller stick, edge-scroll, middle-drag) slide the
  // focus point across the map.
  moveSpeed: 1.5,
  // Per-step zoom rate shared by the wheel and the continuous keyboard/controller zoom.
  zoomSpeed: 5,
  // Closest / farthest the camera may zoom (world units of orbit distance).
  minDistance: 75,
  maxDistance: 200,
  // How quickly the camera eases toward selected troops / a piloted unit.
  followSpeed: 1.5,
  // Width (CSS px) of the screen-edge band that triggers edge-pan.
  edgePanMargin: 24,
  // World units the focus slides per pixel of middle-mouse drag.
  dragPanSensitivity: 0.6,
  // Fraction of zoom distance the look-at point is biased forward of a followed
  // selection, so troops sit in the lower screen instead of dead center.
  followScreenBias: 0.25,
  // Same forward bias for a piloted King/Queen (rides a touch higher).
  monarchScreenBias: 0.28,
  // Orbit distance the camera opens each match at.
  initialDistance: 200,
  // Depth (toward the battlefield) of the opening focus point.
  initialFocusDepth: 225,
};
export type CameraSettings = typeof DEFAULT_CAMERA_SETTINGS;

const loadCameraSettings = (): CameraSettings => {
  try {
    const raw = localStorage.getItem(CAMERA_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CAMERA_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<CameraSettings>;
    // Merge over defaults so a missing/older key never yields NaN or undefined.
    return { ...DEFAULT_CAMERA_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_CAMERA_SETTINGS };
  }
};

// Best-effort persistence: a write failure (private mode / disabled storage)
// must never throw — the setting still applies for the current session.
const persist = (storageKey: string, value: string): void => {
  try {
    localStorage.setItem(storageKey, value);
  } catch {
    /* localStorage unavailable; setting still applies for the session */
  }
};

// --- Store ----------------------------------------------------------------

export interface UiSettingsState {
  lightingSettings: LightingSettings;
  // Updates state only; the Settings video tab persists lighting to localStorage
  // itself, so writing here too would double up. Preserve the original division.
  updateLightingSettings: (settings: Partial<LightingSettings>) => void;

  shadowsEnabled: boolean;
  setShadowsEnabled: (enabled: boolean) => void;

  healthBarsEnabled: boolean;
  setHealthBarsEnabled: (enabled: boolean) => void;

  unitAurasEnabled: boolean;
  setUnitAurasEnabled: (enabled: boolean) => void;

  musicEnabled: boolean;
  setMusicEnabled: (enabled: boolean) => void;

  controlSpeeds: ControlSpeeds;
  updateControlSpeeds: (settings: Partial<ControlSpeeds>) => void;

  // Live camera framing/feel, driven by the F5 admin panel. Pure presentation
  // (never enters the tick), so the per-frame CameraController loop is free to
  // read these without any determinism risk.
  cameraSettings: CameraSettings;
  updateCameraSettings: (settings: Partial<CameraSettings>) => void;
  resetCameraSettings: () => void;

  // Remappable controls. Keyboard/mouse and controller each carry a full binding
  // map (which input) plus a parallel activation-mode map (tap / double-tap /
  // hold / chord); see components/Working/controlBindings.ts. Setters persist via
  // that module so a player's layout survives reloads.
  keyboardBindings: ControlBindings;
  controllerBindings: ControlBindings;
  keyboardBindingModes: ControlBindingModes;
  controllerBindingModes: ControlBindingModes;
  setBinding: (device: InputDevice, actionId: ControlActionId, token: string) => void;
  setBindingMode: (device: InputDevice, actionId: ControlActionId, mode: ActivationMode) => void;
  resetBindings: (device: InputDevice) => void;
}

export const useUiSettingsStore = create<UiSettingsState>((set) => ({
  lightingSettings: loadLightingSettings(),
  updateLightingSettings: (settings) =>
    set((state) => ({
      lightingSettings: { ...state.lightingSettings, ...settings },
    })),

  shadowsEnabled: loadShadowsEnabled(),
  setShadowsEnabled: (enabled) => {
    persist(SHADOWS_STORAGE_KEY, String(enabled));
    set({ shadowsEnabled: enabled });
  },

  healthBarsEnabled: loadBooleanDefaultOn(HEALTH_BARS_STORAGE_KEY),
  setHealthBarsEnabled: (enabled) => {
    persist(HEALTH_BARS_STORAGE_KEY, String(enabled));
    set({ healthBarsEnabled: enabled });
  },

  unitAurasEnabled: loadBooleanDefaultOn(UNIT_AURAS_STORAGE_KEY),
  setUnitAurasEnabled: (enabled) => {
    persist(UNIT_AURAS_STORAGE_KEY, String(enabled));
    set({ unitAurasEnabled: enabled });
  },

  musicEnabled: loadBooleanDefaultOn(MUSIC_STORAGE_KEY),
  setMusicEnabled: (enabled) => {
    persist(MUSIC_STORAGE_KEY, String(enabled));
    set({ musicEnabled: enabled });
  },

  controlSpeeds: loadControlSpeeds(),
  updateControlSpeeds: (settings) =>
    set((state) => {
      const next = { ...state.controlSpeeds, ...settings };
      persist(CONTROL_SPEEDS_STORAGE_KEY, JSON.stringify(next));
      return { controlSpeeds: next };
    }),

  cameraSettings: loadCameraSettings(),
  updateCameraSettings: (settings) =>
    set((state) => {
      const next = { ...state.cameraSettings, ...settings };
      persist(CAMERA_SETTINGS_STORAGE_KEY, JSON.stringify(next));
      return { cameraSettings: next };
    }),
  resetCameraSettings: () => {
    const defaults = { ...DEFAULT_CAMERA_SETTINGS };
    persist(CAMERA_SETTINGS_STORAGE_KEY, JSON.stringify(defaults));
    set({ cameraSettings: defaults });
  },

  keyboardBindings: loadBindings('keyboard'),
  controllerBindings: loadBindings('controller'),
  keyboardBindingModes: loadModes('keyboard'),
  controllerBindingModes: loadModes('controller'),
  setBinding: (device, actionId, token) =>
    set((state) => {
      const isKeyboard = device === 'keyboard';
      const bindings = isKeyboard ? state.keyboardBindings : state.controllerBindings;
      const modes = isKeyboard ? state.keyboardBindingModes : state.controllerBindingModes;
      // Pass the mode map so a transfer only unbinds another action sharing the same
      // (token, mode) pair — two actions may share one input under different modes.
      const updated = applyBinding(bindings, modes, actionId, token);
      saveBindings(device, updated);
      return isKeyboard ? { keyboardBindings: updated } : { controllerBindings: updated };
    }),
  setBindingMode: (device, actionId, mode) =>
    set((state) => {
      const isKeyboard = device === 'keyboard';
      const bindings = isKeyboard ? state.keyboardBindings : state.controllerBindings;
      const modes = isKeyboard ? state.keyboardBindingModes : state.controllerBindingModes;
      const next = applyBindingMode(bindings, modes, actionId, mode);
      saveBindings(device, next.bindings);
      saveModes(device, next.modes);
      return isKeyboard
        ? { keyboardBindings: next.bindings, keyboardBindingModes: next.modes }
        : { controllerBindings: next.bindings, controllerBindingModes: next.modes };
    }),
  resetBindings: (device) =>
    set(() => {
      const defaults = getDefaultBindings(device);
      const defaultModes = getDefaultModes(device);
      saveBindings(device, defaults);
      saveModes(device, defaultModes);
      return device === 'keyboard'
        ? { keyboardBindings: defaults, keyboardBindingModes: defaultModes }
        : { controllerBindings: defaults, controllerBindingModes: defaultModes };
    }),
}));

// Exported for tests and the determinism harness so they reference the same
// storage keys/defaults rather than re-deriving them.
export const UI_SETTINGS_STORAGE_KEYS = {
  lighting: LIGHTING_STORAGE_KEY,
  shadows: SHADOWS_STORAGE_KEY,
  healthBars: HEALTH_BARS_STORAGE_KEY,
  unitAuras: UNIT_AURAS_STORAGE_KEY,
  music: MUSIC_STORAGE_KEY,
  controlSpeeds: CONTROL_SPEEDS_STORAGE_KEY,
  cameraSettings: CAMERA_SETTINGS_STORAGE_KEY,
} as const;
