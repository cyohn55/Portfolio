import { useEffect, useMemo, useRef, useState } from 'react';
import { useGameStore } from '../../game/state';

import { useUiSettingsStore } from "../../game/uiSettingsStore";
import type { FireMode, TargetPriority, Unit, UnitStance } from '../../game/types';
import { behaviorOf } from './unitBehavior';
import { formatKeyboardToken } from './controlBindings';
import { type RadialHover, hoverFromVector, semicircleAngleDeg } from './radialGeometry';
import {
  STANCE_OPTIONS,
  PRIORITY_OPTIONS,
  FIRE_COLOR,
  POSTURE_COLOR,
  PRIORITY_COLOR,
  RING_RADIUS,
  PANEL_SIZE,
  uniform,
  BEHAVIOR_RADIAL_STYLE,
} from './behaviorRadialModel';

/**
 * The selection radial for the combat-posture system. It drives the deterministic
 * `setBehavior` command (see state.ts / unitBehavior.ts), letting the player set
 * the three composable axes of a selection's behavior with a single split ring
 * around a central toggle:
 *   - fire:     the center toggle (weapons-free vs hold-fire)
 *   - stance:   the posture circles, filling the TOP half of the ring
 *   - priority: the target-priority circles, filling the BOTTOM half of the ring
 *
 * Opens on the `b` key / R3 / the on-screen button while own, commandable units are
 * selected. With a controller the right stick aims: its deflection MAGNITUDE picks
 * center-vs-ring (at rest = the center fire toggle) and its ANGLE picks the option
 * (a top-half angle = a posture, a bottom-half angle = a priority). RT applies the
 * highlighted option and the radial stays open so all three axes can be set in one
 * visit; B closes it. A mouse can also click any circle directly.
 *
 * Only the five combat stances are offered here; the positional stances
 * (patrol/guard/escort) need a target-placement gesture that is not built yet, so
 * they are deliberately omitted rather than shown as no-ops.
 *
 * The option lists, colors, ring geometry, and stylesheet live in the shared
 * behaviorRadialModel so Conquest's ConquestBehaviorRadial draws an identical ring.
 */

