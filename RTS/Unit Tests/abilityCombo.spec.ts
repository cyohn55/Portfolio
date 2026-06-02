import { test, expect } from '@playwright/test';
import type { AnimalId, Position3D, Unit, UnitKind } from '../src/game/types';
import {
  type AbilityComboActions,
  type AbilityComboContext,
  type AbilityComboCursor,
  abilityPlanIsActionable,
  executeAbilityCombo,
  planAbilityCombo,
  tryFireAbilityCombo,
} from '../src/components/Working/abilityCombo';

/**
 * These tests exercise the real abilityCombo module against real inputs and
 * outputs: units are built with the production Unit shape, the cursor is a
 * structural stub matching what the mouse/controller supply, and the actions
 * object records the exact store commands dispatched. Nothing is hard-coded into
 * the module under test. Run with:
 *   npx playwright test --config "Unit Tests/playwright.config.ts"
 */

const LOCAL = 'player-1';
const ENEMY = 'player-2';

// Minimal Unit factory: fills the required combat fields with inert defaults so a
// test only states the handful of properties it actually cares about.
function makeUnit(overrides: Partial<Unit> & { id: string; animal: AnimalId; kind: UnitKind }): Unit {
  return {
    ownerId: LOCAL,
    position: { x: 0, y: 0, z: 0 },
    hp: 100,
    maxHp: 100,
    attackDamage: 10,
    moveSpeed: 5,
    attackRange: 4,
    attackCooldownMs: 1000,
    lastAttackAtMs: 0,
    rotation: 0,
    ...overrides,
  };
}

function context(units: Unit[], selectedUnitIds: string[]): AbilityComboContext {
  return { units, localPlayerId: LOCAL, selectedUnitIds };
}

// A cursor that reports a fixed ground point and a fixed unit-under-cursor, so the
// pickup/aim branches can be steered deterministically.
function cursor(opts: { ground?: Position3D | null; under?: Unit | null } = {}): AbilityComboCursor {
  return {
    groundPoint: () => (opts.ground === undefined ? { x: 7, y: 0, z: 9 } : opts.ground),
    unitUnderCursor: () => opts.under ?? null,
  };
}

// An actions recorder: every dispatch is captured so the test can assert exactly
// what fired (and with which arguments) instead of mocking behavior.
function recordingActions() {
  const calls: { name: keyof AbilityComboActions; arg: unknown }[] = [];
  const record = (name: keyof AbilityComboActions) => (arg: unknown) => calls.push({ name, arg });
  const actions: AbilityComboActions = {
    toggleTurtleShell: record('toggleTurtleShell') as AbilityComboActions['toggleTurtleShell'],
    throwEggs: record('throwEggs') as AbilityComboActions['throwEggs'],
    fireTongues: record('fireTongues') as AbilityComboActions['fireTongues'],
    hiss: record('hiss') as AbilityComboActions['hiss'],
    swarm: record('swarm') as AbilityComboActions['swarm'],
    pickup: record('pickup') as AbilityComboActions['pickup'],
    deliverCargo: record('deliverCargo') as AbilityComboActions['deliverCargo'],
  };
  return { actions, calls };
}

