import { useEffect, useMemo, useRef, useState } from 'react';
import { useGameStore } from '../../game/state';
import type { FireMode, TargetPriority, Unit, UnitStance } from '../../game/types';
import { behaviorOf } from './unitBehavior';
import { formatKeyboardToken } from './controlBindings';
import { type RadialHover, hoverFromVector } from './radialGeometry';

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
}

// Ordered for the inner ring (placed clockwise from the top).
const STANCE_OPTIONS: StanceOption[] = [
  { stance: 'aggressive', icon: '⚔️', label: 'Aggressive', hint: 'Hunt & chase enemies in vision' },
  { stance: 'skirmish', icon: '🏹', label: 'Skirmish', hint: 'Kite — fight at range, back off when closed on' },
  { stance: 'holdGround', icon: '🚩', label: 'Hold Ground', hint: 'Attack only what is in range; never move' },
  { stance: 'defensive', icon: '🛡️', label: 'Defensive', hint: 'Engage within a leash, then return home' },
  { stance: 'flee', icon: '🏃', label: 'Flee', hint: 'Never engage; retreat toward home' },
];

interface PriorityOption {
  priority: TargetPriority;
  icon: string;
  label: string;
  hint: string;
}

// Ordered for the outer ring (placed clockwise from the top).
const PRIORITY_OPTIONS: PriorityOption[] = [
  { priority: 'nearest', icon: '📍', label: 'Nearest', hint: 'Closest enemy first' },
  { priority: 'lowestHp', icon: '🩸', label: 'Weakest', hint: 'Finish the lowest-HP enemy' },
  { priority: 'highestThreat', icon: '💥', label: 'Threat', hint: 'Highest damage-per-second first' },
  { priority: 'ranged', icon: '🎯', label: 'Ranged', hint: 'Longest-reach enemy first' },
  { priority: 'monarch', icon: '👑', label: 'Royalty', hint: 'Kings, Queens, and Bases first' },
];

// Circle sizes (kept in sync with the CSS below) so the ring radii can be derived
// for equal radial gaps and guaranteed no overlap between the center toggle, the
// inner ring, and the outer ring.
const NODE_DIAMETER = 76; // each posture / priority option circle
const CENTER_DIAMETER = 104; // the fire-mode toggle in the middle
const RADIAL_GAP = 22; // equal clear gap between center→inner and inner→outer edges

// Derived so every gap between consecutive ring edges is exactly RADIAL_GAP:
//   inner edge of inner ring = CENTER_DIAMETER/2 + RADIAL_GAP + NODE_DIAMETER/2
//   inner edge of outer ring = (inner ring outer edge) + RADIAL_GAP + NODE_DIAMETER/2
const INNER_RADIUS = CENTER_DIAMETER / 2 + RADIAL_GAP + NODE_DIAMETER / 2; // 112
const OUTER_RADIUS = INNER_RADIUS + NODE_DIAMETER + RADIAL_GAP; // 210
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
              {/* Outer ring: target priority. */}
              {PRIORITY_OPTIONS.map((option, index) => {
                const angle = (-90 + index * (360 / PRIORITY_OPTIONS.length)) * (Math.PI / 180);
                const x = Math.cos(angle) * OUTER_RADIUS;
                const y = Math.sin(angle) * OUTER_RADIUS;
                const active = currentPriority === option.priority;
                const hovered = gamepadHover?.ring === 'priority' && gamepadHover.index === index;
                return (
                  <button
                    key={option.priority}
                    className={`rts-stance-node${active ? ' rts-stance-node-active' : ''}${hovered ? ' rts-stance-node-hover' : ''}`}
                    style={{ transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` }}
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
                    style={{ transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` }}
                    onClick={() => applyStance(option.stance)}
                    title={option.hint}
                  >
                    <span className="rts-stance-node-icon">{option.icon}</span>
                    <span className="rts-stance-node-label">{option.label}</span>
                  </button>
                );
              })}

              {/* Center: weapons-free / hold-fire toggle. Shares the option circles'
                  background; its state is read from the icon + label, not color. */}
              <button
                className={`rts-stance-node rts-stance-center${gamepadHover?.ring === 'fire' ? ' rts-stance-node-hover' : ''}`}
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

/* One shared circle for every option — fire toggle, posture, and priority all use
   the SAME background so color never signals which type an option is (the ring it
   sits in does). The opaque fill + drop shadow + text shadow keep each circle and
   its label legible floating directly over the battlefield (no backing card). */
.rts-stance-node {
  position: absolute; top: 50%; left: 50%; width: 76px; height: 76px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
  border-radius: 50%; cursor: pointer; color: #e2e8f0;
  background: rgba(15,23,42,0.92); border: 1px solid rgba(148,163,184,0.55);
  box-shadow: 0 3px 12px rgba(0,0,0,0.6);
  transition: transform 0.1s, border-color 0.15s, background 0.15s, color 0.15s, box-shadow 0.15s;
}
.rts-stance-node:hover { background: rgba(30,41,66,0.96); border-color: rgba(203,213,225,0.9); color: #fff; }
.rts-stance-node-icon { font-size: 22px; line-height: 1; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.9)); }
.rts-stance-node-label { font-size: 10px; font-weight: bold; text-align: center; text-shadow: 0 1px 3px rgba(0,0,0,0.95); }

/* Selected value on an axis: a single accent fill, shared by all three types so
   the accent reads as "this is the current choice", not as a type color. */
.rts-stance-node-active {
  background: rgba(37,99,235,0.92); border-color: #93c5fd; color: #fff;
}

/* Controller right-stick aim highlight (distinct from the selected-state fill). */
.rts-stance-node-hover {
  border-color: #fde047 !important; color: #fff;
  box-shadow: 0 0 0 3px rgba(253,224,71,0.65), 0 3px 12px rgba(0,0,0,0.6);
}

/* The center fire toggle is only larger; it inherits the shared circle background
   from .rts-stance-node above. Listed after it so the size/position win. */
.rts-stance-center {
  width: 104px; height: 104px;
  transform: translate(-50%, -50%); gap: 4px;
}
.rts-stance-center-icon { font-size: 30px; line-height: 1; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.9)); }
.rts-stance-center-label { font-size: 11px; font-weight: bold; text-align: center; text-shadow: 0 1px 3px rgba(0,0,0,0.95); }

.rts-stance-footer {
  margin-top: 12px; font-size: 11px; color: #cbd5e1; text-align: center; max-width: 460px;
  text-shadow: 0 1px 4px rgba(0,0,0,0.95);
}
.rts-stance-key {
  display: inline-block; background: rgba(15,23,42,0.92); border: 1px solid rgba(203,213,225,0.7);
  border-radius: 5px; padding: 0 5px; color: #fff; font-weight: bold;
}
`;
