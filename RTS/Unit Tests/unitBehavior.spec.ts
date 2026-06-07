import { test, expect } from '@playwright/test';
import type { AnimalId, Unit, UnitBehavior, UnitKind } from '../src/game/types';
import {
  behaviorOf,
  defaultBehaviorFor,
  distanceXZ,
  FLEE_HP_FRACTION,
  mergeBehavior,
  pickTargetByPriority,
  resolveFireMode,
  retreatDestination,
  RETREAT_DISTANCE,
  shouldFleeLowHp,
  stanceParams,
} from '../src/components/Working/unitBehavior';

/**
 * Exercises the real unitBehavior module against real Unit inputs/outputs — no
 * values are hard-coded into the module under test, and every "pick one" path is
 * checked for the deterministic id tiebreak the lockstep sim depends on.
 * Run with: npx playwright test --config "Unit Tests/playwright.config.ts"
 */

// Builds a Unit with sane defaults; tests override only the fields they assert on,
// so the module is always fed a complete, realistic entity.
function makeUnit(overrides: Partial<Unit> = {}): Unit {
  return {
    id: 'U1',
    ownerId: 'p0',
    animal: 'Bear' as AnimalId,
    kind: 'Unit' as UnitKind,
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

test.describe('defaults', () => {
  test('every kind defaults to weapons-free defensive/nearest', () => {
    const kinds: UnitKind[] = ['Unit', 'Queen', 'King', 'Base'];
    for (const kind of kinds) {
      const behavior = defaultBehaviorFor('Bear' as AnimalId, kind);
      expect(behavior).toEqual({ stance: 'defensive', fire: 'free', priority: 'nearest' });
    }
  });

  test('behaviorOf falls back to default when absent and returns the set behavior otherwise', () => {
    expect(behaviorOf(makeUnit({ behavior: undefined }))).toEqual(defaultBehaviorFor('Bear' as AnimalId, 'Unit'));
    const custom: UnitBehavior = { stance: 'aggressive', fire: 'hold', priority: 'lowestHp' };
    expect(behaviorOf(makeUnit({ behavior: custom }))).toEqual(custom);
  });
});

test.describe('stanceParams', () => {
  test('holdGround keys detection to the unit attack range and never moves or returns', () => {
    const unit = makeUnit({ attackRange: 7 });
    const params = stanceParams('holdGround', unit);
    expect(params.detectionRadius).toBe(7);
    expect(params.chaseRadius).toBe(7);
    expect(params.movesToEngage).toBe(false);
    expect(params.returnsToAnchor).toBe(false);
  });

  test('aggressive reaches and chases farther than defensive', () => {
    const unit = makeUnit();
    const aggressive = stanceParams('aggressive', unit);
    const defensive = stanceParams('defensive', unit);
    expect(aggressive.detectionRadius).toBeGreaterThan(defensive.detectionRadius);
    expect(aggressive.chaseRadius).toBeGreaterThan(defensive.chaseRadius);
  });

  test('flee never engages but still seeks home', () => {
    const params = stanceParams('flee', makeUnit());
    expect(params.engages).toBe(false);
    expect(params.detectionRadius).toBe(0);
    expect(params.returnsToAnchor).toBe(true);
  });

  test('skirmish detection scales with a longer attack range', () => {
    const shortRange = stanceParams('skirmish', makeUnit({ attackRange: 4 }));
    const longRange = stanceParams('skirmish', makeUnit({ attackRange: 40 }));
    expect(longRange.detectionRadius).toBeGreaterThan(shortRange.detectionRadius);
  });
});

test.describe('fire mode', () => {
  test('patrol forces weapons-free even when fire is stored as hold', () => {
    expect(resolveFireMode({ stance: 'patrol', fire: 'hold', priority: 'nearest' })).toBe('free');
  });

  test('non-patrol stances honor the stored fire mode', () => {
    expect(resolveFireMode({ stance: 'defensive', fire: 'hold', priority: 'nearest' })).toBe('hold');
    expect(resolveFireMode({ stance: 'aggressive', fire: 'free', priority: 'nearest' })).toBe('free');
  });
});

test.describe('low-HP flee reflex', () => {
  test('a regular Unit below the HP fraction flees, at/above does not', () => {
    expect(shouldFleeLowHp(makeUnit({ hp: 100 * FLEE_HP_FRACTION - 1, maxHp: 100 }))).toBe(true);
    expect(shouldFleeLowHp(makeUnit({ hp: 100 * FLEE_HP_FRACTION, maxHp: 100 }))).toBe(false);
    expect(shouldFleeLowHp(makeUnit({ hp: 100, maxHp: 100 }))).toBe(false);
  });

  test('monarchs and bases never reflex-flee', () => {
    expect(shouldFleeLowHp(makeUnit({ kind: 'King', hp: 1, maxHp: 100 }))).toBe(false);
    expect(shouldFleeLowHp(makeUnit({ kind: 'Queen', hp: 1, maxHp: 100 }))).toBe(false);
    expect(shouldFleeLowHp(makeUnit({ kind: 'Base', hp: 1, maxHp: 100 }))).toBe(false);
  });
});

test.describe('target priority', () => {
  const seeker = makeUnit({ position: { x: 0, y: 0, z: 0 } });

  test('nearest picks the closest enemy', () => {
    const near = makeUnit({ id: 'A', position: { x: 5, y: 0, z: 0 } });
    const far = makeUnit({ id: 'B', position: { x: 50, y: 0, z: 0 } });
    expect(pickTargetByPriority(seeker, [far, near], 'nearest')?.id).toBe('A');
  });

  test('lowestHp finishes the weakest enemy regardless of distance', () => {
    const healthyClose = makeUnit({ id: 'A', hp: 90, position: { x: 2, y: 0, z: 0 } });
    const woundedFar = makeUnit({ id: 'B', hp: 5, position: { x: 40, y: 0, z: 0 } });
    expect(pickTargetByPriority(seeker, [healthyClose, woundedFar], 'lowestHp')?.id).toBe('B');
  });

  test('highestThreat picks the strongest damage-per-second enemy', () => {
    const lowDps = makeUnit({ id: 'A', attackDamage: 10, attackCooldownMs: 1000, position: { x: 3, y: 0, z: 0 } });
    const highDps = makeUnit({ id: 'B', attackDamage: 50, attackCooldownMs: 500, position: { x: 30, y: 0, z: 0 } });
    expect(pickTargetByPriority(seeker, [lowDps, highDps], 'highestThreat')?.id).toBe('B');
  });

  test('ranged prefers the longest-reach enemy', () => {
    const melee = makeUnit({ id: 'A', attackRange: 4, position: { x: 2, y: 0, z: 0 } });
    const archer = makeUnit({ id: 'B', attackRange: 30, position: { x: 25, y: 0, z: 0 } });
    expect(pickTargetByPriority(seeker, [melee, archer], 'ranged')?.id).toBe('B');
  });

  test('monarch targets a King/Queen before regular units', () => {
    const trooper = makeUnit({ id: 'A', kind: 'Unit', position: { x: 2, y: 0, z: 0 } });
    const queen = makeUnit({ id: 'B', kind: 'Queen', position: { x: 30, y: 0, z: 0 } });
    expect(pickTargetByPriority(seeker, [trooper, queen], 'monarch')?.id).toBe('B');
  });

  test('ties break on the smallest id so both peers agree', () => {
    // Identical position and hp: the only differentiator is the id.
    const high = makeUnit({ id: 'Z', position: { x: 10, y: 0, z: 0 } });
    const low = makeUnit({ id: 'A', position: { x: 10, y: 0, z: 0 } });
    expect(pickTargetByPriority(seeker, [high, low], 'nearest')?.id).toBe('A');
    // Order of the candidate array must not change the result.
    expect(pickTargetByPriority(seeker, [low, high], 'nearest')?.id).toBe('A');
  });

  test('returns null when there are no candidates', () => {
    expect(pickTargetByPriority(seeker, [], 'nearest')).toBeNull();
  });
});

test.describe('retreat destination', () => {
  test('prefers the anchor when one exists', () => {
    const unit = makeUnit({ position: { x: 100, y: 0, z: 100 } });
    const anchor = { x: 10, y: 0, z: 20 };
    expect(retreatDestination(unit, anchor, { x: 99, y: 0, z: 99 })).toEqual({ x: 10, y: 0, z: 20 });
  });

  test('runs directly away from the threat at RETREAT_DISTANCE when anchorless', () => {
    const unit = makeUnit({ position: { x: 0, y: 0, z: 0 } });
    const dest = retreatDestination(unit, undefined, { x: 10, y: 0, z: 0 });
    expect(dest).not.toBeNull();
    // Enemy is east, so we flee west by exactly RETREAT_DISTANCE.
    expect(dest!.x).toBeCloseTo(-RETREAT_DISTANCE, 5);
    expect(dest!.z).toBeCloseTo(0, 5);
    expect(distanceXZ(unit.position, dest!)).toBeCloseTo(RETREAT_DISTANCE, 5);
  });

  test('returns null with no anchor and no threat, or when standing on the threat', () => {
    const unit = makeUnit();
    expect(retreatDestination(unit, undefined, null)).toBeNull();
    expect(retreatDestination(unit, undefined, { x: 0, y: 0, z: 0 })).toBeNull();
  });
});

test.describe('behavior merge', () => {
  test('a single-axis patch leaves the other axes untouched', () => {
    const current: UnitBehavior = { stance: 'defensive', fire: 'free', priority: 'nearest' };
    expect(mergeBehavior(current, { stance: 'aggressive' })).toEqual({ stance: 'aggressive', fire: 'free', priority: 'nearest' });
    expect(mergeBehavior(current, { fire: 'hold' })).toEqual({ stance: 'defensive', fire: 'hold', priority: 'nearest' });
    expect(mergeBehavior(current, { priority: 'lowestHp' })).toEqual({ stance: 'defensive', fire: 'free', priority: 'lowestHp' });
  });
});
