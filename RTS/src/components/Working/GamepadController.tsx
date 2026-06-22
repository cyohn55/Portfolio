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
import { firstConnectedBridgedGamepad } from './gamepadSource';
import { clampToArena } from './arenaBoundary';
import { UNIT_PLACEMENT_REPEAT_INTERVAL_MS } from './monarchPilot';
import {
  type ActivationMode,
  type TokenDispatch,
  type TokenGestureConfig,
  buildTokenDispatch,
} from './gestureModes';
import {
  PATROL_ARROW_COLOR,
  RALLY_ARROW_COLOR,
  createDottedArrow,
  createSegmentedLine,
  hideDottedArrow,
  positionDottedArrow,
  positionSegmentedLine,
} from './dottedArrow';
import type { AnimalId, Unit } from '../../game/types';
import { getKindTargetScale } from '../../utils/ModelPreloader';

/**
 * GamepadController — the single per-frame gamepad poller. It lives inside the
 * R3F <Canvas> so it can raycast the cursor reticle against the ground for
 * move/attack orders. Responsibilities:
 *   - publish analog camera pan/zoom intent (read by CameraController),
 *   - drive a 3D targeting cursor (blue ring + spinning pyramid) with the right
 *     stick — anchored to the piloted monarch (a 50-unit leash) or free-roaming,
 *   - fire selection/command/pause actions on the rising edge of bound buttons,
 *   - run the multi-edge gestures (Select All hold-to-deploy, Queen spawn-rally
 *     aim, Queen patrol hold) with their on-screen indicator lines.
 *
 * Bindings, units, and selection are read fresh from the store each frame via
 * getState() so the poll loop never holds a stale closure and never forces a
 * React re-render of this (render-nothing) component.
 */

// Single left-stick→camera and right-stick→cursor tuning. Free-roam cursor speed
// is in pixels/second; pan speed is unitless intent (CameraController scales it).
const RETICLE_SPEED_PX_PER_SEC = 900;
// A button press counts as a "tap" only on the frame it transitions to active,
// so holding a button doesn't repeat the order every frame.
const UNIT_PICK_RADIUS_PX = 40;

// --- 3D targeting cursor (blue ring + spinning upside-down pyramid) ---
// Sizes are world units; a standard King is ~6 units across, so a ~3-unit ring
// reads as a clear reticle without swallowing the monarch.
// Navy to match the selection ring beneath selected units (UnitsLayer
// SELECTION_*_MAT, #000080), with a strong emissive so the dark blue still glows
// rather than reading as black.
const CURSOR_BLUE = '#000080';
const CURSOR_EMISSIVE_INTENSITY = 2.5;
const CURSOR_RING_RADIUS = 3.0;   // torus centerline radius
const CURSOR_RING_TUBE = 0.32;    // torus tube thickness
// Lifted clearly above the battlefield surface (ground units sit at ~y=0.25) so
// the ring visibly hovers on the scene instead of sinking beneath the terrain.
const CURSOR_RING_Y = 0.6;
const CURSOR_PYRAMID_RADIUS = 1.8;
const CURSOR_PYRAMID_HEIGHT = 3.2;
const CURSOR_PYRAMID_APEX_Y = 0.5; // apex hovers just above the ring center
// Cone center sits half a height above the apex (cone is centered on its axis).
const CURSOR_PYRAMID_CENTER_Y = CURSOR_PYRAMID_APEX_Y + CURSOR_PYRAMID_HEIGHT / 2;
const CURSOR_SPIN_SPEED = 2.2;    // radians/second
// When piloting a monarch the cursor extends out from it on a leash of this many
// world units, mapped from full right-stick deflection at this speed.
const PILOT_CURSOR_MAX_DISTANCE = 50;
const PILOT_CURSOR_SPEED = 56.25; // world units/second at full deflection (25% faster than the original 45)

// Command-trigger color feedback: while the command trigger is held the cursor
// (and its leash line) turn neon green over open ground or red while aimed at an
// enemy, then settle back to navy on release.
const CURSOR_GREEN = '#39ff14';
const CURSOR_RED = '#ff1f3d';
type CursorTint = 'default' | 'ground' | 'enemy';
const CURSOR_TINT_HEX: Record<CursorTint, string> = {
  default: CURSOR_BLUE,
  ground: CURSOR_GREEN,
  enemy: CURSOR_RED,
};
// Precreated Color objects so the per-frame material tint copies rather than parsing hex.
const CURSOR_TINT_COLOR: Record<CursorTint, THREE.Color> = {
  default: new THREE.Color(CURSOR_BLUE),
  ground: new THREE.Color(CURSOR_GREEN),
  enemy: new THREE.Color(CURSOR_RED),
};
// The monarch→cursor leash is drawn as this many equal dash segments.
const CURSOR_LINK_SEGMENTS = 10;

// Right-trigger "click" feedback: while the command trigger is held the ring
// shrinks to half size and the pyramid dips toward it, as if pressed into the
// battlefield. Eased toward these targets each frame for a soft press.
const CURSOR_PRESS_RING_SCALE = 0.5;
const CURSOR_PRESS_PYRAMID_DROP = 0.7; // world units the pyramid lowers when held
const CURSOR_PRESS_EASE = 0.35;        // per-frame lerp factor toward the target

