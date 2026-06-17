import { useMemo } from 'react';
import { useGameStore } from '../../game/state';
import { formatKeyboardToken } from './controlBindings';
import { FullRingRadial, type RingOption } from './FullRingRadial';
import { PLAYBOOK_OPTIONS } from './playbook';
import type { PlaybookId } from '../../game/types';

/**
 * The King's playbook wheel — one call (Assault / Pincer / Hold / Turtle / Fall
 * Back) re-shapes and re-postures ALL of the player's formed teams at once by their
 * auto-classified positional role, driving the deterministic `callPlay` command.
 * Independent of the current selection, so it is available whenever any team is
 * formed. Opens on D-Pad Left / `x` / the on-screen Playbook button.
 */

const PLAYBOOK_COLOR = '#d97706'; // amber — distinct from the green formation/audible wheels

const PLAY_OPTIONS: readonly RingOption[] = PLAYBOOK_OPTIONS.map((item) => ({
  key: item.id,
  icon: item.icon,
  label: item.label,
  hint: item.hint,
}));

export function PlaybookRadial() {
  const matchStarted = useGameStore((s) => s.matchStarted);
  const units = useGameStore((s) => s.units);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const fireTeams = useGameStore((s) => s.fireTeams);
  const callPlay = useGameStore((s) => s.callPlay);
  const keyboardBindings = useGameStore((s) => s.keyboardBindings);

  // A play acts on every formed team the player owns, regardless of selection.
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

  const triggerKeyLabel = useMemo(() => {
    const token = keyboardBindings?.togglePlaybookRadial ?? '';
    return token ? formatKeyboardToken(token) : '';
  }, [keyboardBindings]);

  if (!matchStarted) return null;

  return (
    <FullRingRadial
      name="playbook"
      options={PLAY_OPTIONS}
      color={PLAYBOOK_COLOR}
      header="Playbook · all teams"
      centerIcon="📋"
      centerLabel="Call play"
      footer={`Aim & RT (D-Pad Left) or click a play${triggerKeyLabel ? ` · ${triggerKeyLabel}` : ''}`}
      enabled={hasAnyOwnFormation}
      autoClose
      onSelect={(key) => callPlay({ play: key as PlaybookId })}
    />
  );
}
