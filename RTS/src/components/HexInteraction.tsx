import { useRef, useState, useEffect, type RefObject } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { useGameStore } from '../game/state';
import { ANIMAL_MOVEMENT_TYPES } from '../game/types';
import * as THREE from 'three';
import { tokenToMouseButton, keyboardEventToToken } from './Working/controlBindings';

// A single left-click selects the nearest own unit whose projected center is
// within this many screen pixels of the cursor. The instanced unit models are
// small and units cluster tightly (queens/kings spawn adjacent), so picking by
// exact mesh raycast was unreliable; screen-space proximity is dependable.
const UNIT_PICK_RADIUS_PX = 40;

// How long the secondary (command) button must be held on a point, with a lone
// Queen selected, before the gesture commits a patrol route instead of a normal
// move order. A quicker press is treated as a plain move command for the Queen.
const PATROL_HOLD_MS = 750;

// MouseEvent.button (0=left, 1=middle, 2=right) -> MouseEvent.buttons bitmask
// (1=left, 2=right, 4=middle). Lets us tell which buttons are held *together*
// from a single event, independent of which one triggered it.
const DOM_BUTTON_TO_BUTTONS_MASK: Record<number, number> = { 0: 1, 1: 4, 2: 2 };
const buttonsMaskFor = (domButton: number): number => DOM_BUTTON_TO_BUTTONS_MASK[domButton] ?? 0;

// Stroke colors for the two dotted-line indicators. The Queen's patrol route is
// gold (matching her gold ring); her spawn rally line is blue so the two
// gestures read as visually distinct at a glance.
const PATROL_ARROW_COLOR = '#ffd700';
const RALLY_ARROW_COLOR = '#1e90ff';

// Build a flat dotted-line-with-arrowhead indicator in the given color. The line
// itself is a zero-height div whose dotted top border is the visible stroke; the
// arrowhead is a child glyph pinned to the far end so it inherits the parent's
// rotation and points along the line. Shared by the patrol and rally indicators.
function createDottedArrow(strokeColor: string): HTMLDivElement {
  const arrow = document.createElement('div');
  arrow.style.position = 'absolute';
  arrow.style.height = '0px';
  arrow.style.borderTop = `3px dotted ${strokeColor}`;
  arrow.style.transformOrigin = 'left center';
  arrow.style.pointerEvents = 'none';
  arrow.style.display = 'none';
  arrow.style.zIndex = '1001';

  const arrowHead = document.createElement('span');
  arrowHead.innerHTML = '➤'; // ➤ points along the line's +x axis
  arrowHead.style.position = 'absolute';
  arrowHead.style.right = '0px';
  arrowHead.style.top = '50%';
  arrowHead.style.transform = 'translate(50%, -50%)';
  arrowHead.style.color = strokeColor;
  arrowHead.style.fontSize = '18px';
  arrowHead.style.lineHeight = '0';
  arrow.appendChild(arrowHead);

  return arrow;
}

interface DragState {
  isDragging: boolean;
  startMouse: { x: number; y: number };
  currentMouse: { x: number; y: number };
}

interface PatrolDragState {
  // Secondary button is down on a lone selected Queen; we are waiting to classify
  // the gesture as a quick click (move order) or a PATROL_HOLD_MS hold (patrol).
  pending: boolean;
  // The hold passed PATROL_HOLD_MS: the patrol line is shown and releasing now
  // commits a patrol route from the Queen's gold ring to the cursor.
  armed: boolean;
  queenId: string | null;
  // Latest cursor position on the ground plane (patrol end / move destination).
  currentWorldPos: THREE.Vector3 | null;
  // setTimeout handle that arms the patrol once the hold threshold elapses.
  holdTimerId: number | null;
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
  const setQueenRally = useGameStore((s) => s.setQueenRally);
  const setMovementHold = useGameStore((s) => s.setMovementHold);
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

  // Patrol drag state for the secondary-button hold-on-a-queen gesture.
  const patrolDragRef = useRef<PatrolDragState>({
    pending: false,
    armed: false,
    queenId: null,
    currentWorldPos: null,
    holdTimerId: null
  });

