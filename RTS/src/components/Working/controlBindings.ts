/**
 * controlBindings — single source of truth for the game's remappable controls.
 *
 * This module is intentionally free of React and Three.js so it can be unit
 * tested in isolation and reused by every input consumer (camera, keyboard
 * shortcuts, map interaction, gamepad poller) and by the Settings UI. It owns:
 *   - the canonical catalog of bindable actions (shared across input devices),
 *   - the default keyboard/mouse and controller maps,
 *   - localStorage persistence (with forward-compatible default merging),
 *   - pure helpers for turning raw input events into binding "tokens",
 *   - human-readable formatting of those tokens for the Settings screen,
 *   - conflict detection so two actions can't silently share one input,
 *   - gamepad token evaluation used by the runtime poller.
 *
 * Token grammar
 * -------------
 * Keyboard/mouse tokens:
 *   - a single key, lower-cased: "w", "escape", "space"
 *   - an optional modifier chord joined with "+": "shift+a"
 *   - a mouse button: "mouse:left" | "mouse:middle" | "mouse:right"
 *   - a scroll wheel direction: "wheelup" | "wheeldown"
 * Controller tokens (Standard Gamepad mapping):
 *   - a button: "button:0" (A) ... "button:15" (D-Pad Right)
 *   - an axis deflection: "axis:1-" (left stick up) / "axis:1+" (left stick down)
 *   - a chord joined with "+": "button:4+button:0" (LB + A)
 * An empty string ("") means the action is intentionally unbound.
 */

import {
  type ActivationMode,
  isActivationMode,
} from './gestureModes';

export type ControlActionId =
  | 'cameraForward'
  | 'cameraBackward'
  | 'cameraLeft'
  | 'cameraRight'
  | 'cameraZoomIn'
  | 'cameraZoomOut'
  | 'rally'
  | 'selectMonarchAnimal'
  | 'selectAllUnits'
  | 'deployUnits'
  | 'selectGroup1'
  | 'selectGroup2'
  | 'selectGroup3'
  | 'deselect'
  | 'primaryAction'
  | 'secondaryAction'
  | 'useAbility'
  | 'setQueenRally'
  | 'setPatrol'
  | 'toggleBehaviorRadial'
  | 'toggleDirectingRadial'
  | 'pilotCycleMonarch'
  | 'pilotMonarch1'
  | 'pilotMonarch2'
  | 'pilotMonarch3'
  | 'pilotToggleMonarch'
  | 'cycleFireTeam'
  | 'pause';

export type InputDevice = 'keyboard' | 'controller';

export type ControlCategory = 'Camera' | 'Selection' | 'Commands' | 'Pilot' | 'System';

/** A binding map assigns one input token to every bindable action. */
export type ControlBindings = Record<ControlActionId, string>;

/**
 * The activation mode for each action's bound input: whether the action triggers
 * on a Tap, Double-Tap, Hold, or Chord of that input. Kept as a parallel map to
 * ControlBindings (rather than folded into it) so the token (what input) and the
 * mode (how it's pressed) persist and rebind independently — and so the many
 * token-only consumers keep reading a plain string and stay untouched.
 */
export type ControlBindingModes = Record<ControlActionId, ActivationMode>;

export interface ControlActionMeta {
  id: ControlActionId;
  label: string;
  category: ControlCategory;
  description: string;
  /**
   * Optional always-visible sub-line for multi-gesture actions whose single
   * binding carries several behaviors (tap / double-tap / hold). Kept terser than
   * `description` (the hover tooltip) so the Settings row stays scannable while
   * still surfacing the gestures without a hover. Omitted for single-behavior actions.
   */
  gestureHint?: string;
}

export const UNBOUND_TOKEN = '';
export const CONTROLLER_DEADZONE = 0.35;

const KEYBOARD_STORAGE_KEY = 'rts-keyboard-bindings';
const CONTROLLER_STORAGE_KEY = 'rts-controller-bindings';
const KEYBOARD_MODES_STORAGE_KEY = 'rts-keyboard-binding-modes';
const CONTROLLER_MODES_STORAGE_KEY = 'rts-controller-binding-modes';

/**
 * Catalog of every bindable action. Order here drives the order rows appear in
 * the Settings screen, grouped by category. Both input devices map the same set
 * of actions so the two Settings sub-tabs stay conceptually aligned.
 */
