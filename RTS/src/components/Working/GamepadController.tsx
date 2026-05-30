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
import { gamepadInput } from './gamepadInput';

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

// Discrete actions fired once per press (rising edge).
const TAP_ACTIONS: readonly ControlActionId[] = [
  'primaryAction', 'secondaryAction', 'selectAll',
  'selectGroup1', 'selectGroup2', 'selectGroup3', 'deselect', 'pause',
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
      if (reticleElRef.current) document.body.removeChild(reticleElRef.current);
      reticleElRef.current = null;
    };
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
      case 'selectAll': {
        const ids = state.units
          .filter((u) => u.ownerId === state.localPlayerId && u.kind !== 'Base')
          .map((u) => u.id);
        if (ids.length > 0) state.selectUnits(ids);
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
      case 'deselect':
        state.clearSelection();
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
  });

  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Camera actions are evaluated analogically above, never as taps; this guard
// documents that intent for future maintainers extending the action set.
void CAMERA_ACTIONS;
