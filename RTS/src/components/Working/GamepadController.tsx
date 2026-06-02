import { useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useGameStore } from '../../game/state';
import {
  type ControlActionId,
  type GamepadLike,
  CONTROLLER_DEADZONE,
  controllerTokenMagnitude,
  isControllerTokenActive,
} from './controlBindings';
import { type AbilityComboCursor, tryFireAbilityCombo } from './abilityCombo';
import { gamepadInput } from './gamepadInput';
import {
  DOUBLE_PRESS_WINDOW_MS,
  UNIT_PLACEMENT_INTERVAL_MS,
  UNIT_PLACEMENT_REPEAT_INTERVAL_MS,
} from './monarchPilot';

/**
 * GamepadController — the single per-frame gamepad poller. It lives inside the
 * R3F <Canvas> so it can raycast the cursor reticle against the ground for
 * move/attack orders. Responsibilities:
 *   - publish analog camera pan/zoom intent (read by CameraController),
 *   - drive an on-screen reticle with the right stick,
 *   - fire selection/command/pause actions on the rising edge of bound buttons.
 *
 * Bindings, units, and selection are read fresh from the store each frame via
 * getState() so the poll loop never holds a stale closure and never forces a
 * React re-render of this (render-nothing) component.
 */

// Single left-stick→camera and right-stick→reticle tuning. Reticle speed is in
// pixels/second; pan speed is unitless intent (CameraController scales it).
const RETICLE_SPEED_PX_PER_SEC = 900;
const RETICLE_SIZE_PX = 28;
// A button press counts as a "tap" only on the frame it transitions to active,
// so holding a button doesn't repeat the order every frame.
const UNIT_PICK_RADIUS_PX = 40;

// Camera-pan actions handled analogically (held), not as discrete taps.
const CAMERA_ACTIONS: ReadonlySet<ControlActionId> = new Set([
  'cameraForward', 'cameraBackward', 'cameraLeft', 'cameraRight', 'cameraZoomIn', 'cameraZoomOut',
]);

// Discrete actions fired once per press (rising edge). 'selectAll' is handled
// separately below: like the keyboard's Space it is a multi-gesture action (tap
// rallies, double-tap selects everything, hold deploys a proportionate number of
// units), so it needs both the rising AND falling edge, not a one-shot tap.
const TAP_ACTIONS: readonly ControlActionId[] = [
  'primaryAction', 'secondaryAction', 'useAbility',
  'selectGroup1', 'selectGroup2', 'selectGroup3', 'deselect',
  'pilotCycleMonarch', 'pilotMonarch1', 'pilotMonarch2', 'pilotMonarch3', 'pilotToggleMonarch', 'pause',
];

function getActiveGamepad(): GamepadLike | null {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  const pads = navigator.getGamepads();
  for (const pad of pads) {
    if (pad && pad.connected) return pad as unknown as GamepadLike;
  }
  return null;
}

