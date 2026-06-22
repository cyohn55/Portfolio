// Shared gamepad access for the Conquest mode.
//
// Single responsibility: expose the first connected Standard-mapping gamepad and a
// deadzoned axis read, so every Conquest controller consumer (the field's drive +
// reticle poll and the posture radial's aim poll) reads the pad the same way
// instead of each re-implementing `navigator.getGamepads()` and deadzone math.
//
// Conquest deliberately does NOT mount Quick Play's GamepadController (that poller
// is bound to the flat-ground battle store and raycasts a y=0 plane, neither of
// which fits the globe), so these tiny primitives are what give Conquest its own
// controller support without dragging in that whole component.

import { CONTROLLER_DEADZONE, type GamepadLike } from '../controlBindings';
import { firstConnectedBridgedGamepad } from '../gamepadSource';

/**
 * The first connected gamepad, or null. Matches GamepadController.getActiveGamepad
 * so Conquest and Quick Play resolve "the active pad" identically.
 */
export function activeConquestGamepad(): GamepadLike | null {
  // Bridged read so Conquest's controller works inside the portfolio iframe, where
  // the pad is only visible to the host page (see gamepadSource.ts).
  return firstConnectedBridgedGamepad() as unknown as GamepadLike | null;
}

/**
 * Read one analog axis, snapping anything inside the shared controller deadzone to
 * zero so a resting stick never produces drift. Returns a value in roughly [-1, 1].
 */
export function axisWithDeadzone(
  gamepad: GamepadLike,
  axisIndex: number,
  deadzone: number = CONTROLLER_DEADZONE,
): number {
  const raw = gamepad.axes[axisIndex] ?? 0;
  return Math.abs(raw) > deadzone ? raw : 0;
}