export const CONTROL_ACTIONS: readonly ControlActionMeta[] = [
  { id: 'cameraForward', label: 'Move Forward', category: 'Camera', description: 'Drives a piloted King/Queen forward. On a controller, the left stick also pans the camera. (Pan the camera with edge-scroll or middle-mouse drag.)' },
  { id: 'cameraBackward', label: 'Move Backward', category: 'Camera', description: 'Drives a piloted King/Queen backward. On a controller, the left stick also pans the camera.' },
  { id: 'cameraLeft', label: 'Move Left', category: 'Camera', description: 'Drives a piloted King/Queen left. On a controller, the left stick also pans the camera.' },
  { id: 'cameraRight', label: 'Move Right', category: 'Camera', description: 'Drives a piloted King/Queen right. On a controller, the left stick also pans the camera.' },
  { id: 'cameraZoomIn', label: 'Zoom In', category: 'Camera', description: 'Bring the camera closer to the map.' },
  { id: 'cameraZoomOut', label: 'Zoom Out', category: 'Camera', description: 'Pull the camera back from the map.' },
  { id: 'rally', label: 'Rally to Monarch', category: 'Selection', description: 'While piloting a King/Queen, rally that animal’s units to fall in and follow the monarch.' },
  { id: 'selectMonarchAnimal', label: 'Select Monarch’s Animal', category: 'Selection', description: 'Select every one of your units that share the animal of the King/Queen you are currently piloting (e.g. while piloting the Bee monarch, selects all your Bees). On the controller this is LT — a double-tap of LT selects all units instead.' },
  { id: 'selectAllUnits', label: 'Select All Units', category: 'Selection', description: 'Select every one of your units. Defaults to a double-tap (Space on keyboard, LT on controller) so it can share an input with single-tap selects.' },
  { id: 'deployUnits', label: 'Deploy Units', category: 'Selection', description: 'While piloting a King/Queen, deploy units at the monarch. Hold to designate a proportionate batch (the longer the hold, the more units peel off — the teardrop count); a Tap or Double-Tap deploys a single unit.', gestureHint: 'Hold = a batch · Tap = one unit' },
  { id: 'selectGroup1', label: 'Select Animal Type 1', category: 'Selection', description: 'Select all units of your first animal.' },
  { id: 'selectGroup2', label: 'Select Animal Type 2', category: 'Selection', description: 'Select all units of your second animal.' },
  { id: 'selectGroup3', label: 'Select Animal Type 3', category: 'Selection', description: 'Select all units of your third animal.' },
  { id: 'deselect', label: 'Deselect All', category: 'Selection', description: 'Clear the current selection.' },
  { id: 'primaryAction', label: 'Select / Confirm', category: 'Commands', description: 'Select the unit under the cursor / reticle.' },
  { id: 'secondaryAction', label: 'Move / Attack', category: 'Commands', description: 'Order selected units to the cursor / reticle (press). On the controller this is RT: a press issues the move/attack at the cursor, and holding RT deploys units at the cursor.', gestureHint: 'Press = move/attack · Hold = deploy at cursor' },
  { id: 'useAbility', label: 'Use Ability', category: 'Commands', description: "Trigger the selected animal's special ability (Turtle shell, Chicken eggs, Frog tongue, Cat hiss, Bee swarm, Owl pickup/deliver), aimed at the cursor/reticle. Keyboard & mouse can also fire this with a simultaneous left + right click." },
  { id: 'setQueenRally', label: 'Set Spawn Rally Point', category: 'Commands', description: 'With a single Queen selected, press to start aiming the blue rally line, then issue Move / Attack (right-click on mouse) to drop the rally point. Units she spawns afterward march straight to it — or follow a friendly King dropped on. On the controller this is RB.', gestureHint: 'Aim, then Move/Attack to drop' },
  { id: 'setPatrol', label: 'Set Patrol Route', category: 'Commands', description: 'With a single Queen selected, hold to aim a back-and-forth patrol route along the gold line, then release to commit it. Keyboard & mouse use a held right-click on the Queen instead, so this stays unbound there by default.', gestureHint: 'Hold to aim · release to set the route' },
  { id: 'toggleBehaviorRadial', label: 'Combat Posture Radial', category: 'Commands', description: 'With your units selected, open the two-ring combat-posture radial: the center toggles weapons-free / hold-fire, the inner ring sets stance (Aggressive, Skirmish, Hold Ground, Defensive, Flee), and the outer ring sets target priority (Nearest, Weakest, Threat, Ranged, Royalty). On a controller this is D-Pad Left; aim with the right stick (deflection picks the ring), press RT to apply the highlighted option, and B to close.' },
  { id: 'toggleDirectingRadial', label: 'Directing Wheel', category: 'Commands', description: 'With your units selected, open the paged Directing wheel. Flip between its three pages with LB / RB (or the on-screen tabs): Shapes — Line, Column, Wedge, Box, Echelon L/R, Skirmish; Audibles — a quick mid-play tweak (Rotate Left/Right, Expand, Contract, Disband) to the selected team; Plays — one call (Assault, Pincer, Hold, Turtle, Fall Back) re-shapes ALL your formed teams at once by their wing. On a controller this is D-Pad Right; aim with the right stick, press RT to apply the highlighted option, and B to close.' },
  { id: 'pilotCycleMonarch', label: 'Cycle Piloted Monarch', category: 'Pilot', description: 'Tap to start piloting your first animal’s King, then cycle through your other animals’ monarchs. Drive it with the Move keys.' },
  { id: 'pilotMonarch1', label: 'Pilot Monarch 1', category: 'Pilot', description: 'Directly pilot the King of your first animal (toggle Queen with Toggle Monarch). Drive it with the Move keys/stick.' },
  { id: 'pilotMonarch2', label: 'Pilot Monarch 2', category: 'Pilot', description: 'Directly pilot the King of your second animal. Drive it with the Move keys/stick.' },
  { id: 'pilotMonarch3', label: 'Pilot Monarch 3', category: 'Pilot', description: 'Directly pilot the King of your third animal. Drive it with the Move keys/stick.' },
  { id: 'pilotToggleMonarch', label: 'Toggle King / Queen', category: 'Pilot', description: 'While piloting, switch between the King and the Queen of the same animal.' },
  { id: 'cycleFireTeam', label: 'Cycle Fire Team', category: 'Pilot', description: 'Cycle drive control through the fire teams you have deployed (each batch dropped by a Deploy hold forms a team), then back to none. While a team is selected, drive all of its units at once with the Move keys/stick — letting a monarch steer a deployed squad from across the map.' },
  { id: 'pause', label: 'Pause Game', category: 'System', description: 'Toggle the pause menu.' },
] as const;

