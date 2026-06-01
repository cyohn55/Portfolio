import { test, expect } from '@playwright/test';
import type { AnimalId, Unit, UnitKind } from '../src/game/types';
import {
  MONARCH_FOLLOW_STOP_DISTANCE,
  findMonarch,
  otherMonarchKind,
  pilotInput,
  shouldChaseMonarch,
} from '../src/components/Working/monarchPilot';

/**
 * These tests exercise the real monarchPilot helpers against real Unit-shaped
 * inputs (no values are hard-coded into the module under test). The piloting
 * tick logic and input wiring build on these pure pieces, so validating them in
 * isolation keeps the heavier game loop honest.
 * Run with: npx playwright test --config "Unit Tests/playwright.config.ts"
 */

let unitCounter = 0;

// Build a real Unit with sensible stats so the helpers operate on the same
// shape the game uses. Tests override only the fields they assert on.
function makeUnit(overrides: Partial<Unit> & { ownerId: string; animal: AnimalId; kind: UnitKind }): Unit {
  return {
    id: `unit-${unitCounter++}`,
    position: { x: 0, y: 0, z: 0 },
    hp: 100,
    maxHp: 100,
    attackDamage: 10,
    moveSpeed: 10,
    attackRange: 4,
    attackCooldownMs: 1000,
    lastAttackAtMs: 0,
    rotation: 0,
    ...overrides,
  };
}

test.describe('otherMonarchKind', () => {
  test('swaps King and Queen', () => {
    expect(otherMonarchKind('King')).toBe('Queen');
    expect(otherMonarchKind('Queen')).toBe('King');
  });
});

test.describe('findMonarch', () => {
  const local = 'player-1';
  const enemy = 'ai-1';

  test('returns the living monarch matching owner, animal, and kind', () => {
    const king = makeUnit({ ownerId: local, animal: 'Bee', kind: 'King' });
    const queen = makeUnit({ ownerId: local, animal: 'Bee', kind: 'Queen' });
    const army = makeUnit({ ownerId: local, animal: 'Bee', kind: 'Unit' });
    const units = [army, king, queen];

    expect(findMonarch(units, local, 'Bee', 'King')).toBe(king);
    expect(findMonarch(units, local, 'Bee', 'Queen')).toBe(queen);
  });

  test('does not match a different animal or owner', () => {
    const ownKing = makeUnit({ ownerId: local, animal: 'Bee', kind: 'King' });
    const enemyKing = makeUnit({ ownerId: enemy, animal: 'Bear', kind: 'King' });
    const units = [ownKing, enemyKing];

    expect(findMonarch(units, local, 'Bear', 'King')).toBeNull(); // own side has no Bear
    expect(findMonarch(units, enemy, 'Bear', 'King')).toBe(enemyKing);
  });

  test('skips a dead monarch', () => {
    const deadKing = makeUnit({ ownerId: local, animal: 'Fox', kind: 'King', hp: 0 });
    expect(findMonarch([deadKing], local, 'Fox', 'King')).toBeNull();
  });
});

test.describe('shouldChaseMonarch', () => {
  test('chases while outside the stop band and idles within it', () => {
    expect(shouldChaseMonarch(MONARCH_FOLLOW_STOP_DISTANCE + 1)).toBe(true);
    expect(shouldChaseMonarch(MONARCH_FOLLOW_STOP_DISTANCE)).toBe(false);
    expect(shouldChaseMonarch(0)).toBe(false);
  });

  test('honors a custom stop distance', () => {
    expect(shouldChaseMonarch(5, 10)).toBe(false);
    expect(shouldChaseMonarch(15, 10)).toBe(true);
  });
});

test.describe('pilotInput singleton', () => {
  test('round-trips the movement vector and clears on reset', () => {
    pilotInput.setMove(0.5, -0.25);
    expect(pilotInput.getMove()).toEqual({ x: 0.5, z: -0.25 });

    // getMove hands out a fresh object so callers can't mutate internal state.
    const snapshot = pilotInput.getMove();
    snapshot.x = 999;
    expect(pilotInput.getMove().x).toBe(0.5);

    pilotInput.reset();
    expect(pilotInput.getMove()).toEqual({ x: 0, z: 0 });
  });
});
