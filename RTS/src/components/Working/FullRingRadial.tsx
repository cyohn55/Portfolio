import { useEffect, useMemo, useRef, useState } from 'react';
import { fullRingAngleDeg, ringIndexFromVector } from './radialGeometry';
import { BEHAVIOR_RADIAL_STYLE } from './behaviorRadialModel';
import { FORMATION_NODE_DIAMETER } from './formationRadialModel';

/**
 * A reusable full-ring selection radial — one ring of option circles around an inert
 * center readout. Shared by the Formation, Audible, and Playbook wheels so they
 * navigate, render, and feel identical (the combat-posture radial keeps its own
 * split-ring layout). It owns the open/close lifecycle and the input:
 *   - opens/closes on `rts:toggle-${name}-radial` (keyboard / controller / button),
 *   - broadcasts `rts:${name}-radial-open|close` so the controller hands it the stick,
 *   - the controller streams `rts:${name}-radial-aim` (a stick vector → highlight) and
 *     `rts:${name}-radial-select` (apply the highlight),
 *   - a mouse can click any circle directly.
 * `autoClose` hides the wheel the instant an option is chosen (Formation/Audible/
 * Playbook); leaving it false keeps the wheel up for multi-pick (the posture radial).
 * Opening one wheel closes any other (a shared exclusivity event) so only one shows.
 *
 * The parent supplies the option list, the live `enabled`/`activeKey`/labels, and the
 * `onSelect` command — this component is purely the picture + the interaction.
 */

export interface RingOption {
  key: string;
  icon: string;
  label: string;
  hint: string;
}

interface FullRingRadialProps {
  /** Event namespace, e.g. 'formation' | 'audible' | 'playbook'. */
  name: string;
  options: readonly RingOption[];
  /** Circle background color (the wheel's identity hue). */
  color: string;
  header: string;
  centerIcon: string;
  centerLabel: string;
  footer: string;
  /** May the wheel open / stay open (e.g. is there a valid selection). */
  enabled: boolean;
  /** Hide the moment an option is selected. */
  autoClose: boolean;
  /** Option key to mark as the current value, if any. */
  activeKey?: string | null;
  onSelect: (key: string) => void;
}

export function FullRingRadial({
  name,
  options,
  color,
  header,
  centerIcon,
  centerLabel,
  footer,
  enabled,
  autoClose,
  activeKey,
  onSelect,
}: FullRingRadialProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [gamepadHoverIndex, setGamepadHoverIndex] = useState<number | null>(null);
  const hoverIndexRef = useRef<number | null>(null);

  // Ring radius derived from the option count so N circles always clear each other.
  const ringRadius = useMemo(() => {
    const slots = Math.max(options.length, 3);
    return (FORMATION_NODE_DIAMETER + 16) / (2 * Math.sin(Math.PI / slots));
  }, [options.length]);
  const panelSize = 2 * (ringRadius + FORMATION_NODE_DIAMETER / 2) + 24;

  const select = (key: string) => {
    onSelect(key);
    if (autoClose) setIsOpen(false);
  };

  // Close automatically the moment there is nothing valid to act on.
  useEffect(() => {
    if (!enabled && isOpen) setIsOpen(false);
  }, [enabled, isOpen]);

  // Toggle on this wheel's shared event (keyboard binding, controller D-pad, or the
  // on-screen button all dispatch it). Ignored when disabled so it can't open empty.
  useEffect(() => {
    const onToggle = () => {
      if (!enabled) return;
      setIsOpen((prev) => !prev);
    };
    window.addEventListener(`rts:toggle-${name}-radial`, onToggle);
    return () => window.removeEventListener(`rts:toggle-${name}-radial`, onToggle);
  }, [name, enabled]);

  // Broadcast open/closed (controller stick hand-off) + enforce one-wheel-at-a-time.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(isOpen ? `rts:${name}-radial-open` : `rts:${name}-radial-close`));
    if (isOpen) {
      window.dispatchEvent(new CustomEvent('rts:radial-exclusive', { detail: { ns: name } }));
    } else {
      hoverIndexRef.current = null;
      setGamepadHoverIndex(null);
    }
  }, [isOpen, name]);

  // Another wheel opened → close this one so only one is ever on screen.
  useEffect(() => {
    const onExclusive = (event: Event) => {
      const ns = (event as CustomEvent).detail?.ns as string | undefined;
      if (ns && ns !== name) setIsOpen(false);
    };
    window.addEventListener('rts:radial-exclusive', onExclusive);
    return () => window.removeEventListener('rts:radial-exclusive', onExclusive);
  }, [name]);

  // Controller stick selection while open: the right stick streams an aim vector
  // (highlight the addressed option), the select event applies it.
  useEffect(() => {
    if (!isOpen) return;
    const onAim = (event: Event) => {
      const detail = (event as CustomEvent).detail as { x?: number; y?: number } | undefined;
      if (!detail || typeof detail.x !== 'number' || typeof detail.y !== 'number') return;
      const index = ringIndexFromVector(detail.x, detail.y, options.length);
      hoverIndexRef.current = index;
      setGamepadHoverIndex(index);
    };
    const onSelectEvent = () => {
      const index = hoverIndexRef.current;
      if (index === null) return;
      select(options[index].key);
    };
    window.addEventListener(`rts:${name}-radial-aim`, onAim);
    window.addEventListener(`rts:${name}-radial-select`, onSelectEvent);
    return () => {
      window.removeEventListener(`rts:${name}-radial-aim`, onAim);
      window.removeEventListener(`rts:${name}-radial-select`, onSelectEvent);
    };
    // select closes over the latest options/onSelect via the deps below.
  }, [isOpen, name, options, onSelect, autoClose]);

  if (!isOpen || !enabled) return null;

  return (
    <>
      <style>{BEHAVIOR_RADIAL_STYLE}</style>
      <div className="rts-stance-backdrop" onClick={() => setIsOpen(false)}>
        <div className="rts-stance-panel" onClick={(e) => e.stopPropagation()}>
          <div className="rts-stance-header">{header}</div>

          <div className="rts-stance-ring" style={{ width: panelSize, height: panelSize }}>
            {options.map((option, index) => {
              const angle = fullRingAngleDeg(index, options.length) * (Math.PI / 180);
              const x = Math.cos(angle) * ringRadius;
              const y = Math.sin(angle) * ringRadius;
              const active = activeKey === option.key;
              const hovered = gamepadHoverIndex === index;
              return (
                <button
                  key={option.key}
                  className={`rts-stance-node${active ? ' rts-stance-node-active' : ''}${hovered ? ' rts-stance-node-hover' : ''}`}
                  style={{ background: color, transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` }}
                  onClick={() => select(option.key)}
                  title={option.hint}
                >
                  <span className="rts-stance-node-icon">{option.icon}</span>
                  <span className="rts-stance-node-label">{option.label}</span>
                </button>
              );
            })}

            <div className="rts-stance-node rts-stance-center" style={{ background: color, cursor: 'default' }}>
              <span className="rts-stance-center-icon">{centerIcon}</span>
              <span className="rts-stance-center-label">{centerLabel}</span>
            </div>
          </div>

          <div className="rts-stance-footer">{footer}</div>
        </div>
      </div>
    </>
  );
}
