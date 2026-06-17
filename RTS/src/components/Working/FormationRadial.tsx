import { useEffect, useMemo, useRef, useState } from 'react';
import { useGameStore } from '../../game/state';
import type { FormationShape, Unit } from '../../game/types';
import { formatKeyboardToken } from './controlBindings';
import { fullRingAngleDeg, ringIndexFromVector } from './radialGeometry';
import { BEHAVIOR_RADIAL_STYLE } from './behaviorRadialModel';
import { PLAYBOOK_OPTIONS, type PlaybookId } from './playbook';
import {
  AUDIBLES,
  FORMATION_AUDIBLE_STYLE,
  FORMATION_OPTIONS,
  FORMATION_COLOR,
  FORMATION_PANEL_SIZE,
  FORMATION_RING_RADIUS,
} from './formationRadialModel';

/**
 * The King's formation "play wheel". A single full ring of shape options that
 * drives the deterministic `setFormation` command (see state.ts / formations.ts),
 * snapping the targeted fire team(s) into a chosen shape — the football-style play
 * call.
 *
 * Targets the units the player is currently commanding: their own movable units in
 * the selection, plus the squad whose drive control they hold (pilotedFireTeamId).
 * Picking a shape groups those units into one fire team (minting a team id if they
 * are not already a squad) and snaps them into the shape — so a plain selection can
 * be formed up directly, no Deploy hold required first. The wheel refuses to open
 * only when nothing of the player's is under command.
 *
 * Opens on the Formation Wheel control (remappable in Settings → Controls; `v` by
 * default) / a bound controller button. With a controller the right stick aims —
 * its angle highlights a shape and the select button (RT) applies it; the wheel
 * stays open so the player can re-shape, and the close button (B) dismisses it. A
 * mouse can also click any circle directly. It reuses the posture radial's floating
 * ring CSS so the two systems look like one family.
 */

