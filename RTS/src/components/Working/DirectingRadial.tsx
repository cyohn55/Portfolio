import { useCallback, useMemo } from 'react';
import { useGameStore, dispatchCommand } from '../../game/state';

import { useUiSettingsStore } from "../../game/uiSettingsStore";
import type {
  CommandAdjustFormation,
  CommandCallPlay,
  CommandSetFormation,
  FormationShape,
  PlaybookId,
  Unit,
} from '../../game/types';
import { formatKeyboardToken } from './controlBindings';
import { FullRingRadial, type RadialPage, type RingOption } from './FullRingRadial';
import {
  AUDIBLES,
  FORMATION_COLOR,
  FORMATION_OPTIONS,
  type FormationAudibleOp,
} from './formationRadialModel';
import { PLAYBOOK_OPTIONS } from './playbook';

/**
 * The King's Directing wheel — one paged radial that consolidates the three former
 * formation-domain wheels into a single control:
 *   - Shapes:   set a fire team's formation (deterministic `setFormation`),
 *   - Audibles: a quick mid-play tweak to the selected team (`adjustFormation`),
 *   - Plays:    one call re-shapes ALL of the player's formed teams (`callPlay`).
 *
 * The shared FullRingRadial owns the open/close, stick aiming, exclusivity, and page
 * flipping (LB/RB on a controller, Tab on the keyboard). This component is purely the
 * per-page data: which units a page commands and the command it issues. Opens on
 * D-Pad Right / `v` / the on-screen Directing button.
 */

// Per-page hues, distinct so each page reads as its own system at a glance.
const SHAPES_COLOR = FORMATION_COLOR;   // green
const AUDIBLES_COLOR = '#0891b2';       // cyan
const PLAYS_COLOR = '#d97706';          // amber

const SHAPE_OPTIONS: readonly RingOption[] = FORMATION_OPTIONS.map((option) => ({
  key: option.shape,
  icon: option.icon,
  label: option.label,
  hint: option.hint,
}));

const AUDIBLE_OPTIONS: readonly RingOption[] = AUDIBLES.map((item) => ({
  key: item.op,
  icon: item.icon,
  label: item.label,
  hint: item.hint,
}));

const PLAY_OPTIONS: readonly RingOption[] = PLAYBOOK_OPTIONS.map((item) => ({
  key: item.id,
  icon: item.icon,
  label: item.label,
  hint: item.hint,
}));

