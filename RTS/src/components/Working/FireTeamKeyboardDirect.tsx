import { useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getSimSnapshot, dispatchCommand, useGameStore } from '../../game/state';
import { useUiStore } from '../../game/uiStore';
import { useUiSettingsStore } from '../../game/uiSettingsStore';
import {
  DIRECT_ARROW_COLOR,
  createButtonBadge,
  hideDottedArrow,
  positionBadge,
} from './dottedArrow';
import {
  directableFireTeamIds,
  fireTeamCentroid,
  fireTeamMemberIds,
} from './fireTeamDirecting';

/**
 * FireTeamKeyboardDirect — the keyboard counterpart of the controller's quick-direct
 * gesture (GamepadController.updateFireTeamDirect). It is the keyboard "Fire Team
 * Overlay": TAP the bound trigger (Shift by default) to open a numbered badge over each
 * of the local player's deployed fire teams, press a badge's number key to select that
 * team (press again to deselect — any number of teams), then tap the trigger again to
 * confirm. Confirming selects the chosen teams' units AND hands the player drive control
 * over all of them at once, so the Move keys steer every selected team (see
 * applyFireTeamDrive / the per-unit drive block in state.ts, which now accept a set of
 * driven teams). Esc closes without confirming.
 *
 * It lives inside the R3F <Canvas> so it can project each team's centroid to screen for
 * the badges. All gesture state is kept off the React path (refs); the badges are
 * body-appended DOM positioned each frame, reusing the same helpers as the controller
 * overlay so the two read identically. The trigger and selection never raycast or touch
 * the mouse — confirming routes through the normal selection + the setPilotFireTeam
 * command, so the player then commands the teams with the usual mouse orders.
 */

// The number keys that label the badges, in directable-team order: 1..9 then 0 for a
// tenth team. Teams beyond this stay directable through the Directing wheel / cycle.
const TEAM_KEYS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