export function GamepadController() {
  const { camera, raycaster } = useThree();

  const reticlePos = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const reticleElRef = useRef<HTMLDivElement | null>(null);
  // Previous-frame active state per tap action, for edge detection.
  const prevActive = useRef<Record<string, boolean>>({});

  // Select All / Rally gesture state, mirroring the keyboard's hold-Space handling
  // (see KeyboardShortcuts). The bound button (default X, or e.g. a trigger once
  // rebound) is multi-gesture: a quick tap rallies the piloted army, a double tap
  // selects every unit, and a sustained hold designates one follower per interval
  // (the teardrop count) to deploy at the monarch on release. Held off the React
  // path in refs so the 60 Hz poll never triggers a re-render.
  const lastSelectAllPressMsRef = useRef(0);
  const placementFirstTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const placementRepeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const selectAllAwaitingReleaseRef = useRef(false);

  // Stop both phases of the placement-hold timer (on release, double tap, pad
  // disconnect, or unmount). Only one phase is ever live, but clearing both is safe.
  const stopPlacementHold = () => {
    if (placementFirstTimeoutRef.current !== null) {
      clearTimeout(placementFirstTimeoutRef.current);
      placementFirstTimeoutRef.current = null;
    }
    if (placementRepeatIntervalRef.current !== null) {
      clearInterval(placementRepeatIntervalRef.current);
      placementRepeatIntervalRef.current = null;
    }
  };

  // Rising edge of the Select All / Rally button. A double tap immediately selects
  // every unit; a single press starts the hold-to-deploy timer (only while piloting,
  // where a placement is possible) and defers its tap-vs-hold meaning to the release.
  const handleSelectAllPress = () => {
    const state = useGameStore.getState();
    if (state.isPaused || state.gameOver || !state.matchStarted) return;

    const now = performance.now();
    const isDoublePress = now - lastSelectAllPressMsRef.current <= DOUBLE_PRESS_WINDOW_MS;
    lastSelectAllPressMsRef.current = now;

    if (isDoublePress) {
      // Abandon the first tap's in-progress hold so the double tap neither places
      // units nor re-toggles a rally; just select everything (piloting or not).
      stopPlacementHold();
      selectAllAwaitingReleaseRef.current = false;
      state.resetUnitPlacement();
      const ids = state.units
        .filter((unit) => unit.ownerId === state.localPlayerId && unit.kind !== 'Base')
        .map((unit) => unit.id);
      if (ids.length > 0) state.selectUnits(ids);
      return;
    }

    selectAllAwaitingReleaseRef.current = true;
    if (state.pilotedUnitId) {
      stopPlacementHold();
      // First follower after the initial hold, then ramp up at the faster repeat rate.
      placementFirstTimeoutRef.current = setTimeout(() => {
        placementFirstTimeoutRef.current = null;
        useGameStore.getState().incrementUnitPlacement();
        placementRepeatIntervalRef.current = setInterval(() => {
          useGameStore.getState().incrementUnitPlacement();
        }, UNIT_PLACEMENT_REPEAT_INTERVAL_MS);
      }, UNIT_PLACEMENT_INTERVAL_MS);
    }
  };

  // Falling edge of the Select All / Rally button. A hold that designated at least
  // one follower deploys them at the monarch; a quick tap while piloting rallies the
  // army instead. A double tap already consumed (and cleared) the awaiting flag.
  const handleSelectAllRelease = () => {
    const state = useGameStore.getState();
    stopPlacementHold();
    if (!selectAllAwaitingReleaseRef.current) return;
    selectAllAwaitingReleaseRef.current = false;

    const designated = useGameStore.getState().unitPlacementCount;
    if (designated >= 1) {
      state.placeRalliedUnits(designated);
    } else if (state.pilotedUnitId) {
      state.rallyToMonarch();
    }
  };

  // Create / tear down the reticle DOM element. Hidden until a stick is moved.
  useEffect(() => {
    const reticle = document.createElement('div');
    reticle.style.position = 'fixed';
    reticle.style.width = `${RETICLE_SIZE_PX}px`;
    reticle.style.height = `${RETICLE_SIZE_PX}px`;
    reticle.style.marginLeft = `${-RETICLE_SIZE_PX / 2}px`;
    reticle.style.marginTop = `${-RETICLE_SIZE_PX / 2}px`;
    reticle.style.border = '2px solid #ffd34d';
    reticle.style.borderRadius = '50%';
    reticle.style.boxShadow = '0 0 8px rgba(255,211,77,0.8)';
    reticle.style.pointerEvents = 'none';
    reticle.style.zIndex = '1002';
    reticle.style.display = 'none';
    document.body.appendChild(reticle);
    reticleElRef.current = reticle;

    return () => {
      gamepadInput.reset();
      stopPlacementHold();
      if (reticleElRef.current) document.body.removeChild(reticleElRef.current);
      reticleElRef.current = null;
    };
    // stopPlacementHold only touches refs (stable), so this one-time setup/teardown
    // effect intentionally runs once; re-subscribing per render is unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Project a unit's world position to screen pixels.
  const projectToScreen = (x: number, y: number, z: number) => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight,
    };
  };

  // Ground-plane (y=0) world position under the reticle.
  const reticleWorldPosition = (): THREE.Vector3 | null => {
    const ndc = new THREE.Vector2(
      (reticlePos.current.x / window.innerWidth) * 2 - 1,
      -(reticlePos.current.y / window.innerHeight) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const point = new THREE.Vector3();
    return raycaster.ray.intersectPlane(ground, point) ? point : null;
  };

  // Nearest unit to the reticle (screen space) matching the owner predicate.
  const nearestUnitId = (
    ownerPredicate: (ownerId: string, localId: string | null) => boolean
  ): string | null => {
    const state = useGameStore.getState();
    let bestId: string | null = null;
    let bestDist = UNIT_PICK_RADIUS_PX;
    for (const unit of state.units) {
      if (unit.kind === 'Base') continue;
      if (!ownerPredicate(unit.ownerId, state.localPlayerId)) continue;
      const screen = projectToScreen(unit.position.x, unit.position.y, unit.position.z);
      const dist = Math.hypot(screen.x - reticlePos.current.x, screen.y - reticlePos.current.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = unit.id;
      }
    }
    return bestId;
  };

  // Nearest non-Base unit (any owner) to the reticle in screen space, or null —
  // the grab target the Owl Pickup ability reads, mirroring the mouse's
  // unitUnderCursor pick.
  const nearestUnitToReticle = () => {
    const state = useGameStore.getState();
    let nearest: typeof state.units[number] | null = null;
    let nearestDist = UNIT_PICK_RADIUS_PX;
    for (const unit of state.units) {
      if (unit.kind === 'Base') continue;
      const screen = projectToScreen(unit.position.x, unit.position.y, unit.position.z);
      const dist = Math.hypot(screen.x - reticlePos.current.x, screen.y - reticlePos.current.y);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = unit;
      }
    }
    return nearest;
  };

  // The combo gesture aimed at the reticle: ground point under it for thrown/
  // delivered abilities, and the nearest unit for the Owl's grab.
  const abilityCursor: AbilityComboCursor = {
    groundPoint: () => {
      const world = reticleWorldPosition();
      return world ? { x: world.x, y: 0, z: world.z } : null;
    },
    unitUnderCursor: () => nearestUnitToReticle(),
  };

  const fireAction = (actionId: ControlActionId) => {
    const state = useGameStore.getState();

    // Pause toggles regardless of paused state so the controller can resume.
    // Dispatch the shared toggle event so the existing HUD pause menu opens
    // (its own effect drives the store's isPaused / sim-halt state).
    if (actionId === 'pause') {
      window.dispatchEvent(new CustomEvent('rts:toggle-pause'));
      return;
    }
    // All other gameplay actions are inert while paused or after the match ends.
    if (state.isPaused || state.gameOver || !state.matchStarted) return;

    switch (actionId) {
      case 'primaryAction': {
        const ownId = nearestUnitId((ownerId, localId) => ownerId === localId);
        if (ownId) state.selectUnits([ownId]);
        else state.clearSelection();
        break;
      }
      case 'secondaryAction': {
        if (state.selectedUnitIds.length === 0) break;
        const enemyId = nearestUnitId((ownerId, localId) => ownerId !== localId);
        if (enemyId) {
          state.attackTarget({ unitIds: state.selectedUnitIds, targetId: enemyId });
        } else {
          const world = reticleWorldPosition();
          if (world) {
            state.moveCommand({
              unitIds: state.selectedUnitIds,
              target: { x: world.x, y: 0, z: world.z },
            });
          }
        }
        break;
      }
      case 'selectGroup1':
      case 'selectGroup2':
      case 'selectGroup3': {
        const index = Number(actionId.slice(-1)) - 1;
        const animal = state.selectedAnimalPool[index];
        if (!animal) break;
        const ids = state.units
          .filter((u) => u.ownerId === state.localPlayerId && u.kind !== 'Base' && u.animal === animal)
          .map((u) => u.id);
        if (ids.length > 0) state.selectUnits(ids);
        break;
      }
      case 'useAbility':
        // Fire the selected animal's special ability at the reticle, shared with
        // the keyboard/mouse left+right gesture so behaviour can't drift.
        tryFireAbilityCombo(
          { units: state.units, localPlayerId: state.localPlayerId, selectedUnitIds: state.selectedUnitIds },
          abilityCursor,
          state
        );
        break;
      case 'deselect':
        state.clearSelection();
        break;
      case 'pilotCycleMonarch':
        state.pilotCycleMonarch();
        break;
      case 'pilotMonarch1':
        state.pilotMonarchBySlot(0);
        break;
      case 'pilotMonarch2':
        state.pilotMonarchBySlot(1);
        break;
      case 'pilotMonarch3':
        state.pilotMonarchBySlot(2);
        break;
      case 'pilotToggleMonarch':
        state.togglePilotMonarchKind();
        break;
      default:
        break;
    }
  };

  useFrame((_, delta) => {
    const gamepad = getActiveGamepad();
    const reticle = reticleElRef.current;

    if (!gamepad) {
      gamepadInput.reset();
      prevActive.current = {};
      // Abandon any in-progress hold so a disconnect mid-gesture can't strand the
      // timer (and a lingering teardrop) with no falling edge ever arriving.
      stopPlacementHold();
      selectAllAwaitingReleaseRef.current = false;
      if (reticle) reticle.style.display = 'none';
      return;
    }

    const { controllerBindings, isPaused, matchStarted } = useGameStore.getState();

    // --- Camera intent (analog, held). Suppressed while paused. ---
    if (matchStarted && !isPaused) {
      const right = controllerTokenMagnitude(gamepad, controllerBindings.cameraRight);
      const left = controllerTokenMagnitude(gamepad, controllerBindings.cameraLeft);
      const forward = controllerTokenMagnitude(gamepad, controllerBindings.cameraForward);
      const backward = controllerTokenMagnitude(gamepad, controllerBindings.cameraBackward);
      const zoomIn = controllerTokenMagnitude(gamepad, controllerBindings.cameraZoomIn);
      const zoomOut = controllerTokenMagnitude(gamepad, controllerBindings.cameraZoomOut);
      gamepadInput.setCameraIntent(right - left, forward - backward, zoomOut - zoomIn);
    } else {
      gamepadInput.reset();
    }

    // --- Reticle (right stick). Hidden while paused / before match start. ---
    if (matchStarted && !isPaused) {
      const rx = gamepad.axes[2] ?? 0;
      const ry = gamepad.axes[3] ?? 0;
      const dx = Math.abs(rx) > CONTROLLER_DEADZONE ? rx : 0;
      const dy = Math.abs(ry) > CONTROLLER_DEADZONE ? ry : 0;
      if (dx !== 0 || dy !== 0) {
        const step = RETICLE_SPEED_PX_PER_SEC * delta;
        reticlePos.current.x = clamp(reticlePos.current.x + dx * step, 0, window.innerWidth);
        reticlePos.current.y = clamp(reticlePos.current.y + dy * step, 0, window.innerHeight);
      }
      if (reticle) {
        reticle.style.left = `${reticlePos.current.x}px`;
        reticle.style.top = `${reticlePos.current.y}px`;
        reticle.style.display = 'block';
      }
    } else if (reticle) {
      reticle.style.display = 'none';
    }

    // --- Discrete taps (rising edge). ---
    for (const actionId of TAP_ACTIONS) {
      const token = controllerBindings[actionId];
      const active = isControllerTokenActive(gamepad, token);
      const wasActive = prevActive.current[actionId] ?? false;
      if (active && !wasActive) fireAction(actionId);
      prevActive.current[actionId] = active;
    }

    // --- Select All / Rally (tap / double-tap / hold), on both edges. ---
    const selectAllActive = isControllerTokenActive(gamepad, controllerBindings.selectAll);
    const selectAllWasActive = prevActive.current.selectAll ?? false;
    if (selectAllActive && !selectAllWasActive) handleSelectAllPress();
    else if (!selectAllActive && selectAllWasActive) handleSelectAllRelease();
    prevActive.current.selectAll = selectAllActive;
  });

  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Camera actions are evaluated analogically above, never as taps; this guard
// documents that intent for future maintainers extending the action set.
void CAMERA_ACTIONS;
