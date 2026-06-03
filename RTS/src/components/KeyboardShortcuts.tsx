import { useEffect, useRef } from 'react';
import { useGameStore } from '../game/state';
import { keyboardCoordinator } from '../utils/keyboardCoordination';
import { keyboardEventToToken } from './Working/controlBindings';
import { UNIT_PLACEMENT_REPEAT_INTERVAL_MS } from './Working/monarchPilot';
import {
  type ActivationMode,
  type TokenGestureConfig,
  buildTokenDispatch,
} from './Working/gestureModes';

// The actions the keyboard layer owns. Excluded on purpose: the analog camera
// drive (CameraController reads those keys directly) and the mouse-domain gestures
// — select/confirm, move/attack, use-ability, and the Queen rally/patrol aims —
// which HexInteraction owns. Each listed action's bound input fires it by the
// activation mode the player picked (tap / double-tap / hold / chord); several can
// share one input when their modes differ (e.g. Space = rally/select-all/deploy).
const KEYBOARD_GESTURE_ACTIONS: readonly string[] = [
  'selectGroup1',
  'selectGroup2',
  'selectGroup3',
  'deselect',
  'pilotCycleMonarch',
  'pilotToggleMonarch',
  'pause',
  'rally',
  'selectAllUnits',
  'deployUnits',
];

export function KeyboardShortcuts() {
  // Re-subscribe only when the match starts/stops or the layout changes. Per-frame
  // state (units, selection, the piloted unit) is read fresh via getState() inside
  // the handlers so the store's new-array-every-tick never re-runs this effect and
  // tears down an in-progress deploy-hold timer.
  const matchStarted = useGameStore((s) => s.matchStarted);
  const keyboardBindings = useGameStore((s) => s.keyboardBindings);
  const keyboardBindingModes = useGameStore((s) => s.keyboardBindingModes);

  // Deploy-hold designation timer (progressive batch), kept off the React path.
  const placementRepeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!matchStarted) return;

    const stopPlacementHold = () => {
      if (placementRepeatIntervalRef.current !== null) {
        clearInterval(placementRepeatIntervalRef.current);
        placementRepeatIntervalRef.current = null;
      }
    };

    // Select every own unit of one animal type; a brief camera-input block keeps the
    // shortcut's keys from also panning the camera.
    const selectByAnimal = (index: number) => {
      const state = useGameStore.getState();
      const animal = state.selectedAnimalPool[index];
      if (!animal) return;
      keyboardCoordinator.blockCameraInput(250);
      const ids = state.units
        .filter((u) => u.ownerId === state.localPlayerId && u.kind !== 'Base' && u.animal === animal)
        .map((u) => u.id);
      if (ids.length > 0) state.selectUnits(ids);
    };

    // Fire an action once (used by tap, double-tap, a simple hold, and chord). The
    // `mode` lets Deploy Units differ: a single unit on tap/double-tap.
    const runAction = (actionId: string, _mode: ActivationMode) => {
      // Pause toggles regardless of paused/over so the player can always resume.
      if (actionId === 'pause') {
        window.dispatchEvent(new CustomEvent('rts:toggle-pause'));
        return;
      }
      const state = useGameStore.getState();
      if (state.isPaused || state.gameOver || !state.matchStarted) return;

      switch (actionId) {
        case 'selectGroup1': selectByAnimal(0); break;
        case 'selectGroup2': selectByAnimal(1); break;
        case 'selectGroup3': selectByAnimal(2); break;
        case 'deselect': state.clearSelection(); break;
        case 'pilotCycleMonarch': state.pilotCycleMonarch(); break;
        case 'pilotToggleMonarch': state.togglePilotMonarchKind(); break;
        case 'rally':
          // Only meaningful while piloting; rallyToMonarch no-ops otherwise.
          if (state.pilotedUnitId) state.rallyToMonarch();
          break;
        case 'selectAllUnits': {
          if (!state.pilotedUnitId) keyboardCoordinator.blockCameraInput(250);
          const ids = state.units
            .filter((u) => u.ownerId === state.localPlayerId && u.kind !== 'Base')
            .map((u) => u.id);
          if (ids.length > 0) state.selectUnits(ids);
          break;
        }
        case 'deployUnits':
          // Tap / double-tap deploy a single unit; the proportionate batch is the
          // Hold lifecycle below.
          if (state.pilotedUnitId) state.placeRalliedUnits(1);
          break;
        default: break;
      }
    };

    // Deploy Units in Hold mode: designate the first follower at the hold threshold,
    // then one more each interval (the teardrop count), and deploy them on release.
    const startDeployDesignate = () => {
      const state = useGameStore.getState();
      if (state.isPaused || state.gameOver || !state.matchStarted || !state.pilotedUnitId) return;
      stopPlacementHold();
      state.incrementUnitPlacement();
      placementRepeatIntervalRef.current = setInterval(() => {
        useGameStore.getState().incrementUnitPlacement();
      }, UNIT_PLACEMENT_REPEAT_INTERVAL_MS);
    };
    const commitDeploy = () => {
      stopPlacementHold();
      const count = useGameStore.getState().unitPlacementCount;
      if (count >= 1) useGameStore.getState().placeRalliedUnits(count);
    };

    const configFor = (actionId: string, mode: ActivationMode): Partial<TokenGestureConfig> | undefined => {
      if (mode === 'tap') return { onTap: () => runAction(actionId, 'tap') };
      if (mode === 'double-tap') return { onDoubleTap: () => runAction(actionId, 'double-tap') };
      if (mode === 'hold') {
        if (actionId === 'deployUnits') {
          return { onHoldStart: startDeployDesignate, onHoldEnd: commitDeploy };
        }
        return { onHoldStart: () => runAction(actionId, 'hold') };
      }
      return undefined; // chord is fired on press below
    };

    const dispatch = buildTokenDispatch({
      bindings: keyboardBindings,
      modes: keyboardBindingModes,
      actionIds: KEYBOARD_GESTURE_ACTIONS,
      configFor,
    });

    const ownsToken = (token: string) =>
      dispatch.resolvers.has(token) || dispatch.chordActions.some((c) => c.token === token);

    const handleKeyDown = (event: KeyboardEvent) => {
      const token = keyboardEventToToken(event);
      if (token === '') return; // bare modifier
      if (!ownsToken(token)) return;
      event.preventDefault();
      // The OS auto-repeats keydown while a key is held; the resolver owns the held
      // cadence (hold timer), so ignore the repeats.
      if (event.repeat) return;

      // Chord-mode actions fire on the rising edge of their (typically modified) token.
      for (const chord of dispatch.chordActions) {
        if (chord.token === token) runAction(chord.actionId, 'chord');
      }
      dispatch.resolvers.get(token)?.press(performance.now());
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const token = keyboardEventToToken(event);
      dispatch.resolvers.get(token)?.release(performance.now());
    };

    // A lost focus never delivers keyup, so abandon any in-progress hold/timing.
    const handleBlur = () => {
      stopPlacementHold();
      dispatch.resolvers.forEach((resolver) => resolver.reset());
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      stopPlacementHold();
      dispatch.resolvers.forEach((resolver) => resolver.reset());
    };
  }, [matchStarted, keyboardBindings, keyboardBindingModes]);

  // This component renders nothing; it only wires keyboard gestures.
  return null;
}