const ACTION_IDS: readonly ControlActionId[] = CONTROL_ACTIONS.map((action) => action.id);

export const DEFAULT_KEYBOARD_BINDINGS: ControlBindings = {
  // ESDF cluster drives a piloted monarch (E=forward, S=left, D=back, F=right).
  // The camera no longer pans from the keyboard — edge-scroll and middle-mouse
  // drag (see CameraController) handle panning, leaving the left hand for hotkeys.
  cameraForward: 'e',
  cameraBackward: 'd',
  cameraLeft: 's',
  cameraRight: 'f',
  cameraZoomIn: 'wheelup',
  cameraZoomOut: 'wheeldown',
  // Rally / Select All Units / Deploy Units share Space by default; their distinct
  // activation modes (tap / double-tap / hold — see DEFAULT_BINDING_MODES) keep them
  // apart, reproducing the classic one-key Space gesture while staying remappable.
  rally: 'space',
  // Select-the-piloted-monarch's-animal is a controller-first gesture (LT); it
  // stays unbound on keyboard by default.
  selectMonarchAnimal: '',
  selectAllUnits: 'space',
  deployUnits: 'space',
  selectGroup1: 'shift+a',
  selectGroup2: 'shift+s',
  selectGroup3: 'shift+d',
  deselect: 'escape',
  primaryAction: 'mouse:left',
  secondaryAction: 'mouse:right',
  // Abilities fire from a simultaneous left+right click (a fixed mouse gesture in
  // HexInteraction), so the rebindable key stays unbound by default; binding a key
  // here also triggers it (HexInteraction reads the live cursor for aiming).
  useAbility: '',
  // R arms a Queen's spawn rally aim; a right-click then drops it (see HexInteraction).
  setQueenRally: 'r',
  // Patrol on keyboard & mouse is the held right-click on a lone Queen (a mouse
  // gesture in HexInteraction), so no dedicated key is bound here by default.
  setPatrol: '',
  // B opens the combat-posture radial for the current selection.
  toggleBehaviorRadial: 'b',
  // V opens the paged Directing wheel (Shapes / Audibles / Plays); flip pages with
  // Tab while it is open or click the on-screen tabs.
  toggleDirectingRadial: 'v',
  // A cycles through the three animals' monarchs; G swaps the current King/Queen.
  // The per-slot pilot keys stay unbound on keyboard (they exist for the
  // controller's D-Pad), so the home row stays free for the cycle/toggle keys.
  pilotCycleMonarch: 'a',
  pilotMonarch1: '',
  pilotMonarch2: '',
  pilotMonarch3: '',
  pilotToggleMonarch: 'g',
  // T cycles drive control through your deployed fire teams (Team).
  cycleFireTeam: 't',
  pause: 'p',
};

