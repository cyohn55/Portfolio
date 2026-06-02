import { useEffect, useRef } from 'react';
import { useGameStore } from '../game/state';
import { keyboardCoordinator } from '../utils/keyboardCoordination';
import { keyboardEventToToken } from './Working/controlBindings';
import { UNIT_PLACEMENT_INTERVAL_MS } from './Working/monarchPilot';

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
  const incrementUnitPlacement = useGameStore((s) => s.incrementUnitPlacement);
  const placeRalliedUnits = useGameStore((s) => s.placeRalliedUnits);
  const resetUnitPlacement = useGameStore((s) => s.resetUnitPlacement);

  // Timestamp of the last Space press, for double-tap detection (both modes).
  const lastSpacePressMsRef = useRef(0);
  // Interval id ticking once per UNIT_PLACEMENT_INTERVAL_MS while Space is held,
  // and a flag marking that a single (non-double) press is awaiting its release.
  // Together they let keyup tell a quick tap (rally) from a hold (place units).
  const placementHoldTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const spacePressAwaitingReleaseRef = useRef(false);

  useEffect(() => {
    if (!matchStarted) return;

    // Stop the placement-hold timer (release, blur, or a double tap interrupting it).
    const stopPlacementHold = () => {
      if (placementHoldTimerRef.current !== null) {
        clearInterval(placementHoldTimerRef.current);
        placementHoldTimerRef.current = null;
      }
    };

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
        // The OS auto-repeats keydown while a key is held; the hold timer (below)
        // owns the held-key cadence, so ignore the repeats here.
        if (event.repeat) return;

        const now = performance.now();
        const isDoublePress = now - lastSpacePressMsRef.current <= DOUBLE_PRESS_WINDOW_MS;
        lastSpacePressMsRef.current = now;

        // A double tap ALWAYS selects every unit, regardless of context (piloting or not,
        // anything currently selected or not). The camera-input block is skipped while piloting
        // so the ESDF drive keys keep working; off-pilot it stops the key from also panning.
        if (isDoublePress) {
          // The first tap already started (and its release may have started) a hold;
          // abandon it so the double tap doesn't also place units or re-toggle rally.
          stopPlacementHold();
          spacePressAwaitingReleaseRef.current = false;
          resetUnitPlacement();
          if (!pilotedUnitId) keyboardCoordinator.blockCameraInput(250);
          const ids = playerUnits.map(u => u.id);
          if (ids.length > 0) selectUnits(ids);
          return;
        }

        // Single press. Its meaning is decided on release: a quick tap rallies (see
        // keyup), while holding past UNIT_PLACEMENT_INTERVAL_MS designates units to
        // place. Start the designation timer only while piloting, where a placement
        // (a monarch with a trailing rally) is possible.
        spacePressAwaitingReleaseRef.current = true;
        if (pilotedUnitId) {
          stopPlacementHold();
          placementHoldTimerRef.current = setInterval(() => {
            incrementUnitPlacement();
          }, UNIT_PLACEMENT_INTERVAL_MS);
        }
        return;
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

    const handleKeyUp = (event: KeyboardEvent) => {
      const token = keyboardEventToToken(event);
      if (token !== keyboardBindings.selectAll) return;

      stopPlacementHold();

      // Only the release of a single (non-double) press carries an action; a
      // double tap already cleared this flag after selecting every unit.
      if (!spacePressAwaitingReleaseRef.current) return;
      spacePressAwaitingReleaseRef.current = false;

      // A hold that reached at least one designated unit places them at the
      // monarch; a quick tap (none designated) rallies the army instead.
      const designated = useGameStore.getState().unitPlacementCount;
      if (designated >= 1) {
        placeRalliedUnits(designated);
      } else if (pilotedUnitId) {
        rallyToMonarch();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    // A lost focus (alt-tab, clicking a menu) never delivers keyup, so abandon any
    // in-progress hold to avoid a stuck timer/teardrop.
    window.addEventListener('blur', stopPlacementHold);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', stopPlacementHold);
      stopPlacementHold();
    };
  }, [matchStarted, localPlayerId, selectedAnimalPool, units, selectUnits, clearSelection, keyboardBindings, pilotedUnitId, pilotCycleMonarch, togglePilotMonarchKind, rallyToMonarch, incrementUnitPlacement, placeRalliedUnits, resetUnitPlacement]);

  // This component doesn't render anything, it just handles keyboard events
  return null;
}
