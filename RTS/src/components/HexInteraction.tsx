import { useRef, useState, useEffect } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { useGameStore } from '../game/state';
import * as THREE from 'three';
import { tokenToMouseButton } from './Working/controlBindings';

// A single left-click selects the nearest own unit whose projected center is
// within this many screen pixels of the cursor. The instanced unit models are
// small and units cluster tightly (queens/kings spawn adjacent), so picking by
// exact mesh raycast was unreliable; screen-space proximity is dependable.
const UNIT_PICK_RADIUS_PX = 40;

// MouseEvent.button (0=left, 1=middle, 2=right) -> MouseEvent.buttons bitmask
// (1=left, 2=right, 4=middle). Lets us tell which buttons are held *together*
// from a single event, independent of which one triggered it.
const DOM_BUTTON_TO_BUTTONS_MASK: Record<number, number> = { 0: 1, 1: 4, 2: 2 };
const buttonsMaskFor = (domButton: number): number => DOM_BUTTON_TO_BUTTONS_MASK[domButton] ?? 0;

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
  const addToSelection = useGameStore((s) => s.addToSelection);
  const setPatrol = useGameStore((s) => s.setPatrol);
  const toggleTurtleShell = useGameStore((s) => s.toggleTurtleShell);
  const throwEggs = useGameStore((s) => s.throwEggs);
  const fireTongues = useGameStore((s) => s.fireTongues);
  const hiss = useGameStore((s) => s.hiss);
  const swarm = useGameStore((s) => s.swarm);
  const pickup = useGameStore((s) => s.pickup);
  const deliverCargo = useGameStore((s) => s.deliverCargo);
  // Mouse buttons are remappable via Settings -> Controls. Defaults: left=select,
  // right=command. tokenToMouseButton maps the saved token back to a DOM button.
  const keyboardBindings = useGameStore((s) => s.keyboardBindings);
  const primaryButton = tokenToMouseButton(keyboardBindings.primaryAction) ?? 0;
  const secondaryButton = tokenToMouseButton(keyboardBindings.secondaryAction) ?? 2;

  // Guards the simultaneous-press combo (turtle shell toggle and chicken egg
  // throw) to one fire per press, reset once the buttons are no longer both held
  // (see handleMouseUp). One press = at most one egg per chicken.
  const shellComboHandledRef = useRef(false);

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

  // The local player's currently-selected Turtle units — the targets of the
  // shell-lock toggle.
  const selectedFriendlyTurtleIds = (): string[] =>
    units
      .filter((unit) => unit.ownerId === localPlayerId && unit.animal === 'Turtle' && selectedUnitIds.includes(unit.id))
      .map((unit) => unit.id);

  // The local player's currently-selected Chicken units — the throwers of the
  // egg ability (simultaneous primary+secondary press).
  const selectedFriendlyChickenIds = (): string[] =>
    units
      .filter((unit) => unit.ownerId === localPlayerId && unit.animal === 'Chicken' && selectedUnitIds.includes(unit.id))
      .map((unit) => unit.id);

  // The local player's currently-selected Frog units — the casters of the
  // tongue-grab ability (simultaneous primary+secondary press).
  const selectedFriendlyFrogIds = (): string[] =>
    units
      .filter((unit) => unit.ownerId === localPlayerId && unit.animal === 'Frog' && selectedUnitIds.includes(unit.id))
      .map((unit) => unit.id);

  // The local player's currently-selected Cat units — the casters of the Hiss
  // knockback ability (simultaneous primary+secondary press).
  const selectedFriendlyCatIds = (): string[] =>
    units
      .filter((unit) => unit.ownerId === localPlayerId && unit.animal === 'Cat' && selectedUnitIds.includes(unit.id))
      .map((unit) => unit.id);

  // The local player's currently-selected regular Bee units — the casters of the
  // Swarm sacrificial-dive ability (simultaneous primary+secondary press). Restricted
  // to the Unit kind so a Bee King/Queen is never risked on the dive, and so a
  // royal-only selection still gets the normal both-button behavior.
  const selectedFriendlyBeeIds = (): string[] =>
    units
      .filter((unit) => unit.ownerId === localPlayerId && unit.animal === 'Bee' && unit.kind === 'Unit' && selectedUnitIds.includes(unit.id))
      .map((unit) => unit.id);

  // The local player's currently-selected regular Owl units — the casters of the Pickup
  // ability (simultaneous primary+secondary press over a unit). Restricted to the Unit kind
  // so an Owl King/Queen is never sent swooping into danger, and so a royal-only selection
  // still gets the normal both-button behavior.
  const selectedFriendlyOwlIds = (): string[] =>
    units
      .filter((unit) => unit.ownerId === localPlayerId && unit.animal === 'Owl' && unit.kind === 'Unit' && selectedUnitIds.includes(unit.id))
      .map((unit) => unit.id);

  // Selected Owls currently hovering with friendly cargo, awaiting a delivery order. When any
  // exist, the next both-buttons press is a delivery (drop-off at the cursor) rather than a new
  // pickup — this is the second press that "shows the Owls where to deliver their cargo".
  const selectedOwlsHoldingCargo = (): string[] =>
    units
      .filter((unit) => unit.ownerId === localPlayerId && unit.animal === 'Owl' && selectedUnitIds.includes(unit.id) && unit.owlPickup?.phase === 'holding')
      .map((unit) => unit.id);

  // The unit (any owner) whose projected center is nearest the cursor within
  // UNIT_PICK_RADIUS_PX, excluding Bases — the Owl Pickup target whose animal type and owner
  // define which units the selected Owls grab. Returns null when no unit is under the cursor.
  const unitUnderCursor = (screen: { x: number; y: number }): typeof units[number] | null => {
    let nearest: typeof units[number] | null = null;
    let nearestDistPx = UNIT_PICK_RADIUS_PX;
    for (const unit of units) {
      if (unit.kind === 'Base') continue;
      const projected = worldToScreen(
        new THREE.Vector3(unit.position.x, unit.position.y, unit.position.z)
      );
      const distPx = Math.hypot(projected.x - screen.x, projected.y - screen.y);
      if (distPx < nearestDistPx) {
        nearestDistPx = distPx;
        nearest = unit;
      }
    }
    return nearest;
  };

  // True when the primary and secondary action buttons are held at the same time
  // (read from a single event's `buttons` bitmask, so press order doesn't matter).
  const areShellButtonsHeld = (buttons: number): boolean =>
    (buttons & buttonsMaskFor(primaryButton)) !== 0 && (buttons & buttonsMaskFor(secondaryButton)) !== 0;

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
    // Simultaneous primary+secondary press drives the per-animal combo abilities:
    // it toggles the shell lock on any selected Turtle, throws an egg from any
    // selected Chicken (toward the cursor), fires any selected Frog's tongue,
    // triggers any selected Cat's Hiss knockback, sends any selected Bee into a
    // Swarm dive, and sends any selected Owl swooping to pick up the unit under the
    // cursor. Only intercepts when such a unit is selected, so pressing both buttons
    // otherwise keeps the per-button behavior.
    if (areShellButtonsHeld(event.buttons)) {
      const turtleIds = selectedFriendlyTurtleIds();
      const chickenIds = selectedFriendlyChickenIds();
      const frogIds = selectedFriendlyFrogIds();
      const catIds = selectedFriendlyCatIds();
      const beeIds = selectedFriendlyBeeIds();
      // Owls have two combo modes. If any selected Owl is already holding friendly cargo, this
      // press is a DELIVERY — it sends those Owls to the cursor location, where each sets its
      // cargo down beneath itself on arrival. Otherwise it is a PICKUP, and only fires when a unit
      // is under the cursor (that unit's animal type and owner decide what the Owls grab).
      const owlIds = selectedFriendlyOwlIds();
      const deliveringOwlIds = owlIds.length > 0 ? selectedOwlsHoldingCargo() : [];
      const deliverActive = deliveringOwlIds.length > 0;
      const owlTarget = (owlIds.length > 0 && !deliverActive) ? unitUnderCursor(getScreenPosition(event)) : null;
      const owlsActive = deliverActive || owlTarget !== null;
      if (turtleIds.length > 0 || chickenIds.length > 0 || frogIds.length > 0 || catIds.length > 0 || beeIds.length > 0 || owlsActive) {
        if (!shellComboHandledRef.current) {
          shellComboHandledRef.current = true;
          if (turtleIds.length > 0) toggleTurtleShell(turtleIds);
          // Hiss is radial from each cat's own position, so it needs no cursor target.
          if (catIds.length > 0) hiss({ unitIds: catIds });
          // Swarm has each bee pick its own nearest enemy, so it needs no cursor target.
          if (beeIds.length > 0) swarm({ unitIds: beeIds });
          if (deliverActive) {
            // Deliver: send the holding Owls to the cursor's ground position; each sets its cargo
            // down beneath itself on arrival, so multiple deliveries spread out around the point.
            const screenPos = getScreenPosition(event);
            const dropOff = getWorldPositionFromMouse(screenPos.x, screenPos.y);
            deliverCargo({ unitIds: deliveringOwlIds, target: { x: dropOff.x, y: 0, z: dropOff.z } });
          } else if (owlTarget) {
            // Pickup: grab units matching the clicked unit's animal type AND owner.
            pickup({ unitIds: owlIds, targetAnimal: owlTarget.animal, targetOwnerId: owlTarget.ownerId });
          }
          if (chickenIds.length > 0 || frogIds.length > 0) {
            const screenPos = getScreenPosition(event);
            const target = getWorldPositionFromMouse(screenPos.x, screenPos.y);
            const cursor = { x: target.x, y: 0, z: target.z };
            if (chickenIds.length > 0) throwEggs({ unitIds: chickenIds, target: cursor });
            if (frogIds.length > 0) fireTongues({ unitIds: frogIds, cursor });
          }
          // Discard the selection/patrol drag the first button may have started.
          hideSelectionBox();
          hidePatrolArrow();
          dragStateRef.current = { isDragging: false, startMouse: { x: 0, y: 0 }, currentMouse: { x: 0, y: 0 } };
          patrolDragRef.current = { isDragging: false, queenId: null, startWorldPos: null, currentWorldPos: null };
        }
        event.preventDefault();
        return;
      }
    }

    if (event.button === primaryButton) { // Primary (select) button
      const screenPos = getScreenPosition(event);
      dragStateRef.current = {
        isDragging: true,
        startMouse: screenPos,
        currentMouse: screenPos
      };
    } else if (event.button === secondaryButton) { // Secondary (command) button
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
    // Re-arm the shell toggle once the two-button combo is broken. `buttons`
    // here reflects the buttons still held after this release.
    if (!areShellButtonsHeld(event.buttons)) {
      shellComboHandledRef.current = false;
    }

    if (dragStateRef.current.isDragging && event.button === primaryButton) {
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
        // Single click: select the nearest own unit whose projected center is
        // within UNIT_PICK_RADIUS_PX of the cursor; otherwise clear selection.
        let nearestId: string | null = null;
        let nearestDistPx = UNIT_PICK_RADIUS_PX;
        for (const unit of units) {
          if (unit.ownerId !== localPlayerId || unit.kind === 'Base') continue;
          const screen = worldToScreen(
            new THREE.Vector3(unit.position.x, unit.position.y, unit.position.z)
          );
          const distPx = Math.hypot(screen.x - endScreen.x, screen.y - endScreen.y);
          if (distPx < nearestDistPx) {
            nearestDistPx = distPx;
            nearestId = unit.id;
          }
        }

        if (nearestId) {
          if (event.shiftKey) addToSelection([nearestId]);
          else selectUnits([nearestId]);
        } else {
          clearSelection();
        }
      }
    }

    if (patrolDragRef.current.isDragging && event.button === secondaryButton) {
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
  }, [gl.domElement, units, localPlayerId, selectedUnitIds, selectUnits, addToSelection, clearSelection, toggleTurtleShell, throwEggs, fireTongues, hiss, swarm, pickup, deliverCargo, primaryButton, secondaryButton]);

  const handleGroundClick = (e: any) => {
    // Prevent browser context menu on right-click - check if preventDefault exists
    if (e.nativeEvent && typeof e.nativeEvent.preventDefault === 'function') {
      e.nativeEvent.preventDefault();
      e.nativeEvent.stopPropagation();
    }

    // Only handle the secondary (command) button for movement
    if (e.button === secondaryButton) { // Secondary (command) button

      // Skip the move when this secondary press is half of a combo on a selected
      // turtle (shell toggle), chicken (egg throw), frog (tongue grab), cat (Hiss),
      // bee (Swarm) or owl (Pickup) — those are handled in handleMouseDown instead, and
      // shouldn't also issue a move.
      const heldButtons = e.nativeEvent?.buttons ?? 0;
      if (areShellButtonsHeld(heldButtons) &&
          (selectedFriendlyTurtleIds().length > 0 || selectedFriendlyChickenIds().length > 0 || selectedFriendlyFrogIds().length > 0 || selectedFriendlyCatIds().length > 0 || selectedFriendlyBeeIds().length > 0 || selectedFriendlyOwlIds().length > 0)) {
        return;
      }

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











