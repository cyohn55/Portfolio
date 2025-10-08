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

  const { camera } = useThree();
  const keysPressed = useRef(new Set<string>());
  const target = useRef(new THREE.Vector3(0, 0, 225));
  const currentDistance = useRef(200);
  const forward = useRef(new THREE.Vector3());
  const right = useRef(new THREE.Vector3());
  const up = useRef(new THREE.Vector3(0, 1, 0));

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

  useEffect(() => {
    // Add event listeners to window for global key handling
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('wheel', handleWheel);
    };
  }, [handleKeyDown, handleKeyUp, handleWheel, instanceId]);

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