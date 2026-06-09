// The Conquest combat-posture radial: the same split-ring posture picker Quick Play
// uses, bridged to Conquest's event model.
//
// Single responsibility: render the stance / fire / priority radial for the current
// Conquest selection and turn a click into a posture command. Unlike Quick Play's
// store-driven BehaviorRadial, Conquest keeps its selection and per-unit behavior
// inside the field component (ConquestField), so this overlay is a thin bridge:
//   - it READS the selection's posture from the published `behaviorSummary` (so the
//     active option on each axis is highlighted), and
//   - it WRITES a chosen axis by dispatching `rts:conquest-apply-behavior`, which the
//     field applies to the selected units.
// Opening/closing is driven by `rts:conquest-toggle-radial`, dispatched by the field
// when the player presses the bound key (so the activation mode is honored there).
// The rings, colors, sizing, and stylesheet come from the shared behaviorRadialModel,
// so this radial is visually identical to Quick Play's.

import { useEffect, useMemo, useState } from 'react';
import type { FireMode, TargetPriority, UnitBehavior, UnitStance } from '../../../game/types';
import { useGameStore } from '../../../game/state';
import { formatKeyboardToken } from '../controlBindings';
import { semicircleAngleDeg } from '../radialGeometry';
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

export function ConquestBehaviorRadial() {
  const summary = useConquestStore((s) => s.behaviorSummary);
  const keyboardBindings = useGameStore((s) => s.keyboardBindings);

  const [isOpen, setIsOpen] = useState(false);

  // The bound key for the radial, shown on the trigger so the hint survives a rebind.
  const triggerKeyLabel = useMemo(() => {
    const token = keyboardBindings?.toggleBehaviorRadial ?? '';
    return token ? formatKeyboardToken(token) : '';
  }, [keyboardBindings]);

  const hasSelection = summary !== null && summary.count > 0;
  const currentStance: UnitStance | null = summary?.stance ?? null;
  const currentFire: FireMode | null = summary?.fire ?? null;
  const currentPriority: TargetPriority | null = summary?.priority ?? null;

  // Toggle on the field's key event; never open on an empty selection.
  useEffect(() => {
    const onToggle = () => setIsOpen((prev) => (prev ? false : hasSelection));
    window.addEventListener('rts:conquest-toggle-radial', onToggle);
    return () => window.removeEventListener('rts:conquest-toggle-radial', onToggle);
  }, [hasSelection]);

  // Close automatically the moment there is nothing to command (e.g. deselect).
  useEffect(() => {
    if (!hasSelection && isOpen) setIsOpen(false);
  }, [hasSelection, isOpen]);

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
                return (
                  <button
                    key={option.priority}
                    className={`rts-stance-node${active ? ' rts-stance-node-active' : ''}`}
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
                return (
                  <button
                    key={option.stance}
                    className={`rts-stance-node${active ? ' rts-stance-node-active' : ''}`}
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
                className="rts-stance-node rts-stance-center"
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
              Click a circle to set posture · center toggles fire ·
              {triggerKeyLabel ? ` press ${triggerKeyLabel} or` : ''} click outside to close
            </div>
          </div>
        </div>
      )}
    </>
  );
}
