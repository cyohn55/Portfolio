import { useMemo } from 'react';
import { useGameStore } from '../../game/state';
import type { Unit } from '../../game/types';
import { formatKeyboardToken } from './controlBindings';
import { FullRingRadial, type RingOption } from './FullRingRadial';
import { AUDIBLES, type FormationAudibleOp } from './formationRadialModel';

/**
 * The formation "audible" wheel — quick mid-play tweaks (Rotate L/R, Expand,
 * Contract, Disband) to the selected team's formation, driving the deterministic
 * `adjustFormation` command. Targets the same commandable selection as the shape
 * wheel, but only matters once a team is formed (it stays disabled otherwise).
 * Opens on D-Pad Right / `c` / the on-screen Audible button.
 */

const AUDIBLE_COLOR = '#0e9f6e';

const AUDIBLE_OPTIONS: readonly RingOption[] = AUDIBLES.map((item) => ({
  key: item.op,
  icon: item.icon,
  label: item.label,
  hint: item.hint,
}));

export function AudibleRadial() {
  const matchStarted = useGameStore((s) => s.matchStarted);
  const units = useGameStore((s) => s.units);
  const selectedUnitIds = useGameStore((s) => s.selectedUnitIds);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const pilotedFireTeamId = useGameStore((s) => s.pilotedFireTeamId);
  const fireTeams = useGameStore((s) => s.fireTeams);
  const adjustFormation = useGameStore((s) => s.adjustFormation);
  const keyboardBindings = useGameStore((s) => s.keyboardBindings);

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

  // Audibles only do anything once a commandable unit is actually in a formation.
  const hasFormedTeam = useMemo(
    () => commandable.some((unit) => unit.fireTeamId !== undefined && fireTeams[unit.fireTeamId] !== undefined),
    [commandable, fireTeams]
  );

  const triggerKeyLabel = useMemo(() => {
    const token = keyboardBindings?.toggleAudibleRadial ?? '';
    return token ? formatKeyboardToken(token) : '';
  }, [keyboardBindings]);

  if (!matchStarted) return null;

  return (
    <FullRingRadial
      name="audible"
      options={AUDIBLE_OPTIONS}
      color={AUDIBLE_COLOR}
      header="Audible · selected team"
      centerIcon="🎚️"
      centerLabel="Adjust"
      footer={`Aim & RT (D-Pad Right) or click a tweak${triggerKeyLabel ? ` · ${triggerKeyLabel}` : ''}`}
      enabled={hasFormedTeam}
      autoClose
      onSelect={(key) => adjustFormation({ unitIds: commandableIds, op: key as FormationAudibleOp })}
    />
  );
}