// Controller layout (Standard Gamepad). Left stick pilots the monarch; right
// stick drives the targeting cursor (and, while a radial wheel is open, aims it).
// Every input is single-purpose — there are no tap/hold overloads on the D-pad:
//   LT  — Select Monarch's Animal (tap) / Select All Units (double-tap)
//   RT  — Move/Attack (press) / Deploy at cursor (hold)  [via secondaryAction]
//   LB  — Switch Monarch (cycle)        RB — Arm Queen spawn-rally
//   L3  — Set Patrol aim (hold)         R3 — Rally to monarch
//   A   — Select / Confirm              B  — Deselect / close wheel
//   X   — Use Ability                   Y  — Switch King/Queen
//   D-Pad — Up/Down Zoom In/Out, Left Combat wheel, Right Directing wheel
//   Start — Pause / Settings menu
// While the Directing wheel is open, LB/RB instead flip its pages (modal); see
// GamepadController.
const DPAD_UP = 'button:12';
const DPAD_DOWN = 'button:13';
const DPAD_LEFT = 'button:14';
const DPAD_RIGHT = 'button:15';

// Standard-mapping shoulder buttons. The Directing wheel reserves these as a fixed
// page-flip convention while it is open (LB = previous page, RB = next) — see the
// wheel footer and the toggleDirectingRadial help text. Paging therefore reads the
// physical bumpers directly rather than whatever remappable action happens to be
// bound to them, so it can never be silently lost when a shoulder binding is unbound
// or persisted from an older mapping (e.g. setQueenRally only became RB in the 2026
// "simplify controller mappings" change; pre-change saves store it as unbound).
export const LEFT_BUMPER = 'button:4';
export const RIGHT_BUMPER = 'button:5';
export const DEFAULT_CONTROLLER_BINDINGS: ControlBindings = {
  cameraForward: 'axis:1-',   // Left stick (pilot the monarch)
  cameraBackward: 'axis:1+',
  cameraLeft: 'axis:0-',
  cameraRight: 'axis:0+',
  // Zoom is held on the D-Pad vertical axis (read analogically by the camera block).
  cameraZoomIn: DPAD_UP,    // D-Pad Up
  cameraZoomOut: DPAD_DOWN, // D-Pad Down
  rally: 'button:11', // R3 — rally the piloted army to the monarch
  // LT: tap selects the piloted monarch's animal; double-tap selects all units.
  selectMonarchAnimal: 'button:6', // LT (tap)
  selectAllUnits: 'button:6',      // LT (double-tap)
  // Deploy-at-cursor rides the RT (secondaryAction) hold in GamepadController, so
  // the standalone deploy-at-monarch action is unbound on the controller.
  deployUnits: '',
  // Per-animal group selects move to the keyboard; LB is Switch Monarch, so the
  // old LB+face chords are unbound here.
  selectGroup1: '',
  selectGroup2: '',
  selectGroup3: '',
  deselect: 'button:1', // B
  primaryAction: 'button:0', // A — Select / Confirm
  secondaryAction: 'button:7', // RT — Move/Attack (press) + Deploy (hold)
  useAbility: 'button:2', // X — fires the selected animal's ability at the reticle
  setQueenRally: 'button:5', // RB — arm the Queen spawn-rally aim (committed by RT)
  setPatrol: 'button:10', // L3 held arms the patrol aim; release commits
  // The two radial wheels live on the D-Pad horizontal axis (tap to open; aim with
  // the right stick, RT to select, B to close).
  toggleBehaviorRadial: DPAD_LEFT,   // Left — Combat posture
  toggleDirectingRadial: DPAD_RIGHT, // Right — Directing (Shapes / Audibles / Plays)
  pilotCycleMonarch: 'button:4', // LB — Switch Monarch
  // The left stick pilots and LB cycles monarchs, so the old per-slot D-Pad pilots
  // stay unbound.
  pilotMonarch1: '',
  pilotMonarch2: '',
  pilotMonarch3: '',
  pilotToggleMonarch: 'button:3', // Y — Switch King / Queen
  cycleFireTeam: 'button:8', // Back/View — cycle drive control through deployed fire teams
  pause: 'button:9', // Start — Pause / Settings
};