// Hold the command trigger this long (ms) — past the snappy move/attack tap — to
// begin the cursor deploy: designate followers (teardrop above the pyramid) and
// place them at the cursor on release. Mirrors the left-trigger deploy timing.
const CURSOR_DEPLOY_HOLD_MS = 300;

// Reused for camera-relative ground movement; never mutated in place.
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// World-space outer radius of a royal's selection ring (the ring beneath a
// piloted King/Queen), mirroring UnitsLayer: the selection ring geometry's outer
// radius (1.5) times royalRingScale (ROYAL_RING_BASE_SCALE 1.6, scaled by the
// royal's size relative to a plain Unit). The leash line anchors to this edge.
const ROYAL_SELECTION_RING_OUTER = 1.5;
const ROYAL_RING_BASE_SCALE = 1.6;
function royalRingWorldRadius(animal: AnimalId, kind: 'King' | 'Queen'): number {
  const unitScale = getKindTargetScale(animal, 'Unit');
  const scale = unitScale > 0
    ? ROYAL_RING_BASE_SCALE * (getKindTargetScale(animal, kind) / unitScale)
    : ROYAL_RING_BASE_SCALE;
  return ROYAL_SELECTION_RING_OUTER * scale;
}

// How long the patrol button must be held (with a lone Queen selected) before the
// gold route line arms and a release commits the patrol. Mirrors PATROL_HOLD_MS in
// HexInteraction so the controller hold-gesture feels identical to the mouse one.
const PATROL_HOLD_MS = 750;

// Camera-pan actions handled analogically (held), not as discrete taps.
const CAMERA_ACTIONS: ReadonlySet<ControlActionId> = new Set([
  'cameraForward', 'cameraBackward', 'cameraLeft', 'cameraRight', 'cameraZoomIn', 'cameraZoomOut',
]);

// The discrete "fire" actions the gamepad poller drives through the activation-mode
// dispatch (tap / double-tap / hold / chord). primaryAction is listed before the
// LB-chord group selects so that, when a chord like LB+A is pressed, the plain A
// fires first and the group select fires after and wins — preserving prior feel.
// Excluded: analog camera pan/zoom (driven by stick / D-pad magnitude, read by the
// camera block), the Queen spawn-rally / patrol aim gestures (their own reticle-aimed
// handlers below), and the secondaryAction RT-hold deploy. The two radial wheels open
// on a plain D-pad tap through this dispatch (fireAction relays the toggle event).
const GAMEPAD_GESTURE_ACTIONS: readonly ControlActionId[] = [
  'primaryAction', 'secondaryAction', 'useAbility',
  'selectMonarchAnimal', 'selectGroup1', 'selectGroup2', 'selectGroup3', 'deselect',
  'selectAllUnits', 'deployUnits', 'rally',
  'toggleBehaviorRadial', 'toggleDirectingRadial',
  'pilotCycleMonarch', 'pilotMonarch1', 'pilotMonarch2', 'pilotMonarch3', 'pilotToggleMonarch', 'cycleFireTeam', 'pause',
];

function getActiveGamepad(): GamepadLike | null {
  // Read through the bridge so the embedded iframe sees the host-forwarded pad
  // even when only the host page can read it directly (see gamepadSource.ts).
  return firstConnectedBridgedGamepad() as unknown as GamepadLike | null;
}