export function FireTeamKeyboardDirect() {
  const { camera } = useThree();

  // All gesture state lives off the React path so the per-frame redraw and the global
  // key listeners never force a re-render of this (render-nothing) component.
  //   open        — the overlay is showing badges and accepting team picks.
  //   armedTeamIds— the teams the player has selected (toggled by their number key).
  //   triggerDown — the trigger key is currently held (for tap detection).
  //   triggerDownAt / otherKeyDuringTrigger — a "tap" is a trigger press+release with no
  //                 other key in between, so a lone Shift tap is told apart from Shift+A.
  const gestureRef = useRef({
    open: false,
    armedTeamIds: [] as string[],
    triggerDown: false,
    triggerDownAt: 0,
    otherKeyDuringTrigger: false,
  });
  // One badge per pickable team slot, body-appended once and positioned each frame.
  const badgeElsRef = useRef<HTMLDivElement[]>([]);

  // Project a world position to screen pixels (mirrors GamepadController.projectToScreen).
  const projectToScreen = (x: number, y: number, z: number) => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v.y * 0.5 + 0.5) * window.innerHeight,
    };
  };

  // Build the badge pool once and tear it down on unmount.
  useEffect(() => {
    const badges = TEAM_KEYS.map(() => {
      const badge = createButtonBadge(DIRECT_ARROW_COLOR);
      document.body.appendChild(badge);
      return badge;
    });
    badgeElsRef.current = badges;
    return () => {
      for (const badge of badges) {
        if (badge.parentNode) badge.parentNode.removeChild(badge);
      }
      badgeElsRef.current = [];
    };
  }, []);

  // Global key handling for the trigger tap + team picks. Reads live state via getState
  // inside the handlers so a binding remap or a new match takes effect without
  // re-subscribing, and so the new-array-every-tick store never tears these listeners down.
  useEffect(() => {
    const hideAllBadges = () => {
      for (const badge of badgeElsRef.current) hideDottedArrow(badge);
    };

    const closeOverlay = () => {
      gestureRef.current.open = false;
      gestureRef.current.armedTeamIds = [];
      hideAllBadges();
    };

    // The bound trigger token for this device (default 'shift'); '' disables the gesture.
    const triggerToken = () => useUiSettingsStore.getState().keyboardBindings.quickDirectFireTeams;

    // The bare key as a single-atom token, so a lone modifier (Shift) resolves to itself
    // and the trigger can be matched whether it is a modifier or a remapped normal key.
    const bareKeyToken = (event: KeyboardEvent): string => {
      const key = event.key.toLowerCase();
      if (key === ' ' || key === 'spacebar') return 'space';
      return key;
    };

    const canEngage = (): boolean => {
      const state = useGameStore.getState();
      return state.matchStarted && !state.gameOver && !useUiStore.getState().isPaused;
    };

    // The local player's directable fire teams, in stable (sorted) order — the same order
    // the badge keys map to.
    const directableTeams = (): string[] => {
      const { units, localPlayerId } = getSimSnapshot();
      return directableFireTeamIds(units, localPlayerId);
    };

    const openOverlay = () => {
      if (!canEngage()) return;
      if (directableTeams().length === 0) return; // nothing to direct
      gestureRef.current.open = true;
      gestureRef.current.armedTeamIds = [];
    };

    // Confirm: select every armed team's units and hand the player drive control over all
    // of them, then close. With nothing armed it just closes (no selection/pilot change).
    const confirmOverlay = () => {
      const armed = gestureRef.current.armedTeamIds;
      if (armed.length > 0) {
        const { units, localPlayerId } = getSimSnapshot();
        const memberIds = armed.flatMap((teamId) => fireTeamMemberIds(units, teamId, localPlayerId));
        if (memberIds.length > 0) {
          useUiStore.getState().selectUnits(memberIds);
          useUiStore.getState().resetUnitPlacement();
        }
        // Sort so the driven-team order is canonical (identical on both lockstep peers),
        // independent of the order the player tapped the badge keys.
        const teamIds = [...armed].sort();
        dispatchCommand({ type: 'setPilotFireTeam', payload: { teamIds } });
      }
      closeOverlay();
    };

    // Toggle a team in/out of the armed set by its badge index, ignoring out-of-range keys.
    const toggleTeamAt = (index: number) => {
      const teams = directableTeams();
      if (index < 0 || index >= teams.length) return;
      const teamId = teams[index];
      const armed = gestureRef.current.armedTeamIds;
      const at = armed.indexOf(teamId);
      if (at >= 0) armed.splice(at, 1);
      else armed.push(teamId);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const token = bareKeyToken(event);
      const trigger = triggerToken();

      // Trigger key: track its press for the keyup tap test; never treated as a pick.
      if (trigger !== '' && token === trigger) {
        if (!event.repeat && !gestureRef.current.triggerDown) {
          gestureRef.current.triggerDown = true;
          gestureRef.current.triggerDownAt = performance.now();
          gestureRef.current.otherKeyDuringTrigger = false;
        }
        return;
      }

      // Any other key while the trigger is held means this was not a lone trigger tap
      // (e.g. Shift+A group-select), so the keyup below must not toggle the overlay.
      if (gestureRef.current.triggerDown) gestureRef.current.otherKeyDuringTrigger = true;

      // While the overlay is open, the badge number keys pick teams and Esc cancels —
      // swallow them so they can't also reach the other keyboard/mouse handlers.
      if (gestureRef.current.open) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          closeOverlay();
          return;
        }
        const index = TEAM_KEYS.indexOf(token);
        if (index >= 0) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (!event.repeat) toggleTeamAt(index);
        }
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const token = bareKeyToken(event);
      const trigger = triggerToken();
      if (trigger === '' || token !== trigger || !gestureRef.current.triggerDown) return;

      gestureRef.current.triggerDown = false;
      // A tap = trigger released with no other key pressed during the hold. Long holds of
      // the trigger alone still count (there is no separate hold gesture on keyboard).
      const wasTap = !gestureRef.current.otherKeyDuringTrigger;
      gestureRef.current.otherKeyDuringTrigger = false;
      if (!wasTap) return;

      if (gestureRef.current.open) confirmOverlay();
      else openOverlay();
    };

    // A lost focus never delivers keyup, so abandon any in-progress gesture.
    const handleBlur = () => {
      gestureRef.current.triggerDown = false;
      gestureRef.current.otherKeyDuringTrigger = false;
      closeOverlay();
    };

    // Capture phase so the open-overlay key swallow beats the canvas/document handlers
    // that own selection, movement, and group-selects.
    document.addEventListener('keydown', handleKeyDown, { capture: true });
    document.addEventListener('keyup', handleKeyUp, { capture: true });
    window.addEventListener('blur', handleBlur);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true });
      document.removeEventListener('keyup', handleKeyUp, { capture: true });
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  // Position the badges each frame while open; hide everything when closed. Also close if
  // the match left a live state (paused / ended) so no badge lingers over a frozen field.
  useFrame(() => {
    const gesture = gestureRef.current;
    const badges = badgeElsRef.current;
    if (!gesture.open) {
      for (const badge of badges) hideDottedArrow(badge);
      return;
    }

    const state = useGameStore.getState();
    if (!state.matchStarted || state.gameOver || useUiStore.getState().isPaused) {
      gesture.open = false;
      gesture.armedTeamIds = [];
      for (const badge of badges) hideDottedArrow(badge);
      return;
    }

    const { units, localPlayerId } = getSimSnapshot();
    const teams = directableFireTeamIds(units, localPlayerId);
    // Drop any armed team that has vanished (all members died / disbanded) so a stale id
    // is never confirmed or drawn.
    gesture.armedTeamIds = gesture.armedTeamIds.filter((teamId) => teams.includes(teamId));

    let slot = 0;
    for (; slot < teams.length && slot < badges.length; slot++) {
      const teamId = teams[slot];
      const badge = badges[slot];
      const center = fireTeamCentroid(units, teamId, localPlayerId);
      if (!center) {
        hideDottedArrow(badge);
        continue;
      }
      badge.textContent = TEAM_KEYS[slot];
      // A filled badge marks an armed (selected) team, matching the controller overlay.
      const armed = gesture.armedTeamIds.includes(teamId);
      badge.style.background = armed ? DIRECT_ARROW_COLOR : 'rgba(0, 0, 0, 0.65)';
      badge.style.color = armed ? '#000000' : DIRECT_ARROW_COLOR;
      positionBadge(badge, projectToScreen(center.x, 0, center.z));
    }
    for (; slot < badges.length; slot++) hideDottedArrow(badges[slot]);
  });

  // Render-nothing: it only wires the keyboard overlay and its body-appended badges.
  return null;
}
