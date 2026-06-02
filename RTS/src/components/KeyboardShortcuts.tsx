import { useEffect, useRef } from 'react';
import { useGameStore } from '../game/state';
import { keyboardCoordinator } from '../utils/keyboardCoordination';
import { keyboardEventToToken } from './Working/controlBindings';
import {
  UNIT_PLACEMENT_INTERVAL_MS,
  UNIT_PLACEMENT_REPEAT_INTERVAL_MS,
} from './Working/monarchPilot';

// Two Space presses within this window count as a "double tap" that escalates
// the selection from one animal's army to every unit. (While piloting the first
// press also rallies; otherwise the first press just selects the army.)
const DOUBLE_PRESS_WINDOW_MS = 350;

export function KeyboardShortcuts() {
  // Only gate listener attachment on matchStarted. Every other piece of state the
  // handlers need (units, bindings, the piloted unit, selection actions) is read
  // fresh from the store via getState() at event time. This is deliberate: the
  // store publishes a NEW units array reference every tick, so depending on it
  // here would re-run this effect ~60x/sec — and each cleanup would clear the
  // hold-to-place interval before it could reach UNIT_PLACEMENT_INTERVAL_MS,
  // silently breaking the hold gesture.
  const matchStarted = useGameStore((s) => s.matchStarted);

  // Timestamp of the last Space press, for double-tap detection (both modes).
  const lastSpacePressMsRef = useRef(0);
  // The placement hold runs a two-phase timer: a one-shot timeout designates the
  // first unit after UNIT_PLACEMENT_INTERVAL_MS, then an interval designates each
  // subsequent unit every UNIT_PLACEMENT_REPEAT_INTERVAL_MS. The flag marks that a
  // single (non-double) press is awaiting its release, so keyup can tell a quick
  // tap (rally) from a hold (place units).
  const placementFirstTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const placementRepeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const spacePressAwaitingReleaseRef = useRef(false);

  useEffect(() => {
    if (!matchStarted) return;

    // Stop both phases of the placement-hold timer (release, blur, or a double tap
    // interrupting it). Only one is ever active at a time, but clear both to be safe.
    const stopPlacementHold = () => {
      if (placementFirstTimeoutRef.current !== null) {
        clearTimeout(placementFirstTimeoutRef.current);
        placementFirstTimeoutRef.current = null;
      }
      if (placementRepeatIntervalRef.current !== null) {
        clearInterval(placementRepeatIntervalRef.current);
        placementRepeatIntervalRef.current = null;
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const token = keyboardEventToToken(event);
      if (token === '') return; // bare modifier press

      const {
        localPlayerId,
        selectedAnimalPool,
        units,
        keyboardBindings,
        pilotedUnitId,
        selectUnits,
        clearSelection,
        pilotCycleMonarch,
        togglePilotMonarchKind,
        incrementUnitPlacement,
        resetUnitPlacement,
      } = useGameStore.getState();

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
          // First unit after the initial hold, then ramp up at the faster repeat rate.
          placementFirstTimeoutRef.current = setTimeout(() => {
            placementFirstTimeoutRef.current = null;
            incrementUnitPlacement();
            placementRepeatIntervalRef.current = setInterval(() => {
              incrementUnitPlacement();
            }, UNIT_PLACEMENT_REPEAT_INTERVAL_MS);
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
      const { keyboardBindings, pilotedUnitId, placeRalliedUnits, rallyToMonarch } =
        useGameStore.getState();
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
  }, [matchStarted]);

  // This component doesn't render anything, it just handles keyboard events
  return null;
}
