import { test, expect } from '@playwright/test';
import type { AnimalId, Unit, UnitKind } from '../src/game/types';
import {
  MONARCH_FOLLOW_STOP_DISTANCE,
  MONARCH_FOLLOW_GAP,
  UNIT_PLACEMENT_INTERVAL_MS,
  clampPlacementCount,
  findMonarch,
  followGapClearance,
  otherMonarchKind,
  pilotInput,
  selectFollowersForPlacement,
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

test.describe('followGapClearance', () => {
  const distanceXZ = (a: { x: number; z: number }, b: { x: number; z: number }) =>
    Math.hypot(a.x - b.x, a.z - b.z);

  test('the follow gap is positive and below the chase stop band', () => {
    // A follower must be able to settle inside the stop band without immediately fighting the
    // gap floor, so the floor has to sit below where chasing stops.
    expect(MONARCH_FOLLOW_GAP).toBeGreaterThan(0);
    expect(MONARCH_FOLLOW_GAP).toBeLessThan(MONARCH_FOLLOW_STOP_DISTANCE);
  });

  test('returns null when the follower is already at or beyond the gap', () => {
    const monarch = { x: 0, z: 0 };
    expect(followGapClearance({ x: 0, z: MONARCH_FOLLOW_GAP }, monarch, MONARCH_FOLLOW_GAP)).toBeNull();
    expect(followGapClearance({ x: 0, z: MONARCH_FOLLOW_GAP + 3 }, monarch, MONARCH_FOLLOW_GAP)).toBeNull();
  });

  test('pushes a crowding follower straight out to exactly the gap', () => {
    const monarch = { x: 10, z: 10 };
    const follower = { x: 12, z: 10 }; // 2 units east of the monarch — inside a gap of 5
    const result = followGapClearance(follower, monarch, MONARCH_FOLLOW_GAP);
    expect(result).not.toBeNull();
    // Pushed along the same monarch->follower heading (+X here), out to the gap distance.
    expect(distanceXZ(result!, monarch)).toBeCloseTo(MONARCH_FOLLOW_GAP, 5);
    expect(result!.z).toBeCloseTo(10, 5); // heading preserved, no lateral drift
    expect(result!.x).toBeGreaterThan(follower.x); // moved further out, not pulled in
  });

  test('preserves the bearing from the monarch when pushing out', () => {
    const monarch = { x: 0, z: 0 };
    const follower = { x: 3, z: 3 }; // diagonal, distance ~4.24 < gap
    const result = followGapClearance(follower, monarch, MONARCH_FOLLOW_GAP);
    expect(result).not.toBeNull();
    // Same 45-degree bearing, just at the gap radius: x and z stay equal.
    expect(result!.x).toBeCloseTo(result!.z, 5);
    expect(distanceXZ(result!, monarch)).toBeCloseTo(MONARCH_FOLLOW_GAP, 5);
  });

  test('escapes deterministically when coincident with the monarch', () => {
    const monarch = { x: 4, z: -2 };
    const result = followGapClearance({ x: 4, z: -2 }, monarch, MONARCH_FOLLOW_GAP);
    expect(result).not.toBeNull();
    // No real heading exists, so the helper picks +X and pushes out one gap — never NaN.
    expect(result).toEqual({ x: 4 + MONARCH_FOLLOW_GAP, z: -2 });
  });

  test('honors a wider gap for larger models', () => {
    const monarch = { x: 0, z: 0 };
    const follower = { x: 2, z: 0 };
    const wideGap = MONARCH_FOLLOW_GAP + 1.5; // e.g. a Yetti's larger spacing
    const result = followGapClearance(follower, monarch, wideGap);
    expect(result).not.toBeNull();
    expect(distanceXZ(result!, monarch)).toBeCloseTo(wideGap, 5);
  });
});

test.describe('clampPlacementCount', () => {
  test('caps a requested count at the available followers', () => {
    // Holding past the size of the rally must not designate phantom units.
    expect(clampPlacementCount(5, 20)).toBe(5);
    expect(clampPlacementCount(20, 20)).toBe(20);
    expect(clampPlacementCount(21, 20)).toBe(20);
  });

  test('floors negative or empty cases at zero', () => {
    expect(clampPlacementCount(3, 0)).toBe(0); // a rally with no followers designates none
    expect(clampPlacementCount(-1, 5)).toBe(0);
    expect(clampPlacementCount(2, -1)).toBe(0);
  });
});

test.describe('UNIT_PLACEMENT_INTERVAL_MS', () => {
  test('matches the documented 750ms-per-unit hold cadence', () => {
    // The teardrop indicator increments once per interval, so N seconds of hold
    // designates floor((N*1000)/interval) units.
    expect(UNIT_PLACEMENT_INTERVAL_MS).toBe(750);
    expect(Math.floor(3750 / UNIT_PLACEMENT_INTERVAL_MS)).toBe(5); // the 5-unit example
  });
});

test.describe('selectFollowersForPlacement', () => {
  const local = 'player-1';

  const followerAt = (x: number, z: number) =>
    makeUnit({ ownerId: local, animal: 'Bee', kind: 'Unit', position: { x, y: 0, z } });

  test('returns the requested number of followers nearest the destination', () => {
    const destination = { x: 0, z: 0 };
    const near = followerAt(1, 0); // distance 1
    const mid = followerAt(5, 0); // distance 5
    const far = followerAt(20, 0); // distance 20
    const followers = [far, near, mid]; // deliberately unsorted

    const chosen = selectFollowersForPlacement(followers, destination, 2);
    expect(chosen.map((u) => u.id)).toEqual([near.id, mid.id]);
  });

  test('returns an empty list for a non-positive count', () => {
    const followers = [followerAt(1, 1), followerAt(2, 2)];
    expect(selectFollowersForPlacement(followers, { x: 0, z: 0 }, 0)).toEqual([]);
    expect(selectFollowersForPlacement(followers, { x: 0, z: 0 }, -3)).toEqual([]);
  });

  test('never returns more followers than exist', () => {
    const followers = [followerAt(1, 0), followerAt(2, 0)];
    const chosen = selectFollowersForPlacement(followers, { x: 0, z: 0 }, 10);
    expect(chosen).toHaveLength(2);
  });

  test('does not mutate the input array order', () => {
    const a = followerAt(9, 0);
    const b = followerAt(1, 0);
    const followers = [a, b];
    selectFollowersForPlacement(followers, { x: 0, z: 0 }, 1);
    expect(followers).toEqual([a, b]); // sorting happens on a copy
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
