import { useRef, useEffect, useCallback } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { keyboardCoordinator } from '../utils/keyboardCoordination';

// Global instance counter to detect multiple mounting
let instanceCounter = 0;

interface CameraControllerProps {
  moveSpeed?: number;
  zoomSpeed?: number;
  minDistance?: number;
  maxDistance?: number;
}

export function CameraController({
  moveSpeed = 0.5,
  zoomSpeed = 2,
  minDistance = 2,
  maxDistance = 100
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

  // Touch handling refs
  const lastTouchPos = useRef<{ x: number; y: number } | null>(null);
  const lastPinchDistance = useRef<number | null>(null);
  const isDragging = useRef(false);

  // Fixed camera angle - lower angle for better RTS view
  const CAMERA_ANGLE = Math.PI / 10; // 18 degrees

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    const key = event.key.toLowerCase();

    // Check if camera input is blocked
    if (keyboardCoordinator.isCameraInputBlocked()) {
      return;
    }

    if (['w', 'a', 's', 'd'].includes(key)) {
      keysPressed.current.add(key);
    }
  }, []);

  const handleKeyUp = useCallback((event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if (['w', 'a', 's', 'd'].includes(key)) {
      keysPressed.current.delete(key);
    }
  }, []);

  const handleWheel = useCallback((event: WheelEvent) => {
    event.preventDefault();

    // Determine zoom direction and apply
    const zoomDelta = event.deltaY > 0 ? zoomSpeed : -zoomSpeed;

    // Apply zoom with constraints
    const newDistance = Math.max(minDistance, Math.min(maxDistance, currentDistance.current + zoomDelta));
    currentDistance.current = newDistance;
  }, [zoomSpeed, minDistance, maxDistance, instanceId]);

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
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
      canvas.removeEventListener('touchend', handleTouchEnd);
      canvas.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleKeyDown, handleKeyUp, handleWheel, handleTouchStart, handleTouchMove, handleTouchEnd, gl, instanceId]);

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

    // Handle movement
    const movement = new THREE.Vector3();

    if (keysPressed.current.size > 0) {
      // Calculate camera direction vectors
      const cameraDirection = new THREE.Vector3();
      camera.getWorldDirection(cameraDirection);
      cameraDirection.y = 0; // Keep movement on horizontal plane
      cameraDirection.normalize();

      forward.current.copy(cameraDirection);
      right.current.crossVectors(forward.current, up.current).normalize();

      // Process movement keys
      if (keysPressed.current.has('w')) {
        movement.add(forward.current);
      }
      if (keysPressed.current.has('s')) {
        movement.sub(forward.current);
      }
      if (keysPressed.current.has('a')) {
        movement.sub(right.current);
      }
      if (keysPressed.current.has('d')) {
        movement.add(right.current);
      }

      // Apply movement
      const moveAmount = moveSpeed * 60 * delta; // Scale by 60 for consistent speed
      if (movement.length() > 0) {
        movement.normalize().multiplyScalar(moveAmount);
        target.current.add(movement);
      }
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