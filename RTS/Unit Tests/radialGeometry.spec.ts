import { test, expect } from '@playwright/test';
import {
  type RadialHover,
  FIRE_BAND,
  fullRingAngleDeg,
  hoverFromVector,
  ringIndexFromVector,
  semicircleAngleDeg,
} from '../src/components/Working/radialGeometry';

/**
 * Exercises the real radial geometry against real right-stick vectors. The radial
 * is a single ring split into a top half of posture options and a bottom half of
 * priority options, around a center fire toggle. The tests derive every
 * expectation from the documented layout (top half = upper semicircle, bottom half
 * = lower semicircle) and the option counts rather than hard-coding magic angles.
 */

const POSTURE_COUNT = 5;
const PRIORITY_COUNT = 5;

// Unit vector pointing at a screen angle (0°=right, 90°=down, 270°=up), the same
// convention the module lays options out with. Lets the tests describe "aim here"
// without restating the module's own arithmetic.
function aimAt(angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

test.describe('semicircleAngleDeg', () => {
  test('places the top half across the upper semicircle (180°–360°)', () => {
    for (let i = 0; i < POSTURE_COUNT; i++) {
      const angle = semicircleAngleDeg('top', i, POSTURE_COUNT);
      expect(angle).toBeGreaterThan(180);
      expect(angle).toBeLessThan(360);
      // Upper semicircle ⇒ screen-y is negative (up).
      expect(Math.sin((angle * Math.PI) / 180)).toBeLessThan(0);
    }
  });

  test('places the bottom half across the lower semicircle (0°–180°)', () => {
    for (let j = 0; j < PRIORITY_COUNT; j++) {
      const angle = semicircleAngleDeg('bottom', j, PRIORITY_COUNT);
      expect(angle).toBeGreaterThan(0);
      expect(angle).toBeLessThan(180);
      // Lower semicircle ⇒ screen-y is positive (down).
      expect(Math.sin((angle * Math.PI) / 180)).toBeGreaterThan(0);
    }
  });

  test('centers each option in an equal sub-arc, leaving clean gaps at the split', () => {
    // No option sits on the horizontal split line (0° or 180°): the nearest is half
    // a sub-arc away, so the two halves meet at clean gaps.
    const half = 180 / POSTURE_COUNT;
    expect(semicircleAngleDeg('bottom', 0, PRIORITY_COUNT)).toBeCloseTo(half / 2, 6);
    expect(semicircleAngleDeg('top', 0, POSTURE_COUNT)).toBeCloseTo(180 + half / 2, 6);
  });
});

test.describe('hoverFromVector', () => {
  test('a near-rest stick addresses the center fire toggle', () => {
    const hover: RadialHover = hoverFromVector(0, 0, POSTURE_COUNT, PRIORITY_COUNT);
    expect(hover.ring).toBe('fire');
  });

  test('a deflection just below the fire band still addresses fire', () => {
    const hover = hoverFromVector(0, -(FIRE_BAND - 0.05), POSTURE_COUNT, PRIORITY_COUNT);
    expect(hover.ring).toBe('fire');
  });

  test('aiming at each posture angle (top half) selects that posture', () => {
    for (let i = 0; i < POSTURE_COUNT; i++) {
      const dir = aimAt(semicircleAngleDeg('top', i, POSTURE_COUNT));
      const hover = hoverFromVector(dir.x, dir.y, POSTURE_COUNT, PRIORITY_COUNT);
      expect(hover.ring).toBe('posture');
      expect(hover.index).toBe(i);
    }
  });

  test('aiming at each priority angle (bottom half) selects that priority', () => {
    for (let j = 0; j < PRIORITY_COUNT; j++) {
      const dir = aimAt(semicircleAngleDeg('bottom', j, PRIORITY_COUNT));
      const hover = hoverFromVector(dir.x, dir.y, POSTURE_COUNT, PRIORITY_COUNT);
      expect(hover.ring).toBe('priority');
      expect(hover.index).toBe(j);
    }
  });

  test('straight up selects a posture, straight down selects a priority', () => {
    expect(hoverFromVector(0, -1, POSTURE_COUNT, PRIORITY_COUNT).ring).toBe('posture');
    expect(hoverFromVector(0, 1, POSTURE_COUNT, PRIORITY_COUNT).ring).toBe('priority');
  });

  test('any upper-half aim resolves to posture, any lower-half aim to priority', () => {
    for (const angle of [200, 250, 270, 300, 340]) {
      expect(hoverFromVector(...aimedAt(angle), POSTURE_COUNT, PRIORITY_COUNT).ring).toBe('posture');
    }
    for (const angle of [20, 60, 90, 120, 160]) {
      expect(hoverFromVector(...aimedAt(angle), POSTURE_COUNT, PRIORITY_COUNT).ring).toBe('priority');
    }
  });
});

// Tuple form of aimAt so the vector can be spread straight into hoverFromVector.
function aimedAt(angleDeg: number): [number, number] {
  const { x, y } = aimAt(angleDeg);
  return [x, y];
}

// The formation wheel's full ring (no center action). Exercised against the same
// aim vectors with a representative option count.
const FORMATION_COUNT = 7;

test.describe('fullRingAngleDeg', () => {
  test('places index 0 at the top of the ring (270°/−90°)', () => {
    // Screen convention: up is −90° ≡ 270°; sin should be negative (pointing up).
    expect(fullRingAngleDeg(0, FORMATION_COUNT)).toBeCloseTo(-90, 6);
    expect(Math.sin((fullRingAngleDeg(0, FORMATION_COUNT) * Math.PI) / 180)).toBeLessThan(0);
  });

  test('steps clockwise by an equal arc per option', () => {
    const step = 360 / FORMATION_COUNT;
    for (let i = 1; i < FORMATION_COUNT; i++) {
      expect(fullRingAngleDeg(i, FORMATION_COUNT) - fullRingAngleDeg(i - 1, FORMATION_COUNT)).toBeCloseTo(step, 6);
    }
  });
});

test.describe('ringIndexFromVector', () => {
  test('a near-rest stick addresses no option (null)', () => {
    expect(ringIndexFromVector(0, 0, FORMATION_COUNT)).toBeNull();
    expect(ringIndexFromVector(0, -(FIRE_BAND - 0.05), FORMATION_COUNT)).toBeNull();
  });

  test('aiming at each option angle selects that option', () => {
    for (let i = 0; i < FORMATION_COUNT; i++) {
      const dir = aimAt(fullRingAngleDeg(i, FORMATION_COUNT));
      expect(ringIndexFromVector(dir.x, dir.y, FORMATION_COUNT)).toBe(i);
    }
  });

  test('a deflected stick always resolves to a real option index', () => {
    for (const angle of [0, 45, 90, 135, 180, 225, 315]) {
      const index = ringIndexFromVector(...aimedAt(angle), FORMATION_COUNT);
      expect(index).not.toBeNull();
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(FORMATION_COUNT);
    }
  });

  test('returns null for an empty ring', () => {
    expect(ringIndexFromVector(1, 0, 0)).toBeNull();
  });
});
