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

export type ControlActionId =
  | 'cameraForward'
  | 'cameraBackward'
  | 'cameraLeft'
  | 'cameraRight'
  | 'cameraZoomIn'
  | 'cameraZoomOut'
  | 'selectAll'
  | 'selectGroup1'
  | 'selectGroup2'
  | 'selectGroup3'
  | 'deselect'
  | 'primaryAction'
  | 'secondaryAction'
  | 'setQueenRally'
  | 'pilotCycleMonarch'
  | 'pilotMonarch1'
  | 'pilotMonarch2'
  | 'pilotMonarch3'
  | 'pilotToggleMonarch'
  | 'pause';

export type InputDevice = 'keyboard' | 'controller';

export type ControlCategory = 'Camera' | 'Selection' | 'Commands' | 'Pilot' | 'System';

/** A binding map assigns one input token to every bindable action. */
export type ControlBindings = Record<ControlActionId, string>;

export interface ControlActionMeta {
  id: ControlActionId;
  label: string;
  category: ControlCategory;
  description: string;
}

export const UNBOUND_TOKEN = '';
export const CONTROLLER_DEADZONE = 0.35;

const KEYBOARD_STORAGE_KEY = 'rts-keyboard-bindings';
const CONTROLLER_STORAGE_KEY = 'rts-controller-bindings';

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
  { id: 'selectAll', label: 'Select All / Rally', category: 'Selection', description: 'Select every one of your units. While piloting a King/Queen, this same key instead rallies that animal’s units to follow the monarch.' },
  { id: 'selectGroup1', label: 'Select Animal Type 1', category: 'Selection', description: 'Select all units of your first animal.' },
  { id: 'selectGroup2', label: 'Select Animal Type 2', category: 'Selection', description: 'Select all units of your second animal.' },
  { id: 'selectGroup3', label: 'Select Animal Type 3', category: 'Selection', description: 'Select all units of your third animal.' },
  { id: 'deselect', label: 'Deselect All', category: 'Selection', description: 'Clear the current selection.' },
  { id: 'primaryAction', label: 'Select / Confirm', category: 'Commands', description: 'Select the unit under the cursor / reticle.' },
  { id: 'secondaryAction', label: 'Move / Attack', category: 'Commands', description: 'Order selected units to the cursor / reticle.' },
  { id: 'setQueenRally', label: 'Set Spawn Rally Point', category: 'Commands', description: 'With a single Queen selected, press once to start aiming the blue rally line, then press again to drop the rally point. Units she spawns afterward march straight to it.' },
  { id: 'pilotCycleMonarch', label: 'Cycle Piloted Monarch', category: 'Pilot', description: 'Tap to start piloting your first animal’s King, then cycle through your other animals’ monarchs. Drive it with the Move keys.' },
  { id: 'pilotMonarch1', label: 'Pilot Monarch 1', category: 'Pilot', description: 'Directly pilot the King of your first animal (toggle Queen with Toggle Monarch). Drive it with the Move keys/stick.' },
  { id: 'pilotMonarch2', label: 'Pilot Monarch 2', category: 'Pilot', description: 'Directly pilot the King of your second animal. Drive it with the Move keys/stick.' },
  { id: 'pilotMonarch3', label: 'Pilot Monarch 3', category: 'Pilot', description: 'Directly pilot the King of your third animal. Drive it with the Move keys/stick.' },
  { id: 'pilotToggleMonarch', label: 'Toggle King / Queen', category: 'Pilot', description: 'While piloting, switch between the King and the Queen of the same animal.' },
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
  selectAll: 'space',
  selectGroup1: 'shift+a',
  selectGroup2: 'shift+s',
  selectGroup3: 'shift+d',
  deselect: 'escape',
  primaryAction: 'mouse:left',
  secondaryAction: 'mouse:right',
  // R aims and drops a Queen's spawn rally point (two taps; see HexInteraction).
  setQueenRally: 'r',
  // A cycles through the three animals' monarchs; G swaps the current King/Queen.
  // The per-slot pilot keys stay unbound on keyboard (they exist for the
  // controller's D-Pad), so the home row stays free for the cycle/toggle keys.
  pilotCycleMonarch: 'a',
  pilotMonarch1: '',
  pilotMonarch2: '',
  pilotMonarch3: '',
  pilotToggleMonarch: 'g',
  pause: 'p',
};

export const DEFAULT_CONTROLLER_BINDINGS: ControlBindings = {
  cameraForward: 'axis:1-',
  cameraBackward: 'axis:1+',
  cameraLeft: 'axis:0-',
  cameraRight: 'axis:0+',
  cameraZoomIn: 'button:7', // RT
  cameraZoomOut: 'button:6', // LT
  selectAll: 'button:2', // X
  selectGroup1: 'button:4+button:0', // LB + A
  selectGroup2: 'button:4+button:1', // LB + B
  selectGroup3: 'button:4+button:3', // LB + Y
  deselect: 'button:3', // Y
  primaryAction: 'button:0', // A
  secondaryAction: 'button:1', // B
  setQueenRally: '', // keyboard-only gesture for now
  pilotCycleMonarch: '', // keyboard-only; the controller uses the per-slot D-Pad pilots below
  pilotMonarch1: 'button:12', // D-Pad Up
  pilotMonarch2: 'button:14', // D-Pad Left
  pilotMonarch3: 'button:15', // D-Pad Right
  pilotToggleMonarch: 'button:13', // D-Pad Down
  pause: 'button:9', // Start
};

export function getDefaultBindings(device: InputDevice): ControlBindings {
  return device === 'keyboard'
    ? { ...DEFAULT_KEYBOARD_BINDINGS }
    : { ...DEFAULT_CONTROLLER_BINDINGS };
}

function storageKey(device: InputDevice): string {
  return device === 'keyboard' ? KEYBOARD_STORAGE_KEY : CONTROLLER_STORAGE_KEY;
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
 * Apply a single rebind immutably. Assigning a token already used by another
 * action transfers it: the previous holder is unbound so two actions never share
 * one input. Returns a new map; the input is not mutated.
 */
export function applyBinding(
  bindings: ControlBindings,
  actionId: ControlActionId,
  token: string
): ControlBindings {
  const next: ControlBindings = { ...bindings };
  if (token !== UNBOUND_TOKEN) {
    for (const id of ACTION_IDS) {
      if (id !== actionId && next[id] === token) {
        next[id] = UNBOUND_TOKEN;
      }
    }
  }
  next[actionId] = token;
  return next;
}

/** Return the action currently holding `token`, ignoring `exceptId`, else null. */
export function findConflict(
  bindings: ControlBindings,
  token: string,
  exceptId: ControlActionId
): ControlActionId | null {
  if (token === UNBOUND_TOKEN) return null;
  for (const id of ACTION_IDS) {
    if (id !== exceptId && bindings[id] === token) return id;
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