export function BehaviorRadial() {
  const matchStarted = useGameStore((s) => s.matchStarted);
  const selectedUnitIds = useGameStore((s) => s.selectedUnitIds);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const setBehavior = useGameStore((s) => s.setBehavior);
  const keyboardBindings = useUiSettingsStore((s) => s.keyboardBindings);

  // We must NOT subscribe to the live `units` array: the sim publishes a fresh
  // `units` reference every tick, which would re-render this always-mounted wheel
  // 60x/s for the whole match. Instead we derive a tiny signature of just the
  // selected units' postures. The selector runs each tick (a cheap scan, no DOM
  // work) but its string output is identical frame-to-frame unless a selected
  // unit's stance/fire/priority actually changes — so React only re-renders on a
  // real posture change (e.g. after setBehavior), keeping the open wheel's active
  // highlights live without the per-tick churn. Membership tracks selectedUnitIds.
  const behaviorSignature = useGameStore((s) => {
    const selected = s.selectedUnitIds;
    if (selected.length === 0) return '';
    const ids = new Set(selected);
    let signature = '';
    for (const unit of s.units) {
      if (!ids.has(unit.id) || unit.ownerId !== localPlayerId || unit.kind === 'Base') continue;
      const behavior = behaviorOf(unit);
      signature += `${unit.id}:${behavior.stance}/${behavior.fire}/${behavior.priority};`;
    }
    return signature;
  });

  // The player's current key for the radial action, shown on the trigger so the
  // hint stays accurate after a rebind. Blank when the action is left unbound.
  const triggerKeyLabel = useMemo(() => {
    const token = keyboardBindings?.toggleBehaviorRadial ?? '';
    return token ? formatKeyboardToken(token) : '';
  }, [keyboardBindings]);

  const [isOpen, setIsOpen] = useState(false);

  // The ring + wedge the controller's right stick is currently addressing (null =
  // no controller aim yet). Mirrored into a ref so the RT-select listener reads the
  // latest aim without re-subscribing every aim frame.
  const [gamepadHover, setGamepadHover] = useState<RadialHover | null>(null);
  const hoverRef = useRef<RadialHover | null>(null);

  // The subset of the selection this player can actually command postures for:
  // their own movable units (Bases have no behavior). Read off the live store (not
  // a subscription) and recomputed whenever the selection or the posture signature
  // changes, so the active highlights still track command results without the wheel
  // re-rendering every sim tick.
  const commandable = useMemo<Unit[]>(() => {
    const selected = new Set(selectedUnitIds);
    return useGameStore
      .getState()
      .units.filter((u) => selected.has(u.id) && u.ownerId === localPlayerId && u.kind !== 'Base');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUnitIds, localPlayerId, behaviorSignature]);

  const commandableIds = useMemo(() => commandable.map((u) => u.id), [commandable]);

  // Current axis values across the selection (null = mixed).
  const currentStance = useMemo(() => uniform(commandable.map((u) => behaviorOf(u).stance)), [commandable]);
  const currentFire = useMemo(() => uniform(commandable.map((u) => behaviorOf(u).fire)), [commandable]);
  const currentPriority = useMemo(() => uniform(commandable.map((u) => behaviorOf(u).priority)), [commandable]);

  // Close automatically the moment there is nothing to command (e.g. deselect).
  useEffect(() => {
    if (commandable.length === 0 && isOpen) setIsOpen(false);
  }, [commandable.length, isOpen]);

  // The Combat Posture Radial action (remappable via Settings → Controls; 'b' by
  // default) toggles the radial. KeyboardShortcuts and the controller's B both fire
  // this event, so the trigger respects the player's chosen key/mode and never
  // fights text entry. Ignored when nothing is selected so it can't open on an
  // empty selection.
  useEffect(() => {
    const onToggle = () => {
      if (commandableIds.length === 0) return;
      setIsOpen((prev) => !prev);
    };
    window.addEventListener('rts:toggle-stance-radial', onToggle);
    return () => window.removeEventListener('rts:toggle-stance-radial', onToggle);
  }, [commandableIds.length]);

  // Broadcast the open/closed state so GamepadController knows when to hand the
  // right stick to ring selection. Clears any stale gamepad hover on close.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(isOpen ? 'rts:stance-radial-open' : 'rts:stance-radial-close'));
    if (isOpen) {
      // Only one wheel on screen at a time: announce this one so the formation /
      // audible / playbook wheels close (and vice-versa).
      window.dispatchEvent(new CustomEvent('rts:radial-exclusive', { detail: { ns: 'stance' } }));
    } else {
      hoverRef.current = null;
      setGamepadHover(null);
    }
  }, [isOpen]);

  // Close when another wheel opens.
  useEffect(() => {
    const onExclusive = (event: Event) => {
      const ns = (event as CustomEvent).detail?.ns as string | undefined;
      if (ns && ns !== 'stance') setIsOpen(false);
    };
    window.addEventListener('rts:radial-exclusive', onExclusive);
    return () => window.removeEventListener('rts:radial-exclusive', onExclusive);
  }, []);

  // Controller ring selection while open: the right stick streams an aim vector
  // (highlight the addressed ring + wedge); pressing RT applies the highlighted
  // option and the radial stays open so the next axis can be set. GamepadController
  // owns the stick reading and the RT/B edges; this side owns the geometry and the
  // commands.
  useEffect(() => {
    if (!isOpen) return;
    const onAim = (event: Event) => {
      const detail = (event as CustomEvent).detail as { x?: number; y?: number } | undefined;
      if (!detail || typeof detail.x !== 'number' || typeof detail.y !== 'number') return;
      const hover = hoverFromVector(detail.x, detail.y, STANCE_OPTIONS.length, PRIORITY_OPTIONS.length);
      hoverRef.current = hover;
      setGamepadHover(hover);
    };
    const onSelect = () => {
      const hover = hoverRef.current;
      if (!hover || commandableIds.length === 0) return;
      if (hover.ring === 'fire') {
        const next: FireMode = (currentFire ?? 'free') === 'free' ? 'hold' : 'free';
        setBehavior({ unitIds: commandableIds, behavior: { fire: next } });
      } else if (hover.ring === 'posture') {
        setBehavior({ unitIds: commandableIds, behavior: { stance: STANCE_OPTIONS[hover.index].stance } });
      } else {
        setBehavior({ unitIds: commandableIds, behavior: { priority: PRIORITY_OPTIONS[hover.index].priority } });
      }
    };
    window.addEventListener('rts:stance-radial-aim', onAim);
    window.addEventListener('rts:stance-radial-select', onSelect);
    return () => {
      window.removeEventListener('rts:stance-radial-aim', onAim);
      window.removeEventListener('rts:stance-radial-select', onSelect);
    };
  }, [isOpen, commandableIds, currentFire, setBehavior]);

  if (!matchStarted) return null;

  const applyStance = (stance: UnitStance) => setBehavior({ unitIds: commandableIds, behavior: { stance } });
  const applyFire = (fire: FireMode) => setBehavior({ unitIds: commandableIds, behavior: { fire } });
  const applyPriority = (priority: TargetPriority) => setBehavior({ unitIds: commandableIds, behavior: { priority } });

  const effectiveFire: FireMode = currentFire ?? 'free';
  const fireIsFree = currentFire === 'free';

  return (
    <>
      <style>{BEHAVIOR_RADIAL_STYLE}</style>

      {/* The collapsed trigger now lives as the 4th button in AnimalSelectionButtons
          (dispatches `rts:toggle-stance-radial`), so the radial only renders the
          expanded panel here. */}
      {isOpen && commandable.length > 0 && (
        // Backdrop closes the radial on an outside click.
        <div className="rts-stance-backdrop" onClick={() => setIsOpen(false)}>
          <div className="rts-stance-panel" onClick={(e) => e.stopPropagation()}>
            <div className="rts-stance-header">
              Combat Posture · {commandable.length} unit{commandable.length === 1 ? '' : 's'}
            </div>

            {/* One ring around the fire toggle: posture fills the top half, priority
                the bottom half. */}
            <div className="rts-stance-ring" style={{ width: PANEL_SIZE, height: PANEL_SIZE }}>
              {/* Bottom half of the ring: target priority. */}
              {PRIORITY_OPTIONS.map((option, index) => {
                const angle = semicircleAngleDeg('bottom', index, PRIORITY_OPTIONS.length) * (Math.PI / 180);
                const x = Math.cos(angle) * RING_RADIUS;
                const y = Math.sin(angle) * RING_RADIUS;
                const active = currentPriority === option.priority;
                const hovered = gamepadHover?.ring === 'priority' && gamepadHover.index === index;
                return (
                  <button
                    key={option.priority}
                    className={`rts-stance-node${active ? ' rts-stance-node-active' : ''}${hovered ? ' rts-stance-node-hover' : ''}`}
                    style={{ background: PRIORITY_COLOR, transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` }}
                    onClick={() => applyPriority(option.priority)}
                    title={option.hint}
                  >
                    <span className="rts-stance-node-icon">{option.icon}</span>
                    <span className="rts-stance-node-label">{option.label}</span>
                  </button>
                );
              })}

              {/* Top half of the ring: posture. */}
              {STANCE_OPTIONS.map((option, index) => {
                const angle = semicircleAngleDeg('top', index, STANCE_OPTIONS.length) * (Math.PI / 180);
                const x = Math.cos(angle) * RING_RADIUS;
                const y = Math.sin(angle) * RING_RADIUS;
                const active = currentStance === option.stance;
                const hovered = gamepadHover?.ring === 'posture' && gamepadHover.index === index;
                return (
                  <button
                    key={option.stance}
                    className={`rts-stance-node${active ? ' rts-stance-node-active' : ''}${hovered ? ' rts-stance-node-hover' : ''}`}
                    style={{ background: POSTURE_COLOR, transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` }}
                    onClick={() => applyStance(option.stance)}
                    title={option.hint}
                  >
                    <span className="rts-stance-node-icon">{option.icon}</span>
                    <span className="rts-stance-node-label">{option.label}</span>
                  </button>
                );
              })}

              {/* Center: weapons-free / hold-fire toggle. Always shows the fire color;
                  its on/off state is read from the icon + label. */}
              <button
                className={`rts-stance-node rts-stance-center${gamepadHover?.ring === 'fire' ? ' rts-stance-node-hover' : ''}`}
                style={{ background: FIRE_COLOR }}
                onClick={() => applyFire(effectiveFire === 'free' ? 'hold' : 'free')}
                title="Toggle weapons-free / hold-fire"
              >
                <span className="rts-stance-center-icon">{fireIsFree ? '🔥' : '✋'}</span>
                <span className="rts-stance-center-label">
                  {currentFire === null ? 'Mixed' : fireIsFree ? 'Weapons Free' : 'Hold Fire'}
                </span>
              </button>
            </div>

            <div className="rts-stance-footer">
              Aim the right stick (center = fire · top = posture · bottom = priority) and press
              <span className="rts-stance-key"> RT</span> to set · <span className="rts-stance-key">B</span> to close ·
              or click a circle{triggerKeyLabel ? ` / press ${triggerKeyLabel}` : ''}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
