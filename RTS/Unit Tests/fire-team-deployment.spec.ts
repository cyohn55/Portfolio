import { test, expect } from '@playwright/test';
import type { AnimalId, Unit, UnitKind } from '../src/game/types';
import {
  PLACEMENT_LADDER,
  clampPlacementCount,
  listFireTeamIds,
  nextFireTeamInCycle,
  nextPlacementStep,
} from '../src/components/Working/monarchPilot';

/**
 * Validates the two new deployment features against the real monarchPilot
 * helpers and real Unit-shaped inputs (no values are hard-coded into the module
 * under test):
 *   1. the deployment ladder (the Deploy hold steps 1 -> 5 -> 10 -> 15 -> 25),
 *   2. fire-team grouping/cycling (deployed squads the player drives remotely).
 * The store and tick build on these pure pieces, so validating them in isolation
 * keeps the heavier game loop honest.
 * Run with: npx playwright test --config "Unit Tests/playwright.config.ts"
 */

let unitCounter = 0;

// Build a real Unit so the helpers operate on the exact shape the game uses;
// tests override only the fields they assert on.
function makeUnit(
  overrides: Partial<Unit> & { ownerId: string; animal: AnimalId; kind: UnitKind }
): Unit {
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

test.describe('nextPlacementStep (deployment ladder)', () => {
  test('climbs the exact 1, 5, 10, 15, 25 ladder the design calls for', () => {
    // Starting from no designated units, hold the Deploy and read each rung.
    const climbed: number[] = [];
    let count = 0;
    for (let i = 0; i < PLACEMENT_LADDER.length; i++) {
      count = nextPlacementStep(count);
      climbed.push(count);
    }
    expect(climbed).toEqual([1, 5, 10, 15, 25]);
  });

  test('is strictly monotonic so the hold can never stall mid-climb', () => {
    let previous = 0;
    for (let i = 0; i < 12; i++) {
      const next = nextPlacementStep(previous);
      expect(next).toBeGreaterThan(previous);
      previous = next;
    }
  });

  test('continues past the top rung by the final stride', () => {
    // Past 25 the ladder keeps climbing by its final stride (25 - 15 = 10).
    expect(nextPlacementStep(25)).toBe(35);
    expect(nextPlacementStep(35)).toBe(45);
  });

  test('jumps to the right rung from an in-between count', () => {
    // A count that is not itself a rung still advances to the next rung up.
    expect(nextPlacementStep(3)).toBe(5);
    expect(nextPlacementStep(7)).toBe(10);
  });

  test('clamps to the followers actually available', () => {
    // With only 7 followers, the 10-rung is held back to 7 and then stays put.
    expect(clampPlacementCount(nextPlacementStep(5), 7)).toBe(7);
    expect(clampPlacementCount(nextPlacementStep(7), 7)).toBe(7);
  });
});

test.describe('listFireTeamIds', () => {
  const owner = 'player-1';

  test('returns each living owner team once, in creation order', () => {
    const units = [
      makeUnit({ ownerId: owner, animal: 'Bee', kind: 'Unit', fireTeamId: 'FT-2' }),
      makeUnit({ ownerId: owner, animal: 'Bee', kind: 'Unit', fireTeamId: 'FT-10' }),
      makeUnit({ ownerId: owner, animal: 'Bee', kind: 'Unit', fireTeamId: 'FT-2' }),
    ];
    // Sorted by the numeric suffix (creation order) — not lexically, which would
    // put FT-10 before FT-2.
    expect(listFireTeamIds(units, owner)).toEqual(['FT-2', 'FT-10']);
  });

  test('omits other owners, ungrouped units, and wiped-out teams', () => {
    const units = [
      makeUnit({ ownerId: owner, animal: 'Bee', kind: 'Unit', fireTeamId: 'FT-1' }),
      makeUnit({ ownerId: 'ai-1', animal: 'Bear', kind: 'Unit', fireTeamId: 'FT-9' }),
      makeUnit({ ownerId: owner, animal: 'Bee', kind: 'Unit' }), // still trailing, no team
      makeUnit({ ownerId: owner, animal: 'Bee', kind: 'Unit', fireTeamId: 'FT-3', hp: 0 }), // dead
    ];
    expect(listFireTeamIds(units, owner)).toEqual(['FT-1']);
  });
});

test.describe('nextFireTeamInCycle', () => {
  const teams = ['FT-1', 'FT-2'];

  test('starts at the first team when none is being driven', () => {
    expect(nextFireTeamInCycle(teams, null)).toBe('FT-1');
  });

  test('advances to the next team', () => {
    expect(nextFireTeamInCycle(teams, 'FT-1')).toBe('FT-2');
  });

  test('wraps off (releases) after the last team so the key toggles off', () => {
    expect(nextFireTeamInCycle(teams, 'FT-2')).toBeNull();
  });

  test('returns null when there are no teams', () => {
    expect(nextFireTeamInCycle([], null)).toBeNull();
  });

  test('falls back to the first team if the current team no longer exists', () => {
    // The driven team was wiped out (dropped from the list) — cycling re-enters
    // the cycle at the first surviving team rather than getting stuck.
    expect(nextFireTeamInCycle(teams, 'FT-99')).toBe('FT-1');
  });
});
