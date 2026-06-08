import { test, expect } from '@playwright/test';
import * as THREE from 'three';
import {
  defaultBehaviorFor,
  stanceParams,
  resolveFireMode,
  selectTargetForBehavior,
  mergeBehavior,
  type BehaviorActor,
} from '../src/components/Working/conquest/conquestBehavior';
import { conquestStatsFor } from '../src/components/Working/conquest/conquestCombat';
import type { ConquestUnitKind } from '../src/components/Working/conquest/conquestState';

/**
 * Unit tests for the Conquest combat-posture system (Increment 2). Pure Node —
 * every helper is side-effect-free, so we assert real behavior (stance radii
 * ordering, fire-mode gating, priority-based target ranking) using real animal
 * stats rather than constants copied from the implementation.
 */

const MELEE_RANGE = conquestStatsFor('Bear').attackRange;

function actor(
  id: string,
  controllerId: string,
  x: number,
  z: number,
  overrides: Partial<BehaviorActor> = {},
): BehaviorActor {
  return {
    id,
    controllerId,
    position: new THREE.Vector3(x, 0, z),
    hp: 100,
    dead: false,
    kind: 'unit' as ConquestUnitKind,
    combat: { damage: 10, attackCooldownMs: 1000, attackRange: MELEE_RANGE },
    ...overrides,
  };
}

test.describe('Default posture', () => {
  test('every fresh unit starts defensive, weapons-free, nearest-target', () => {
    expect(defaultBehaviorFor('Bear', 'unit')).toEqual({ stance: 'defensive', fire: 'free', priority: 'nearest' });
    expect(defaultBehaviorFor('Owl', 'king')).toEqual({ stance: 'defensive', fire: 'free', priority: 'nearest' });
  });
});

test.describe('Stance resolution (globe-scaled)', () => {
  test('aggressive sees and chases farther than defensive', () => {
    const aggressive = stanceParams('aggressive', MELEE_RANGE);
    const defensive = stanceParams('defensive', MELEE_RANGE);
    expect(aggressive.detectionRadius).toBeGreaterThan(defensive.detectionRadius);
    expect(aggressive.chaseRadius).toBeGreaterThan(defensive.chaseRadius);
    expect(aggressive.movesToEngage).toBe(true);
  });

  test('hold-ground never advances and only sees what it can already strike', () => {
    const hold = stanceParams('holdGround', MELEE_RANGE);
    expect(hold.movesToEngage).toBe(false);
    expect(hold.detectionRadius).toBeCloseTo(MELEE_RANGE, 6);
  });

  test('flee engages nothing', () => {
    expect(stanceParams('flee', MELEE_RANGE).engages).toBe(false);
  });

  test('radii are globe-scaled (sub-tile), not battlemap units', () => {
    // A level-3 tile spans ~0.18 globe units; even aggressive vision stays within a
    // few tiles rather than the 45-unit battlemap reach it derives from.
    expect(stanceParams('aggressive', MELEE_RANGE).detectionRadius).toBeLessThan(1);
    expect(stanceParams('defensive', MELEE_RANGE).detectionRadius).toBeGreaterThan(0);
  });
});

test.describe('Fire-mode resolution', () => {
  test('patrol forces weapons-free regardless of stored fire mode', () => {
    expect(resolveFireMode({ stance: 'patrol', fire: 'hold', priority: 'nearest' })).toBe('free');
  });

  test('every other stance honors the explicit fire setting', () => {
    expect(resolveFireMode({ stance: 'defensive', fire: 'hold', priority: 'nearest' })).toBe('hold');
    expect(resolveFireMode({ stance: 'aggressive', fire: 'free', priority: 'nearest' })).toBe('free');
  });
});

test.describe('Behavior-driven target acquisition', () => {
  const defensive = stanceParams('defensive', MELEE_RANGE);

  test('acquires the nearest in-detection enemy by default', () => {
    const self = actor('self', 'p0', 0, 0);
    const near = actor('e-near', 'ai1', 0.05, 0);
    const far = actor('e-far', 'ai1', 0.12, 0);
    const picked = selectTargetForBehavior(self, [self, near, far], { stance: 'defensive', fire: 'free', priority: 'nearest' }, defensive);
    expect(picked).toBe(near);
  });

  test('ignores allies, the dead, and enemies beyond the detection radius', () => {
    const self = actor('self', 'p0', 0, 0);
    const ally = actor('ally', 'p0', 0.02, 0);
    const dead = actor('dead', 'ai1', 0.03, 0, { dead: true });
    const distant = actor('distant', 'ai1', defensive.detectionRadius + 0.1, 0);
    const picked = selectTargetForBehavior(self, [ally, dead, distant], { stance: 'defensive', fire: 'free', priority: 'nearest' }, defensive);
    expect(picked).toBeNull();
  });

  test('weapons-tight (fire hold) acquires nothing even with an enemy in range', () => {
    const self = actor('self', 'p0', 0, 0);
    const enemy = actor('enemy', 'ai1', 0.02, 0);
    const picked = selectTargetForBehavior(self, [enemy], { stance: 'defensive', fire: 'hold', priority: 'nearest' }, defensive);
    expect(picked).toBeNull();
  });

  test('a non-engaging stance (flee) acquires nothing', () => {
    const self = actor('self', 'p0', 0, 0);
    const enemy = actor('enemy', 'ai1', 0.02, 0);
    const flee = stanceParams('flee', MELEE_RANGE);
    const picked = selectTargetForBehavior(self, [enemy], { stance: 'flee', fire: 'free', priority: 'nearest' }, flee);
    expect(picked).toBeNull();
  });

  test('lowest-HP priority finishes the weaker of two equidistant enemies', () => {
    const self = actor('self', 'p0', 0, 0);
    const healthy = actor('healthy', 'ai1', 0.05, 0, { hp: 100 });
    const wounded = actor('wounded', 'ai1', 0, 0.05, { hp: 10 });
    const picked = selectTargetForBehavior(self, [healthy, wounded], { stance: 'defensive', fire: 'free', priority: 'lowestHp' }, defensive);
    expect(picked).toBe(wounded);
  });

  test('monarch priority strikes a King over a nearer regular unit', () => {
    const self = actor('self', 'p0', 0, 0);
    const nearUnit = actor('grunt', 'ai1', 0.03, 0, { kind: 'unit' });
    const farKing = actor('king', 'ai1', 0.06, 0, { kind: 'king' });
    const picked = selectTargetForBehavior(self, [nearUnit, farKing], { stance: 'defensive', fire: 'free', priority: 'monarch' }, defensive);
    expect(picked).toBe(farKing);
  });
});

test.describe('Behavior merge (forward-compat with the set-behavior command)', () => {
  test('patches one axis while preserving the others', () => {
    const current = { stance: 'defensive', fire: 'free', priority: 'nearest' } as const;
    expect(mergeBehavior(current, { stance: 'aggressive' })).toEqual({ stance: 'aggressive', fire: 'free', priority: 'nearest' });
    expect(mergeBehavior(current, { fire: 'hold' })).toEqual({ stance: 'defensive', fire: 'hold', priority: 'nearest' });
  });
});