  // Spawn-rally gesture state. The rally key is a two-tap toggle on a lone selected
  // Queen: the first tap arms placement (the blue line follows the cursor), the
  // second drops the rally point. queenId is captured on the first tap so the
  // commit targets that Queen even if the cursor wanders.
  const rallyPlacementRef = useRef<{ active: boolean; queenId: string | null }>({
    active: false,
    queenId: null,
  });

  // Latest cursor position in screen pixels, refreshed on every mouse move. The
  // rally gesture is keyboard-driven, so the key handler has no event coordinates
  // of its own; it reads the cursor from here to anchor and commit the blue line.
  const lastMouseScreenRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Create selection box visual element
  const selectionBoxRef = useRef<HTMLDivElement | null>(null);
  // Create patrol arrow visual element (gold) and spawn-rally arrow (blue)
  const patrolArrowRef = useRef<HTMLDivElement | null>(null);
  const rallyArrowRef = useRef<HTMLDivElement | null>(null);

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

    // Patrol indicator (gold): the line drawn from the Queen's gold ring to the
    // cursor when she's given a patrol route. Spawn-rally indicator (blue): the
    // line drawn while the player aims a Queen's spawn rally point. Both are the
    // same dotted-line-with-arrowhead shape, distinguished only by color.
    const patrolArrow = createDottedArrow(PATROL_ARROW_COLOR);
    document.body.appendChild(patrolArrow);
    patrolArrowRef.current = patrolArrow;

    const rallyArrow = createDottedArrow(RALLY_ARROW_COLOR);
    document.body.appendChild(rallyArrow);
    rallyArrowRef.current = rallyArrow;

