import { useEffect, useRef } from 'react';
import { useGameStore } from '../game/state';
import { keyboardCoordinator } from '../utils/keyboardCoordination';
import { keyboardEventToToken } from './Working/controlBindings';

// While piloting, two Space presses within this window count as a "double tap"
// that selects the whole army rather than just rallying the current animal's.
const DOUBLE_PRESS_WINDOW_MS = 350;

export function KeyboardShortcuts() {
  const matchStarted = useGameStore((s) => s.matchStarted);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const selectedAnimalPool = useGameStore((s) => s.selectedAnimalPool);
  const units = useGameStore((s) => s.units);
  const selectUnits = useGameStore((s) => s.selectUnits);
  const clearSelection = useGameStore((s) => s.clearSelection);
  const keyboardBindings = useGameStore((s) => s.keyboardBindings);
  const pilotedUnitId = useGameStore((s) => s.pilotedUnitId);
  const pilotCycleMonarch = useGameStore((s) => s.pilotCycleMonarch);
  const togglePilotMonarchKind = useGameStore((s) => s.togglePilotMonarchKind);
  const rallyToMonarch = useGameStore((s) => s.rallyToMonarch);

  // Timestamp of the last Space press while piloting, for double-tap detection.
  const lastRallyPressMsRef = useRef(0);

  useEffect(() => {
    if (!matchStarted) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const token = keyboardEventToToken(event);
      if (token === '') return; // bare modifier press

      // Pause toggles regardless of selection state. Dispatch the shared toggle
      // event so the existing HUD pause menu opens (and drives the sim-halt).
      if (token === keyboardBindings.pause) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('rts:toggle-pause'));
        return;
      }

      const playerUnits = units.filter(u => u.ownerId === localPlayerId && u.kind !== 'Base');

      // Select every own unit of one animal type; brief camera-input block keeps
      // the shortcut's keys from also panning the camera.
      const selectByAnimal = (animal: string | undefined) => {
        if (!animal) return;
        event.preventDefault();
        keyboardCoordinator.blockCameraInput(250);
        const ids = playerUnits.filter(u => u.animal === animal).map(u => u.id);
        if (ids.length > 0) selectUnits(ids);
      };

      // Cycle through the animals' monarchs (A) and swap King<->Queen (G). No
      // camera-input block here: blocking would briefly swallow the ESDF presses
      // used to drive the piloted unit.
      if (token === keyboardBindings.pilotCycleMonarch) {
        event.preventDefault();
        pilotCycleMonarch();
        return;
      } else if (token === keyboardBindings.pilotToggleMonarch) {
        event.preventDefault();
        togglePilotMonarchKind();
        return;
      }

      if (token === keyboardBindings.selectAll) {
        event.preventDefault();
        // While piloting, Space rallies the piloted monarch's army to follow it
        // AND selects that army (so a right-click immediately redirects it — see
        // rallyToMonarch). Two quick presses escalate to selecting *every* unit.
        // Don't block camera input here so the ESDF keys keep driving the unit.
        if (pilotedUnitId) {
          const now = performance.now();
          const isDoublePress = now - lastRallyPressMsRef.current <= DOUBLE_PRESS_WINDOW_MS;
          lastRallyPressMsRef.current = now;

          if (isDoublePress) {
            const ids = playerUnits.map(u => u.id);
            if (ids.length > 0) selectUnits(ids);
          } else {
            rallyToMonarch();
          }
          return;
        }
        keyboardCoordinator.blockCameraInput(250);
        const ids = playerUnits.map(u => u.id);
        if (ids.length > 0) selectUnits(ids);
      } else if (token === keyboardBindings.selectGroup1) {
        selectByAnimal(selectedAnimalPool[0]);
      } else if (token === keyboardBindings.selectGroup2) {
        selectByAnimal(selectedAnimalPool[1]);
      } else if (token === keyboardBindings.selectGroup3) {
        selectByAnimal(selectedAnimalPool[2]);
      } else if (token === keyboardBindings.deselect) {
        clearSelection();
      }
    };

    // Add event listener
    document.addEventListener('keydown', handleKeyDown);

    // Cleanup
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [matchStarted, localPlayerId, selectedAnimalPool, units, selectUnits, clearSelection, keyboardBindings, pilotedUnitId, pilotCycleMonarch, togglePilotMonarchKind, rallyToMonarch]);

  // This component doesn't render anything, it just handles keyboard events
  return null;
}