export function FormationRadial() {
  const matchStarted = useGameStore((s) => s.matchStarted);
  const units = useGameStore((s) => s.units);
  const selectedUnitIds = useGameStore((s) => s.selectedUnitIds);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const pilotedFireTeamId = useGameStore((s) => s.pilotedFireTeamId);
  const fireTeams = useGameStore((s) => s.fireTeams);
  const setFormation = useGameStore((s) => s.setFormation);
  const adjustFormation = useGameStore((s) => s.adjustFormation);
  const callPlay = useGameStore((s) => s.callPlay);
  const keyboardBindings = useGameStore((s) => s.keyboardBindings);

  const [isOpen, setIsOpen] = useState(false);

  // The shape the controller's right stick is currently addressing (null = stick at
  // rest / no aim yet). Mirrored into a ref so the select listener reads the latest
  // aim without re-subscribing every aim frame.
  const [gamepadHoverIndex, setGamepadHoverIndex] = useState<number | null>(null);
  const hoverIndexRef = useRef<number | null>(null);

  // The units the wheel will form up: the player's own living movable units that are
  // selected, plus the members of the squad whose drive control they hold. Recomputed
  // from live state so it tracks selection / drive changes.
  const commandable = useMemo<Unit[]>(() => {
    const selected = new Set(selectedUnitIds);
    return units.filter(
      (unit) =>
        unit.ownerId === localPlayerId &&
        unit.kind === 'Unit' &&
        unit.hp > 0 &&
        (selected.has(unit.id) || (pilotedFireTeamId !== null && unit.fireTeamId === pilotedFireTeamId))
    );
  }, [units, selectedUnitIds, localPlayerId, pilotedFireTeamId]);

  const commandableIds = useMemo(() => commandable.map((unit) => unit.id), [commandable]);

  // The shape shared by every commandable unit's fire team, or null when they
  // disagree / hold none — so the active highlight only lights up unambiguously.
  const currentShape = useMemo<FormationShape | null>(() => {
    if (commandable.length === 0) return null;
    let shared: FormationShape | null = null;
    for (const unit of commandable) {
      const shape = unit.fireTeamId ? fireTeams[unit.fireTeamId]?.shape ?? null : null;
      if (shape === null) return null;
      if (shared === null) shared = shape;
      else if (shared !== shape) return null;
    }
    return shared;
  }, [commandable, fireTeams]);

  const triggerKeyLabel = useMemo(() => {
    const token = keyboardBindings?.toggleFormationRadial ?? '';
    return token ? formatKeyboardToken(token) : '';
  }, [keyboardBindings]);

  const apply = (shape: FormationShape) => {
    if (commandableIds.length > 0) setFormation({ unitIds: commandableIds, shape });
  };

  // Whether any commandable unit is already in a formation — the audibles only act
  // on a formed team, so the audible bar is disabled until a shape has been called.
  const hasFormedTeam = useMemo(
    () => commandable.some((unit) => unit.fireTeamId !== undefined && fireTeams[unit.fireTeamId] !== undefined),
    [commandable, fireTeams]
  );

  const audible = (op: 'rotateLeft' | 'rotateRight' | 'expand' | 'contract' | 'disband') => {
    if (commandableIds.length > 0) adjustFormation({ unitIds: commandableIds, op });
  };

  // A play re-shapes ALL of the player's formed teams (by role), independent of the
  // current selection — so the playbook is available whenever any team is formed.
  const hasAnyOwnFormation = useMemo(
    () =>
      units.some(
        (unit) =>
          unit.ownerId === localPlayerId &&
          unit.kind === 'Unit' &&
          unit.hp > 0 &&
          unit.fireTeamId !== undefined &&
          fireTeams[unit.fireTeamId] !== undefined
      ),
    [units, localPlayerId, fireTeams]
  );

  const play = (id: PlaybookId) => callPlay({ play: id });

  // Close automatically the moment there is nothing to form up (e.g. the selection
  // was wiped out or the player deselected / released drive control).
  useEffect(() => {
    if (commandable.length === 0 && isOpen) setIsOpen(false);
  }, [commandable.length, isOpen]);

  // The Formation Wheel action (remappable; `v` by default) toggles the wheel.
  // KeyboardShortcuts and the controller both fire this event, so there is one
  // entry point. Ignored when nothing is selected so it can't open empty.
  useEffect(() => {
    const onToggle = () => {
      if (commandableIds.length === 0) return;
      setIsOpen((prev) => !prev);
    };
    window.addEventListener('rts:toggle-formation-radial', onToggle);
    return () => window.removeEventListener('rts:toggle-formation-radial', onToggle);
  }, [commandableIds.length]);

  // Broadcast open/closed so GamepadController hands the right stick to wheel
  // selection while it is up. Clears any stale gamepad hover on close.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(isOpen ? 'rts:formation-radial-open' : 'rts:formation-radial-close'));
    if (!isOpen) {
      hoverIndexRef.current = null;
      setGamepadHoverIndex(null);
    }
  }, [isOpen]);

  // Controller ring selection while open: the right stick streams an aim vector
  // (highlight the addressed shape); the select button applies it and the wheel
  // stays open. GamepadController owns the stick reading and the select/close
  // edges; this side owns the geometry and the command.
  useEffect(() => {
    if (!isOpen) return;
    const onAim = (event: Event) => {
      const detail = (event as CustomEvent).detail as { x?: number; y?: number } | undefined;
      if (!detail || typeof detail.x !== 'number' || typeof detail.y !== 'number') return;
      const index = ringIndexFromVector(detail.x, detail.y, FORMATION_OPTIONS.length);
      hoverIndexRef.current = index;
      setGamepadHoverIndex(index);
    };
    const onSelect = () => {
      const index = hoverIndexRef.current;
      if (index === null || commandableIds.length === 0) return;
      apply(FORMATION_OPTIONS[index].shape);
    };
    window.addEventListener('rts:formation-radial-aim', onAim);
    window.addEventListener('rts:formation-radial-select', onSelect);
    return () => {
      window.removeEventListener('rts:formation-radial-aim', onAim);
      window.removeEventListener('rts:formation-radial-select', onSelect);
    };
    // apply/commandableIds captured fresh each open via the deps below.
  }, [isOpen, commandableIds]);

  if (!matchStarted) return null;

  return (
    <>
      <style>{BEHAVIOR_RADIAL_STYLE}</style>
      <style>{FORMATION_AUDIBLE_STYLE}</style>

      {isOpen && commandable.length > 0 && (
        <div className="rts-stance-backdrop" onClick={() => setIsOpen(false)}>
          <div className="rts-stance-panel" onClick={(e) => e.stopPropagation()}>
            <div className="rts-stance-header">
              Formation · {commandable.length} unit{commandable.length === 1 ? '' : 's'}
            </div>

            <div className="rts-stance-ring" style={{ width: FORMATION_PANEL_SIZE, height: FORMATION_PANEL_SIZE }}>
              {FORMATION_OPTIONS.map((option, index) => {
                const angle = fullRingAngleDeg(index, FORMATION_OPTIONS.length) * (Math.PI / 180);
                const x = Math.cos(angle) * FORMATION_RING_RADIUS;
                const y = Math.sin(angle) * FORMATION_RING_RADIUS;
                const active = currentShape === option.shape;
                const hovered = gamepadHoverIndex === index;
                return (
                  <button
                    key={option.shape}
                    className={`rts-stance-node${active ? ' rts-stance-node-active' : ''}${hovered ? ' rts-stance-node-hover' : ''}`}
                    style={{ background: FORMATION_COLOR, transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` }}
                    onClick={() => apply(option.shape)}
                    title={option.hint}
                  >
                    <span className="rts-stance-node-icon">{option.icon}</span>
                    <span className="rts-stance-node-label">{option.label}</span>
                  </button>
                );
              })}

              {/* Center: an inert readout of the squad the call will form up. */}
              <div className="rts-stance-node rts-stance-center" style={{ background: FORMATION_COLOR, cursor: 'default' }}>
                <span className="rts-stance-center-icon">🪖</span>
                <span className="rts-stance-center-label">
                  {commandable.length} unit{commandable.length === 1 ? '' : 's'}
                </span>
              </div>
            </div>

            {/* Audible bar: quick mid-play tweaks to the already-formed team. */}
            <div className="rts-formation-audibles">
              {AUDIBLES.map((item) => (
                <button
                  key={item.op}
                  className="rts-formation-audible"
                  disabled={!hasFormedTeam}
                  onClick={() => audible(item.op)}
                  title={item.hint}
                >
                  <span className="rts-formation-audible-icon">{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>

            {/* Playbook: one call re-shapes & re-postures every formed team by role. */}
            <div className="rts-formation-playbook-label">Playbook · all teams</div>
            <div className="rts-formation-audibles">
              {PLAYBOOK_OPTIONS.map((item) => (
                <button
                  key={item.id}
                  className="rts-formation-audible rts-formation-play"
                  disabled={!hasAnyOwnFormation}
                  onClick={() => play(item.id)}
                  title={item.hint}
                >
                  <span className="rts-formation-audible-icon">{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>

            <div className="rts-stance-footer">
              Click a shape to form up · the audibles above re-face, spread, or break it ·
              order a move to send the formation · attack an enemy to focus-fire it
              {triggerKeyLabel ? ` · press ${triggerKeyLabel} to close` : ''}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
