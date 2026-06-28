import { useRef, useEffect, useCallback } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { keyboardCoordinator } from '../utils/keyboardCoordination';
import { useGameStore, getSimSnapshot } from '../game/state';
import { useUiStore } from '../game/uiStore';

import { useUiSettingsStore } from "../game/uiSettingsStore";
import { gamepadInput } from './Working/gamepadInput';
import { pilotInput } from './Working/monarchPilot';
import { getArenaBoundary } from './Working/arenaBoundary';
import { clampCameraFocus } from './Working/cameraFocusBounds';
import { computeActiveEdges, edgePanIndicator } from './Working/edgePanIndicator';

/**
 * A camera-movement binding is only usable as a held key when it's a single
 * plain key — no modifier chord, and not a mouse button or wheel direction
 * (those are handled elsewhere). Returns that key token for matching against
 * the pressed-keys set, or null when the binding isn't a plain key.
 */
function plainKeyToken(token: string): string | null {
  if (!token || token.includes('+') || token.startsWith('mouse:') || token === 'wheelup' || token === 'wheeldown') {
    return null;
  }
  return token;
}

// Global instance counter to detect multiple mounting
let instanceCounter = 0;

// The view a match opens on: focus point on the player's side of the map and
// the starting zoom distance. Hoisted to module scope so the ref initializers
// and the per-match reset (see the matchStartNonce effect) share one source of
// truth instead of duplicating the literals.
//
// Multiplayer is deterministic lockstep: both peers run the SAME world (p0's
// base sits at +z, p1's at -z), so the only thing that may differ per peer is
// the view. Each player must open behind their OWN base looking into the
// battlefield, otherwise the guest (p1) would stare across the map at the
// host's army (its enemies) while its own troops sit off-screen behind the
// camera. `viewSignFor` returns +1 for the host/single-player (p0 orientation:
// camera on the +z side looking toward -z) and -1 for the guest (mirrored).
const INITIAL_FOCUS_DEPTH = 225;
const INITIAL_DISTANCE = 200;

// When the camera is following selected troops (or a piloted monarch), aim the
// look-at point *ahead* of the unit — deeper into the battlefield — by this
// fraction of the current zoom distance. The camera always frames its look-at
// point at screen center, so biasing the focus forward leaves the followed unit
// behind it: closer to the camera and sitting a touch below dead center. The
// bias scales with zoom distance (and the shallow fixed camera angle) so the
// on-screen placement stays put as the player zooms. Kept modest so a large,
// spread-out selection clears the bottom-edge HUD buttons instead of hiding
// behind them.
const FOLLOW_SCREEN_BIAS = 0.25;

// A piloted King/Queen rides a touch higher on screen than a plain selection: a
// smaller forward bias pulls its look-at point back toward the unit, lifting the
// monarch nearer to center while still keeping it in the lower half.
const MONARCH_SCREEN_BIAS = 0.28;

function viewSignFor(localPlayerId: string | null): number {
  return localPlayerId === 'p1' ? -1 : 1;
}

function initialFocusFor(localPlayerId: string | null): THREE.Vector3 {
  return new THREE.Vector3(0, 0, INITIAL_FOCUS_DEPTH * viewSignFor(localPlayerId));
}

interface CameraControllerProps {
  moveSpeed?: number;
  zoomSpeed?: number;
  minDistance?: number;
  maxDistance?: number;
  // How quickly the camera eases toward the selected troops, in "fraction of
  // the remaining distance closed per second" terms. A small value keeps the
  // follow gentle so the camera glides rather than snaps.
  followSpeed?: number;
  // Width of the screen-edge band (in CSS pixels) that triggers edge-pan when
  // the cursor enters it — the classic RTS "push the mouse to the edge to
  // scroll" zone.
  edgePanMargin?: number;
  // World units the camera slides per pixel of middle-mouse drag ("grab and
  // slide the terrain"). Scaled by moveSpeed so it tracks the overall pan feel.
  dragPanSensitivity?: number;
}

