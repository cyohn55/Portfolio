import { useMemo } from 'react';
import { useGameStore } from '../../game/state';
import type { FormationShape, Unit } from '../../game/types';
import { formatKeyboardToken } from './controlBindings';
import { FullRingRadial, type RingOption } from './FullRingRadial';
import { FORMATION_OPTIONS, FORMATION_COLOR } from './formationRadialModel';

/**
 * The King's formation wheel — a ring of shape options that drives the deterministic
 * `setFormation` command (see state.ts / formations.ts), grouping the commanded
 * units into one fire team and snapping them into the chosen shape.
 *
 * Targets the units the player is commanding: their own movable units in the
 * selection, plus the squad whose drive control they hold (pilotedFireTeamId). It is
 * the SHAPE wheel only; the per-team Audible wheel and the all-teams Playbook wheel
 * are sibling radials. Opens on D-Pad Up / `v` / the on-screen Formation button.
 */

const SHAPE_OPTIONS: readonly RingOption[] = FORMATION_OPTIONS.map((option) => ({
  key: option.shape,
  icon: option.icon,
  label: option.label,
  hint: option.hint,
}));

export function FormationRadial() {
  const matchStarted = useGameStore((s) => s.matchStarted);
  const units = useGameStore((s) => s.units);
  const selectedUnitIds = useGameStore((s) => s.selectedUnitIds);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const pilotedFireTeamId = useGameStore((s) => s.pilotedFireTeamId);
  const fireTeams = useGameStore((s) => s.fireTeams);
  const setFormation = useGameStore((s) => s.setFormation);
  const keyboardBindings = useGameStore((s) => s.keyboardBindings);

  // The units the wheel will form up: the player's own living movable units that are
  // selected, plus the members of the squad whose drive control they hold.
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

  // The shape shared by every commandable unit's fire team, or null when mixed/none.
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

  if (!matchStarted) return null;

  return (
    <FullRingRadial
      name="formation"
      options={SHAPE_OPTIONS}
      color={FORMATION_COLOR}
      header={`Formation · ${commandable.length} unit${commandable.length === 1 ? '' : 's'}`}
      centerIcon="🪖"
      centerLabel={`${commandable.length} unit${commandable.length === 1 ? '' : 's'}`}
      footer={`Aim & RT (D-Pad Up) or click a shape to form up · order a move to send it · attack to focus-fire${triggerKeyLabel ? ` · ${triggerKeyLabel}` : ''}`}
      enabled={commandableIds.length > 0}
      autoClose
      activeKey={currentShape}
      onSelect={(key) => setFormation({ unitIds: commandableIds, shape: key as FormationShape })}
    />
  );
}
