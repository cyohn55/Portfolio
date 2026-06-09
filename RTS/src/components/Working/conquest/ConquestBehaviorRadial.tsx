// The Conquest combat-posture radial: the same split-ring posture picker Quick Play
// uses, bridged to Conquest's event model and driven by mouse OR controller.
//
// Single responsibility: render the stance / fire / priority radial for the current
// Conquest selection and turn a click (or controller aim) into a posture command.
// Unlike Quick Play's store-driven BehaviorRadial, Conquest keeps its selection and
// per-unit behavior inside the field component (ConquestField), so this overlay is a
// thin bridge:
//   - it READS the selection's posture from the published `behaviorSummary` (so the
//     active option on each axis is highlighted), and
//   - it WRITES a chosen axis by dispatching `rts:conquest-apply-behavior`, which the
//     field applies to the selected units.
// Keyboard open/close is driven by `rts:conquest-toggle-radial`, dispatched by the
// field when the player presses the bound key (so the activation mode is honored).
//
// Controller support: Conquest does not mount Quick Play's GamepadController, so this
// component runs its OWN minimal right-stick poller while mounted — R3 (the
// toggleBehaviorRadial binding) opens/closes it, the right stick aims a ring/wedge
// (deflection magnitude picks center-vs-ring), RT applies the highlighted option (the
// radial stays open), and B closes it. This mirrors GamepadController's radial block.
//
// The rings, colors, sizing, and stylesheet come from the shared behaviorRadialModel,
// so this radial is visually identical to Quick Play's.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FireMode, TargetPriority, UnitBehavior, UnitStance } from '../../../game/types';
import { useGameStore } from '../../../game/state';
import {
  formatKeyboardToken,
  isControllerTokenActive,
} from '../controlBindings';
import { activeConquestGamepad } from './conquestGamepad';
import { semicircleAngleDeg, hoverFromVector, type RadialHover } from '../radialGeometry';
import {
  STANCE_OPTIONS,
  PRIORITY_OPTIONS,
  FIRE_COLOR,
  POSTURE_COLOR,
  PRIORITY_COLOR,
  RING_RADIUS,
  PANEL_SIZE,
  labelForStance,
  fireToggleNext,
  BEHAVIOR_RADIAL_STYLE,
} from '../behaviorRadialModel';
import { useConquestStore } from './conquestState';

/** Ask the field to merge a partial behavior into every selected, controlled unit. */
function applyBehavior(behavior: Partial<UnitBehavior>): void {
  window.dispatchEvent(new CustomEvent('rts:conquest-apply-behavior', { detail: { behavior } }));
}

/** Whether two radial hovers address the same ring + wedge (to skip redundant re-renders). */
function sameHover(a: RadialHover | null, b: RadialHover | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.ring === b.ring && a.index === b.index;
}

