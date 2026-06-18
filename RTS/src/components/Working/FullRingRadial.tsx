import { useEffect, useMemo, useRef, useState } from 'react';
import { fullRingAngleDeg, ringIndexFromVector } from './radialGeometry';
import { BEHAVIOR_RADIAL_STYLE } from './behaviorRadialModel';
import { FORMATION_NODE_DIAMETER } from './formationRadialModel';

/**
 * A reusable selection radial — one ring of option circles around an inert center
 * readout. It owns the open/close lifecycle and the input:
 *   - opens/closes on `rts:toggle-${name}-radial` (keyboard / controller / button),
 *   - broadcasts `rts:${name}-radial-open|close` so the controller hands it the stick,
 *   - the controller streams `rts:${name}-radial-aim` (a stick vector → highlight) and
 *     `rts:${name}-radial-select` (apply the highlight),
 *   - a mouse can click any circle directly.
 * `autoClose` hides the wheel the instant an option is chosen; leaving it false keeps
 * the wheel up for multi-pick. Opening one wheel closes any other (a shared
 * exclusivity event) so only one shows.
 *
 * Two modes:
 *   - Single ring: pass `options` + the single-ring props (the Combat posture radial
 *     keeps its own split-ring layout and does not use this).
 *   - Paged: pass `pages` (>= 1 RadialPage). The wheel renders a tab strip and one
 *     ring per page; LB/RB (controller, via `rts:${name}-radial-page`) and Tab /
 *     Shift+Tab (keyboard) flip pages, and the aim/select stream acts on the active
 *     page. The wheel opens whenever ANY page is enabled, landing on the first enabled
 *     page; a disabled page is shown dimmed and cannot be selected.
 *
 * The parent supplies the option list(s), the live `enabled`/`activeKey`/labels, and
 * the `onSelect` command(s) — this component is purely the picture + the interaction.
 */

export interface RingOption {
  key: string;
  icon: string;
  label: string;
  hint: string;
}

/** One page of a paged radial: its own ring of options, identity, and command. */
export interface RadialPage {
  /** Stable page key (also the tab's React key). */
  key: string;
  /** Short tab label shown in the page strip. */
  tabLabel: string;
  options: readonly RingOption[];
  color: string;
  header: string;
  centerIcon: string;
  centerLabel: string;
  footer: string;
  /** May this page be acted on (e.g. is there a formed team). Disabled pages dim. */
  enabled: boolean;
  /** Option key to mark as the current value on this page, if any. */
  activeKey?: string | null;
  onSelect: (key: string) => void;
}

interface FullRingRadialProps {
  /** Event namespace, e.g. 'directing'. */
  name: string;
  /** Hide the moment an option is selected. */
  autoClose: boolean;
  // --- Single-ring mode (ignored when `pages` is provided) ---
  options?: readonly RingOption[];
  /** Circle background color (the wheel's identity hue). */
  color?: string;
  header?: string;
  centerIcon?: string;
  centerLabel?: string;
  footer?: string;
  /** May the wheel open / stay open (e.g. is there a valid selection). */
  enabled?: boolean;
  /** Option key to mark as the current value, if any. */
  activeKey?: string | null;
  onSelect?: (key: string) => void;
  // --- Paged mode ---
  pages?: readonly RadialPage[];
}

// Tab-strip styling, namespaced (rts-radial-tab*) to dodge the global-CSS class
// collisions Vite's concatenated sheet is prone to. Injected with the reused
// posture-radial style below.
const RADIAL_TAB_STYLE = `
.rts-radial-tabs {
  display: flex; gap: 8px; margin-bottom: 10px; justify-content: center; flex-wrap: wrap;
}
.rts-radial-tab {
  background: rgba(17,23,38,0.9); border: 1px solid rgba(129,160,255,0.45);
  border-radius: 8px; padding: 5px 12px; color: #cbd5e1;
  font-family: monospace; font-size: 12px; font-weight: 600; cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.rts-radial-tab:hover { border-color: rgba(129,160,255,0.9); background: rgba(28,38,64,0.92); }
.rts-radial-tab-active { color: #fff; background: rgba(40,54,92,0.95); border-color: #fff; }
.rts-radial-tab-disabled { opacity: 0.45; }
`;