export function DirectingRadial() {
  const matchStarted = useGameStore((s) => s.matchStarted);
  const selectedUnitIds = useGameStore((s) => s.selectedUnitIds);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const pilotedFireTeamId = useGameStore((s) => s.pilotedFireTeamId);
  const fireTeams = useGameStore((s) => s.fireTeams);
  // Stable adapters so the useMemo dep array below keeps constant references:
  // each issues its directive through the single command funnel.
  const setFormation = useCallback(
    (cmd: CommandSetFormation) => dispatchCommand({ type: 'setFormation', payload: cmd }),
    [],
  );
  const adjustFormation = useCallback(
    (cmd: CommandAdjustFormation) => dispatchCommand({ type: 'adjustFormation', payload: cmd }),
    [],
  );
  const callPlay = useCallback(
    (cmd: CommandCallPlay) => dispatchCommand({ type: 'callPlay', payload: cmd }),
    [],
  );
  const keyboardBindings = useUiSettingsStore((s) => s.keyboardBindings);

  // The wheel's contents change only when the selection, the piloted team, or the
  // fire-team table changes — all of which are user-triggered and rare. We therefore
  // do NOT subscribe to the live `units` array: it gets a fresh reference every tick
  // (the sim publishes `units` each frame), which would re-render this component and
  // rebuild the radial 60x/s for the whole match. Reading `units` via getState inside
  // the memos keeps the data current at the moments that matter without that churn.
  // The units the Shapes / Audibles pages command: the player's own living movable
  // units that are selected, plus the squad whose drive control they hold.
  const commandable = useMemo<Unit[]>(() => {
    const selected = new Set(selectedUnitIds);
    return useGameStore.getState().units.filter(
      (unit) =>
        unit.ownerId === localPlayerId &&
        unit.kind === 'Unit' &&
        unit.hp > 0 &&
        (selected.has(unit.id) || (pilotedFireTeamId !== null && unit.fireTeamId === pilotedFireTeamId))
    );
    // `fireTeams` is a dep so team membership/disband changes refresh the set even
    // though it is read off the live store rather than subscribed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUnitIds, localPlayerId, pilotedFireTeamId, fireTeams]);

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

  // Audibles only do anything once a commandable unit is actually in a formation.
  const hasFormedTeam = useMemo(
    () => commandable.some((unit) => unit.fireTeamId !== undefined && fireTeams[unit.fireTeamId] !== undefined),
    [commandable, fireTeams]
  );

  // A play acts on every formed team the player owns, regardless of selection.
  // Derived from the fire-team table (a play needs at least one formed team), which
  // is the rarely-changing signal — so this stays correct without subscribing to the
  // per-tick `units` array. (Disbanded teams are pruned from `fireTeams` each tick.)
  const hasAnyOwnFormation = useMemo(
    () =>
      useGameStore.getState().units.some(
        (unit) =>
          unit.ownerId === localPlayerId &&
          unit.kind === 'Unit' &&
          unit.hp > 0 &&
          unit.fireTeamId !== undefined &&
          fireTeams[unit.fireTeamId] !== undefined
      ),
    [localPlayerId, fireTeams]
  );

  const triggerKeyLabel = useMemo(() => {
    const token = keyboardBindings?.toggleDirectingRadial ?? '';
    return token ? formatKeyboardToken(token) : '';
  }, [keyboardBindings]);

  const unitWord = commandable.length === 1 ? 'unit' : 'units';
  const flipHint = 'LB/RB or tabs to flip pages';
  const keyHint = triggerKeyLabel ? ` · ${triggerKeyLabel}` : '';

  const pages = useMemo<RadialPage[]>(
    () => [
      {
        key: 'shapes',
        tabLabel: 'Shapes',
        options: SHAPE_OPTIONS,
        color: SHAPES_COLOR,
        header: `Shapes · ${commandable.length} ${unitWord}`,
        centerIcon: '🪖',
        centerLabel: `${commandable.length} ${unitWord}`,
        footer: `Aim & RT or click a shape to form up · order a move to send it · ${flipHint}${keyHint}`,
        enabled: commandableIds.length > 0,
        activeKey: currentShape,
        onSelect: (key) => setFormation({ unitIds: commandableIds, shape: key as FormationShape }),
      },
      {
        key: 'audibles',
        tabLabel: 'Audibles',
        options: AUDIBLE_OPTIONS,
        color: AUDIBLES_COLOR,
        header: 'Audibles · selected team',
        centerIcon: '🎚️',
        centerLabel: 'Adjust',
        footer: `Aim & RT or click a tweak · ${flipHint}${keyHint}`,
        enabled: hasFormedTeam,
        onSelect: (key) => adjustFormation({ unitIds: commandableIds, op: key as FormationAudibleOp }),
      },
      {
        key: 'plays',
        tabLabel: 'Plays',
        options: PLAY_OPTIONS,
        color: PLAYS_COLOR,
        header: 'Playbook · all teams',
        centerIcon: '📋',
        centerLabel: 'Call play',
        footer: `Aim & RT or click a play · ${flipHint}${keyHint}`,
        enabled: hasAnyOwnFormation,
        onSelect: (key) => callPlay({ play: key as PlaybookId }),
      },
    ],
    [commandable.length, unitWord, keyHint, commandableIds, currentShape, hasFormedTeam, hasAnyOwnFormation, setFormation, adjustFormation, callPlay]
  );

  if (!matchStarted) return null;

  return <FullRingRadial name="directing" autoClose pages={pages} />;
}
