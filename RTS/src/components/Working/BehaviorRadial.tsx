import { useEffect, useMemo, useRef, useState } from 'react';
import { useGameStore } from '../../game/state';
import type { FireMode, TargetPriority, Unit, UnitStance } from '../../game/types';
import { behaviorOf } from './unitBehavior';
import { formatKeyboardToken } from './controlBindings';
import { type RadialHover, halfWedgeDeg, hoverFromVector } from './radialGeometry';

/**
 * The selection radial for the combat-posture system. It drives the deterministic
 * `setBehavior` command (see state.ts / unitBehavior.ts), letting the player set
 * the three composable axes of a selection's behavior with two concentric rings
 * around a central toggle:
 *   - fire:     the center toggle (weapons-free vs hold-fire)
 *   - stance:   the INNER ring of posture circles (how far it commits)
 *   - priority: the OUTER ring of target-priority circles (what it targets first)
 *
 * Opens on the `b` key / R3 / the on-screen button while own, commandable units are
 * selected. With a controller the right stick aims: its deflection MAGNITUDE picks
 * the ring (at rest = the center fire toggle, a half-push = the posture ring, a
 * full push = the priority ring) and its ANGLE picks the wedge in that ring. RT
 * applies the highlighted option and the radial stays open so all three axes can be
 * set in one visit; B closes it. A mouse can also click any circle directly.
 *
 * Only the five combat stances are offered here; the positional stances
 * (patrol/guard/escort) need a target-placement gesture that is not built yet, so
 * they are deliberately omitted rather than shown as no-ops.
 *
 * Class names are prefixed `rts-stance-` because Vite concatenates every
 * component's CSS into one global sheet — generic names would collide across
 * components (see the rts-css-class-collision-trap memory).
 */

interface StanceOption {
  stance: UnitStance;
  icon: string;
  label: string;
  hint: string;
  color: string; // vibrant fill, always visible so the option is identifiable at a glance
}

// Ordered for the inner ring (placed clockwise from the top). Each stance carries a
// distinct vibrant color so the option reads by color even before it is selected.
const STANCE_OPTIONS: StanceOption[] = [
  { stance: 'aggressive', icon: '⚔️', label: 'Aggressive', hint: 'Hunt & chase enemies in vision', color: '#ef4444' },
  { stance: 'skirmish', icon: '🏹', label: 'Skirmish', hint: 'Kite — fight at range, back off when closed on', color: '#f97316' },
  { stance: 'holdGround', icon: '🚩', label: 'Hold Ground', hint: 'Attack only what is in range; never move', color: '#eab308' },
  { stance: 'defensive', icon: '🛡️', label: 'Defensive', hint: 'Engage within a leash, then return home', color: '#3b82f6' },
  { stance: 'flee', icon: '🏃', label: 'Flee', hint: 'Never engage; retreat toward home', color: '#22c55e' },
];

interface PriorityOption {
  priority: TargetPriority;
  icon: string;
  label: string;
  hint: string;
  color: string; // vibrant fill, always visible (kept in a different hue family from the stances)
}

// Ordered for the outer ring (placed clockwise from the top). Priority colors sit
// in a different part of the wheel than the stance colors so the two rings stay
// distinguishable while every individual option still has its own color.
const PRIORITY_OPTIONS: PriorityOption[] = [
  { priority: 'nearest', icon: '📍', label: 'Nearest', hint: 'Closest enemy first', color: '#06b6d4' },
  { priority: 'lowestHp', icon: '🩸', label: 'Weakest', hint: 'Finish the lowest-HP enemy', color: '#ec4899' },
  { priority: 'highestThreat', icon: '💥', label: 'Threat', hint: 'Highest damage-per-second first', color: '#a855f7' },
  { priority: 'ranged', icon: '🎯', label: 'Ranged', hint: 'Longest-reach enemy first', color: '#6366f1' },
  { priority: 'monarch', icon: '👑', label: 'Royalty', hint: 'Kings, Queens, and Bases first', color: '#14b8a6' },
];

// The fire-mode toggle's always-visible color (a fiery red-orange, matching its 🔥).
const FIRE_COLOR = '#fb5607';

// Circle sizes (kept in sync with the CSS below) so the ring radii can be derived
// rather than hand-tuned — keeping the no-overlap guarantees as the sizes change.
const NODE_DIAMETER = 76; // each posture / priority option circle
const CENTER_DIAMETER = NODE_DIAMETER; // the fire-mode toggle is the same size as an option
const RADIAL_GAP = 10; // clear gap between the center toggle and the inner ring (kept tight for a compact radial)

// The outer (priority) ring is rotated by this half-wedge so each priority circle
// sits in the gap between two posture circles instead of directly outside one.
const PRIORITY_OFFSET_DEG = halfWedgeDeg(PRIORITY_OPTIONS.length);

// Inner ring radius: the center toggle's edge plus RADIAL_GAP plus a circle radius.
const INNER_RADIUS = CENTER_DIAMETER / 2 + RADIAL_GAP + NODE_DIAMETER / 2; // 86