export function CameraController({
  moveSpeed = 0.5,
  zoomSpeed = 2,
  minDistance = 2,
  maxDistance = 100,
  followSpeed = 1.5,
  edgePanMargin = 24,
  dragPanSensitivity = 0.6
}: CameraControllerProps) {
  instanceCounter++;
  const instanceId = instanceCounter;

  const { camera, gl } = useThree();
  const keysPressed = useRef(new Set<string>());

  // Which peer's view this is. Drives the camera orientation so the host (p0)
  // and guest (p1) each look into the battlefield from behind their own base.
  // Null in single-player, where it falls back to the p0 orientation.
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const target = useRef(initialFocusFor(localPlayerId));
  const currentDistance = useRef(INITIAL_DISTANCE);
  const forward = useRef(new THREE.Vector3());
  const right = useRef(new THREE.Vector3());
  const up = useRef(new THREE.Vector3(0, 1, 0));

  // Live keyboard bindings, mirrored to a ref so the per-frame loop reads the
  // current layout without re-subscribing or rebuilding callbacks each render.
  const keyboardBindings = useUiSettingsStore((s) => s.keyboardBindings);
  const bindingsRef = useRef(keyboardBindings);
  bindingsRef.current = keyboardBindings;

  // Player-tuned speed multipliers, mirrored to a ref so the per-frame loop and the
  // wheel/drag callbacks read the live values without re-subscribing. "scroll" scales
  // the zoom + camera-pan rate; the keyboard "cursor" multiplier scales edge-scroll
  // (the OS owns the real mouse pointer, so edge-scroll is what a KB&M player can tune).
  const controlSpeeds = useUiSettingsStore((s) => s.controlSpeeds);
  const speedsRef = useRef(controlSpeeds);
  speedsRef.current = controlSpeeds;

  // Whether the camera is currently easing toward the selected troops. Manual
  // panning (edge-scroll, middle-drag, controller stick, touch drag) cancels it; making a fresh
  // selection re-arms it.
  const followEnabled = useRef(false);

  // Re-arm follow whenever the player makes a non-empty selection. The store
  // hands out a new array reference on every select/add/clear, so this fires on
  // each selection change rather than every game tick.
  const selectedUnitIds = useUiStore((s) => s.selectedUnitIds); // selection is local-UI (P1-1)
  useEffect(() => {
    followEnabled.current = selectedUnitIds.length > 0;
  }, [selectedUnitIds]);

  // Snap the view back to the opening shot at the start of every match. This
  // component stays mounted across "Play Again" (the Canvas never leaves the
  // 'playing' screen), so its focus/zoom refs would otherwise carry over
  // wherever the player last panned the previous match. Keyed on matchStartNonce
  // rather than matchStarted because the latter never changes value across a
  // replay (see types.ts). The initial mount also runs this — harmless, since
  // the refs already hold these defaults.
  // Also keyed on localPlayerId so the guest snaps to its own (mirrored) opening
  // shot once its role resolves, even if that lands after the initial mount.
  const matchStartNonce = useGameStore((s) => s.matchStartNonce);
  useEffect(() => {
    target.current.copy(initialFocusFor(localPlayerId));
    currentDistance.current = INITIAL_DISTANCE;
    followEnabled.current = false;
  }, [matchStartNonce, localPlayerId]);

  // Touch handling refs
  const lastTouchPos = useRef<{ x: number; y: number } | null>(null);
  const lastPinchDistance = useRef<number | null>(null);
  const isDragging = useRef(false);

  // Mouse-driven camera panning refs. `mousePos` is the latest cursor position
  // in client pixels; `mouseOverCanvas` gates edge-pan so hovering a HUD widget
  // (minimap, buttons) near a screen edge doesn't scroll the map. The middle-
  // drag refs track a "grab and slide the terrain" gesture.
  const mousePos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const mouseOverCanvas = useRef(false);
  const isMiddleDragging = useRef(false);
  const lastDragPos = useRef<{ x: number; y: number } | null>(null);

  // Fixed camera angle - lower angle for better RTS view
  const CAMERA_ANGLE = Math.PI / 10; // 18 degrees

  // Clearing the pressed-key set is needed in any situation where a `keyup`
  // event might be missed (window blur, tab hidden, OS-level hotkey swallows
  // the release, focus jumping to an input). Without this the camera would
  // drift forever in the last-held direction once that happens.
  const clearPressedKeys = useCallback(() => {
    keysPressed.current.clear();
  }, []);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    const key = event.key.toLowerCase();

    // Check if camera input is blocked
    if (keyboardCoordinator.isCameraInputBlocked()) {
      return;
    }

    // Record every key (normalizing space) so any rebound camera key resolves
    // in the per-frame loop; unrelated keys are simply never read there.
    keysPressed.current.add(key === ' ' ? 'space' : key);
  }, []);

  const handleKeyUp = useCallback((event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    keysPressed.current.delete(key === ' ' ? 'space' : key);
  }, []);

  const handleVisibilityChange = useCallback(() => {
    if (document.hidden) {
      clearPressedKeys();
    }
  }, [clearPressedKeys]);

  const handleWheel = useCallback((event: WheelEvent) => {
    // The listener is attached to `window` so we receive every wheel event on
    // the page. Only treat the wheel as a camera-zoom input when the event
    // originated over the WebGL canvas — otherwise let the browser scroll
    // whatever UI surface the cursor is over (post-game leaderboard, HUD
    // panels, modal overlays). Calling preventDefault() unconditionally was
    // suppressing scroll in those overlays.
    const target = event.target as Node | null;
    if (!target || !gl.domElement.contains(target)) {
      return;
    }

    event.preventDefault();

    // Determine zoom direction and apply, scaled by the keyboard scroll-speed setting.
    const wheelStep = zoomSpeed * speedsRef.current.keyboardScroll;
    const zoomDelta = event.deltaY > 0 ? wheelStep : -wheelStep;

    // Apply zoom with constraints
    const newDistance = Math.max(minDistance, Math.min(maxDistance, currentDistance.current + zoomDelta));
    currentDistance.current = newDistance;
  }, [zoomSpeed, minDistance, maxDistance, instanceId, gl]);

  // Start a "grab and slide" pan when the middle mouse button is pressed over
  // the canvas. preventDefault suppresses the browser's middle-click autoscroll.
  const handleMouseDown = useCallback((event: MouseEvent) => {
    if (event.button !== 1) return; // middle button only
    const node = event.target as Node | null;
    if (!node || !gl.domElement.contains(node)) return;
    event.preventDefault();
    isMiddleDragging.current = true;
    lastDragPos.current = { x: event.clientX, y: event.clientY };
  }, [gl]);

  // Track the cursor (for edge-pan) and, while middle-dragging, slide the focus
  // point so the terrain appears to follow the cursor. Listening on `window`
  // keeps the drag alive even if the cursor briefly leaves the canvas.
  const handleMouseMove = useCallback((event: MouseEvent) => {
    mousePos.current = { x: event.clientX, y: event.clientY };
    const node = event.target as Node | null;
    mouseOverCanvas.current = !!node && gl.domElement.contains(node);

    if (!isMiddleDragging.current || !lastDragPos.current) return;

    const deltaX = event.clientX - lastDragPos.current.x;
    const deltaY = event.clientY - lastDragPos.current.y;

    // Ground-plane basis derived fresh from the camera so the slide direction is
    // always correct regardless of frame timing.
    const cameraDirection = new THREE.Vector3();
    camera.getWorldDirection(cameraDirection);
    cameraDirection.y = 0;
    cameraDirection.normalize();
    const rightVec = new THREE.Vector3().crossVectors(cameraDirection, up.current).normalize();

    // Grabbing the terrain: dragging right slides the world right, so the focus
    // point moves left (inverted), matching the single-finger touch drag. Middle-drag
    // is a scroll gesture, so it tracks the keyboard scroll-speed setting.
    const perPixel = moveSpeed * dragPanSensitivity * speedsRef.current.keyboardScroll;
    target.current.add(rightVec.multiplyScalar(-deltaX * perPixel));
    target.current.add(cameraDirection.multiplyScalar(deltaY * perPixel));

    // A manual grab cancels selection auto-follow until the next selection.
    followEnabled.current = false;
    lastDragPos.current = { x: event.clientX, y: event.clientY };
  }, [camera, gl, moveSpeed, dragPanSensitivity]);

  const handleMouseUp = useCallback((event: MouseEvent) => {
    if (event.button !== 1) return;
    isMiddleDragging.current = false;
    lastDragPos.current = null;
  }, []);

  // Cursor left the document entirely — stop edge-panning and any active drag.
  const handleMouseLeaveWindow = useCallback(() => {
    mouseOverCanvas.current = false;
    isMiddleDragging.current = false;
    lastDragPos.current = null;
  }, []);

  // Touch event handlers for mobile
  const handleTouchStart = useCallback((event: TouchEvent) => {
    if (event.touches.length === 1) {
      // Single touch - prepare for drag
      lastTouchPos.current = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY
      };
      isDragging.current = true;
    } else if (event.touches.length === 2) {
      // Two finger touch - prepare for pinch zoom
      isDragging.current = false;
      const dx = event.touches[0].clientX - event.touches[1].clientX;
      const dy = event.touches[0].clientY - event.touches[1].clientY;
      lastPinchDistance.current = Math.sqrt(dx * dx + dy * dy);
    }
  }, []);

  const handleTouchMove = useCallback((event: TouchEvent) => {
    event.preventDefault();

    if (event.touches.length === 1 && isDragging.current && lastTouchPos.current) {
      // Single finger drag - move camera
      const touchX = event.touches[0].clientX;
      const touchY = event.touches[0].clientY;

      const deltaX = (touchX - lastTouchPos.current.x) * 0.5;
      const deltaY = (touchY - lastTouchPos.current.y) * 0.5;

      // Calculate camera direction vectors for movement
      const cameraDirection = new THREE.Vector3();
      camera.getWorldDirection(cameraDirection);
      cameraDirection.y = 0;
      cameraDirection.normalize();

      const forwardVec = cameraDirection.clone();
      const rightVec = new THREE.Vector3().crossVectors(forwardVec, up.current).normalize();

      // Move target based on drag (inverted for natural feel)
      target.current.add(rightVec.multiplyScalar(-deltaX * moveSpeed * 0.5));
      target.current.add(forwardVec.multiplyScalar(deltaY * moveSpeed * 0.5));

      // Dragging the view is a manual pan, so stop chasing the selection.
      followEnabled.current = false;

      lastTouchPos.current = { x: touchX, y: touchY };
    } else if (event.touches.length === 2 && lastPinchDistance.current !== null) {
      // Two finger pinch - zoom
      const dx = event.touches[0].clientX - event.touches[1].clientX;
      const dy = event.touches[0].clientY - event.touches[1].clientY;
      const currentPinchDistance = Math.sqrt(dx * dx + dy * dy);

      const pinchDelta = lastPinchDistance.current - currentPinchDistance;
      const zoomDelta = pinchDelta * 0.5;

      const newDistance = Math.max(minDistance, Math.min(maxDistance, currentDistance.current + zoomDelta));
      currentDistance.current = newDistance;

      lastPinchDistance.current = currentPinchDistance;
    }
  }, [camera, moveSpeed, minDistance, maxDistance]);

  const handleTouchEnd = useCallback(() => {
    lastTouchPos.current = null;
    lastPinchDistance.current = null;
    isDragging.current = false;
  }, []);

  useEffect(() => {
    // Add event listeners to window for global key handling
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('wheel', handleWheel, { passive: false });

    // Mouse-driven camera panning: middle-drag "grab and slide" plus edge-pan
    // cursor tracking. mousedown is bound to the canvas so a drag only begins
    // over the game; move/up live on the window so the gesture survives the
    // cursor briefly leaving the canvas.
    const canvasEl = gl.domElement;
    canvasEl.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mouseleave', handleMouseLeaveWindow);

    // Drop any "still pressed" keys whenever the window/tab loses the ability
    // to deliver the matching keyup. Otherwise the camera drifts forever in
    // the last-held direction after alt-tabbing, opening dev tools, or any
    // OS hotkey that steals focus mid-press. The same blur also ends any active
    // mouse drag and stops edge-pan.
    window.addEventListener('blur', clearPressedKeys);
    window.addEventListener('blur', handleMouseLeaveWindow);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Touch event listeners
    const canvas = gl.domElement;
    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', handleTouchEnd, { passive: false });

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mouseleave', handleMouseLeaveWindow);
      window.removeEventListener('blur', clearPressedKeys);
      window.removeEventListener('blur', handleMouseLeaveWindow);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
      canvas.removeEventListener('touchend', handleTouchEnd);
      canvas.removeEventListener('touchcancel', handleTouchEnd);
      // Drop any lit edge chevrons so none lingers after the camera unmounts.
      edgePanIndicator.reset();
    };
  }, [handleKeyDown, handleKeyUp, handleWheel, handleMouseDown, handleMouseMove, handleMouseUp, handleMouseLeaveWindow, handleTouchStart, handleTouchMove, handleTouchEnd, clearPressedKeys, handleVisibilityChange, gl, instanceId]);

  useFrame((state, delta) => {
    // Set camera properties on first frame
    if ((camera as any).near !== 0.01) {
      (camera as any).near = 0.01;
      (camera as any).far = 2000;
      camera.updateProjectionMatrix();
    }

    // Camera orientation for this peer: +z behind the host's base, -z behind the
    // guest's. Mirrors the focus point and the eye offset so each player looks
    // into the battlefield rather than out the back of the map.
    const viewSign = viewSignFor(localPlayerId);

    // Initialize camera position if needed
    if (camera.position.length() === 0) {
      const height = currentDistance.current * Math.sin(CAMERA_ANGLE);
      const horizontalDistance = currentDistance.current * Math.cos(CAMERA_ANGLE);
      camera.position.set(target.current.x, height, target.current.z + horizontalDistance * viewSign);
      camera.lookAt(target.current);
    }

    // Ground-plane basis vectors, recomputed each frame (cheap) so edge-pan,
    // middle-drag, keyboard drive, and the controller stick all share one frame.
    const cameraDirection = new THREE.Vector3();
    camera.getWorldDirection(cameraDirection);
    cameraDirection.y = 0;
    cameraDirection.normalize();
    forward.current.copy(cameraDirection);
    right.current.crossVectors(forward.current, up.current).normalize();

    const bindings = bindingsRef.current;
    const cameraIntent = gamepadInput.getCameraIntent();
    const keys = keysPressed.current;
    const speeds = speedsRef.current;
    const forwardKey = plainKeyToken(bindings.cameraForward);
    const backwardKey = plainKeyToken(bindings.cameraBackward);
    const leftKey = plainKeyToken(bindings.cameraLeft);
    const rightKey = plainKeyToken(bindings.cameraRight);

    // Keyboard movement (ESDF) only ever drives a piloted King/Queen — the
    // keyboard no longer pans the camera (edge-scroll and middle-drag do that).
    const keyboardDrive = new THREE.Vector3();
    if (forwardKey && keys.has(forwardKey)) keyboardDrive.add(forward.current);
    if (backwardKey && keys.has(backwardKey)) keyboardDrive.sub(forward.current);
    if (leftKey && keys.has(leftKey)) keyboardDrive.sub(right.current);
    if (rightKey && keys.has(rightKey)) keyboardDrive.add(right.current);

    // Controller left-stick: drives a piloted monarch when piloting, otherwise
    // pans the camera (the keyboard's old job).
    const gamepadMove = new THREE.Vector3();
    if (cameraIntent.panZ !== 0) gamepadMove.add(forward.current.clone().multiplyScalar(cameraIntent.panZ));
    if (cameraIntent.panX !== 0) gamepadMove.add(right.current.clone().multiplyScalar(cameraIntent.panX));

    // While piloting a King/Queen, the ESDF keys and controller stick drive that
    // unit (the game tick reads pilotInput) and the camera eases to follow it.
    // Otherwise the controller stick plus screen-edge scroll pan the camera.
    // Read the piloted id straight from the store so this per-frame loop never
    // forces a React re-render.
    const store = getSimSnapshot();
    const pilotedId = store.pilotedUnitId;
    // The same ESDF/stick drive steers a deployed fire team when the player has
    // handed control onto one (mutually exclusive with piloting a monarch). The
    // camera follows the squad's centroid instead of a single monarch.
    const pilotedFireTeamId = store.pilotedFireTeamId;
    const isDriving = pilotedId !== null || pilotedFireTeamId !== null;

    if (isDriving) {
      // The drive vector is camera-relative; clamp its length to 1 so an analog
      // stick scales speed while digital keys (length 1) mean full speed.
      const drive = keyboardDrive.add(gamepadMove);
      const intentMagnitude = Math.hypot(drive.x, drive.z);
      if (intentMagnitude > 1) {
        drive.x /= intentMagnitude;
        drive.z /= intentMagnitude;
      }
      pilotInput.setMove(drive.x, drive.z);

      // No edge-pan while driving, so no edge chevrons should be lit.
      edgePanIndicator.reset();

      // Ease the camera focus onto whatever is being driven — the piloted monarch,
      // or the centroid of the driven fire team's living members. Selection
      // auto-follow stays off so the two follow behaviours don't fight.
      followEnabled.current = false;
      let focusX = 0;
      let focusZ = 0;
      let focusCount = 0;
      for (const unit of store.units) {
        if (pilotedId !== null) {
          if (unit.id === pilotedId) {
            focusX = unit.position.x;
            focusZ = unit.position.z;
            focusCount = 1;
            break;
          }
        } else if (unit.fireTeamId === pilotedFireTeamId && unit.hp > 0) {
          focusX += unit.position.x;
          focusZ += unit.position.z;
          focusCount++;
        }
      }
      if (focusCount > 0) {
        // Bias the look-at point ahead of the target so it rides in the lower
        // portion of the screen, closer to the camera.
        const followBias = currentDistance.current * MONARCH_SCREEN_BIAS;
        const desiredX = focusX / focusCount + forward.current.x * followBias;
        const desiredZ = focusZ / focusCount + forward.current.z * followBias;
        const easing = 1 - Math.exp(-followSpeed * delta);
        target.current.x += (desiredX - target.current.x) * easing;
        target.current.z += (desiredZ - target.current.z) * easing;
      }
    } else {
      // Camera panning: controller stick plus screen-edge scroll. (Middle-drag
      // is applied directly in handleMouseMove.) The two sources carry different
      // player-tuned speeds — the controller stick rides the controller scroll-speed
      // setting, the screen-edge scroll rides the keyboard cursor-speed setting — so
      // they are accumulated and scaled independently rather than summed first.
      const stickPan = gamepadMove;

      // Edge-pan only fires while the cursor sits in the edge band over the canvas, so
      // hovering a HUD widget near a screen edge doesn't scroll the map.
      const edgePan = new THREE.Vector3();
      if (mouseOverCanvas.current && !isMiddleDragging.current) {
        const { x: mouseX, y: mouseY } = mousePos.current;
        // One shared computation drives both the pan and the on-screen chevrons,
        // so the chevron for an edge is lit exactly when that edge's pan fires.
        const edges = computeActiveEdges(mouseX, mouseY, window.innerWidth, window.innerHeight, edgePanMargin);
        if (edges.left) edgePan.sub(right.current);
        else if (edges.right) edgePan.add(right.current);
        if (edges.top) edgePan.add(forward.current);
        else if (edges.bottom) edgePan.sub(forward.current);
        edgePanIndicator.setEdges(edges);
      } else {
        // Cursor off-canvas or mid middle-drag: edge-pan is suppressed, so are the chevrons.
        edgePanIndicator.reset();
      }

      let panned = false;
      if (stickPan.length() > 0) {
        const moveAmount = moveSpeed * speeds.controllerScroll * 60 * delta; // 60 = frame-rate independence
        target.current.add(stickPan.clone().normalize().multiplyScalar(moveAmount));
        panned = true;
      }
      if (edgePan.length() > 0) {
        const moveAmount = moveSpeed * speeds.keyboardCursor * 60 * delta;
        target.current.add(edgePan.normalize().multiplyScalar(moveAmount));
        panned = true;
      }
      // Any manual pan input cancels the auto-follow until a fresh selection.
      if (panned) followEnabled.current = false;

      // Slow auto-follow: when armed, ease the focus point toward the centroid of
      // the currently selected, still-living troops. Reads the store directly so
      // the per-frame loop never forces a React re-render on unit movement.
      if (followEnabled.current) {
        const selectedIds = useUiStore.getState().selectedUnitIds; // selection is local-UI (P1-1)
        if (selectedIds.length === 0) {
          followEnabled.current = false;
        } else {
          const selectedSet = new Set(selectedIds);
          let sumX = 0;
          let sumZ = 0;
          let count = 0;
          for (const unit of store.units) {
            if (selectedSet.has(unit.id)) {
              sumX += unit.position.x;
              sumZ += unit.position.z;
              count++;
            }
          }

          if (count > 0) {
            // Frame-rate-independent easing toward the troop centroid, biased
            // forward so the selection sits in the lower third of the screen
            // (closer to the camera) instead of dead center. Only the horizontal
            // focus moves; height/zoom stay under the player's control.
            const followBias = currentDistance.current * FOLLOW_SCREEN_BIAS;
            const desiredX = sumX / count + forward.current.x * followBias;
            const desiredZ = sumZ / count + forward.current.z * followBias;
            const easing = 1 - Math.exp(-followSpeed * delta);
            target.current.x += (desiredX - target.current.x) * easing;
            target.current.z += (desiredZ - target.current.z) * easing;
          }
        }
      }
    }

    // Zoom from bound keyboard keys (if any) plus the controller, applied as a
    // continuous per-frame rate. Mouse-wheel zoom stays in handleWheel. The controller
    // trigger zoom rides the controller scroll-speed setting; the bound keyboard zoom
    // keys ride the keyboard scroll-speed setting (negative = zoom in, positive = out).
    const zoomInKey = plainKeyToken(bindings.cameraZoomIn);
    const zoomOutKey = plainKeyToken(bindings.cameraZoomOut);
    let keyboardZoom = 0;
    if (zoomInKey && keys.has(zoomInKey)) keyboardZoom -= 1;
    if (zoomOutKey && keys.has(zoomOutKey)) keyboardZoom += 1;
    const applyZoom = (direction: number, speedScale: number) => {
      if (direction === 0) return;
      const zoomAmount = direction * zoomSpeed * speedScale * 30 * delta;
      currentDistance.current = Math.max(minDistance, Math.min(maxDistance, currentDistance.current + zoomAmount));
    };
    applyZoom(cameraIntent.zoom, speeds.controllerScroll);
    applyZoom(keyboardZoom, speeds.keyboardScroll);

    // Confine the focus to the playable map. Every pan source above (controller stick, edge-pan,
    // middle-drag, auto-follow, piloted-unit follow) mutates target.current without bounds, so a
    // continuous input — most notably analog stick drift — could otherwise slide the view off the
    // map with no way to stop it. Clamping the focus (not the eye) keeps the map edges visible.
    const focusBounds = getArenaBoundary();
    if (focusBounds) {
      const clamped = clampCameraFocus(focusBounds, target.current.x, target.current.z);
      target.current.x = clamped.x;
      target.current.z = clamped.z;
    }

    // Update camera position based on target and current distance
    const height = currentDistance.current * Math.sin(CAMERA_ANGLE);
    const horizontalDistance = currentDistance.current * Math.cos(CAMERA_ANGLE);

    const newCameraPos = new THREE.Vector3(
      target.current.x,
      target.current.y + height,
      target.current.z + horizontalDistance * viewSign
    );

    // Set camera position directly - no lerp to avoid rocking
    camera.position.copy(newCameraPos);
    camera.lookAt(target.current);
  });

  return null;
}