test.describe('abilityCombo', () => {
  test('a selected Turtle Unit shells, and only that unit', () => {
    const turtle = makeUnit({ id: 't1', animal: 'Turtle', kind: 'Unit' });
    const otherTurtle = makeUnit({ id: 't2', animal: 'Turtle', kind: 'Unit' });
    const plan = planAbilityCombo(context([turtle, otherTurtle], ['t1']), cursor());

    expect(plan.turtleIds).toEqual(['t1']);
    expect(abilityPlanIsActionable(plan)).toBe(true);

    const { actions, calls } = recordingActions();
    executeAbilityCombo(plan, actions);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ name: 'toggleTurtleShell', arg: ['t1'] });
  });

  test('Kings and Queens never trigger a combo (royals are excluded)', () => {
    const queen = makeUnit({ id: 'q', animal: 'Turtle', kind: 'Queen' });
    const king = makeUnit({ id: 'k', animal: 'Cat', kind: 'King' });
    const plan = planAbilityCombo(context([queen, king], ['q', 'k']), cursor());

    expect(plan.turtleIds).toEqual([]);
    expect(plan.catIds).toEqual([]);
    expect(abilityPlanIsActionable(plan)).toBe(false);
    expect(tryFireAbilityCombo(context([queen, king], ['q', 'k']), cursor(), recordingActions().actions)).toBe(false);
  });

  test("another player's units are ignored", () => {
    const enemyBee = makeUnit({ id: 'b', animal: 'Bee', kind: 'Unit', ownerId: ENEMY });
    const plan = planAbilityCombo(context([enemyBee], ['b']), cursor());
    expect(plan.beeIds).toEqual([]);
    expect(abilityPlanIsActionable(plan)).toBe(false);
  });

  test('Cat hiss and Bee swarm fire without needing a cursor point', () => {
    const cat = makeUnit({ id: 'c', animal: 'Cat', kind: 'Unit' });
    const bee = makeUnit({ id: 'b', animal: 'Bee', kind: 'Unit' });
    const plan = planAbilityCombo(context([cat, bee], ['c', 'b']), cursor({ ground: null }));

    const { actions, calls } = recordingActions();
    executeAbilityCombo(plan, actions);
    expect(calls).toEqual([
      { name: 'hiss', arg: { unitIds: ['c'] } },
      { name: 'swarm', arg: { unitIds: ['b'] } },
    ]);
  });

  test('Chicken eggs and Frog tongues aim at the ground point, and no-op when the cursor misses', () => {
    const chicken = makeUnit({ id: 'ch', animal: 'Chicken', kind: 'Unit' });
    const frog = makeUnit({ id: 'fr', animal: 'Frog', kind: 'Unit' });

    const aimed = planAbilityCombo(context([chicken, frog], ['ch', 'fr']), cursor({ ground: { x: 2, y: 0, z: 3 } }));
    const hit = recordingActions();
    executeAbilityCombo(aimed, hit.actions);
    expect(hit.calls).toEqual([
      { name: 'throwEggs', arg: { unitIds: ['ch'], target: { x: 2, y: 0, z: 3 } } },
      { name: 'fireTongues', arg: { unitIds: ['fr'], cursor: { x: 2, y: 0, z: 3 } } },
    ]);

    const missed = planAbilityCombo(context([chicken, frog], ['ch', 'fr']), cursor({ ground: null }));
    expect(abilityPlanIsActionable(missed)).toBe(true); // units are selected…
    const miss = recordingActions();
    executeAbilityCombo(missed, miss.actions);
    expect(miss.calls).toHaveLength(0); // …but nothing fires without an aim point
  });

  test('Owl pickup targets the unit under the cursor by animal + owner; air units are not grabbable', () => {
    const owl = makeUnit({ id: 'o', animal: 'Owl', kind: 'Unit' });
    const groundEnemy = makeUnit({ id: 'e', animal: 'Bear', kind: 'Unit', ownerId: ENEMY });
    const flyingEnemy = makeUnit({ id: 'f', animal: 'Bee', kind: 'Unit', ownerId: ENEMY });

    const grab = planAbilityCombo(context([owl, groundEnemy], ['o']), cursor({ under: groundEnemy }));
    expect(grab.owlPickupTarget).toEqual({ animal: 'Bear', ownerId: ENEMY });
    const { actions, calls } = recordingActions();
    executeAbilityCombo(grab, actions);
    expect(calls).toEqual([{ name: 'pickup', arg: { unitIds: ['o'], targetAnimal: 'Bear', targetOwnerId: ENEMY } }]);

    const overAir = planAbilityCombo(context([owl, flyingEnemy], ['o']), cursor({ under: flyingEnemy }));
    expect(overAir.owlPickupTarget).toBeNull();
    expect(abilityPlanIsActionable(overAir)).toBe(false);
  });

  test('an Owl already holding cargo delivers (priority over pickup)', () => {
    const owl = makeUnit({
      id: 'o',
      animal: 'Owl',
      kind: 'Unit',
      owlPickup: { phase: 'holding' } as Unit['owlPickup'],
    });
    const grabbable = makeUnit({ id: 'e', animal: 'Bear', kind: 'Unit', ownerId: ENEMY });

    const plan = planAbilityCombo(context([owl, grabbable], ['o']), cursor({ ground: { x: 5, y: 0, z: 6 }, under: grabbable }));
    expect(plan.deliveringOwlIds).toEqual(['o']);
    expect(plan.owlPickupTarget).toBeNull(); // delivery suppresses a new pickup

    const { actions, calls } = recordingActions();
    executeAbilityCombo(plan, actions);
    expect(calls).toEqual([{ name: 'deliverCargo', arg: { unitIds: ['o'], target: { x: 5, y: 0, z: 6 } } }]);
  });

  test('tryFireAbilityCombo reports whether anything fired', () => {
    const turtle = makeUnit({ id: 't', animal: 'Turtle', kind: 'Unit' });
    expect(tryFireAbilityCombo(context([turtle], ['t']), cursor(), recordingActions().actions)).toBe(true);
    expect(tryFireAbilityCombo(context([turtle], []), cursor(), recordingActions().actions)).toBe(false);
  });
});
