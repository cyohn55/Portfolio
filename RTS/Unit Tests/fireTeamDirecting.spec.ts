import { test, expect } from '@playwright/test';
import type { Position3D, Unit } from '../src/game/types';
import {
  FIRE_TEAM_BUTTON_SLOTS,
  FIRE_TEAM_CANCEL_BUTTON,
  FIRE_TEAM_SEND_BUTTON,
  assignFireTeamButtons,
  directMoveTarget,
  directableFireTeamIds,
  directionForHeading,
  fireTeamCentroid,
  fireTeamMemberIds,
  headingForGroundVector,
} from '../src/components/Working/fireTeamDirecting';

/**
 * Validates the pure quick-direct helpers against the module's real outputs — every
 * assertion derives its expectation from the inputs (filter membership, slot order,
 * trig identities) rather than hard-coding a result. GamepadController feeds these
 * the live store and a controller's right-stick vector, so proving them here keeps
 * the per-frame poll loop honest without driving the rendered 3D scene.
 *
 * Run from the RTS project root:
 *   npx playwright test --config="Unit Tests/playwright.config.ts" "Unit Tests/fireTeamDirecting.spec.ts"
 */

const EPSILON = 1e-9;

// A minimal army Unit carrying only the fields the helpers read. Cast through unknown
// so the fixture stays focused on the inputs under test without inventing values for
// the dozens of unrelated optional fields on Unit.
function makeUnit(overrides: Partial<Unit>): Unit {
  return {
    id: 'U?',
    ownerId: 'p0',
    kind: 'Unit',
    hp: 100,
    ...overrides,
  } as unknown as Unit;
}

test.describe('directableFireTeamIds — which teams the gesture offers', () => {
  test('returns each owned, living team exactly once, sorted by id', () => {
    const units = [
      makeUnit({ id: 'U1', fireTeamId: 'FT3' }),
      makeUnit({ id: 'U2', fireTeamId: 'FT1' }),
      makeUnit({ id: 'U3', fireTeamId: 'FT1' }), // second member of FT1 — must not duplicate
      makeUnit({ id: 'U4', fireTeamId: 'FT2' }),
    ];
    const ids = directableFireTeamIds(units, 'p0');
    expect(ids).toEqual(['FT1', 'FT2', 'FT3']);
  });

  test('offers an unshaped squad — a fire team needs no formation entry', () => {
    // A team exists the moment a squad is deployed (it shares a fireTeamId); it does
    // NOT need to be shaped via the Directing wheel first. This was the bug that hid
    // the badges, so it is pinned here.
    const units = [makeUnit({ id: 'U1', fireTeamId: 'FT_DEPLOYED' })];
    expect(directableFireTeamIds(units, 'p0')).toEqual(['FT_DEPLOYED']);
  });

  test('excludes enemy-owned, dead, non-Unit, and team-less units', () => {
    const units = [
      makeUnit({ id: 'U1', fireTeamId: 'FT_OWN' }),
      makeUnit({ id: 'U2', fireTeamId: 'FT_ENEMY', ownerId: 'p1' }),
      makeUnit({ id: 'U3', fireTeamId: 'FT_DEAD', hp: 0 }),
      makeUnit({ id: 'U4', fireTeamId: 'FT_QUEEN', kind: 'Queen' }),
      makeUnit({ id: 'U6' }), // no fireTeamId at all
    ];
    expect(directableFireTeamIds(units, 'p0')).toEqual(['FT_OWN']);
  });

  test('returns nothing without an acting owner', () => {
    const units = [makeUnit({ id: 'U1', fireTeamId: 'FT1' })];
    expect(directableFireTeamIds(units, null)).toEqual([]);
  });
});