export function getDefaultBindings(device: InputDevice): ControlBindings {
  return device === 'keyboard'
    ? { ...DEFAULT_KEYBOARD_BINDINGS }
    : { ...DEFAULT_CONTROLLER_BINDINGS };
}

/**
 * Default activation mode for every action. Most actions are a plain Tap. The
 * three Space/X-sharing actions and the inherently-held gestures take distinct
 * modes so they coexist on one input and preserve today's feel:
 *   - selectAllUnits: Double-Tap (the classic double-tap-Space select-all),
 *   - deployUnits: Hold (hold to deploy a proportionate batch),
 *   - setPatrol: Hold (its hold-to-aim gesture).
 * Modes are device-agnostic by default, so both devices start from this map.
 */
export const DEFAULT_BINDING_MODES: ControlBindingModes = {
  cameraForward: 'tap',
  cameraBackward: 'tap',
  cameraLeft: 'tap',
  cameraRight: 'tap',
  cameraZoomIn: 'tap',
  cameraZoomOut: 'tap',
  rally: 'tap',
  // LT shares one input: a tap selects the monarch's animal, a double-tap selects
  // all units (same token, distinct modes — like Space on keyboard).
  selectMonarchAnimal: 'tap',
  selectAllUnits: 'double-tap',
  deployUnits: 'hold',
  selectGroup1: 'tap',
  selectGroup2: 'tap',
  selectGroup3: 'tap',
  deselect: 'tap',
  primaryAction: 'tap',
  secondaryAction: 'tap',
  useAbility: 'tap',
  setQueenRally: 'tap',
  setPatrol: 'hold',
  toggleBehaviorRadial: 'tap',
  toggleDirectingRadial: 'tap',
  pilotCycleMonarch: 'tap',
  pilotMonarch1: 'tap',
  pilotMonarch2: 'tap',
  pilotMonarch3: 'tap',
  pilotToggleMonarch: 'tap',
  cycleFireTeam: 'tap',
  pause: 'tap',
};

export function getDefaultModes(_device: InputDevice): ControlBindingModes {
  return { ...DEFAULT_BINDING_MODES };
}

function storageKey(device: InputDevice): string {
  return device === 'keyboard' ? KEYBOARD_STORAGE_KEY : CONTROLLER_STORAGE_KEY;
}

function modesStorageKey(device: InputDevice): string {
  return device === 'keyboard' ? KEYBOARD_MODES_STORAGE_KEY : CONTROLLER_MODES_STORAGE_KEY;
}

/**
 * Merge a partial/persisted map over the defaults so newly added actions always
 * resolve to a sane default even when an older saved map predates them. Unknown
 * keys in the stored object are ignored.
 */
export function mergeWithDefaults(
  device: InputDevice,
  stored: Partial<ControlBindings> | null | undefined
): ControlBindings {
  const merged = getDefaultBindings(device);
  if (!stored) return merged;
  for (const id of ACTION_IDS) {
    const value = stored[id];
    if (typeof value === 'string') {
      merged[id] = value;
    }
  }
  return merged;
}