export function GamepadController() {
  const { camera, raycaster } = useThree();

  const reticlePos = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  // The 3D targeting cursor: a group placed on the ground at the target point, and
  // the inner pivot whose Y rotation spins the pyramid. Driven imperatively each
  // frame so the 60 Hz poll never forces a React re-render.
  const cursorGroupRef = useRef<THREE.Group | null>(null);
  const pyramidSpinRef = useRef<THREE.Group | null>(null);
  // The ring mesh (scaled on a trigger press) and the live cursor world point
  // (read by the deploy gesture and the monarch→cursor line).
  const ringMeshRef = useRef<THREE.Mesh | null>(null);
  const cursorWorldRef = useRef(new THREE.Vector3());
  // The segmented blue leash line from the piloted monarch's ring to the cursor.
  const cursorLinkLineRef = useRef<HTMLDivElement | null>(null);
  // The cursor's two materials, tinted together each frame (navy at rest, green/
  // red on a command flash).
  const ringMatRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const pyramidMatRef = useRef<THREE.MeshStandardMaterial | null>(null);
  // The cursor's current tint, recomputed each frame from the command-trigger
  // state (held over ground = green, over an enemy = red, else navy).
  const cursorTintRef = useRef<CursorTint>('default');
  // Scratch vectors reused every frame to keep the cursor math allocation-free.
  // `offset` is the persistent world-space leash offset from the piloted monarch.
  const cursorScratch = useRef({
    offset: new THREE.Vector3(),
    camForward: new THREE.Vector3(),
    camRight: new THREE.Vector3(),
    world: new THREE.Vector3(),
  });
  // Latest controller layout, subscribed so the dispatch rebuilds on a rebind.
  const controllerBindings = useGameStore((s) => s.controllerBindings);
  const controllerBindingModes = useGameStore((s) => s.controllerBindingModes);

  // Previous-frame active state per token, for press/release edge detection of the
  // activation-mode dispatch (and of the chord-mode actions, keyed "chord:<action>").
  const prevActive = useRef<Record<string, boolean>>({});

  // The activation-mode dispatch (token -> resolver + chord actions), rebuilt when
  // the controller layout changes. Held in a ref so the per-frame poll reads a stable
  // object without re-subscribing each frame.
  const dispatchRef = useRef<TokenDispatch>({ resolvers: new Map(), chordActions: [] });

  // Deploy Units (Hold mode) designation timer: one more follower each interval while
  // held, deployed on release. Kept off the React path so the 60 Hz poll never
  // triggers a re-render.
  const placementRepeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Right-trigger cursor-deploy gesture state. The command trigger issues a
  // move/attack on press (the snappy tap); held past CURSOR_DEPLOY_HOLD_MS while
  // piloting it instead grows a placement at the cursor (teardrop above the
  // pyramid) and deploys those units there on release. Tracked off the React path.
  const secondaryPrevRef = useRef(false);
  const secondaryPressAtRef = useRef(0);
  const cursorDeployActiveRef = useRef(false);
  const cursorDeployIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Eased press-feedback amount (0 = rest, 1 = fully pressed) for the ring/pyramid.
  const pressAmountRef = useRef(0);

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

  // The namespace of the currently-open selection radial (posture / formation /
  // audible / playbook), or null. Mirrored from each radial's open/close window
  // events. While one is open the right stick aims it, RT applies the highlight, and
  // B closes it; the prev-edge refs debounce RT/B to a single fire per press.
  const openRadialNsRef = useRef<string | null>(null);
  const radialSelectPrevRef = useRef(false);
  const radialClosePrevRef = useRef(false);
  // Edge state for the Directing wheel's page-flip buttons (LB prev / RB next), which
  // own those buttons only while that wheel is open.
  const pageNextPrevRef = useRef(false);
  const pagePrevPrevRef = useRef(false);

  // Stop the deploy designation interval (on release, pad disconnect, or unmount).
  const stopPlacementHold = () => {
    if (placementRepeatIntervalRef.current !== null) {
      clearInterval(placementRepeatIntervalRef.current);
      placementRepeatIntervalRef.current = null;
    }
  };

  const stopCursorDeployInterval = () => {
    if (cursorDeployIntervalRef.current !== null) {
      clearInterval(cursorDeployIntervalRef.current);
      cursorDeployIntervalRef.current = null;
    }
  };

  // Begin a cursor deploy: designate the first follower and float the teardrop over
  // the cursor, then one more follower each interval (mirrors startDeployDesignate).
  const startCursorDeploy = () => {
    const state = useGameStore.getState();
    if (state.isPaused || state.gameOver || !state.matchStarted || !state.pilotedUnitId) return;
    cursorDeployActiveRef.current = true;
    stopCursorDeployInterval();
    state.setUnitPlacementCursor({
      x: cursorWorldRef.current.x,
      y: cursorWorldRef.current.y,
      z: cursorWorldRef.current.z,
    });
    state.incrementUnitPlacement();
    cursorDeployIntervalRef.current = setInterval(() => {
      useGameStore.getState().incrementUnitPlacement();
    }, UNIT_PLACEMENT_REPEAT_INTERVAL_MS);
  };

  // Commit an in-progress cursor deploy: place the designated units at the cursor.
  const commitCursorDeploy = () => {
    stopCursorDeployInterval();
    cursorDeployActiveRef.current = false;
    const count = useGameStore.getState().unitPlacementCount;
    if (count >= 1) {
      useGameStore.getState().placeRalliedUnits(count, {
        x: cursorWorldRef.current.x,
        z: cursorWorldRef.current.z,
      });
    } else {
      useGameStore.getState().setUnitPlacementCursor(null);
    }
  };

  // Abandon a cursor deploy without placing (pad disconnect, pause, unmount).
  const cancelCursorDeploy = () => {
    stopCursorDeployInterval();
    if (cursorDeployActiveRef.current) {
      cursorDeployActiveRef.current = false;
      useGameStore.getState().resetUnitPlacement();
    }
    secondaryPrevRef.current = false;
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

  // Deploy Units in Hold mode: designate the first follower at the hold threshold,
  // then one more each interval (the teardrop count), and deploy the batch on release.
  const startDeployDesignate = () => {
    const state = useGameStore.getState();
    if (state.isPaused || state.gameOver || !state.matchStarted || !state.pilotedUnitId) return;
    stopPlacementHold();
    state.incrementUnitPlacement();
    placementRepeatIntervalRef.current = setInterval(() => {
      useGameStore.getState().incrementUnitPlacement();
    }, UNIT_PLACEMENT_REPEAT_INTERVAL_MS);
  };
  const commitDeploy = () => {
    stopPlacementHold();
    const count = useGameStore.getState().unitPlacementCount;
    if (count >= 1) useGameStore.getState().placeRalliedUnits(count);
  };

  // Track which selection radial is open so the poll loop can hand it the right
  // stick. Each radial broadcasts `rts:${ns}-radial-open|close`; we record the open
  // namespace and reset the RT/B edge refs on close so a stale press can't fire.
  useEffect(() => {
    const namespaces = ['stance', 'directing'];
    const cleanups: Array<() => void> = [];
    for (const ns of namespaces) {
      const onOpen = () => { openRadialNsRef.current = ns; };
      const onClose = () => {
        if (openRadialNsRef.current === ns) openRadialNsRef.current = null;
        radialSelectPrevRef.current = false;
        radialClosePrevRef.current = false;
      };
      window.addEventListener(`rts:${ns}-radial-open`, onOpen);
      window.addEventListener(`rts:${ns}-radial-close`, onClose);
      cleanups.push(() => {
        window.removeEventListener(`rts:${ns}-radial-open`, onOpen);
        window.removeEventListener(`rts:${ns}-radial-close`, onClose);
      });
    }
    return () => cleanups.forEach((fn) => fn());
  }, []);

  // Create / tear down the Queen-gesture DOM overlays. The targeting cursor itself
  // is a 3D scene object (returned below), not a DOM element.
  useEffect(() => {
    // The blue spawn-rally line and the gold patrol line the Queen gestures draw,
    // hidden until their gesture arms. Same dotted-arrow shape as the mouse path.
    const rallyArrow = createDottedArrow(RALLY_ARROW_COLOR);
    document.body.appendChild(rallyArrow);
    rallyArrowElRef.current = rallyArrow;

    const patrolArrow = createDottedArrow(PATROL_ARROW_COLOR);
    document.body.appendChild(patrolArrow);
    patrolArrowElRef.current = patrolArrow;

    // The segmented leash from the piloted monarch's ring to the cursor; its color
    // (matching the cursor) and segment tiling are set each frame as it is drawn.
    const cursorLinkLine = createSegmentedLine();
    document.body.appendChild(cursorLinkLine);
    cursorLinkLineRef.current = cursorLinkLine;

    return () => {
      gamepadInput.reset();
      stopPlacementHold();
      cancelCursorDeploy();
      dispatchRef.current.resolvers.forEach((resolver) => resolver.reset());
      cancelRallyAim();
      cancelPatrolAim();
      if (rallyArrowElRef.current) document.body.removeChild(rallyArrowElRef.current);
      if (patrolArrowElRef.current) document.body.removeChild(patrolArrowElRef.current);
      if (cursorLinkLineRef.current) document.body.removeChild(cursorLinkLineRef.current);
      rallyArrowElRef.current = null;
      patrolArrowElRef.current = null;
      cursorLinkLineRef.current = null;
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

  // The local player's currently piloted King/Queen, or null. This is the cursor's
  // origin while piloting: the cursor hides under it at rest and extends out from
  // it on the PILOT_CURSOR_MAX_DISTANCE leash.
  const pilotedMonarch = (): Unit | null => {
    const state = useGameStore.getState();
    if (!state.pilotedUnitId) return null;
    const unit = state.units.find((candidate) => candidate.id === state.pilotedUnitId);
    if (!unit || unit.ownerId !== state.localPlayerId) return null;
    if (unit.kind !== 'King' && unit.kind !== 'Queen') return null;
    return unit;
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
    // While the Directing wheel is open it borrows RB (the spawn-rally button) to flip
    // pages, so don't also arm the spawn-rally aim then — just track the edge.
    const directingOpen = openRadialNsRef.current === 'directing';
    const rallyActive = isControllerTokenActive(gamepad, bindings.setQueenRally);
    if (!directingOpen && rallyActive && !rallyPrevRef.current) handleRallyArm();
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

    // While the posture radial is open it owns RT (Move/Attack) and B (Deselect) as
    // its select/close inputs, so swallow those here too — defense against a chord
    // binding reaching this path while the dispatch loop skip handles plain presses.
    if (openRadialNsRef.current && (actionId === 'secondaryAction' || actionId === 'deselect')) return;

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
        const enemyId = nearestUnitId((ownerId, localId) => ownerId !== localId);
        // The cursor commands the player's units — never the monarch they are
        // actively piloting (that one is driven by the left stick). Excluding the
        // piloted monarch stops it from marching to the cursor on a command.
        const commandIds = state.selectedUnitIds.filter((id) => id !== state.pilotedUnitId);
        if (commandIds.length === 0) break;
        if (enemyId) {
          state.attackTarget({ unitIds: commandIds, targetId: enemyId });
        } else {
          const world = reticleWorldPosition();
          if (world) {
            state.moveCommand({
              unitIds: commandIds,
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
      case 'rally':
        // Rally the piloted army to follow; a no-op when not piloting.
        if (state.pilotedUnitId) state.rallyToMonarch();
        break;
      case 'selectAllUnits': {
        const ids = state.units
          .filter((u) => u.ownerId === state.localPlayerId && u.kind !== 'Base')
          .map((u) => u.id);
        if (ids.length > 0) state.selectUnits(ids);
        break;
      }
      case 'selectMonarchAnimal': {
        // Select every own unit sharing the piloted monarch's animal (e.g. piloting
        // the Bee King/Queen selects all Bees). A no-op when not piloting.
        const piloted = state.units.find((u) => u.id === state.pilotedUnitId);
        if (!piloted) break;
        const ids = state.units
          .filter((u) => u.ownerId === state.localPlayerId && u.kind !== 'Base' && u.animal === piloted.animal)
          .map((u) => u.id);
        if (ids.length > 0) state.selectUnits(ids);
        break;
      }
      case 'toggleBehaviorRadial':
        // Open/close the combat-posture radial; the right stick then aims a wedge
        // (handled in the poll loop) and a release confirms it. Same event the
        // keyboard binding fires, so BehaviorRadial has one entry point.
        window.dispatchEvent(new CustomEvent('rts:toggle-stance-radial'));
        break;
      case 'toggleDirectingRadial':
        // Open/close the paged Directing wheel (Shapes / Audibles / Plays); the right
        // stick then aims the active page and RT confirms, LB/RB flip pages. Same
        // event the keyboard binding fires, so DirectingRadial has one entry point.
        window.dispatchEvent(new CustomEvent('rts:toggle-directing-radial'));
        break;
      case 'deployUnits':
        // The one-shot path (tap / double-tap / chord): deploy a single unit. The
        // proportionate batch is the Hold lifecycle (startDeployDesignate/commitDeploy).
        if (state.pilotedUnitId) state.placeRalliedUnits(1);
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
      case 'cycleFireTeam':
        state.cycleFireTeam();
        break;
      default:
        break;
    }
  };

  // (Re)build the activation-mode dispatch whenever the controller layout changes.
  // Most actions are one-shot via fireAction in their chosen mode; Deploy Units in
  // Hold mode gets the designate/commit lifecycle. Old resolvers are reset so any
  // pending hold/double-tap timing can't outlive the rebind.
  useEffect(() => {
    const configFor = (actionId: string, mode: ActivationMode): Partial<TokenGestureConfig> | undefined => {
      if (mode === 'tap') return { onTap: () => fireAction(actionId as ControlActionId) };
      if (mode === 'double-tap') return { onDoubleTap: () => fireAction(actionId as ControlActionId) };
      if (mode === 'hold') {
        if (actionId === 'deployUnits') return { onHoldStart: startDeployDesignate, onHoldEnd: commitDeploy };
        return { onHoldStart: () => fireAction(actionId as ControlActionId) };
      }
      return undefined; // chord fired on the rising edge in the poll loop
    };

    dispatchRef.current.resolvers.forEach((resolver) => resolver.reset());
    dispatchRef.current = buildTokenDispatch({
      bindings: controllerBindings,
      modes: controllerBindingModes,
      actionIds: GAMEPAD_GESTURE_ACTIONS,
      configFor,
    });
    // fireAction / the deploy lifecycle read everything via getState(), so an older
    // closure behaves identically; rebuild only when the layout changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controllerBindings, controllerBindingModes]);

  useFrame((_, delta) => {
    const gamepad = getActiveGamepad();
    const cursorGroup = cursorGroupRef.current;

    // The pyramid spins continuously so the cursor always reads as "live" the
    // instant it appears — independent of pad/match state (hidden when not shown).
    if (pyramidSpinRef.current) pyramidSpinRef.current.rotation.y += CURSOR_SPIN_SPEED * delta;

    // Tint both materials from the current cursor tint (held over ground = green,
    // over an enemy = red, else navy). Copied, not re-parsed, every frame.
    const tint = CURSOR_TINT_COLOR[cursorTintRef.current];
    if (ringMatRef.current) {
      ringMatRef.current.color.copy(tint);
      ringMatRef.current.emissive.copy(tint);
    }
    if (pyramidMatRef.current) {
      pyramidMatRef.current.color.copy(tint);
      pyramidMatRef.current.emissive.copy(tint);
    }

    if (!gamepad) {
      gamepadInput.reset();
      prevActive.current = {};
      // Abandon any in-progress timing/aim so a disconnect mid-gesture can't strand a
      // timer, a movement pin, or a lingering line with no falling edge ever arriving.
      stopPlacementHold();
      cancelCursorDeploy();
      dispatchRef.current.resolvers.forEach((resolver) => resolver.reset());
      cancelRallyAim();
      cancelPatrolAim();
      rallyPrevRef.current = false;
      patrolPrevRef.current = false;
      pressAmountRef.current = 0;
      cursorTintRef.current = 'default';
      if (ringMeshRef.current) ringMeshRef.current.scale.setScalar(1);
      if (pyramidSpinRef.current) pyramidSpinRef.current.position.y = CURSOR_PYRAMID_CENTER_Y;
      if (cursorGroup) cursorGroup.visible = false;
      hideDottedArrow(cursorLinkLineRef.current);
      return;
    }

    const { controllerBindings, isPaused, matchStarted } = useGameStore.getState();

    const openRadialNs = openRadialNsRef.current;
    // A wheel owns the right stick while open, so the cursor block below is suppressed.
    const anyRadialOpen = openRadialNs !== null;

    // --- Radial selection (right stick + RT + B) for whichever wheel is open. The
    // right stick aims it (each wheel derives its highlight from the raw vector), RT
    // applies the highlight, and B closes it. The cursor block is suppressed (hides
    // via its else branch) so the two never fight over the stick, and the dispatch
    // loop skips RT/B so they don't also command/deselect. ---
    if (matchStarted && !isPaused && openRadialNs) {
      const rx = gamepad.axes[2] ?? 0;
      const ry = gamepad.axes[3] ?? 0;
      window.dispatchEvent(new CustomEvent(`rts:${openRadialNs}-radial-aim`, { detail: { x: rx, y: ry } }));

      // RT applies the highlighted option; rising edge only so a held trigger does
      // not repeat-apply every frame.
      const selectActive = isControllerTokenActive(gamepad, controllerBindings.secondaryAction);
      if (selectActive && !radialSelectPrevRef.current) {
        window.dispatchEvent(new CustomEvent(`rts:${openRadialNs}-radial-select`));
      }
      radialSelectPrevRef.current = selectActive;

      // B closes the radial; rising edge only. Reuses the toggle event (open → closed).
      const closeActive = isControllerTokenActive(gamepad, controllerBindings.deselect);
      if (closeActive && !radialClosePrevRef.current) {
        window.dispatchEvent(new CustomEvent(`rts:toggle-${openRadialNs}-radial`));
      }
      radialClosePrevRef.current = closeActive;

      // The Directing wheel is paged; LB/RB flip its pages while it is open (their
      // normal cycle-monarch / arm-spawn-rally jobs are suppressed in the dispatch
      // loop below). Rising edge only so a held bumper flips once per press.
      if (openRadialNs === 'directing') {
        const nextActive = isControllerTokenActive(gamepad, controllerBindings.setQueenRally); // RB
        if (nextActive && !pageNextPrevRef.current) {
          window.dispatchEvent(new CustomEvent('rts:directing-radial-page', { detail: { dir: 1 } }));
        }
        pageNextPrevRef.current = nextActive;

        const prevActivePage = isControllerTokenActive(gamepad, controllerBindings.pilotCycleMonarch); // LB
        if (prevActivePage && !pagePrevPrevRef.current) {
          window.dispatchEvent(new CustomEvent('rts:directing-radial-page', { detail: { dir: -1 } }));
        }
        pagePrevPrevRef.current = prevActivePage;
      } else {
        pageNextPrevRef.current = false;
        pagePrevPrevRef.current = false;
      }
    } else {
      radialSelectPrevRef.current = false;
      radialClosePrevRef.current = false;
      pageNextPrevRef.current = false;
      pagePrevPrevRef.current = false;
    }

    // --- Camera intent (analog, held). Suppressed while paused. Zoom is the bound
    // zoom tokens' magnitude (D-Pad Up/Down by default), held = continuous zoom. ---
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

    // --- Targeting cursor (right stick). The blue ring + spinning pyramid shows
    // while the stick is in use (always, when not piloting). When piloting a monarch
    // it hides under that unit at rest and extends out from it on a
    // PILOT_CURSOR_MAX_DISTANCE leash; otherwise it free-roams the screen (raycast to
    // the ground each frame). Hidden entirely while paused / before match start, and
    // while the posture radial owns the right stick (above). ---
    if (matchStarted && !isPaused && !anyRadialOpen) {
      const rx = gamepad.axes[2] ?? 0;
      const ry = gamepad.axes[3] ?? 0;
      const dx = Math.abs(rx) > CONTROLLER_DEADZONE ? rx : 0;
      const dy = Math.abs(ry) > CONTROLLER_DEADZONE ? ry : 0;
      const stickActive = dx !== 0 || dy !== 0;

      const monarch = pilotedMonarch();
      const deployActive = cursorDeployActiveRef.current;
      const { offset, camForward, camRight, world } = cursorScratch.current;
      let cursorVisible = false;

      if (monarch) {
        if (stickActive) {
          // Map the stick to camera-relative ground directions so "right" on the
          // stick pushes the cursor right on screen regardless of camera yaw.
          camera.getWorldDirection(camForward);
          camForward.y = 0;
          if (camForward.lengthSq() > 0) camForward.normalize();
          camRight.crossVectors(camForward, WORLD_UP).normalize();
          const step = PILOT_CURSOR_SPEED * delta;
          offset.addScaledVector(camRight, dx * step);
          offset.addScaledVector(camForward, -dy * step); // stick up (dy<0) pushes away
          offset.y = 0;
          if (offset.length() > PILOT_CURSOR_MAX_DISTANCE) offset.setLength(PILOT_CURSOR_MAX_DISTANCE);
          // Sit at the monarch's own elevation so the cursor hugs the scene even
          // when she stands on a raised deck rather than flat ground.
          world.set(monarch.position.x + offset.x, monarch.position.y, monarch.position.z + offset.z);
          // Keep the cursor inside the playable map, then re-sync the offset to the
          // clamped point so reversing direction responds immediately (no lag while
          // a clipped offset unwinds).
          clampToArena(world);
          offset.set(world.x - monarch.position.x, 0, world.z - monarch.position.z);
        } else if (deployActive) {
          // Mid-deploy the cursor stays put where it was aimed (it does not snap home
          // when the stick is released), so the player can free the stick to commit.
          world.set(monarch.position.x + offset.x, monarch.position.y, monarch.position.z + offset.z);
        } else {
          // At rest the cursor tucks back under the monarch and hides.
          offset.set(0, 0, 0);
          world.set(monarch.position.x, monarch.position.y, monarch.position.z);
        }
        cursorVisible = stickActive || deployActive;
        cursorWorldRef.current.copy(world);
        // Keep the screen-space anchor in sync so the existing pick/command logic
        // (which works in screen pixels) targets the same point the ring marks.
        const screen = projectToScreen(world.x, world.y, world.z);
        reticlePos.current.x = screen.x;
        reticlePos.current.y = screen.y;
        if (cursorGroup) {
          cursorGroup.position.copy(world);
          cursorGroup.visible = cursorVisible;
        }
      } else {
        // Free-roam: move the screen anchor in pixels, then raycast it to the ground.
        if (stickActive) {
          const step = RETICLE_SPEED_PX_PER_SEC * delta;
          reticlePos.current.x = clamp(reticlePos.current.x + dx * step, 0, window.innerWidth);
          reticlePos.current.y = clamp(reticlePos.current.y + dy * step, 0, window.innerHeight);
        }
        const ground = reticleWorldPosition();
        if (cursorGroup) {
          if (ground) {
            // Confine the cursor to the playable map, then pin the screen anchor to
            // the clamped point so the ring and any command target stay in-bounds.
            clampToArena(ground);
            cursorWorldRef.current.copy(ground);
            cursorGroup.position.copy(ground);
            const screen = projectToScreen(ground.x, ground.y, ground.z);
            reticlePos.current.x = screen.x;
            reticlePos.current.y = screen.y;
          }
          // Not piloting: keep the cursor visible (per spec), not gated on stick use.
          cursorVisible = ground !== null;
          cursorGroup.visible = cursorVisible;
        }
      }

      // --- Right-trigger press feedback + cursor-deploy gesture ---
      // The command trigger issues a move/attack on press (the dispatch's snappy
      // tap). Held past CURSOR_DEPLOY_HOLD_MS while piloting with a visible cursor,
      // it additionally grows a placement at the cursor and deploys on release.
      const triggerHeld = isControllerTokenActive(gamepad, controllerBindings.secondaryAction);
      const now = performance.now();
      if (triggerHeld && !secondaryPrevRef.current) {
        secondaryPressAtRef.current = now; // rising edge
      } else if (!triggerHeld && secondaryPrevRef.current && cursorDeployActiveRef.current) {
        commitCursorDeploy(); // falling edge with a deploy in progress
      }
      secondaryPrevRef.current = triggerHeld;

      // Ease the ring/pyramid toward "pressed" (ring half-size, pyramid dipped) so
      // a command press reads as a click onto the battlefield. Computed first so the
      // ring's current size is known when anchoring the leash to its edge below.
      const press = (pressAmountRef.current += ((triggerHeld ? 1 : 0) - pressAmountRef.current) * CURSOR_PRESS_EASE);
      const cursorRingRadius = CURSOR_RING_RADIUS * (1 - (1 - CURSOR_PRESS_RING_SCALE) * press);
      if (ringMeshRef.current) {
        ringMeshRef.current.scale.setScalar(1 - (1 - CURSOR_PRESS_RING_SCALE) * press);
      }
      if (pyramidSpinRef.current) {
        pyramidSpinRef.current.position.y = CURSOR_PYRAMID_CENTER_Y - CURSOR_PRESS_PYRAMID_DROP * press;
      }

      // Tint the cursor for the whole time the trigger is held: red when it would
      // attack (an enemy under it), neon green for a ground command, else navy.
      cursorTintRef.current = triggerHeld
        ? (nearestUnitId((ownerId, localId) => ownerId !== localId) ? 'enemy' : 'ground')
        : 'default';

      // Segmented leash, in the cursor's color, while a piloted cursor is shown. It
      // attaches to the EDGE of each ring on the side facing the other end, so each
      // anchor slides around its ring to stay pointed at the far ring as the cursor
      // orbits the monarch.
      if (monarch && cursorVisible) {
        const monRingRadius = royalRingWorldRadius(monarch.animal, monarch.kind as 'King' | 'Queen');
        const cw = cursorWorldRef.current;
        const dxw = cw.x - monarch.position.x;
        const dzw = cw.z - monarch.position.z;
        const lenw = Math.hypot(dxw, dzw);
        if (lenw > monRingRadius + cursorRingRadius) {
          const ux = dxw / lenw;
          const uz = dzw / lenw;
          const monarchAnchor = projectToScreen(
            monarch.position.x + ux * monRingRadius,
            monarch.position.y,
            monarch.position.z + uz * monRingRadius,
          );
          const cursorAnchor = projectToScreen(cw.x - ux * cursorRingRadius, cw.y + CURSOR_RING_Y, cw.z - uz * cursorRingRadius);
          positionSegmentedLine(
            cursorLinkLineRef.current,
            monarchAnchor,
            cursorAnchor,
            CURSOR_LINK_SEGMENTS,
            CURSOR_TINT_HEX[cursorTintRef.current],
          );
        } else {
          hideDottedArrow(cursorLinkLineRef.current); // rings overlap — no gap to span
        }
      } else {
        hideDottedArrow(cursorLinkLineRef.current);
      }

      if (
        triggerHeld && monarch && cursorVisible && !cursorDeployActiveRef.current &&
        now - secondaryPressAtRef.current >= CURSOR_DEPLOY_HOLD_MS
      ) {
        startCursorDeploy();
      }
      // While deploying, keep the teardrop floating over the live cursor point.
      if (cursorDeployActiveRef.current) {
        useGameStore.getState().setUnitPlacementCursor({
          x: cursorWorldRef.current.x,
          y: cursorWorldRef.current.y,
          z: cursorWorldRef.current.z,
        });
      }
    } else {
      if (cursorGroup) cursorGroup.visible = false;
      hideDottedArrow(cursorLinkLineRef.current);
      // A pause / match end mid-gesture must not strand the teardrop, timer, or press.
      cancelCursorDeploy();
      pressAmountRef.current = 0;
      cursorTintRef.current = 'default';
      if (ringMeshRef.current) ringMeshRef.current.scale.setScalar(1);
      if (pyramidSpinRef.current) pyramidSpinRef.current.position.y = CURSOR_PYRAMID_CENTER_Y;
    }

    // --- Activation-mode dispatch: feed each bound token's press/release edges to
    // its resolver (which fires tap / double-tap / hold per the player's choice).
    // While a radial wheel is open it owns RT (select) and B (close); skip those
    // tokens so the resolver never registers a press — preventing both an in-radial
    // command and a stray release firing once the radial closes. The Directing wheel
    // additionally borrows LB/RB as its page-flip, so those are skipped too while it
    // is open (they flip pages in the open-radial block above). ---
    const dispatch = dispatchRef.current;
    const radialOwnedTokens = anyRadialOpen
      ? new Set(
          [
            controllerBindings.secondaryAction,
            controllerBindings.deselect,
            ...(openRadialNs === 'directing'
              ? [controllerBindings.pilotCycleMonarch, controllerBindings.setQueenRally]
              : []),
          ].filter(Boolean)
        )
      : null;
    for (const [token, resolver] of dispatch.resolvers) {
      if (radialOwnedTokens?.has(token)) continue;
      const active = isControllerTokenActive(gamepad, token);
      const wasActive = prevActive.current[token] ?? false;
      if (active && !wasActive) resolver.press(performance.now());
      else if (!active && wasActive) resolver.release(performance.now());
      prevActive.current[token] = active;
    }

    // --- Chord-mode actions: fire once on the rising edge of the (multi-atom) token. ---
    for (const chord of dispatch.chordActions) {
      const key = `chord:${chord.actionId}`;
      const active = isControllerTokenActive(gamepad, chord.token);
      const wasActive = prevActive.current[key] ?? false;
      if (active && !wasActive) fireAction(chord.actionId as ControlActionId);
      prevActive.current[key] = active;
    }

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

  // The 3D targeting cursor lives in the scene (this component is inside the
  // <Canvas>). Hidden by default; the frame loop positions it and toggles
  // visibility. The ring lies flat on the ground; the 4-sided pyramid hovers
  // above with its point aimed down at the ring's center and spins about Y.
  return (
    <group ref={cursorGroupRef} visible={false}>
      <mesh ref={ringMeshRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, CURSOR_RING_Y, 0]}>
        <torusGeometry args={[CURSOR_RING_RADIUS, CURSOR_RING_TUBE, 16, 48]} />
        <meshStandardMaterial
          ref={ringMatRef}
          color={CURSOR_BLUE}
          emissive={CURSOR_BLUE}
          emissiveIntensity={CURSOR_EMISSIVE_INTENSITY}
          roughness={0.35}
          metalness={0}
          toneMapped={false}
        />
      </mesh>
      <group ref={pyramidSpinRef} position={[0, CURSOR_PYRAMID_CENTER_Y, 0]}>
        <mesh rotation={[Math.PI, 0, 0]}>
          <coneGeometry args={[CURSOR_PYRAMID_RADIUS, CURSOR_PYRAMID_HEIGHT, 4]} />
          <meshStandardMaterial
            ref={pyramidMatRef}
            color={CURSOR_BLUE}
            emissive={CURSOR_BLUE}
            emissiveIntensity={CURSOR_EMISSIVE_INTENSITY}
            roughness={0.35}
            metalness={0}
            toneMapped={false}
          />
        </mesh>
      </group>
    </group>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Camera actions are evaluated analogically above, never as taps; this guard
// documents that intent for future maintainers extending the action set.
void CAMERA_ACTIONS;