test.describe('assignFireTeamButtons — binding teams to buttons', () => {
  test('binds teams to the slot order, capped at the available buttons', () => {
    // More teams than slots: the surplus is intentionally unreachable by this gesture.
    const teamIds = Array.from({ length: FIRE_TEAM_BUTTON_SLOTS.length + 2 }, (_, i) => `FT${i}`);
    const assignments = assignFireTeamButtons(teamIds);

    expect(assignments).toHaveLength(FIRE_TEAM_BUTTON_SLOTS.length);
    assignments.forEach((assignment, index) => {
      expect(assignment.teamId).toBe(teamIds[index]);
      expect(assignment.token).toBe(FIRE_TEAM_BUTTON_SLOTS[index].token);
      expect(assignment.glyph).toBe(FIRE_TEAM_BUTTON_SLOTS[index].glyph);
    });
  });

  test('binds only as many slots as there are teams', () => {
    const assignments = assignFireTeamButtons(['FTa', 'FTb']);
    expect(assignments.map((a) => a.glyph)).toEqual([
      FIRE_TEAM_BUTTON_SLOTS[0].glyph,
      FIRE_TEAM_BUTTON_SLOTS[1].glyph,
    ]);
  });

  test('never offers the reserved send (RT) or cancel (B) buttons as selectors', () => {
    // RT sends and B cancels during the gesture, so neither may double as a team
    // selector — guarding the resolved ambiguity in the slot table itself.
    const selectorTokens = new Set(FIRE_TEAM_BUTTON_SLOTS.map((slot) => slot.token));
    expect(selectorTokens.has(FIRE_TEAM_SEND_BUTTON)).toBe(false);
    expect(selectorTokens.has(FIRE_TEAM_CANCEL_BUTTON)).toBe(false);
  });

  test('every selector slot is a distinct token', () => {
    const tokens = FIRE_TEAM_BUTTON_SLOTS.map((slot) => slot.token);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

test.describe('headingForGroundVector — right-stick aim to heading', () => {
  test('matches atan2(x, z) so the heading shares the formation facing convention', () => {
    // forward axis is (sin h, cos h); a vector toward (x, z) therefore has heading atan2(x, z).
    for (const [x, z] of [[1, 0], [0, 1], [-1, 0], [0.5, -0.5]]) {
      expect(headingForGroundVector(x, z)).toBeCloseTo(Math.atan2(x, z), 12);
    }
  });

  test('returns null inside the epsilon (a centered stick keeps the prior aim)', () => {
    expect(headingForGroundVector(0, 0)).toBeNull();
    expect(headingForGroundVector(1e-6, -1e-6)).toBeNull();
    expect(headingForGroundVector(1e-3, 0)).not.toBeNull(); // outside the default epsilon
  });
});

test.describe('directionForHeading — heading back to a ground direction', () => {
  test('is the unit vector (sin h, cos h) and round-trips through headingForGroundVector', () => {
    for (const heading of [0, Math.PI / 3, -Math.PI / 2, 2.5]) {
      const direction = directionForHeading(heading);
      expect(Math.hypot(direction.x, direction.z)).toBeCloseTo(1, 12);
      expect(direction.x).toBeCloseTo(Math.sin(heading), 12);
      expect(direction.z).toBeCloseTo(Math.cos(heading), 12);
      // Recovering the heading from the direction returns the original aim.
      expect(headingForGroundVector(direction.x, direction.z)).toBeCloseTo(heading, 12);
    }
  });
});

test.describe('directMoveTarget — where the team is sent', () => {
  test('lies exactly `distance` from the anchor along the heading, on the ground', () => {
    const anchor: Position3D = { x: 10, y: 0, z: -4 };
    const distance = 60;
    for (const heading of [0, Math.PI / 4, Math.PI, -1.2]) {
      const target = directMoveTarget(anchor, heading, distance);
      const dx = target.x - anchor.x;
      const dz = target.z - anchor.z;
      expect(Math.hypot(dx, dz)).toBeCloseTo(distance, 9);
      expect(Math.atan2(dx, dz)).toBeCloseTo(heading === Math.PI ? Math.PI : heading, 9);
      expect(target.y).toBe(0); // a ground move order, matching moveCommand's target
    }
  });

  test('a zero distance leaves the team on its anchor', () => {
    const anchor: Position3D = { x: 3, y: 5, z: 7 };
    const target = directMoveTarget(anchor, 1.0, 0);
    expect(Math.hypot(target.x - anchor.x, target.z - anchor.z)).toBeLessThan(EPSILON);
  });
});

test.describe('fireTeamMemberIds — the units the move command addresses', () => {
  test('returns only the owned, living army members of the team', () => {
    const units = [
      makeUnit({ id: 'U1', fireTeamId: 'FT1' }),
      makeUnit({ id: 'U2', fireTeamId: 'FT1' }),
      makeUnit({ id: 'U3', fireTeamId: 'FT1', hp: 0 }),        // dead — excluded
      makeUnit({ id: 'U4', fireTeamId: 'FT1', ownerId: 'p1' }), // enemy — excluded
      makeUnit({ id: 'U5', fireTeamId: 'FT2' }),               // other team — excluded
      makeUnit({ id: 'U6', fireTeamId: 'FT1', kind: 'Queen' }), // not an army Unit — excluded
    ];
    expect(fireTeamMemberIds(units, 'FT1', 'p0').sort()).toEqual(['U1', 'U2']);
  });

  test('returns nothing without an acting owner', () => {
    const units = [makeUnit({ id: 'U1', fireTeamId: 'FT1' })];
    expect(fireTeamMemberIds(units, 'FT1', null)).toEqual([]);
  });
});

test.describe('fireTeamCentroid — the arrow origin and move basis', () => {
  test('is the mean of the team\'s living owned members, flattened to the ground', () => {
    const units = [
      makeUnit({ id: 'U1', fireTeamId: 'FT1', position: { x: 0, y: 1, z: 0 } }),
      makeUnit({ id: 'U2', fireTeamId: 'FT1', position: { x: 10, y: 2, z: 4 } }),
      makeUnit({ id: 'U3', fireTeamId: 'FT1', position: { x: 2, y: 0, z: -4 } }),
      makeUnit({ id: 'U4', fireTeamId: 'FT1', position: { x: 99, y: 0, z: 99 }, hp: 0 }), // dead — ignored
      makeUnit({ id: 'U5', fireTeamId: 'FT2', position: { x: 50, y: 0, z: 50 } }),        // other team
    ];
    const center = fireTeamCentroid(units, 'FT1', 'p0');
    expect(center).not.toBeNull();
    expect(center!.x).toBeCloseTo((0 + 10 + 2) / 3, 9);
    expect(center!.z).toBeCloseTo((0 + 4 + -4) / 3, 9);
    expect(center!.y).toBe(0); // a ground point regardless of member elevation
  });

  test('is null for a team with no living owned members', () => {
    const units = [makeUnit({ id: 'U1', fireTeamId: 'FT1', position: { x: 0, y: 0, z: 0 }, hp: 0 })];
    expect(fireTeamCentroid(units, 'FT1', 'p0')).toBeNull();
    expect(fireTeamCentroid(units, 'FT1', null)).toBeNull();
  });
});
