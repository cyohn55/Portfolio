import { test, expect } from '@playwright/test';
import {
  selectArmyUnitIds,
  selectAllControlledUnitIds,
  type SelectableUnit,
} from '../src/components/Working/conquest/conquestCommands';

/**
 * Unit tests for the Conquest army-command selection helpers behind the Space
 * gestures (Rally / Select All / Muster). Pure Node — the helpers are
 * side-effect-free id selectors, so we assert the exact ids they pick given a
 * roster and a control predicate, independent of the field's mutation/ordering.
 */

/** Build a minimal roster unit; overrides tweak the fields a case exercises. */
function makeUnit(overrides: Partial<SelectableUnit> & { id: string; armyId: string }): SelectableUnit {
  return {
    dead: false,
    carriedByOwlId: null,
    ...overrides,
  };
}

// A small two-army roster: the player controls 'p0', the AI controls 'ai1'.
const roster: SelectableUnit[] = [
  makeUnit({ id: 'p0-king', armyId: 'p0' }),
  makeUnit({ id: 'p0-queen', armyId: 'p0' }),
  makeUnit({ id: 'p0-unit', armyId: 'p0' }),
  makeUnit({ id: 'ai1-king', armyId: 'ai1' }),
  makeUnit({ id: 'ai1-unit', armyId: 'ai1' }),
];

const controlsP0 = (armyId: string) => armyId === 'p0';

test.describe('selectArmyUnitIds (Rally)', () => {
  test('selects every commandable unit of a controlled army', () => {
    expect(selectArmyUnitIds(roster, 'p0', controlsP0)).toEqual(['p0-king', 'p0-queen', 'p0-unit']);
  });

  test('selects nothing for an army the player does not control', () => {
    expect(selectArmyUnitIds(roster, 'ai1', controlsP0)).toEqual([]);
  });

  test('excludes dead and Owl-carried units, but keeps downed monarchs', () => {
    const mixed: SelectableUnit[] = [
      makeUnit({ id: 'alive', armyId: 'p0' }),
      makeUnit({ id: 'dead', armyId: 'p0', dead: true }),
      makeUnit({ id: 'carried', armyId: 'p0', carriedByOwlId: 'owl-7' }),
    ];
    // A downed monarch is still selectable (dead:false), matching the pointer layer.
    expect(selectArmyUnitIds(mixed, 'p0', controlsP0)).toEqual(['alive']);
  });
});

test.describe('selectAllControlledUnitIds (Select All / Muster)', () => {
  test('selects every commandable unit across all controlled armies', () => {
    // After capturing 'ai1', the player controls both armies.
    const controlsBoth = (armyId: string) => armyId === 'p0' || armyId === 'ai1';
    expect(selectAllControlledUnitIds(roster, controlsBoth)).toEqual([
      'p0-king', 'p0-queen', 'p0-unit', 'ai1-king', 'ai1-unit',
    ]);
  });

  test('omits units of armies the player does not control', () => {
    expect(selectAllControlledUnitIds(roster, controlsP0)).toEqual(['p0-king', 'p0-queen', 'p0-unit']);
  });

  test('returns an empty list when the player controls nothing', () => {
    expect(selectAllControlledUnitIds(roster, () => false)).toEqual([]);
  });
});