export function FullRingRadial({
  name,
  autoClose,
  options,
  color,
  header,
  centerIcon,
  centerLabel,
  footer,
  enabled,
  activeKey,
  onSelect,
  pages,
}: FullRingRadialProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [gamepadHoverIndex, setGamepadHoverIndex] = useState<number | null>(null);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const hoverIndexRef = useRef<number | null>(null);

  const paged = !!pages && pages.length > 0;

  // The currently-displayed page (paged) or the single-ring props folded into the
  // same shape, so the render and the input handlers read one `view` either way.
  const view = useMemo(() => {
    if (paged) {
      const index = Math.min(activePageIndex, pages!.length - 1);
      return pages![index];
    }
    return {
      key: '_single',
      tabLabel: '',
      options: options ?? [],
      color: color ?? '#0e9f6e',
      header: header ?? '',
      centerIcon: centerIcon ?? '',
      centerLabel: centerLabel ?? '',
      footer: footer ?? '',
      enabled: enabled ?? false,
      activeKey,
      onSelect: onSelect ?? (() => {}),
    } satisfies RadialPage;
  }, [paged, pages, activePageIndex, options, color, header, centerIcon, centerLabel, footer, enabled, activeKey, onSelect]);

  // The wheel may open while ANY page (paged) / the single ring is enabled.
  const anyEnabled = paged ? pages!.some((page) => page.enabled) : (enabled ?? false);

  // Ring radius derived from the active page's option count so N circles always clear.
  const ringRadius = useMemo(() => {
    const slots = Math.max(view.options.length, 3);
    return (FORMATION_NODE_DIAMETER + 16) / (2 * Math.sin(Math.PI / slots));
  }, [view.options.length]);
  const panelSize = 2 * (ringRadius + FORMATION_NODE_DIAMETER / 2) + 24;

  const select = (key: string) => {
    if (!view.enabled) return; // a dimmed page cannot be acted on
    view.onSelect(key);
    if (autoClose) setIsOpen(false);
  };

  // Close automatically the moment there is nothing valid to act on anywhere.
  useEffect(() => {
    if (!anyEnabled && isOpen) setIsOpen(false);
  }, [anyEnabled, isOpen]);

  // Toggle on this wheel's shared event (keyboard binding, controller D-pad, or the
  // on-screen button all dispatch it). Ignored when nothing is enabled.
  useEffect(() => {
    const onToggle = () => {
      if (!anyEnabled) return;
      setIsOpen((prev) => !prev);
    };
    window.addEventListener(`rts:toggle-${name}-radial`, onToggle);
    return () => window.removeEventListener(`rts:toggle-${name}-radial`, onToggle);
  }, [name, anyEnabled]);

  // On open, land on the first enabled page so the wheel never opens to a dimmed one.
  useEffect(() => {
    if (!isOpen || !paged) return;
    if (pages![activePageIndex]?.enabled) return;
    const firstEnabled = pages!.findIndex((page) => page.enabled);
    if (firstEnabled >= 0) setActivePageIndex(firstEnabled);
    // Only re-evaluate when the open state flips; mid-session enable changes are
    // handled by the close-when-disabled effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

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

  // Reset the stick highlight whenever the page changes so a stale index from the
  // previous (differently-sized) ring can't linger.
  useEffect(() => {
    hoverIndexRef.current = null;
    setGamepadHoverIndex(null);
  }, [activePageIndex]);

  // Page flipping (paged only): LB/RB stream `rts:${name}-radial-page` {dir}; Tab /
  // Shift+Tab do the same on the keyboard. Cycles through every page (wrapping).
  useEffect(() => {
    if (!isOpen || !paged) return;
    const flip = (dir: number) => {
      setActivePageIndex((prev) => (prev + dir + pages!.length) % pages!.length);
    };
    const onPage = (event: Event) => {
      const dir = (event as CustomEvent).detail?.dir as number | undefined;
      if (dir === 1 || dir === -1) flip(dir);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      flip(event.shiftKey ? -1 : 1);
    };
    window.addEventListener(`rts:${name}-radial-page`, onPage);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(`rts:${name}-radial-page`, onPage);
      window.removeEventListener('keydown', onKey);
    };
  }, [isOpen, paged, name, pages]);

  // Controller stick selection while open: the right stick streams an aim vector
  // (highlight the addressed option), the select event applies it.
  useEffect(() => {
    if (!isOpen) return;
    const onAim = (event: Event) => {
      const detail = (event as CustomEvent).detail as { x?: number; y?: number } | undefined;
      if (!detail || typeof detail.x !== 'number' || typeof detail.y !== 'number') return;
      const index = ringIndexFromVector(detail.x, detail.y, view.options.length);
      hoverIndexRef.current = index;
      setGamepadHoverIndex(index);
    };
    const onSelectEvent = () => {
      const index = hoverIndexRef.current;
      if (index === null) return;
      select(view.options[index].key);
    };
    window.addEventListener(`rts:${name}-radial-aim`, onAim);
    window.addEventListener(`rts:${name}-radial-select`, onSelectEvent);
    return () => {
      window.removeEventListener(`rts:${name}-radial-aim`, onAim);
      window.removeEventListener(`rts:${name}-radial-select`, onSelectEvent);
    };
    // select closes over the active page's options/onSelect via the deps below.
  }, [isOpen, name, view, autoClose]);

  if (!isOpen || !anyEnabled) return null;

  const dimmed = !view.enabled;

  return (
    <>
      <style>{BEHAVIOR_RADIAL_STYLE}</style>
      <style>{RADIAL_TAB_STYLE}</style>
      <div className="rts-stance-backdrop" onClick={() => setIsOpen(false)}>
        <div className="rts-stance-panel" onClick={(e) => e.stopPropagation()}>
          {paged && (
            <div className="rts-radial-tabs">
              {pages!.map((page, index) => (
                <button
                  key={page.key}
                  className={`rts-radial-tab${index === activePageIndex ? ' rts-radial-tab-active' : ''}${page.enabled ? '' : ' rts-radial-tab-disabled'}`}
                  onClick={() => setActivePageIndex(index)}
                >
                  {page.tabLabel}
                </button>
              ))}
            </div>
          )}

          <div className="rts-stance-header">{view.header}</div>

          <div className="rts-stance-ring" style={{ width: panelSize, height: panelSize }}>
            {view.options.map((option, index) => {
              const angle = fullRingAngleDeg(index, view.options.length) * (Math.PI / 180);
              const x = Math.cos(angle) * ringRadius;
              const y = Math.sin(angle) * ringRadius;
              const active = view.activeKey === option.key;
              const hovered = gamepadHoverIndex === index;
              return (
                <button
                  key={option.key}
                  className={`rts-stance-node${active ? ' rts-stance-node-active' : ''}${hovered ? ' rts-stance-node-hover' : ''}`}
                  style={{ background: view.color, opacity: dimmed ? 0.45 : 1, transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` }}
                  onClick={() => select(option.key)}
                  disabled={dimmed}
                  title={option.hint}
                >
                  <span className="rts-stance-node-icon">{option.icon}</span>
                  <span className="rts-stance-node-label">{option.label}</span>
                </button>
              );
            })}

            <div className="rts-stance-node rts-stance-center" style={{ background: view.color, cursor: 'default' }}>
              <span className="rts-stance-center-icon">{view.centerIcon}</span>
              <span className="rts-stance-center-label">{view.centerLabel}</span>
            </div>
          </div>

          <div className="rts-stance-footer">{view.footer}</div>
        </div>
      </div>
    </>
  );
}