    return () => {
      if (selectionBoxRef.current) {
        document.body.removeChild(selectionBoxRef.current);
      }
      if (patrolArrowRef.current) {
        document.body.removeChild(patrolArrowRef.current);
      }
      if (rallyArrowRef.current) {
        document.body.removeChild(rallyArrowRef.current);
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

  // Current world position of the patrol Queen (the gold-ring / line origin),
  // looked up live so the indicator and committed route track the Queen even if
  // it shifts during the hold. Null once the Queen is gone (died/deselected).
  const queenWorldPos = (queenId: string | null): THREE.Vector3 | null => {
    if (!queenId) return null;
    const queen = units.find((unit) => unit.id === queenId);
    if (!queen) return null;
    return new THREE.Vector3(queen.position.x, queen.position.y, queen.position.z);
  };

  // The local player's currently-selected regular Turtle units — the targets of the
  // shell-lock toggle (simultaneous primary+secondary press). Restricted to the Unit
  // kind, like every combo caster, so a Turtle King/Queen is never shell-locked and a
  // royal-only selection keeps the normal both-button behavior (move / patrol draw).
  const selectedFriendlyTurtleIds = (): string[] =>
    units
      .filter((unit) => unit.ownerId === localPlayerId && unit.animal === 'Turtle' && unit.kind === 'Unit' && selectedUnitIds.includes(unit.id))
      .map((unit) => unit.id);

  // The local player's currently-selected regular Chicken units — the throwers of the
  // egg ability (simultaneous primary+secondary press). Restricted to the Unit kind so a
  // Chicken King/Queen never throws and a royal-only selection keeps the normal both-button
  // behavior (move / patrol draw).
  const selectedFriendlyChickenIds = (): string[] =>
    units
      .filter((unit) => unit.ownerId === localPlayerId && unit.animal === 'Chicken' && unit.kind === 'Unit' && selectedUnitIds.includes(unit.id))
      .map((unit) => unit.id);

  // The local player's currently-selected regular Frog units — the casters of the
  // tongue-grab ability (simultaneous primary+secondary press). Restricted to the Unit kind
  // so a Frog King/Queen never casts and a royal-only selection keeps the normal both-button
  // behavior — crucially the lone-Queen patrol-draw gesture, which the combo would otherwise hijack.
  const selectedFriendlyFrogIds = (): string[] =>
    units
      .filter((unit) => unit.ownerId === localPlayerId && unit.animal === 'Frog' && unit.kind === 'Unit' && selectedUnitIds.includes(unit.id))
      .map((unit) => unit.id);

  // The local player's currently-selected regular Cat units — the casters of the Hiss
  // knockback ability (simultaneous primary+secondary press). Restricted to the Unit kind so a
  // Cat King/Queen never hisses and a royal-only selection keeps the normal both-button behavior
  // (move / patrol draw).
  const selectedFriendlyCatIds = (): string[] =>
    units
      .filter((unit) => unit.ownerId === localPlayerId && unit.animal === 'Cat' && unit.kind === 'Unit' && selectedUnitIds.includes(unit.id))
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

  // The local player's King whose projected center is nearest the cursor within
  // UNIT_PICK_RADIUS_PX, else null. Used by the spawn-rally gesture: dropping the
  // rally on your own King makes the Queen's future spawns follow him instead of
  // marching to a fixed point.
  const friendlyKingUnderCursor = (screen: { x: number; y: number }): typeof units[number] | null => {
    let nearest: typeof units[number] | null = null;
    let nearestDistPx = UNIT_PICK_RADIUS_PX;
    for (const unit of units) {
      if (unit.ownerId !== localPlayerId || unit.kind !== 'King') continue;
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

  // Resolve where the rally line currently points. If a friendly King is under the
  // cursor the line snaps to him (and `king` is returned so the commit can make the
  // spawns follow him); otherwise it falls to the cursor's ground point. Shared by
  // the live aim (handleMouseMove) and the commit (second key tap) so both agree.
  const resolveRallyAim = (
    screen: { x: number; y: number }
  ): { king: typeof units[number] | null; world: THREE.Vector3 } => {
    const king = friendlyKingUnderCursor(screen);
    if (king) {
      return { king, world: new THREE.Vector3(king.position.x, king.position.y, king.position.z) };
    }
    return { king: null, world: getWorldPositionFromMouse(screen.x, screen.y) };
  };

  // True when the primary and secondary action buttons are held at the same time
  // (read from a single event's `buttons` bitmask, so press order doesn't matter).
  const areShellButtonsHeld = (buttons: number): boolean =>
    (buttons & buttonsMaskFor(primaryButton)) !== 0 && (buttons & buttonsMaskFor(secondaryButton)) !== 0;

  // Hide / re-aim one of the dotted-line indicators. Shared by the patrol (gold)
  // and rally (blue) gestures so each only differs by which ref it drives.
  const hideArrow = (arrowRef: RefObject<HTMLDivElement | null>) => {
    if (arrowRef.current) {
      arrowRef.current.style.display = 'none';
    }
  };

  const updateArrow = (
    arrowRef: RefObject<HTMLDivElement | null>,
    startWorld: THREE.Vector3,
    endWorld: THREE.Vector3
  ) => {
    if (!arrowRef.current) return;

    const startScreen = worldToScreen(startWorld);
    const endScreen = worldToScreen(endWorld);

    const dx = endScreen.x - startScreen.x;
    const dy = endScreen.y - startScreen.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);

    arrowRef.current.style.left = `${startScreen.x}px`;
    arrowRef.current.style.top = `${startScreen.y}px`;
    arrowRef.current.style.width = `${length}px`;
    arrowRef.current.style.transform = `rotate(${angle}rad)`;
    arrowRef.current.style.display = 'block';
  };

  const hidePatrolArrow = () => hideArrow(patrolArrowRef);
  const updatePatrolArrow = (startWorld: THREE.Vector3, endWorld: THREE.Vector3) =>
    updateArrow(patrolArrowRef, startWorld, endWorld);

  const hideRallyArrow = () => hideArrow(rallyArrowRef);
  const updateRallyArrow = (startWorld: THREE.Vector3, endWorld: THREE.Vector3) =>
    updateArrow(rallyArrowRef, startWorld, endWorld);

  // Cancel an in-progress rally aim and clear the blue line. Used by Escape, a
  // committed placement, and the combo handler that discards stray gestures.
  const resetRallyPlacement = () => {
    rallyPlacementRef.current = { active: false, queenId: null };
    hideRallyArrow();
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
      // cargo down beneath itself on arrival. Otherwise it is a PICKUP, and only fires when a
      // grabbable unit is under the cursor (that unit's animal type and owner decide what the
      // Owls grab). Flying units (Owls, Bees) can't be plucked out of the air, so they are not
      // valid pickup targets — clicking one is treated as no target.
      const owlIds = selectedFriendlyOwlIds();
      const deliveringOwlIds = owlIds.length > 0 ? selectedOwlsHoldingCargo() : [];
      const deliverActive = deliveringOwlIds.length > 0;
      const cursorUnit = (owlIds.length > 0 && !deliverActive) ? unitUnderCursor(getScreenPosition(event)) : null;
      const owlTarget = (cursorUnit && ANIMAL_MOVEMENT_TYPES[cursorUnit.animal] !== 'air') ? cursorUnit : null;
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
          resetPatrolDrag();
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
      // With exactly one Queen selected, the secondary button is the patrol
      // gesture: arm it only after a PATROL_HOLD_MS hold (a quick release falls
      // back to a normal move order in handleMouseUp). The competing immediate
      // move from handleGroundClick is suppressed for this case.
      const queen = isSelectedQueenOnly();
      if (queen) {
        const screenPos = getScreenPosition(event);
        const worldPos = getWorldPositionFromMouse(screenPos.x, screenPos.y);

        resetPatrolDrag();
        // Pin the Queen in place for the whole hold so the patrol line's origin
        // (her gold ring) stays anchored to her while the player aims the route.
        setMovementHold(queen.id);
        patrolDragRef.current = {
          pending: true,
          armed: false,
          queenId: queen.id,
          currentWorldPos: worldPos,
          holdTimerId: window.setTimeout(() => {
            // Hold threshold reached: arm patrol and reveal the line from the
            // Queen's gold ring to the cursor's last known ground position.
            patrolDragRef.current.armed = true;
            patrolDragRef.current.holdTimerId = null;
            const origin = queenWorldPos(patrolDragRef.current.queenId);
            if (origin && patrolDragRef.current.currentWorldPos) {
              updatePatrolArrow(origin, patrolDragRef.current.currentWorldPos);
            }
          }, PATROL_HOLD_MS)
        };
      }
    }
  };

  const handleMouseMove = (event: MouseEvent) => {
    // Always remember the cursor so the keyboard-driven rally gesture can anchor
    // and commit its blue line at the current pointer position.
    lastMouseScreenRef.current = getScreenPosition(event);

    // While aiming a spawn rally point, redraw the blue line from the Queen to the
    // cursor — snapping to a friendly King under the cursor — so the player sees
    // where the next batch of units will gather (or which King they will follow).
    if (rallyPlacementRef.current.active) {
      const origin = queenWorldPos(rallyPlacementRef.current.queenId);
      const aim = resolveRallyAim(lastMouseScreenRef.current);
      if (origin && aim.world) {
        updateRallyArrow(origin, aim.world);
      }
    }

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

    if (patrolDragRef.current.pending) {
      const currentScreen = getScreenPosition(event);
      patrolDragRef.current.currentWorldPos = getWorldPositionFromMouse(currentScreen.x, currentScreen.y);

      // Only the armed (post-hold) gesture draws the line, from the Queen's
      // current gold-ring position to the cursor.
      if (patrolDragRef.current.armed) {
        const origin = queenWorldPos(patrolDragRef.current.queenId);
        if (origin) {
          updatePatrolArrow(origin, patrolDragRef.current.currentWorldPos);
        }
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
      resetPatrolDrag();
      resetRallyPlacement();
      return;
    }

    // Spawn-rally gesture (default 'R'): a two-tap toggle on a lone selected Queen.
    // First tap arms placement and reveals the blue line; second tap commits the
    // rally — on a friendly King the Queen's future spawns follow him, otherwise
    // they march to the cursor's ground point.
    const token = keyboardEventToToken(event);
    if (token !== '' && token === keyboardBindings.setQueenRally) {
      event.preventDefault();
      // The OS auto-repeats keydown while the key is held; ignore the repeats so a
      // held key can't arm and immediately commit on a single press.
      if (event.repeat) return;

      if (!rallyPlacementRef.current.active) {
        // First tap: only a single owned Queen can carry a rally point.
        const queen = isSelectedQueenOnly();
        if (!queen) return;
        rallyPlacementRef.current = { active: true, queenId: queen.id };

        const origin = queenWorldPos(queen.id);
        const aim = resolveRallyAim(lastMouseScreenRef.current);
        if (origin && aim.world) {
          updateRallyArrow(origin, aim.world);
        }
      } else {
        // Second tap: commit. A King under the cursor becomes a follow target; an
        // empty spot becomes a fixed ground rally point.
        const { queenId } = rallyPlacementRef.current;
        const aim = resolveRallyAim(lastMouseScreenRef.current);
        resetRallyPlacement();
        if (!queenId) return;
        if (aim.king) {
          setQueenRally({ queenId, target: { mode: 'follow', monarchId: aim.king.id } });
        } else if (aim.world) {
          setQueenRally({
            queenId,
            target: { mode: 'point', position: { x: aim.world.x, y: 0, z: aim.world.z } },
          });
        }
      }
    }
  };

  // Cancel any in-progress patrol gesture: stop the pending hold timer and clear
  // the drag state so a stray timer can't arm the line after release/cancel.
  const resetPatrolDrag = () => {
    if (patrolDragRef.current.holdTimerId !== null) {
      window.clearTimeout(patrolDragRef.current.holdTimerId);
    }
    // Release the movement pin: the hold is over (released, cancelled, or
    // superseded), so the Queen resumes her order/patrol/AI next tick.
    setMovementHold(null);
    patrolDragRef.current = {
      pending: false,
      armed: false,
      queenId: null,
      currentWorldPos: null,
      holdTimerId: null
    };
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

    if (patrolDragRef.current.pending && event.button === secondaryButton) {
      const { armed, queenId } = patrolDragRef.current;
      hidePatrolArrow();

      const endScreen = getScreenPosition(event);
      const endWorld = getWorldPositionFromMouse(endScreen.x, endScreen.y);

      if (armed && queenId) {
        // Held past the threshold: commit a patrol route between the Queen's
        // current position (the gold ring) and the released point. The Queen
        // then walks back and forth along this line (see tick in state.ts).
        const origin = queenWorldPos(queenId);
        if (origin && endWorld) {
          setPatrol({
            queenId,
            startPosition: { x: origin.x, y: origin.y, z: origin.z },
            endPosition: { x: endWorld.x, y: 0, z: endWorld.z }
          });
        }
      } else if (queenId && endWorld) {
        // Released before the hold threshold: a quick right-click is a normal
        // move order for the Queen (handleGroundClick deferred to us so the
        // move and the patrol gesture never both fire on one press).
        moveCommand({ unitIds: [queenId], target: { x: endWorld.x, y: 0, z: endWorld.z } });
      }

      resetPatrolDrag();
    }
  };

  useEffect(() => {
    const canvas = gl.domElement;

    // Gestures START on the canvas (mousedown), so selection/patrol drags can only
    // begin over the 3D view. But the RELEASE is bound to `window`, not the canvas:
    // the patrol-draw gesture pins the Queen in place (setMovementHold) for the whole
    // hold and relies on mouse-up to commit the route and release her. A release that
    // lands off the canvas — over a HUD overlay or just outside it — would never reach
    // a canvas-bound mouse-up, stranding the pin so the Queen silently refuses to
    // patrol. Handling mouse-up at the window level guarantees the gesture is always
    // resolved (route committed, freeze cleared) wherever the button comes up.
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [gl.domElement, units, localPlayerId, selectedUnitIds, selectUnits, addToSelection, clearSelection, toggleTurtleShell, throwEggs, fireTongues, hiss, swarm, pickup, deliverCargo, primaryButton, secondaryButton, setQueenRally, keyboardBindings]);

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

      // A lone selected Queen drives the secondary button through the patrol
      // gesture (quick click = move, PATROL_HOLD_MS hold = patrol), resolved on
      // mouse-up in handleMouseUp. Don't also issue an immediate move here — that
      // would send the Queen off mid-hold and detach the patrol line's origin
      // from its gold ring.
      if (isSelectedQueenOnly()) {
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