export function loadBindings(device: InputDevice): ControlBindings {
  try {
    const raw = localStorage.getItem(storageKey(device));
    if (!raw) return getDefaultBindings(device);
    return mergeWithDefaults(device, JSON.parse(raw) as Partial<ControlBindings>);
  } catch {
    // Corrupt JSON or unavailable storage (private mode) — fall back to defaults.
    return getDefaultBindings(device);
  }
}

export function saveBindings(device: InputDevice, bindings: ControlBindings): void {
  try {
    localStorage.setItem(storageKey(device), JSON.stringify(bindings));
  } catch {
    /* localStorage unavailable; the in-memory binding still applies this session */
  }
}

/**
 * Merge a partial/persisted activation-mode map over the defaults. Unknown keys and
 * any value that isn't a real ActivationMode are ignored, so older saves (which had
 * no modes at all) and forward-compatible additions both resolve sanely.
 */
export function mergeModesWithDefaults(
  device: InputDevice,
  stored: Partial<ControlBindingModes> | null | undefined
): ControlBindingModes {
  const merged = getDefaultModes(device);
  if (!stored) return merged;
  for (const id of ACTION_IDS) {
    const value = stored[id];
    if (isActivationMode(value)) {
      merged[id] = value;
    }
  }
  return merged;
}

export function loadModes(device: InputDevice): ControlBindingModes {
  try {
    const raw = localStorage.getItem(modesStorageKey(device));
    if (!raw) return getDefaultModes(device);
    return mergeModesWithDefaults(device, JSON.parse(raw) as Partial<ControlBindingModes>);
  } catch {
    return getDefaultModes(device);
  }
}

export function saveModes(device: InputDevice, modes: ControlBindingModes): void {
  try {
    localStorage.setItem(modesStorageKey(device), JSON.stringify(modes));
  } catch {
    /* localStorage unavailable; the in-memory mode still applies this session */
  }
}

/**
 * Apply a single token rebind immutably. Two actions may now share one input as
 * long as their activation modes differ, so a token is "in use" only when another
 * action holds the SAME token AND the SAME mode — that holder is unbound (the input
 * transfers). Returns a new bindings map; inputs are not mutated.
 */
export function applyBinding(
  bindings: ControlBindings,
  modes: ControlBindingModes,
  actionId: ControlActionId,
  token: string
): ControlBindings {
  const next: ControlBindings = { ...bindings };
  if (token !== UNBOUND_TOKEN) {
    const mode = modes[actionId];
    for (const id of ACTION_IDS) {
      if (id !== actionId && next[id] === token && modes[id] === mode) {
        next[id] = UNBOUND_TOKEN;
      }
    }
  }
  next[actionId] = token;
  return next;
}

/**
 * Apply a single activation-mode change immutably. Changing a mode can collide with
 * another action that shares this action's token under the new mode; that holder is
 * unbound so each (token, mode) pair stays unique. Returns new maps.
 */
export function applyBindingMode(
  bindings: ControlBindings,
  modes: ControlBindingModes,
  actionId: ControlActionId,
  mode: ActivationMode
): { bindings: ControlBindings; modes: ControlBindingModes } {
  const nextModes: ControlBindingModes = { ...modes, [actionId]: mode };
  const nextBindings: ControlBindings = { ...bindings };
  const token = nextBindings[actionId];
  if (token !== UNBOUND_TOKEN) {
    for (const id of ACTION_IDS) {
      if (id !== actionId && nextBindings[id] === token && nextModes[id] === mode) {
        nextBindings[id] = UNBOUND_TOKEN;
      }
    }
  }
  return { bindings: nextBindings, modes: nextModes };
}

/**
 * Return another action sharing the SAME (token, mode) pair, ignoring `exceptId`,
 * else null. Same token under a different mode is not a conflict.
 */
