import { test, expect } from '@playwright/test';
import * as THREE from 'three';
import {
  conquestStatsFor,
  selectNearestEnemy,
  isWithinAttackRange,
  isAttackReady,
  regenAmount,
  AGGRO_RANGE,
  OUT_OF_COMBAT_MS,
  REGEN_FRACTION_PER_SECOND,
  type CombatActor,
} from '../src/components/Working/conquest/conquestCombat';

/**
 * Unit tests for the Conquest combat model. Pure Node — every helper is
 * side-effect-free, so we assert real behavior (relative balance, target
 * selection, range/cooldown gating, regeneration) rather than copied constants.
 */

function actor(controllerId: string, x: number, y: number, z: number, overrides: Partial<CombatActor> = {}): CombatActor {
  return { controllerId, position: new THREE.Vector3(x, y, z), hp: 100, dead: false, ...overrides };
}

test.describe('Globe-scaled combat stats', () => {
  test('derive directly from the shared animal balance (HP and damage preserved)', () => {
    const turtle = conquestStatsFor('Turtle');
    const bee = conquestStatsFor('Bee');
    // The Turtle is the HP wall; the Bee is the fragile fast striker.
    expect(turtle.maxHp).toBeGreaterThan(bee.maxHp);
    expect(turtle.attackCooldownMs).toBeGreaterThan(bee.attackCooldownMs);
  });

  test('preserve each animal\'s relative reach in globe space', () => {
    // Owl (sniper) out-ranges the melee Bear, just as on the battlemap.
    expect(conquestStatsFor('Owl').attackRange).toBeGreaterThan(conquestStatsFor('Bear').attackRange);
    // Ranges are scaled down to the unit-radius globe, not battlemap units.
    expect(conquestStatsFor('Bear').attackRange).toBeLessThan(0.1);
    expect(conquestStatsFor('Bear').attackRange).toBeGreaterThan(0);
  });
});

test.describe('Target selection', () => {
  test('picks the nearest living enemy within aggro range', () => {
    const self = actor('p0', 0, 0, 0);
    const near = actor('ai1', 0.05, 0, 0);
    const far = actor('ai1', 0.12, 0, 0);
    expect(selectNearestEnemy(self, [near, far], AGGRO_RANGE)).toBe(near);
  });

  test('ignores allies, the dead, and anything beyond aggro range', () => {
    const self = actor('p0', 0, 0, 0);
    const ally = actor('p0', 0.02, 0, 0);
    const deadEnemy = actor('ai1', 0.03, 0, 0, { dead: true });
    const distantEnemy = actor('ai1', AGGRO_RANGE + 0.1, 0, 0);
    expect(selectNearestEnemy(self, [ally, deadEnemy, distantEnemy], AGGRO_RANGE)).toBeNull();
  });
});

test.describe('Attack gating', () => {
  test('range check matches the configured attack range', () => {
    const attacker = actor('p0', 0, 0, 0);
    const inRange = actor('ai1', 0.02, 0, 0);
    const outOfRange = actor('ai1', 0.08, 0, 0);
    expect(isWithinAttackRange(attacker, inRange, 0.03)).toBe(true);
    expect(isWithinAttackRange(attacker, outOfRange, 0.03)).toBe(false);
  });

  test('cooldown gate blocks until the cooldown elapses', () => {
    expect(isAttackReady(1000, 800, 1500)).toBe(false); // 500ms < 800ms
    expect(isAttackReady(1000, 800, 1900)).toBe(true);  // 900ms >= 800ms
  });
});

test.describe('Out-of-combat regeneration', () => {
  test('no regen while recently in combat', () => {
    expect(regenAmount(100, 1000, 1000 + OUT_OF_COMBAT_MS - 1, 0.016)).toBe(0);
  });

  test('regenerates a fraction of max HP per second once out of combat', () => {
    const oneSecond = 1.0;
    const heal = regenAmount(100, 0, OUT_OF_COMBAT_MS + 1000, oneSecond);
    expect(heal).toBeCloseTo(100 * REGEN_FRACTION_PER_SECOND, 5);
  });
});