export function ConquestBehaviorRadial() {
  const summary = useConquestStore((s) => s.behaviorSummary);
  const keyboardBindings = useGameStore((s) => s.keyboardBindings);

  const [isOpen, setIsOpen] = useState(false);
  // The ring + wedge the controller's right stick is currently addressing (null = no
  // controller aim), used to draw the yellow aim highlight while the stick is in play.
  const [gamepadHover, setGamepadHover] = useState<RadialHover | null>(null);

  // The bound key for the radial, shown on the trigger so the hint survives a rebind.
  const triggerKeyLabel = useMemo(() => {
    const token = keyboardBindings?.toggleBehaviorRadial ?? '';
    return token ? formatKeyboardToken(token) : '';
  }, [keyboardBindings]);

  const hasSelection = summary !== null && summary.count > 0;
  const currentStance: UnitStance | null = summary?.stance ?? null;
  const currentFire: FireMode | null = summary?.fire ?? null;
  const currentPriority: TargetPriority | null = summary?.priority ?? null;

  // Live mirrors the controller poll loop reads without re-subscribing each frame.
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const hasSelectionRef = useRef(hasSelection);
  hasSelectionRef.current = hasSelection;
  const currentFireRef = useRef(currentFire);
  currentFireRef.current = currentFire;
  const hoverRef = useRef<RadialHover | null>(null);

  // Toggle on the field's keyboard event; never open on an empty selection.
  useEffect(() => {
    const onToggle = () => setIsOpen((prev) => (prev ? false : hasSelection));
    window.addEventListener('rts:conquest-toggle-radial', onToggle);
    return () => window.removeEventListener('rts:conquest-toggle-radial', onToggle);
  }, [hasSelection]);

  // Close automatically the moment there is nothing to command (e.g. deselect), and
  // clear any stale controller aim whenever the radial closes.
  useEffect(() => {
    if (!hasSelection && isOpen) setIsOpen(false);
    if (!isOpen && hoverRef.current) {
      hoverRef.current = null;
      setGamepadHover(null);
    }
  }, [hasSelection, isOpen]);

  // Broadcast open/close so the field's controller poll knows when the radial owns the
  // right stick + RT/B (it then suppresses its own reticle aim and order/clear on those
  // inputs, exactly as Quick Play's GamepadController defers to its stance radial).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(isOpen ? 'rts:conquest-radial-open' : 'rts:conquest-radial-close'));
  }, [isOpen]);

  // Controller poller (Conquest has no GamepadController of its own). Runs for the
  // component's whole life so R3 can OPEN the radial, then aims/applies/closes while
  // open — reading the live controller bindings each frame so a rebind takes effect.
  useEffect(() => {
    let raf = 0;
    let togglePrev = false;
    let selectPrev = false;
    let closePrev = false;

    const applyHover = (hover: RadialHover | null) => {
      if (!hover) return;
      if (hover.ring === 'fire') applyBehavior({ fire: fireToggleNext(currentFireRef.current) });
      else if (hover.ring === 'posture') applyBehavior({ stance: STANCE_OPTIONS[hover.index].stance });
      else applyBehavior({ priority: PRIORITY_OPTIONS[hover.index].priority });
    };

    const poll = () => {
      raf = requestAnimationFrame(poll);
      const pad = activeConquestGamepad();
      if (!pad) { togglePrev = selectPrev = closePrev = false; return; }
      const bindings = useGameStore.getState().controllerBindings;

      // Open/close on the radial toggle button (default R3), rising edge — works
      // whether the radial is open or closed, and never opens on an empty selection.
      const toggleActive = isControllerTokenActive(pad, bindings.toggleBehaviorRadial);
      if (toggleActive && !togglePrev) {
        setIsOpen((prev) => (prev ? false : hasSelectionRef.current));
      }
      togglePrev = toggleActive;

      if (isOpenRef.current && hasSelectionRef.current) {
        // Stream the raw aim (including near-center, where the fire toggle is
        // addressed) so the radial derives the ring from the deflection magnitude.
        const aim = hoverFromVector(pad.axes[2] ?? 0, pad.axes[3] ?? 0, STANCE_OPTIONS.length, PRIORITY_OPTIONS.length);
        if (!sameHover(aim, hoverRef.current)) {
          hoverRef.current = aim;
          setGamepadHover(aim);
        }

        // RT applies the highlighted option; rising edge so a held trigger applies once.
        const selectActive = isControllerTokenActive(pad, bindings.secondaryAction);
        if (selectActive && !selectPrev) applyHover(hoverRef.current);
        selectPrev = selectActive;

        // B closes; rising edge.
        const closeActive = isControllerTokenActive(pad, bindings.deselect);
        if (closeActive && !closePrev) setIsOpen(false);
        closePrev = closeActive;
      } else {
        selectPrev = closePrev = false;
      }
    };

    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!hasSelection && !isOpen) return null;
  const count = summary?.count ?? 0;
  const fireIsFree = (currentFire ?? 'free') === 'free';

  return (
    <>
      <style>{BEHAVIOR_RADIAL_STYLE}</style>

      {/* Collapsed trigger: shown only when there is a commandable selection. */}
      {!isOpen && hasSelection && (
        <button
          className="rts-stance-trigger"
          onClick={() => setIsOpen(true)}
          title={`Set combat posture for the selection${triggerKeyLabel ? ` (${triggerKeyLabel})` : ''}`}
        >
          <span className="rts-stance-trigger-icon">
            {STANCE_OPTIONS.find((o) => o.stance === currentStance)?.icon ?? '⚔️'}
          </span>
          <span>
            Stance: {currentStance ? labelForStance(currentStance) : 'Mixed'}
            {triggerKeyLabel && <span className="rts-stance-trigger-key"> · {triggerKeyLabel}</span>}
          </span>
        </button>
      )}

      {isOpen && hasSelection && (
        // Backdrop closes the radial on an outside click.
        <div className="rts-stance-backdrop" onClick={() => setIsOpen(false)}>
          <div className="rts-stance-panel" onClick={(e) => e.stopPropagation()}>
            <div className="rts-stance-header">
              Combat Posture · {count} unit{count === 1 ? '' : 's'}
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
                    onClick={() => applyBehavior({ priority: option.priority })}
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
                    onClick={() => applyBehavior({ stance: option.stance })}
                    title={option.hint}
                  >
                    <span className="rts-stance-node-icon">{option.icon}</span>
                    <span className="rts-stance-node-label">{option.label}</span>
                  </button>
                );
              })}

              {/* Center: weapons-free / hold-fire toggle. */}
              <button
                className={`rts-stance-node rts-stance-center${gamepadHover?.ring === 'fire' ? ' rts-stance-node-hover' : ''}`}
                style={{ background: FIRE_COLOR }}
                onClick={() => applyBehavior({ fire: fireToggleNext(currentFire) })}
                title="Toggle weapons-free / hold-fire"
              >
                <span className="rts-stance-center-icon">{fireIsFree ? '🔥' : '✋'}</span>
                <span className="rts-stance-center-label">
                  {currentFire === null ? 'Mixed' : fireIsFree ? 'Weapons Free' : 'Hold Fire'}
                </span>
              </button>
            </div>

            <div className="rts-stance-footer">
              Click a circle (center toggles fire) — or aim the right stick and press
              <span className="rts-stance-key"> RT</span> to set ·
              <span className="rts-stance-key"> B</span> /
              {triggerKeyLabel ? ` ${triggerKeyLabel} /` : ''} click outside to close
            </div>
          </div>
        </div>
      )}
    </>
  );
}
