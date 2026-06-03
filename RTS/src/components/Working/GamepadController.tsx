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
import {
  PATROL_ARROW_COLOR,
  RALLY_ARROW_COLOR,
  createDottedArrow,
  hideDottedArrow,
  positionDottedArrow,
} from './dottedArrow';
import type { Unit } from '../../game/types';

/**
 * GamepadController — the single per-frame gamepad poller. It lives inside the
 * R3F <Canvas> so it can raycast the cursor reticle against the ground for
 * move/attack orders. Responsibilities:
 *   - publish analog camera pan/zoom intent (read by CameraController),
 *   - drive an on-screen reticle with the right stick,
 *   - fire selection/command/pause actions on the rising edge of bound buttons,
 *   - run the multi-edge gestures (Select All hold-to-deploy, Queen spawn-rally
 *     aim, Queen patrol hold) with their on-screen indicator lines.
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

// How long the patrol button must be held (with a lone Queen selected) before the
// gold route line arms and a release commits the patrol. Mirrors PATROL_HOLD_MS in
// HexInteraction so the controller hold-gesture feels identical to the mouse one.
const PATROL_HOLD_MS = 750;

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

  // Queen spawn-rally gesture state (default R3): the rally button arms a blue aim
  // line that follows the reticle, and the next Move / Attack (B) drops the point —
  // mirroring the mouse's arm-then-right-click. queenId is captured at arm time so
  // the commit targets that Queen even if the reticle wanders. The blue line is a
  // DOM element drawn each frame while armed.
  const rallyArmedRef = useRef(false);
  const rallyQueenIdRef = useRef<string | null>(null);
  const rallyArrowElRef = useRef<HTMLDivElement | null>(null);

  // Queen patrol gesture state (default L3 held): after PATROL_HOLD_MS the gold
  // route line arms and a release commits the patrol, mirroring the mouse right-hold.
  // The Queen is pinned (setMovementHold) for the whole hold so the line's origin
  // stays anchored to her, and is released when the gesture resolves or is cancelled.
  const patrolPendingRef = useRef(false);
  const patrolArmedRef = useRef(false);
  const patrolQueenIdRef = useRef<string | null>(null);
  const patrolHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const patrolArrowElRef = useRef<HTMLDivElement | null>(null);
  // Previous-frame active state of the rally / patrol buttons, for edge detection.
  const rallyPrevRef = useRef(false);
  const patrolPrevRef = useRef(false);

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

  // The lone owned Queen, if exactly one Queen of the local player is selected,
  // else null — the only selection that can carry a rally point or a patrol route
  // (mirrors isSelectedQueenOnly in the mouse path).
  const loneSelectedQueen = (): Unit | null => {
    const state = useGameStore.getState();
    if (state.selectedUnitIds.length !== 1) return null;
    const unit = state.units.find((candidate) => candidate.id === state.selectedUnitIds[0]);
    if (!unit || unit.kind !== 'Queen' || unit.ownerId !== state.localPlayerId) return null;
    return unit;
  };

  // Abandon an in-progress spawn-rally aim and hide the blue line. Used on commit,
  // selection change, pad disconnect, pause, and unmount.
  const cancelRallyAim = () => {
    rallyArmedRef.current = false;
    rallyQueenIdRef.current = null;
    hideDottedArrow(rallyArrowElRef.current);
  };

  // Abandon an in-progress patrol hold: stop the arm timer, release the Queen's
  // movement pin, hide the gold line, and clear the gesture refs.
  const cancelPatrolAim = () => {
    if (patrolHoldTimerRef.current !== null) {
      clearTimeout(patrolHoldTimerRef.current);
      patrolHoldTimerRef.current = null;
    }
    if (patrolPendingRef.current) {
      // Only the gesture that pinned the Queen should release her.
      useGameStore.getState().setMovementHold(null);
    }
    patrolPendingRef.current = false;
    patrolArmedRef.current = false;
    patrolQueenIdRef.current = null;
    hideDottedArrow(patrolArrowElRef.current);
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

    // The blue spawn-rally line and the gold patrol line the Queen gestures draw,
    // hidden until their gesture arms. Same dotted-arrow shape as the mouse path.
    const rallyArrow = createDottedArrow(RALLY_ARROW_COLOR);
    document.body.appendChild(rallyArrow);
    rallyArrowElRef.current = rallyArrow;

    const patrolArrow = createDottedArrow(PATROL_ARROW_COLOR);
    document.body.appendChild(patrolArrow);
    patrolArrowElRef.current = patrolArrow;

    return () => {
      gamepadInput.reset();
      stopPlacementHold();
      cancelRallyAim();
      cancelPatrolAim();
      if (reticleElRef.current) document.body.removeChild(reticleElRef.current);
      if (rallyArrowElRef.current) document.body.removeChild(rallyArrowElRef.current);
      if (patrolArrowElRef.current) document.body.removeChild(patrolArrowElRef.current);
      reticleElRef.current = null;
      rallyArrowElRef.current = null;
      patrolArrowElRef.current = null;
    };
    // The helpers cleared here only touch refs (stable), so this one-time
    // setup/teardown effect intentionally runs once; re-subscribing is unnecessary.
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

  // The local player's King nearest the reticle within UNIT_PICK_RADIUS_PX, else
  // null. Dropping a rally on your own King makes the Queen's spawns follow him
  // instead of marching to a fixed point (mirrors friendlyKingUnderCursor on mouse).
  const friendlyKingUnderReticle = (): Unit | null => {
    const state = useGameStore.getState();
    let nearest: Unit | null = null;
    let nearestDist = UNIT_PICK_RADIUS_PX;
    for (const unit of state.units) {
      if (unit.ownerId !== state.localPlayerId || unit.kind !== 'King') continue;
      const screen = projectToScreen(unit.position.x, unit.position.y, unit.position.z);
      const dist = Math.hypot(screen.x - reticlePos.current.x, screen.y - reticlePos.current.y);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = unit;
      }
    }
    return nearest;
  };

  // The live Unit for a gesture's captured Queen id (looked up fresh so the line
  // origin tracks her if she shifts), or null once she has died / been removed.
  const queenById = (queenId: string | null): Unit | null => {
    if (!queenId) return null;
    return useGameStore.getState().units.find((unit) => unit.id === queenId) ?? null;
  };

  // Rising edge of the spawn-rally button: arm (or re-anchor) the blue aim line to
  // the lone selected Queen. The commit happens on the next Move / Attack (B) in
  // fireAction. With no lone Queen selected, abandon any stale aim.
  const handleRallyArm = () => {
    const state = useGameStore.getState();
    if (state.isPaused || state.gameOver || !state.matchStarted) return;
    const queen = loneSelectedQueen();
    if (!queen) {
      cancelRallyAim();
      return;
    }
    rallyArmedRef.current = true;
    rallyQueenIdRef.current = queen.id;
  };

  // Commit the armed spawn-rally point at the reticle: a friendly King under it
  // becomes a follow target, otherwise the ground point is a fixed staging spot.
  // Invoked by the Move / Attack handler so it takes precedence over a move order.
  const commitRallyAim = () => {
    const queenId = rallyQueenIdRef.current;
    cancelRallyAim();
    if (!queenId) return;
    const king = friendlyKingUnderReticle();
    if (king) {
      useGameStore.getState().setQueenRally({ queenId, target: { mode: 'follow', monarchId: king.id } });
      return;
    }
    const world = reticleWorldPosition();
    if (world) {
      useGameStore.getState().setQueenRally({
        queenId,
        target: { mode: 'point', position: { x: world.x, y: 0, z: world.z } },
      });
    }
  };

  // Rising edge of the patrol button: with a lone Queen selected, pin her and start
  // the hold timer; once it elapses the gold route line arms (drawn each frame).
  const handlePatrolPress = () => {
    const state = useGameStore.getState();
    if (state.isPaused || state.gameOver || !state.matchStarted) return;
    const queen = loneSelectedQueen();
    if (!queen) return;

    cancelPatrolAim();
    state.setMovementHold(queen.id); // keep her still so the line origin stays anchored
    patrolPendingRef.current = true;
    patrolQueenIdRef.current = queen.id;
    patrolHoldTimerRef.current = setTimeout(() => {
      patrolArmedRef.current = true;
      patrolHoldTimerRef.current = null;
    }, PATROL_HOLD_MS);
  };

  // Falling edge of the patrol button: an armed hold commits a back-and-forth route
  // from the Queen to the reticle; a too-quick release just cancels (no patrol).
  const handlePatrolRelease = () => {
    if (!patrolPendingRef.current) return;
    if (patrolArmedRef.current) {
      const queen = queenById(patrolQueenIdRef.current);
      const end = reticleWorldPosition();
      if (queen && end) {
        useGameStore.getState().setPatrol({
          queenId: queen.id,
          startPosition: { x: queen.position.x, y: queen.position.y, z: queen.position.z },
          endPosition: { x: end.x, y: 0, z: end.z },
        });
      }
    }
    cancelPatrolAim();
  };

  // Redraw the armed Queen-gesture lines from the Queen to the reticle. Called each
  // frame while the match is live; cancels a gesture whose Queen is gone or whose
  // lone-Queen selection has changed, so a stale line can never linger.
  const drawQueenGestureLines = () => {
    if (rallyArmedRef.current) {
      const queen = queenById(rallyQueenIdRef.current);
      if (!queen || loneSelectedQueen()?.id !== queen.id) {
        cancelRallyAim();
      } else {
        const start = projectToScreen(queen.position.x, queen.position.y, queen.position.z);
        const king = friendlyKingUnderReticle();
        const end = king
          ? projectToScreen(king.position.x, king.position.y, king.position.z)
          : { x: reticlePos.current.x, y: reticlePos.current.y };
        positionDottedArrow(rallyArrowElRef.current, start, end);
      }
    }

    if (patrolArmedRef.current) {
      const queen = queenById(patrolQueenIdRef.current);
      if (!queen) {
        cancelPatrolAim();
      } else {
        const start = projectToScreen(queen.position.x, queen.position.y, queen.position.z);
        positionDottedArrow(patrolArrowElRef.current, start, {
          x: reticlePos.current.x,
          y: reticlePos.current.y,
        });
      }
    }
  };

  // Edge-detect the rally / patrol buttons and run their handlers. Kept together so
  // the frame loop can gate the whole gesture set behind "match live, not paused".
  const updateQueenGestures = (gamepad: GamepadLike, bindings: Record<ControlActionId, string>) => {
    const rallyActive = isControllerTokenActive(gamepad, bindings.setQueenRally);
    if (rallyActive && !rallyPrevRef.current) handleRallyArm();
    rallyPrevRef.current = rallyActive;

    const patrolActive = isControllerTokenActive(gamepad, bindings.setPatrol);
    if (patrolActive && !patrolPrevRef.current) handlePatrolPress();
    else if (!patrolActive && patrolPrevRef.current) handlePatrolRelease();
    patrolPrevRef.current = patrolActive;

    drawQueenGestureLines();
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
        // While a spawn-rally aim is armed, Move / Attack drops the rally point
        // instead of issuing a move — mirroring the mouse's right-click commit.
        if (rallyArmedRef.current) {
          commitRallyAim();
          break;
        }
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
      // Abandon any in-progress hold/aim so a disconnect mid-gesture can't strand a
      // timer, a movement pin, or a lingering line with no falling edge ever arriving.
      stopPlacementHold();
      selectAllAwaitingReleaseRef.current = false;
      cancelRallyAim();
      cancelPatrolAim();
      rallyPrevRef.current = false;
      patrolPrevRef.current = false;
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

    // --- Queen spawn-rally aim + patrol hold. Only meaningful while the match is
    // live; otherwise abandon any in-progress aim (releasing a patrol pin) and reset
    // the edge state so a press that began during a pause can't commit on resume. ---
    if (matchStarted && !isPaused) {
      updateQueenGestures(gamepad, controllerBindings);
    } else {
      cancelRallyAim();
      cancelPatrolAim();
      rallyPrevRef.current = false;
      patrolPrevRef.current = false;
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