// Outer ring radius: pulled in as close to the center as possible. Because the
// priority circles are STAGGERED into the posture gaps, the binding constraint is
// not a radial edge gap but the DIAGONAL distance to the nearest posture circle
// (which sits PRIORITY_OFFSET_DEG away). Solve the law of cosines for the smallest
// OUTER_RADIUS whose priority circle still clears that posture circle by
// STAGGER_CLEARANCE — letting the outer ring nest tightly without touching the
// inner ring. (Assumes both rings hold the same option count, which they do.)
const STAGGER_CLEARANCE = 14; // px between a priority circle and its nearest posture circle
const STAGGER_SEP_RAD = (PRIORITY_OFFSET_DEG * Math.PI) / 180;
const OUTER_RADIUS =
  INNER_RADIUS * Math.cos(STAGGER_SEP_RAD) +
  Math.sqrt((NODE_DIAMETER + STAGGER_CLEARANCE) ** 2 - (INNER_RADIUS * Math.sin(STAGGER_SEP_RAD)) ** 2);

const PANEL_SIZE = 2 * (OUTER_RADIUS + NODE_DIAMETER / 2) + 24; // fits the outer ring + margin

// Returns the single shared value across the list, or null when they disagree
// ("mixed" — shown so the player knows the selection is not uniform).
function uniform<T>(values: T[]): T | null {
  if (values.length === 0) return null;
  const first = values[0];
  return values.every((v) => v === first) ? first : null;
}

