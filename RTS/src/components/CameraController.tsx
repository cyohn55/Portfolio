import { useRef, useEffect, useCallback } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { keyboardCoordinator } from '../utils/keyboardCoordination';
import { useGameStore } from '../game/state';
import { gamepadInput } from './Working/gamepadInput';

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

interface CameraControllerProps {
  moveSpeed?: number;
  zoomSpeed?: number;
  minDistance?: number;
  maxDistance?: number;
  // How quickly the camera eases toward the selected troops, in "fraction of
  // the remaining distance closed per second" terms. A small value keeps the
  // follow gentle so the camera glides rather than snaps.
  followSpeed?: number;
}

export function CameraController({
  moveSpeed = 0.5,
  zoomSpeed = 2,
  minDistance = 2,
  maxDistance = 100,
  followSpeed = 1.5
}: CameraControllerProps) {
  instanceCounter++;
  const instanceId = instanceCounter;

  const { camera, gl } = useThree();
  const keysPressed = useRef(new Set<string>());
  const target = useRef(new THREE.Vector3(0, 0, 225));
  const currentDistance = useRef(200);
  const forward = useRef(new THREE.Vector3());
  const right = useRef(new THREE.Vector3());
  const up = useRef(new THREE.Vector3(0, 1, 0));

  // Live keyboard bindings, mirrored to a ref so the per-frame loop reads the
  // current layout without re-subscribing or rebuilding callbacks each render.
  const keyboardBindings = useGameStore((s) => s.keyboardBindings);
  const bindingsRef = useRef(keyboardBindings);
  bindingsRef.current = keyboardBindings;

  // Whether the camera is currently easing toward the selected troops. Manual
  // panning (WASD, controller stick, touch drag) cancels it; making a fresh
  // selection re-arms it.
  const followEnabled = useRef(false);

  // Re-arm follow whenever the player makes a non-empty selection. The store
  // hands out a new array reference on every select/add/clear, so this fires on
  // each selection change rather than every game tick.
  const selectedUnitIds = useGameStore((s) => s.selectedUnitIds);
  useEffect(() => {
    followEnabled.current = selectedUnitIds.length > 0;
  }, [selectedUnitIds]);

  // Touch handling refs
  const lastTouchPos = useRef<{ x: number; y: number } | null>(null);
  const lastPinchDistance = useRef<number | null>(null);
  const isDragging = useRef(false);

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

    // Determine zoom direction and apply
    const zoomDelta = event.deltaY > 0 ? zoomSpeed : -zoomSpeed;

    // Apply zoom with constraints
    const newDistance = Math.max(minDistance, Math.min(maxDistance, currentDistance.current + zoomDelta));
    currentDistance.current = newDistance;
  }, [zoomSpeed, minDistance, maxDistance, instanceId, gl]);

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

    // Drop any "still pressed" keys whenever the window/tab loses the ability
    // to deliver the matching keyup. Otherwise the camera drifts forever in
    // the last-held direction after alt-tabbing, opening dev tools, or any
    // OS hotkey that steals focus mid-press.
    window.addEventListener('blur', clearPressedKeys);
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
      window.removeEventListener('blur', clearPressedKeys);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
      canvas.removeEventListener('touchend', handleTouchEnd);
      canvas.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleKeyDown, handleKeyUp, handleWheel, handleTouchStart, handleTouchMove, handleTouchEnd, clearPressedKeys, handleVisibilityChange, gl, instanceId]);

  useFrame((state, delta) => {
    // Set camera properties on first frame
    if ((camera as any).near !== 0.01) {
      (camera as any).near = 0.01;
      (camera as any).far = 2000;
      camera.updateProjectionMatrix();
    }

    // Initialize camera position if needed
    if (camera.position.length() === 0) {
      const height = currentDistance.current * Math.sin(CAMERA_ANGLE);
      const horizontalDistance = currentDistance.current * Math.cos(CAMERA_ANGLE);
      camera.position.set(0, height, horizontalDistance);
      camera.lookAt(target.current);
    }

    // Movement from keyboard (remappable) and controller (analog left stick).
    const bindings = bindingsRef.current;
    const cameraIntent = gamepadInput.getCameraIntent();
    const keys = keysPressed.current;
    const forwardKey = plainKeyToken(bindings.cameraForward);
    const backwardKey = plainKeyToken(bindings.cameraBackward);
    const leftKey = plainKeyToken(bindings.cameraLeft);
    const rightKey = plainKeyToken(bindings.cameraRight);

    const movement = new THREE.Vector3();
    const hasGamepadPan = cameraIntent.panX !== 0 || cameraIntent.panZ !== 0;

    if (keys.size > 0 || hasGamepadPan) {
      // Camera direction vectors, flattened to the horizontal plane.
      const cameraDirection = new THREE.Vector3();
      camera.getWorldDirection(cameraDirection);
      cameraDirection.y = 0;
      cameraDirection.normalize();

      forward.current.copy(cameraDirection);
      right.current.crossVectors(forward.current, up.current).normalize();

      // Keyboard movement keys (whichever keys are currently bound).
      if (forwardKey && keys.has(forwardKey)) movement.add(forward.current);
      if (backwardKey && keys.has(backwardKey)) movement.sub(forward.current);
      if (leftKey && keys.has(leftKey)) movement.sub(right.current);
      if (rightKey && keys.has(rightKey)) movement.add(right.current);

      // Controller left-stick analog pan.
      if (cameraIntent.panZ !== 0) movement.add(forward.current.clone().multiplyScalar(cameraIntent.panZ));
      if (cameraIntent.panX !== 0) movement.add(right.current.clone().multiplyScalar(cameraIntent.panX));

      const moveAmount = moveSpeed * 60 * delta; // Scale by 60 for frame-rate independence
      if (movement.length() > 0) {
        movement.normalize().multiplyScalar(moveAmount);
        target.current.add(movement);
        // Any manual pan input cancels the auto-follow until a fresh selection.
        followEnabled.current = false;
      }
    }

    // Slow auto-follow: when armed, ease the focus point toward the centroid of
    // the currently selected, still-living troops. Reads the store directly so
    // the per-frame loop never forces a React re-render on unit movement.
    if (followEnabled.current) {
      const store = useGameStore.getState();
      const selectedIds = store.selectedUnitIds;
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
          // Frame-rate-independent easing toward the troop centroid. Only the
          // horizontal focus moves; height/zoom stay under the player's control.
          const easing = 1 - Math.exp(-followSpeed * delta);
          target.current.x += (sumX / count - target.current.x) * easing;
          target.current.z += (sumZ / count - target.current.z) * easing;
        }
      }
    }

    // Zoom from bound keyboard keys (if any) plus the controller, applied as a
    // continuous per-frame rate. Mouse-wheel zoom stays in handleWheel.
    let zoomDirection = cameraIntent.zoom; // negative = zoom in, positive = zoom out
    const zoomInKey = plainKeyToken(bindings.cameraZoomIn);
    const zoomOutKey = plainKeyToken(bindings.cameraZoomOut);
    if (zoomInKey && keys.has(zoomInKey)) zoomDirection -= 1;
    if (zoomOutKey && keys.has(zoomOutKey)) zoomDirection += 1;
    if (zoomDirection !== 0) {
      const zoomAmount = zoomDirection * zoomSpeed * 30 * delta;
      currentDistance.current = Math.max(minDistance, Math.min(maxDistance, currentDistance.current + zoomAmount));
    }

    // Update camera position based on target and current distance
    const height = currentDistance.current * Math.sin(CAMERA_ANGLE);
    const horizontalDistance = currentDistance.current * Math.cos(CAMERA_ANGLE);

    const newCameraPos = new THREE.Vector3(
      target.current.x,
      target.current.y + height,
      target.current.z + horizontalDistance
    );

    // Set camera position directly - no lerp to avoid rocking
    camera.position.copy(newCameraPos);
    camera.lookAt(target.current);
  });

  return null;
}