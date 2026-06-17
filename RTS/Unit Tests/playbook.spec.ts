import { test, expect } from '@playwright/test';
import {
  type PlaybookId,
  PLAYBOOK,
  PLAYBOOK_OPTIONS,
  classifyRole,
  rightAxisComponent,
} from '../src/components/Working/playbook';

/**
 * Exercises the pure playbook logic against real inputs — the per-role shape/stance
 * table, the positional role classifier, and the right-axis projection used to
 * place a team left/center/right of the army. No magic positions are hard-coded;
 * each expectation is derived from the documented geometry.
 */

const ALL_PLAYS: PlaybookId[] = ['assault', 'hold', 'pincer', 'fallBack', 'turtle'];
const ROLES = ['leftWing', 'center', 'rightWing'] as const;

test.describe('PLAYBOOK table', () => {
  test('every play defines a shape and stance for all three positional roles', () => {
    for (const id of ALL_PLAYS) {
      const playEntry = PLAYBOOK[id];
      expect(playEntry, id).toBeTruthy();
      for (const role of ROLES) {
        expect(playEntry[role].shape, `${id}.${role}.shape`).toBeTruthy();
        expect(playEntry[role].stance, `${id}.${role}.stance`).toBeTruthy();
      }
    }
  });

  test('pincer flanks with the wings while the center holds', () => {
    expect(PLAYBOOK.pincer.leftWing.shape).toBe('echelonLeft');
    expect(PLAYBOOK.pincer.rightWing.shape).toBe('echelonRight');
    expect(PLAYBOOK.pincer.center.stance).toBe('holdGround');
  });

  test('turtle boxes every role and holds ground', () => {
    for (const role of ROLES) {
      expect(PLAYBOOK.turtle[role].shape).toBe('box');
      expect(PLAYBOOK.turtle[role].stance).toBe('holdGround');
    }
  });

  test('the UI options list exactly the defined plays', () => {
    expect(PLAYBOOK_OPTIONS.map((option) => option.id).sort()).toEqual([...ALL_PLAYS].sort());
  });
});

test.describe('classifyRole', () => {
  const band = 6;

  test('a team well left of center is the left wing', () => {
    expect(classifyRole(-20, band)).toBe('leftWing');
  });

  test('a team well right of center is the right wing', () => {
    expect(classifyRole(20, band)).toBe('rightWing');
  });

  test('a team within the band is the center', () => {
    expect(classifyRole(0, band)).toBe('center');
    expect(classifyRole(band - 0.1, band)).toBe('center');
    expect(classifyRole(-(band - 0.1), band)).toBe('center');
  });
});

test.describe('rightAxisComponent', () => {
  test('facing +Z (0 rad): the right axis is world +X', () => {
    // A team offset purely in +x is fully to the right; a +z offset is none.
    expect(rightAxisComponent(5, 0, 0)).toBeCloseTo(5);
    expect(rightAxisComponent(0, 5, 0)).toBeCloseTo(0);
  });

  test('rotating the facing rotates which world direction counts as "right"', () => {
    // Facing +X (π/2): the right axis swings to world -Z, so a -z offset reads as
    // positive (to the right).
    const facing = Math.PI / 2;
    expect(rightAxisComponent(0, -5, facing)).toBeCloseTo(5);
    expect(rightAxisComponent(5, 0, facing)).toBeCloseTo(0);
  });
});