export function BehaviorRadial() {
  const matchStarted = useGameStore((s) => s.matchStarted);
  const units = useGameStore((s) => s.units);
  const selectedUnitIds = useGameStore((s) => s.selectedUnitIds);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const setBehavior = useGameStore((s) => s.setBehavior);
  const keyboardBindings = useGameStore((s) => s.keyboardBindings);

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
  // their own movable units (Bases have no behavior). Recomputed from the live
  // `units`/`selectedUnitIds` so highlights track command results.
  const commandable = useMemo<Unit[]>(() => {
    const selected = new Set(selectedUnitIds);
    return units.filter((u) => selected.has(u.id) && u.ownerId === localPlayerId && u.kind !== 'Base');
  }, [units, selectedUnitIds, localPlayerId]);

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
    if (!isOpen) {
      hoverRef.current = null;
      setGamepadHover(null);
    }
  }, [isOpen]);

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
      <style>{STYLE}</style>

      {/* Collapsed trigger: shown only when there is a commandable selection. */}
      {!isOpen && commandable.length > 0 && (
        <button
          className="rts-stance-trigger"
          onClick={() => setIsOpen(true)}
          title={`Set combat posture for the selection${triggerKeyLabel ? ` (${triggerKeyLabel})` : ''}`}
        >
          <span className="rts-stance-trigger-icon">
            {STANCE_OPTIONS.find((o) => o.stance === currentStance)?.icon ?? '⚔️'}
          </span>
          <span>
            Stance: {currentStance ? labelFor(currentStance) : 'Mixed'}
            {triggerKeyLabel && <span className="rts-stance-trigger-key"> · {triggerKeyLabel}</span>}
          </span>
        </button>
      )}

      {isOpen && commandable.length > 0 && (
        // Backdrop closes the radial on an outside click.
        <div className="rts-stance-backdrop" onClick={() => setIsOpen(false)}>
          <div className="rts-stance-panel" onClick={(e) => e.stopPropagation()}>
            <div className="rts-stance-header">
              Combat Posture · {commandable.length} unit{commandable.length === 1 ? '' : 's'}
            </div>

            {/* Two concentric rings (posture inner, priority outer) around the fire toggle. */}
            <div className="rts-stance-ring" style={{ width: PANEL_SIZE, height: PANEL_SIZE }}>
              {/* Outer ring: target priority — staggered a half-wedge so each
                  circle nests in the gap between two posture circles. */}
              {PRIORITY_OPTIONS.map((option, index) => {
                const angle = (-90 + PRIORITY_OFFSET_DEG + index * (360 / PRIORITY_OPTIONS.length)) * (Math.PI / 180);
                const x = Math.cos(angle) * OUTER_RADIUS;
                const y = Math.sin(angle) * OUTER_RADIUS;
                const active = currentPriority === option.priority;
                const hovered = gamepadHover?.ring === 'priority' && gamepadHover.index === index;
                return (
                  <button
                    key={option.priority}
                    className={`rts-stance-node${active ? ' rts-stance-node-active' : ''}${hovered ? ' rts-stance-node-hover' : ''}`}
                    style={{ background: option.color, transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` }}
                    onClick={() => applyPriority(option.priority)}
                    title={option.hint}
                  >
                    <span className="rts-stance-node-icon">{option.icon}</span>
                    <span className="rts-stance-node-label">{option.label}</span>
                  </button>
                );
              })}

              {/* Inner ring: posture. */}
              {STANCE_OPTIONS.map((option, index) => {
                const angle = (-90 + index * (360 / STANCE_OPTIONS.length)) * (Math.PI / 180);
                const x = Math.cos(angle) * INNER_RADIUS;
                const y = Math.sin(angle) * INNER_RADIUS;
                const active = currentStance === option.stance;
                const hovered = gamepadHover?.ring === 'posture' && gamepadHover.index === index;
                return (
                  <button
                    key={option.stance}
                    className={`rts-stance-node${active ? ' rts-stance-node-active' : ''}${hovered ? ' rts-stance-node-hover' : ''}`}
                    style={{ background: option.color, transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` }}
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
              Aim the right stick (center = fire · inner = posture · outer = priority) and press
              <span className="rts-stance-key"> RT</span> to set · <span className="rts-stance-key">B</span> to close ·
              or click a circle{triggerKeyLabel ? ` / press ${triggerKeyLabel}` : ''}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function labelFor(stance: UnitStance): string {
  return STANCE_OPTIONS.find((o) => o.stance === stance)?.label ?? stance;
}

const STYLE = `
.rts-stance-trigger {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  z-index: 1000; display: flex; align-items: center; gap: 8px;
  background: rgba(17,23,38,0.88); border: 1px solid rgba(88,120,255,0.5);
  border-radius: 10px; padding: 8px 14px; color: #e2e8f0;
  font-family: monospace; font-size: 13px; cursor: pointer;
  backdrop-filter: blur(10px); transition: border-color 0.15s, background 0.15s;
}
.rts-stance-trigger:hover { border-color: rgba(129,160,255,0.95); background: rgba(28,38,64,0.92); }
.rts-stance-trigger-icon { font-size: 16px; }
.rts-stance-trigger-key { color: #64748b; }

/* Full-screen click-catcher that closes the radial on an outside click. It is
   intentionally transparent (no dim, no blur) so the battlefield stays visible
   behind the floating rings while the radial is open. */
.rts-stance-backdrop {
  position: fixed; inset: 0; z-index: 1100; display: flex;
  align-items: center; justify-content: center; background: transparent;
}
/* No card: a transparent layout container so only the rings float on the scene. */
.rts-stance-panel {
  display: flex; flex-direction: column; align-items: center;
  padding: 0; color: #e2e8f0; font-family: monospace;
}
.rts-stance-header {
  font-size: 13px; color: #e2e8f0; letter-spacing: 0.5px; margin-bottom: 8px;
  text-shadow: 0 1px 4px rgba(0,0,0,0.95);
}

.rts-stance-ring { position: relative; }

/* Every option circle — fire toggle, posture, and priority — carries its OWN
   vibrant background (set inline per option) so its color is always visible, even
   before it is selected. The white text/icon + shadows keep the label legible on
   any hue floating directly over the battlefield (no backing card). The subtle
   light rim gives each colored circle definition against the scene. */
.rts-stance-node {
  position: absolute; top: 50%; left: 50%; width: 76px; height: 76px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
  border-radius: 50%; cursor: pointer; color: #fff;
  border: 2px solid rgba(255,255,255,0.4);
  box-shadow: 0 3px 12px rgba(0,0,0,0.6);
  transition: transform 0.1s, border-color 0.15s, filter 0.15s, box-shadow 0.15s;
}
/* Mouse hover brightens the circle (a background change can't win over the inline
   per-option color, so use a filter instead). */
.rts-stance-node:hover { filter: brightness(1.18); border-color: rgba(255,255,255,0.85); }
.rts-stance-node-icon { font-size: 22px; line-height: 1; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.9)); }
.rts-stance-node-label { font-size: 10px; font-weight: bold; text-align: center; text-shadow: 0 1px 3px rgba(0,0,0,0.95); }

/* Selected value on an axis: keep the option's own color, mark it with a crisp
   white ring + glow so "the current choice" reads without hiding the hue. */
.rts-stance-node-active {
  border-color: #fff;
  box-shadow: 0 0 0 3px rgba(255,255,255,0.95), 0 3px 14px rgba(0,0,0,0.6);
}

/* Controller right-stick aim highlight: a yellow ring with a dark separator so it
   stays visible on top of any option color (and distinct from the white selected
   ring). Listed last so it wins over the selected ring when both apply. */
.rts-stance-node-hover {
  border-color: #0b1020 !important;
  box-shadow: 0 0 0 3px #fde047, 0 0 0 6px rgba(0,0,0,0.55), 0 3px 14px rgba(0,0,0,0.6);
}

/* The center fire toggle is the same size as the option circles and inherits the
   shared circle background from .rts-stance-node above; it only needs its own
   centering transform (ring nodes get an inline transform; the center does not). */
.rts-stance-center {
  transform: translate(-50%, -50%);
}
.rts-stance-center-icon { font-size: 22px; line-height: 1; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.9)); }
.rts-stance-center-label { font-size: 9px; font-weight: bold; text-align: center; text-shadow: 0 1px 3px rgba(0,0,0,0.95); }

.rts-stance-footer {
  margin-top: 12px; font-size: 11px; color: #cbd5e1; text-align: center; max-width: 460px;
  text-shadow: 0 1px 4px rgba(0,0,0,0.95);
}
.rts-stance-key {
  display: inline-block; background: rgba(15,23,42,0.92); border: 1px solid rgba(203,213,225,0.7);
  border-radius: 5px; padding: 0 5px; color: #fff; font-weight: bold;
}
`;
