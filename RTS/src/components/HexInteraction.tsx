import { useRef, useState, useEffect } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { useGameStore } from '../game/state';
import * as THREE from 'three';

interface DragState {
  isDragging: boolean;
  startMouse: { x: number; y: number };
  currentMouse: { x: number; y: number };
}

interface PatrolDragState {
  isDragging: boolean;
  queenId: string | null;
  startWorldPos: THREE.Vector3 | null;
  currentWorldPos: THREE.Vector3 | null;
}

export function MapInteraction() {
  const { camera, raycaster, gl } = useThree();
  const selectedUnitIds = useGameStore((s) => s.selectedUnitIds);
  const units = useGameStore((s) => s.units);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const moveCommand = useGameStore((s) => s.moveCommand);
  const clearSelection = useGameStore((s) => s.clearSelection);
  const selectUnits = useGameStore((s) => s.selectUnits);
  const setPatrol = useGameStore((s) => s.setPatrol);

  // Use ref instead of state to avoid timing issues
  const dragStateRef = useRef<DragState>({
    isDragging: false,
    startMouse: { x: 0, y: 0 },
    currentMouse: { x: 0, y: 0 }
  });

  // Patrol drag state for right-click drag on queens
  const patrolDragRef = useRef<PatrolDragState>({
    isDragging: false,
    queenId: null,
    startWorldPos: null,
    currentWorldPos: null
  });

  // Create selection box visual element
  const selectionBoxRef = useRef<HTMLDivElement | null>(null);
  // Create patrol arrow visual element
  const patrolArrowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Create selection box element
    const selectionBox = document.createElement('div');
    selectionBox.style.position = 'absolute';
    selectionBox.style.border = '2px solid #00ff00';
    selectionBox.style.backgroundColor = 'rgba(0, 255, 0, 0.1)';
    selectionBox.style.pointerEvents = 'none';
    selectionBox.style.display = 'none';
    selectionBox.style.zIndex = '1000';
    document.body.appendChild(selectionBox);
    selectionBoxRef.current = selectionBox;

    // Create patrol arrow element
    const patrolArrow = document.createElement('div');
    patrolArrow.style.position = 'absolute';
    patrolArrow.style.height = '3px';
    patrolArrow.style.backgroundColor = '#1e3a8a'; // Navy blue
    patrolArrow.style.transformOrigin = 'left center';
    patrolArrow.style.pointerEvents = 'none';
    patrolArrow.style.display = 'none';
    patrolArrow.style.zIndex = '1001';
    patrolArrow.innerHTML = '→'; // Arrow symbol at the end
    patrolArrow.style.color = '#1e3a8a';
    patrolArrow.style.fontWeight = 'bold';
    patrolArrow.style.fontSize = '16px';
    patrolArrow.style.textAlign = 'right';
    patrolArrow.style.lineHeight = '3px';
    document.body.appendChild(patrolArrow);
    patrolArrowRef.current = patrolArrow;

    return () => {
      if (selectionBoxRef.current) {
        document.body.removeChild(selectionBoxRef.current);
      }
      if (patrolArrowRef.current) {
        document.body.removeChild(patrolArrowRef.current);
      }
    };
  }, []);

  const getMousePosition = (event: MouseEvent) => {
    return {
      x: (event.clientX / window.innerWidth) * 2 - 1,
      y: -(event.clientY / window.innerHeight) * 2 + 1
    };
  };

  const getScreenPosition = (event: MouseEvent) => {
    return {
      x: event.clientX,
      y: event.clientY
    };
  };

  const worldToScreen = (worldPos: THREE.Vector3) => {
    const vector = worldPos.clone();
    vector.project(camera);

    const widthHalf = window.innerWidth / 2;
    const heightHalf = window.innerHeight / 2;

    return {
      x: (vector.x * widthHalf) + widthHalf,
      y: -(vector.y * heightHalf) + heightHalf
    };
  };

  const isUnitInSelectionBox = (unit: any, startScreen: {x: number, y: number}, endScreen: {x: number, y: number}) => {
    const unitWorldPos = new THREE.Vector3(unit.position.x, unit.position.y, unit.position.z);
    const unitScreen = worldToScreen(unitWorldPos);

    const minX = Math.min(startScreen.x, endScreen.x);
    const maxX = Math.max(startScreen.x, endScreen.x);
    const minY = Math.min(startScreen.y, endScreen.y);
    const maxY = Math.max(startScreen.y, endScreen.y);

    return unitScreen.x >= minX && unitScreen.x <= maxX &&
           unitScreen.y >= minY && unitScreen.y <= maxY;
  };

  const getWorldPositionFromMouse = (mouseX: number, mouseY: number) => {
    // Convert normalized device coordinates to world position
    const raycasterVector = new THREE.Vector2(
      (mouseX / window.innerWidth) * 2 - 1,
      -(mouseY / window.innerHeight) * 2 + 1
    );

    raycaster.setFromCamera(raycasterVector, camera);

    // Intersect with ground plane (y = 0)
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const intersection = new THREE.Vector3();
    raycaster.ray.intersectPlane(groundPlane, intersection);

    return intersection;
  };

  const isSelectedQueenOnly = () => {
    if (selectedUnitIds.length !== 1) return null;

    const selectedUnit = units.find(u => u.id === selectedUnitIds[0]);
    if (!selectedUnit || selectedUnit.kind !== 'Queen' || selectedUnit.ownerId !== localPlayerId) {
      return null;
    }

    return selectedUnit;
  };

  const hidePatrolArrow = () => {
    if (patrolArrowRef.current) {
      patrolArrowRef.current.style.display = 'none';
    }
  };

  const updatePatrolArrow = (startWorld: THREE.Vector3, endWorld: THREE.Vector3) => {
    if (!patrolArrowRef.current) return;

    const startScreen = worldToScreen(startWorld);
    const endScreen = worldToScreen(endWorld);

    const dx = endScreen.x - startScreen.x;
    const dy = endScreen.y - startScreen.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);

    patrolArrowRef.current.style.left = `${startScreen.x}px`;
    patrolArrowRef.current.style.top = `${startScreen.y}px`;
    patrolArrowRef.current.style.width = `${length}px`;
    patrolArrowRef.current.style.transform = `rotate(${angle}rad)`;
    patrolArrowRef.current.style.display = 'block';
  };

  const handleMouseDown = (event: MouseEvent) => {
    if (event.button === 0) { // Left mouse button
      const screenPos = getScreenPosition(event);
      dragStateRef.current = {
        isDragging: true,
        startMouse: screenPos,
        currentMouse: screenPos
      };
    } else if (event.button === 2) { // Right mouse button
      // Check if exactly one queen is selected
      const queen = isSelectedQueenOnly();
      if (queen) {
        const screenPos = getScreenPosition(event);
        const worldPos = getWorldPositionFromMouse(screenPos.x, screenPos.y);

        patrolDragRef.current = {
          isDragging: true,
          queenId: queen.id,
          startWorldPos: new THREE.Vector3(queen.position.x, queen.position.y, queen.position.z),
          currentWorldPos: worldPos
        };

        // Show initial arrow
        updatePatrolArrow(patrolDragRef.current.startWorldPos!, worldPos);
      }
    }
  };

  const handleMouseMove = (event: MouseEvent) => {
    if (dragStateRef.current.isDragging) {
      const currentScreen = getScreenPosition(event);
      dragStateRef.current.currentMouse = currentScreen;

      // Update selection box visual - only if still dragging
      if (selectionBoxRef.current && dragStateRef.current.isDragging) {
        const minX = Math.min(dragStateRef.current.startMouse.x, currentScreen.x);
        const maxX = Math.max(dragStateRef.current.startMouse.x, currentScreen.x);
        const minY = Math.min(dragStateRef.current.startMouse.y, currentScreen.y);
        const maxY = Math.max(dragStateRef.current.startMouse.y, currentScreen.y);

        const width = maxX - minX;
        const height = maxY - minY;

        if (width > 5 || height > 5) { // Only show if dragging more than 5 pixels
          selectionBoxRef.current.style.display = 'block';
          selectionBoxRef.current.style.left = `${minX}px`;
          selectionBoxRef.current.style.top = `${minY}px`;
          selectionBoxRef.current.style.width = `${width}px`;
          selectionBoxRef.current.style.height = `${height}px`;
        }
      }
    }

    if (patrolDragRef.current.isDragging) {
      const currentScreen = getScreenPosition(event);
      const currentWorldPos = getWorldPositionFromMouse(currentScreen.x, currentScreen.y);
      patrolDragRef.current.currentWorldPos = currentWorldPos;

      // Update patrol arrow visual
      if (patrolDragRef.current.startWorldPos) {
        updatePatrolArrow(patrolDragRef.current.startWorldPos, currentWorldPos);
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      hideSelectionBox();
      hidePatrolArrow();
      dragStateRef.current = {
        isDragging: false,
        startMouse: { x: 0, y: 0 },
        currentMouse: { x: 0, y: 0 }
      };
      patrolDragRef.current = {
        isDragging: false,
        queenId: null,
        startWorldPos: null,
        currentWorldPos: null
      };
    }
  };

  const hideSelectionBox = () => {
    if (selectionBoxRef.current) {
      selectionBoxRef.current.style.display = 'none';
      selectionBoxRef.current.style.left = '0px';
      selectionBoxRef.current.style.top = '0px';
      selectionBoxRef.current.style.width = '0px';
      selectionBoxRef.current.style.height = '0px';
    }
  };

  const handleMouseUp = (event: MouseEvent) => {

    if (dragStateRef.current.isDragging && event.button === 0) {
      // IMMEDIATELY hide selection box first
      hideSelectionBox();

      const endScreen = getScreenPosition(event);
      const distance = Math.sqrt(
        Math.pow(endScreen.x - dragStateRef.current.startMouse.x, 2) +
        Math.pow(endScreen.y - dragStateRef.current.startMouse.y, 2)
      );



      // IMMEDIATELY reset drag state to prevent further updates
      const startMouse = dragStateRef.current.startMouse;
      dragStateRef.current = {
        isDragging: false,
        startMouse: { x: 0, y: 0 },
        currentMouse: { x: 0, y: 0 }
      };

      if (distance > 5) { // If dragged more than 5 pixels, do box selection

        // Find units in selection box
        const ownUnits = units.filter(unit => unit.ownerId === localPlayerId && unit.kind !== 'Base');
        const selectedUnitsInBox = ownUnits.filter(unit =>
          isUnitInSelectionBox(unit, startMouse, endScreen)
        );

        const selectedIds = selectedUnitsInBox.map(unit => unit.id);
        selectUnits(selectedIds);
      } else {
        // Single click - clear selection
        clearSelection();
      }
    }

    if (patrolDragRef.current.isDragging && event.button === 2) {
      // Complete patrol drag
      hidePatrolArrow();

      if (patrolDragRef.current.queenId && patrolDragRef.current.startWorldPos && patrolDragRef.current.currentWorldPos) {

        setPatrol({
          queenId: patrolDragRef.current.queenId,
          startPosition: {
            x: patrolDragRef.current.startWorldPos.x,
            y: patrolDragRef.current.startWorldPos.y,
            z: patrolDragRef.current.startWorldPos.z
          },
          endPosition: {
            x: patrolDragRef.current.currentWorldPos.x,
            y: patrolDragRef.current.currentWorldPos.y,
            z: patrolDragRef.current.currentWorldPos.z
          }
        });
      }

      // Reset patrol drag state
      patrolDragRef.current = {
        isDragging: false,
        queenId: null,
        startWorldPos: null,
        currentWorldPos: null
      };
    }
  };

  useEffect(() => {
    const canvas = gl.domElement;

    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [gl.domElement, units, localPlayerId, selectUnits, clearSelection]);

  const handleGroundClick = (e: any) => {
    // Prevent browser context menu on right-click - check if preventDefault exists
    if (e.nativeEvent && typeof e.nativeEvent.preventDefault === 'function') {
      e.nativeEvent.preventDefault();
      e.nativeEvent.stopPropagation();
    }

    // Only handle right-click for movement
    if (e.button === 2) { // Right click

      if (selectedUnitIds.length === 0) {
        return;
      }

      // Calculate world position from mouse click using the event's intersection point
      if (e.point) {
        // Use Three.js intersection point directly
        const target = { x: e.point.x, y: 0, z: e.point.z };
        moveCommand({ unitIds: selectedUnitIds, target });
      }
    }
  };

  const handleContextMenu = (e: any) => {
    // Prevent browser context menu from appearing - check if preventDefault exists
    if (e.nativeEvent && typeof e.nativeEvent.preventDefault === 'function') {
      e.nativeEvent.preventDefault();
      e.nativeEvent.stopPropagation();
    }
  };

  return (
    <mesh
      position={[0, 0, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      onPointerDown={handleGroundClick}
      onContextMenu={handleContextMenu}
      material-transparent={true}
      material-opacity={0}
      material-alphaTest={0.01}
      renderOrder={-1000}
    >
      <planeGeometry args={[1000, 1000]} />
    </mesh>
  );
}











