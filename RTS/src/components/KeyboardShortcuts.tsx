import { useEffect, useRef } from 'react';
import { useGameStore } from '../game/state';
import { keyboardCoordinator } from '../utils/keyboardCoordination';
import { keyboardEventToToken } from './Working/controlBindings';

// Two Space presses within this window count as a "double tap" that escalates
// the selection from one animal's army to every unit. (While piloting the first
// press also rallies; otherwise the first press just selects the army.)
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

  // Timestamp of the last Space press, for double-tap detection (both modes).
  const lastSpacePressMsRef = useRef(0);

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

        const now = performance.now();
        const isDoublePress = now - lastSpacePressMsRef.current <= DOUBLE_PRESS_WINDOW_MS;
        lastSpacePressMsRef.current = now;

        // A double tap ALWAYS selects every unit, regardless of context (piloting or not,
        // anything currently selected or not). The camera-input block is skipped while piloting
        // so the ESDF drive keys keep working; off-pilot it stops the key from also panning.
        if (isDoublePress) {
          if (!pilotedUnitId) keyboardCoordinator.blockCameraInput(250);
          const ids = playerUnits.map(u => u.id);
          if (ids.length > 0) selectUnits(ids);
          return;
        }

        // A single press only does something while piloting: it rallies the piloted monarch's
        // army to follow it (and selects that army — see rallyToMonarch). In every other context
        // a single press does nothing; only a double tap changes the selection here.
        if (pilotedUnitId) rallyToMonarch();
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