export function findConflict(
  bindings: ControlBindings,
  modes: ControlBindingModes,
  token: string,
  mode: ActivationMode,
  exceptId: ControlActionId
): ControlActionId | null {
  if (token === UNBOUND_TOKEN) return null;
  for (const id of ACTION_IDS) {
    if (id !== exceptId && bindings[id] === token && modes[id] === mode) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Keyboard / mouse token helpers
// ---------------------------------------------------------------------------

const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta']);

/**
 * Convert a KeyboardEvent into a binding token, e.g. Shift+A -> "shift+a".
 * Returns "" for a press of a bare modifier so the rebind UI keeps listening
 * until a real key arrives.
 */
export function keyboardEventToToken(event: {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): string {
  let key = event.key.toLowerCase();
  if (key === ' ' || key === 'spacebar') key = 'space';
  if (MODIFIER_KEYS.has(key)) return UNBOUND_TOKEN;

  const parts: string[] = [];
  if (event.shiftKey) parts.push('shift');
  if (event.ctrlKey) parts.push('ctrl');
  if (event.altKey) parts.push('alt');
  parts.push(key);
  return parts.join('+');
}

export function mouseButtonToToken(button: number): string {
  switch (button) {
    case 0: return 'mouse:left';
    case 1: return 'mouse:middle';
    case 2: return 'mouse:right';
    default: return `mouse:${button}`;
  }
}

/** Map a mouse token back to its DOM button index, or null if not a mouse token. */
export function tokenToMouseButton(token: string): number | null {
  switch (token) {
    case 'mouse:left': return 0;
    case 'mouse:middle': return 1;
    case 'mouse:right': return 2;
    default: {
      const match = /^mouse:(\d+)$/.exec(token);
      return match ? Number(match[1]) : null;
    }
  }
}

export function wheelDeltaToToken(deltaY: number): string {
  return deltaY > 0 ? 'wheeldown' : 'wheelup';
}

const KEY_DISPLAY_NAMES: Record<string, string> = {
  space: 'Space',
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  shift: 'Shift',
  ctrl: 'Ctrl',
  alt: 'Alt',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  wheelup: 'Scroll Up',
  wheeldown: 'Scroll Down',
  'mouse:left': 'Left Click',
  'mouse:middle': 'Middle Click',
  'mouse:right': 'Right Click',
};

export function formatKeyboardToken(token: string): string {
  if (token === UNBOUND_TOKEN) return 'Unbound';
  if (KEY_DISPLAY_NAMES[token]) return KEY_DISPLAY_NAMES[token];
  return token
    .split('+')
    .map((part) => KEY_DISPLAY_NAMES[part] ?? (part.length === 1 ? part.toUpperCase() : capitalize(part)))
    .join(' + ');
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

// ---------------------------------------------------------------------------
// Controller token helpers (Standard Gamepad mapping)
// ---------------------------------------------------------------------------

const GAMEPAD_BUTTON_NAMES: Record<number, string> = {
  0: 'A', 1: 'B', 2: 'X', 3: 'Y',
  4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
  8: 'Back', 9: 'Start', 10: 'L3', 11: 'R3',
  12: 'D-Pad Up', 13: 'D-Pad Down', 14: 'D-Pad Left', 15: 'D-Pad Right',
};

const GAMEPAD_AXIS_NAMES: Record<number, string> = {
  0: 'Left Stick', 1: 'Left Stick', 2: 'Right Stick', 3: 'Right Stick',
};

export function gamepadButtonToken(index: number): string {
  return `button:${index}`;
}

export function gamepadAxisToken(axis: number, sign: '+' | '-'): string {
  return `axis:${axis}${sign}`;
}

function formatControllerAtom(atom: string): string {
  const buttonMatch = /^button:(\d+)$/.exec(atom);
  if (buttonMatch) {
    const index = Number(buttonMatch[1]);
    return GAMEPAD_BUTTON_NAMES[index] ?? `Button ${index}`;
  }
  const axisMatch = /^axis:(\d+)([+-])$/.exec(atom);
  if (axisMatch) {
    const axis = Number(axisMatch[1]);
    const sign = axisMatch[2] as '+' | '-';
    const stick = GAMEPAD_AXIS_NAMES[axis] ?? `Axis ${axis}`;
    const isVertical = axis % 2 === 1;
    let direction: string;
    if (isVertical) direction = sign === '-' ? '↑' : '↓';
    else direction = sign === '-' ? '←' : '→';
    return `${stick} ${direction}`;
  }
  return atom;
}

/**
 * Split a controller token into its atoms. We can't naively split on '+' because
 * axis tokens embed a '+'/'-' direction (e.g. "axis:0+"); a global match for the
 * atom shapes extracts them correctly even inside an "LB + A" style chord.
 */
function parseControllerAtoms(token: string): string[] {
  return token.match(/button:\d+|axis:\d+[+-]/g) ?? [];
}

export function formatControllerToken(token: string): string {
  if (token === UNBOUND_TOKEN) return 'Unbound';
  return parseControllerAtoms(token).map(formatControllerAtom).join(' + ');
}

export function formatToken(device: InputDevice, token: string): string {
  return device === 'keyboard' ? formatKeyboardToken(token) : formatControllerToken(token);
}

// ---------------------------------------------------------------------------
// Gamepad runtime evaluation (used by the in-game poller)
// ---------------------------------------------------------------------------

/** Minimal structural view of a Gamepad so this stays testable without the DOM. */
export interface GamepadLike {
  buttons: ReadonlyArray<{ pressed: boolean; value: number }>;
  axes: ReadonlyArray<number>;
}

function isButtonAtomActive(gamepad: GamepadLike, index: number): boolean {
  const button = gamepad.buttons[index];
  if (!button) return false;
  return button.pressed || button.value > 0.5;
}

function axisSignedValue(gamepad: GamepadLike, axis: number, sign: '+' | '-', deadzone: number): number {
  const value = gamepad.axes[axis] ?? 0;
  if (sign === '+') return value > deadzone ? value : 0;
  return value < -deadzone ? -value : 0; // magnitude (0..1)
}

/** Numeric activation (0..1) of a single, non-chord atom. */
function atomMagnitude(gamepad: GamepadLike, atom: string, deadzone: number): number {
  const buttonMatch = /^button:(\d+)$/.exec(atom);
  if (buttonMatch) {
    const index = Number(buttonMatch[1]);
    const button = gamepad.buttons[index];
    if (!button) return 0;
    if (button.pressed) return Math.max(button.value, 1);
    return button.value > 0.5 ? button.value : 0;
  }
  const axisMatch = /^axis:(\d+)([+-])$/.exec(atom);
  if (axisMatch) {
    return axisSignedValue(gamepad, Number(axisMatch[1]), axisMatch[2] as '+' | '-', deadzone);
  }
  return 0;
}

/**
 * True when every atom of `token` (chords split on "+") is currently active.
 * Used for digital actions like "select" or "pause".
 */
export function isControllerTokenActive(
  gamepad: GamepadLike,
  token: string,
  deadzone: number = CONTROLLER_DEADZONE
): boolean {
  if (token === UNBOUND_TOKEN) return false;
  const atoms = parseControllerAtoms(token);
  if (atoms.length === 0) return false;
  return atoms.every((atom) => atomMagnitude(gamepad, atom, deadzone) > 0);
}

/**
 * Analog activation (0..1) for a token, used for proportional camera panning.
 * For chords the weakest atom governs; for a button it is full strength.
 */
export function controllerTokenMagnitude(
  gamepad: GamepadLike,
  token: string,
  deadzone: number = CONTROLLER_DEADZONE
): number {
  if (token === UNBOUND_TOKEN) return 0;
  const atoms = parseControllerAtoms(token);
  if (atoms.length === 0) return 0;
  let magnitude = 1;
  for (const atom of atoms) {
    const value = atomMagnitude(gamepad, atom, deadzone);
    if (value <= 0) return 0;
    magnitude = Math.min(magnitude, value);
  }
  return magnitude;
}

/**
 * Scan a gamepad for the first active input and return its token, for capturing
 * a rebind. Buttons take priority over axes; only single atoms are captured
 * (chords are reserved for the shipped defaults).
 */
export function scanGamepadToken(
  gamepad: GamepadLike,
  deadzone: number = CONTROLLER_DEADZONE
): string | null {
  for (let i = 0; i < gamepad.buttons.length; i++) {
    if (isButtonAtomActive(gamepad, i)) return gamepadButtonToken(i);
  }
  for (let axis = 0; axis < gamepad.axes.length; axis++) {
    const value = gamepad.axes[axis] ?? 0;
    if (value > deadzone) return gamepadAxisToken(axis, '+');
    if (value < -deadzone) return gamepadAxisToken(axis, '-');
  }
  return null;
}

export { ACTION_IDS, KEYBOARD_STORAGE_KEY, CONTROLLER_STORAGE_KEY };
