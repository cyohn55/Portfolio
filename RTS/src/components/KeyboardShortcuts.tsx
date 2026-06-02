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
  const selectedUnitIds = useGameStore((s) => s.selectedUnitIds);
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

        const selectEveryUnit = () => {
          const ids = playerUnits.map(u => u.id);
          if (ids.length > 0) selectUnits(ids);
        };

        // A double tap ALWAYS selects every unit, regardless of context (piloting or not,
        // anything currently selected or not). Handled first so neither the piloting rally
        // nor the anchored-army single-press path can shadow it. The camera-input block is
        // skipped while piloting so the ESDF drive keys keep working; off-pilot it stops the
        // shortcut's keys from also panning the camera (matching the single-press path).
        if (isDoublePress) {
          if (!pilotedUnitId) keyboardCoordinator.blockCameraInput(250);
          selectEveryUnit();
          return;
        }

        // Single press is contextual.
        if (pilotedUnitId) {
          // Piloting: rally the piloted monarch's army to follow it AND select that army (so a
          // right-click immediately redirects it — see rallyToMonarch). No camera-input block
          // here so the ESDF keys keep driving the unit.
          rallyToMonarch();
          return;
        }

        // Not piloting: a single press selects the army (kind 'Unit') of the currently
        // anchored animal — the animal of the first selected own unit. With nothing selected
        // to anchor on, the press does nothing rather than grabbing every unit: that fallback
        // made a first press select everything and a confusing second press narrow it back to
        // the anchor animal's units. Use a double tap to select all (handled above).
        keyboardCoordinator.blockCameraInput(250);
        const selectedSet = new Set(selectedUnitIds);
        const anchor = playerUnits.find(u => selectedSet.has(u.id));
        if (!anchor) return; // nothing to anchor on — leave the selection untouched
        const armyIds = playerUnits
          .filter(u => u.kind === 'Unit' && u.animal === anchor.animal)
          .map(u => u.id);
        if (armyIds.length > 0) selectUnits(armyIds);
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
  }, [matchStarted, localPlayerId, selectedAnimalPool, units, selectedUnitIds, selectUnits, clearSelection, keyboardBindings, pilotedUnitId, pilotCycleMonarch, togglePilotMonarchKind, rallyToMonarch]);

  // This component doesn't render anything, it just handles keyboard events
  return null;
}