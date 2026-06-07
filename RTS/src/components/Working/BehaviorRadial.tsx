import { useEffect, useMemo, useState } from 'react';
import { useGameStore } from '../../game/state';
import type { FireMode, TargetPriority, Unit, UnitStance } from '../../game/types';
import { behaviorOf } from './unitBehavior';

/**
 * The selection radial for the combat-posture system. It drives the deterministic
 * `setBehavior` command (see state.ts / unitBehavior.ts), letting the player set
 * the three composable axes of a selection's behavior:
 *   - stance: the main ring (how far it commits)
 *   - fire:   the center toggle (weapons-free vs hold-fire)
 *   - priority: the chip row (what it targets first)
 *
 * Opens on the `b` key or the on-screen button while own, commandable units are
 * selected. Only the five combat stances are offered here; the positional stances
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

// Ordered for the ring (placed clockwise from the top).
const STANCE_OPTIONS: StanceOption[] = [
  { stance: 'aggressive', icon: '⚔️', label: 'Aggressive', hint: 'Hunt & chase enemies in vision' },
  { stance: 'skirmish', icon: '🏹', label: 'Skirmish', hint: 'Kite — fight at range, back off when closed on' },
  { stance: 'holdGround', icon: '🚩', label: 'Hold Ground', hint: 'Attack only what is in range; never move' },
  { stance: 'defensive', icon: '🛡️', label: 'Defensive', hint: 'Engage within a leash, then return home' },
  { stance: 'flee', icon: '🏃', label: 'Flee', hint: 'Never engage; retreat toward home' },
];

interface PriorityOption {
  priority: TargetPriority;
  label: string;
  hint: string;
}

const PRIORITY_OPTIONS: PriorityOption[] = [
  { priority: 'nearest', label: 'Nearest', hint: 'Closest enemy first' },
  { priority: 'lowestHp', label: 'Weakest', hint: 'Finish the lowest-HP enemy' },
  { priority: 'highestThreat', label: 'Threat', hint: 'Highest damage-per-second first' },
  { priority: 'ranged', label: 'Ranged', hint: 'Longest-reach enemy first' },
  { priority: 'monarch', label: 'Royalty', hint: 'Kings, Queens, and Bases first' },
];

const RING_RADIUS = 116; // px from the center to each stance button
const PANEL_SIZE = 360; // px square the ring lives in

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

  const [isOpen, setIsOpen] = useState(false);

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

  // `b` toggles the radial. Ignored while typing in a field and when no own units
  // are selected, so it never fights text entry or fires on an empty selection.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'b' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      if (commandableIds.length === 0) return;
      event.preventDefault();
      setIsOpen((prev) => !prev);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commandableIds.length]);

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
          title="Set combat posture for the selection (B)"
        >
          <span className="rts-stance-trigger-icon">
            {STANCE_OPTIONS.find((o) => o.stance === currentStance)?.icon ?? '⚔️'}
          </span>
          <span>
            Stance: {currentStance ? labelFor(currentStance) : 'Mixed'}
            <span className="rts-stance-trigger-key"> · B</span>
          </span>
        </button>
      )}

      {isOpen && commandable.length > 0 && (
        // Backdrop closes the radial on an outside click.
        <div className="rts-stance-backdrop" onClick={() => setIsOpen(false)}>
          <div className="rts-stance-panel" onClick={(e) => e.stopPropagation()}>
            <div className="rts-stance-header">
              Posture · {commandable.length} unit{commandable.length === 1 ? '' : 's'}
            </div>

            {/* Stance ring with the fire toggle at its center. */}
            <div className="rts-stance-ring" style={{ width: PANEL_SIZE, height: PANEL_SIZE }}>
              {STANCE_OPTIONS.map((option, index) => {
                const angle = (-90 + index * (360 / STANCE_OPTIONS.length)) * (Math.PI / 180);
                const x = Math.cos(angle) * RING_RADIUS;
                const y = Math.sin(angle) * RING_RADIUS;
                const active = currentStance === option.stance;
                return (
                  <button
                    key={option.stance}
                    className={`rts-stance-wedge${active ? ' rts-stance-wedge-active' : ''}`}
                    style={{ transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` }}
                    onClick={() => applyStance(option.stance)}
                    title={option.hint}
                  >
                    <span className="rts-stance-wedge-icon">{option.icon}</span>
                    <span className="rts-stance-wedge-label">{option.label}</span>
                  </button>
                );
              })}

              <button
                className={`rts-stance-center${fireIsFree ? ' rts-stance-center-free' : ''}`}
                onClick={() => applyFire(effectiveFire === 'free' ? 'hold' : 'free')}
                title="Toggle weapons-free / hold-fire"
              >
                <span className="rts-stance-center-icon">{fireIsFree ? '🔥' : '✋'}</span>
                <span className="rts-stance-center-label">
                  {currentFire === null ? 'Mixed' : fireIsFree ? 'Weapons Free' : 'Hold Fire'}
                </span>
              </button>
            </div>

            {/* Target priority chips. */}
            <div className="rts-stance-priority-label">Target priority</div>
            <div className="rts-stance-priority-row">
              {PRIORITY_OPTIONS.map((option) => (
                <button
                  key={option.priority}
                  className={`rts-stance-chip${currentPriority === option.priority ? ' rts-stance-chip-active' : ''}`}
                  onClick={() => applyPriority(option.priority)}
                  title={option.hint}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="rts-stance-footer">Click outside or press B to close</div>
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

.rts-stance-backdrop {
  position: fixed; inset: 0; z-index: 1100; display: flex;
  align-items: center; justify-content: center; background: rgba(4,8,18,0.45);
  backdrop-filter: blur(2px);
}
.rts-stance-panel {
  display: flex; flex-direction: column; align-items: center;
  background: rgba(13,18,32,0.94); border: 1px solid rgba(88,120,255,0.4);
  border-radius: 16px; padding: 18px 22px 16px; color: #e2e8f0;
  font-family: monospace; box-shadow: 0 12px 48px rgba(0,0,0,0.5);
}
.rts-stance-header { font-size: 13px; color: #94a3b8; letter-spacing: 0.5px; margin-bottom: 6px; }

.rts-stance-ring { position: relative; }
.rts-stance-wedge {
  position: absolute; top: 50%; left: 50%; width: 96px; height: 76px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  background: rgba(24,32,52,0.92); border: 1px solid rgba(88,120,255,0.35);
  border-radius: 12px; color: #cbd5e1; cursor: pointer;
  transition: transform 0.1s, border-color 0.15s, background 0.15s, color 0.15s;
}
.rts-stance-wedge:hover { background: rgba(40,52,84,0.98); border-color: rgba(129,160,255,0.9); color: #fff; }
.rts-stance-wedge-active {
  background: rgba(37,99,235,0.9); border-color: #93c5fd; color: #fff;
  box-shadow: 0 0 0 2px rgba(147,197,253,0.4);
}
.rts-stance-wedge-icon { font-size: 22px; line-height: 1; }
.rts-stance-wedge-label { font-size: 11px; font-weight: bold; }

.rts-stance-center {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 104px; height: 104px; border-radius: 50%;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  background: rgba(30,18,18,0.95); border: 2px solid rgba(248,113,113,0.6);
  color: #fca5a5; cursor: pointer; transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.rts-stance-center:hover { border-color: rgba(248,113,113,0.95); }
.rts-stance-center-free { background: rgba(34,24,12,0.95); border-color: rgba(251,146,60,0.75); color: #fdba74; }
.rts-stance-center-icon { font-size: 26px; line-height: 1; }
.rts-stance-center-label { font-size: 10px; font-weight: bold; text-align: center; }

.rts-stance-priority-label { margin-top: 14px; font-size: 11px; color: #94a3b8; }
.rts-stance-priority-row { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 6px; max-width: 360px; }
.rts-stance-chip {
  background: rgba(24,32,52,0.92); border: 1px solid rgba(88,120,255,0.35);
  border-radius: 999px; padding: 5px 12px; color: #cbd5e1; cursor: pointer;
  font-family: monospace; font-size: 12px; transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.rts-stance-chip:hover { background: rgba(40,52,84,0.98); border-color: rgba(129,160,255,0.9); color: #fff; }
.rts-stance-chip-active { background: rgba(37,99,235,0.9); border-color: #93c5fd; color: #fff; }

.rts-stance-footer { margin-top: 14px; font-size: 10px; color: #64748b; }
`;
