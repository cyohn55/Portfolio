/**
 * uiGamepadNav — pure, DOM-free spatial-navigation and gamepad-edge helpers that
 * let a controller move keyboard focus around the HTML menus.
 *
 * The React layer (UINavigationController) owns the DOM and the per-frame poll
 * loop; this module owns only the geometry and timing math. Keeping that math
 * here — free of the DOM and the Gamepad API — lets the focus-selection and
 * repeat rules be unit-tested against plain inputs and outputs, and keeps the
 * controller component thin (single responsibility, low coupling).
 *
 * Coordinates follow the DOM convention: x grows rightward, y grows downward.
 */

export type NavDirection = 'up' | 'down' | 'left' | 'right';

/** A DOM-free rectangle in screen coordinates (mirrors DOMRect's edges). */
export interface NavRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface NavPoint {
  x: number;
  y: number;
}

/** Below this stick magnitude the left stick is treated as centered. */
export const NAV_DEADZONE = 0.5;

// Standard-mapping gamepad indices (Xbox layout): face buttons and the D-Pad.
// A confirms, B goes back; the D-Pad gives discrete focus steps.
const BUTTON_CONFIRM = 0;
const BUTTON_BACK = 1;
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;

// Penalty applied to a candidate's perpendicular offset when scoring a move, so
// the navigator prefers the neighbor most squarely in the pressed direction over
// one that is marginally closer but far off-axis.
const PERPENDICULAR_PENALTY = 2;

/** Minimal structural view of a Gamepad, so callers can test without the DOM. */
export interface GamepadSnapshot {
  buttons: ReadonlyArray<{ pressed: boolean; value: number }>;
  axes: ReadonlyArray<number>;
}

export function rectCenter(rect: NavRect): NavPoint {
  return {
    x: (rect.left + rect.right) / 2,
    y: (rect.top + rect.bottom) / 2,
  };
}

/**
 * Gap between two 1-D intervals: 0 when they overlap, otherwise the distance
 * between their nearest edges. Used to measure perpendicular misalignment so two
 * controls that share a row (or column) score as aligned regardless of size.
 */
function intervalGap(aMin: number, aMax: number, bMin: number, bMax: number): number {
  if (aMax < bMin) return bMin - aMax;
  if (bMax < aMin) return aMin - bMax;
  return 0;
}

/**
 * Choose the index of the best focus target when moving `direction` from the
 * rectangle at `currentIndex`. Candidates must lie ahead along the pressed axis;
 * among those, the one with the smallest along-axis distance plus a weighted
 * perpendicular gap wins. Returns null when nothing lies in that direction.
 */
export function chooseNextIndex(
  rects: ReadonlyArray<NavRect>,
  currentIndex: number,
  direction: NavDirection
): number | null {
  const current = rects[currentIndex];
  if (!current) return null;

  const currentCenter = rectCenter(current);
  const isHorizontal = direction === 'left' || direction === 'right';

  let bestIndex: number | null = null;
  let bestScore = Infinity;

  for (let index = 0; index < rects.length; index += 1) {
    if (index === currentIndex) continue;
    const candidate = rects[index];
    const candidateCenter = rectCenter(candidate);

    let alongDistance: number;
    let perpendicularGap: number;

    if (isHorizontal) {
      alongDistance =
        direction === 'right'
          ? candidateCenter.x - currentCenter.x
          : currentCenter.x - candidateCenter.x;
      perpendicularGap = intervalGap(current.top, current.bottom, candidate.top, candidate.bottom);
    } else {
      alongDistance =
        direction === 'down'
          ? candidateCenter.y - currentCenter.y
          : currentCenter.y - candidateCenter.y;
      perpendicularGap = intervalGap(current.left, current.right, candidate.left, candidate.right);
    }

    // Must be genuinely ahead in the pressed direction.
    if (alongDistance <= 0) continue;

    const score = alongDistance + PERPENDICULAR_PENALTY * perpendicularGap;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function isButtonPressed(pad: GamepadSnapshot, index: number): boolean {
  const button = pad.buttons[index];
  if (!button) return false;
  return button.pressed || button.value > 0.5;
}

/**
 * Resolve the focus-move direction the controller is currently expressing. The
 * D-Pad takes priority (it is unambiguous); otherwise the left stick's dominant
 * axis is used once it clears the deadzone. Returns null when neutral.
 */
export function readNavDirection(
  pad: GamepadSnapshot,
  deadzone: number = NAV_DEADZONE
): NavDirection | null {
  if (isButtonPressed(pad, DPAD_UP)) return 'up';
  if (isButtonPressed(pad, DPAD_DOWN)) return 'down';
  if (isButtonPressed(pad, DPAD_LEFT)) return 'left';
  if (isButtonPressed(pad, DPAD_RIGHT)) return 'right';

  const horizontal = pad.axes[0] ?? 0;
  const vertical = pad.axes[1] ?? 0;
  if (Math.abs(horizontal) < deadzone && Math.abs(vertical) < deadzone) return null;

  if (Math.abs(horizontal) >= Math.abs(vertical)) {
    return horizontal > 0 ? 'right' : 'left';
  }
  return vertical > 0 ? 'down' : 'up';
}

export function isConfirmPressed(pad: GamepadSnapshot): boolean {
  return isButtonPressed(pad, BUTTON_CONFIRM);
}

export function isBackPressed(pad: GamepadSnapshot): boolean {
  return isButtonPressed(pad, BUTTON_BACK);
}

/**
 * Repeat state for held directions: an initial step on press, a pause, then
 * steady auto-repeat — the same feel as holding an arrow key. Kept as plain data
 * advanced by `stepRepeat` so the timing is deterministic and testable.
 */
export interface NavRepeatState {
  direction: NavDirection | null;
  nextFireAtMs: number;
}

export function createRepeatState(): NavRepeatState {
  return { direction: null, nextFireAtMs: 0 };
}

export interface NavRepeatResult {
  fire: boolean;
  state: NavRepeatState;
}

/**
 * Advance the held-direction repeat machine by one polled frame.
 *
 * - A new (or first) direction fires immediately, then arms the initial delay.
 * - Holding the same direction fires again only once `nowMs` reaches the armed
 *   time, after which it re-arms at the faster repeat interval.
 * - Releasing to null disarms with no fire.
 */
export function stepRepeat(
  state: NavRepeatState,
  direction: NavDirection | null,
  nowMs: number,
  initialDelayMs: number,
  repeatMs: number
): NavRepeatResult {
  if (direction === null) {
    return { fire: false, state: { direction: null, nextFireAtMs: 0 } };
  }

  if (direction !== state.direction) {
    return { fire: true, state: { direction, nextFireAtMs: nowMs + initialDelayMs } };
  }

  if (nowMs >= state.nextFireAtMs) {
    return { fire: true, state: { direction, nextFireAtMs: nowMs + repeatMs } };
  }

  return { fire: false, state };
}
