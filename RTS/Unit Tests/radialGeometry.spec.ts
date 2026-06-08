import { test, expect } from '@playwright/test';
import {
  type RadialHover,
  FIRE_BAND,
  POSTURE_BAND,
  hoverFromVector,
  wedgeFromVector,
} from '../src/components/Working/radialGeometry';

/**
 * Exercises the real radial geometry against real right-stick vectors. The radial
 * has five posture wedges (inner ring) and five priority wedges (outer ring), so
 * the tests derive every expectation from those counts and the documented layout
 * (wedge 0 at the top, clockwise) rather than hard-coding magic indices.
 */

const POSTURE_COUNT = 5;
const PRIORITY_COUNT = 5;

// Build the unit vector that points straight at wedge `index` of `count`, using
// the same -90°-at-top, clockwise, x-right / y-down convention the module lays the
// wedges out with. Used so the tests describe "aim at wedge i" without restating
// the module's own arithmetic verbatim.
function aimAtWedge(index: number, count: number): { x: number; y: number } {
  const deg = -90 + index * (360 / count);
  const rad = (deg * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

test.describe('wedgeFromVector', () => {
  test('maps a vector aimed at each wedge back to that wedge index', () => {
    for (let index = 0; index < POSTURE_COUNT; index++) {
      const { x, y } = aimAtWedge(index, POSTURE_COUNT);
      expect(wedgeFromVector(x, y, POSTURE_COUNT)).toBe(index);
    }
  });

  test('places wedge 0 straight up (stick up is negative y)', () => {
    expect(wedgeFromVector(0, -1, POSTURE_COUNT)).toBe(0);
  });

  test('resolves a vector between two wedges to the nearer one', () => {
    // Nudge the top wedge's aim slightly toward wedge 1; it must still pick wedge 0.
    const a = aimAtWedge(0, POSTURE_COUNT);
    const b = aimAtWedge(1, POSTURE_COUNT);
    const nearTop = { x: a.x * 0.9 + b.x * 0.1, y: a.y * 0.9 + b.y * 0.1 };
    expect(wedgeFromVector(nearTop.x, nearTop.y, POSTURE_COUNT)).toBe(0);
  });

  test('wraps correctly across the ±180° seam for a different wedge count', () => {
    for (let index = 0; index < PRIORITY_COUNT; index++) {
      const { x, y } = aimAtWedge(index, PRIORITY_COUNT);
      expect(wedgeFromVector(x, y, PRIORITY_COUNT)).toBe(index);
    }
  });
});

test.describe('hoverFromVector ring selection', () => {
  test('a near-rest stick addresses the center fire toggle', () => {
    const hover: RadialHover = hoverFromVector(0, 0, POSTURE_COUNT, PRIORITY_COUNT);
    expect(hover.ring).toBe('fire');
  });

  test('a deflection just below the fire band still addresses fire', () => {
    const magnitude = FIRE_BAND - 0.05;
    const hover = hoverFromVector(0, -magnitude, POSTURE_COUNT, PRIORITY_COUNT);
    expect(hover.ring).toBe('fire');
  });

  test('a mid deflection addresses the posture ring at the aimed wedge', () => {
    const magnitude = (FIRE_BAND + POSTURE_BAND) / 2;
    for (let index = 0; index < POSTURE_COUNT; index++) {
      const dir = aimAtWedge(index, POSTURE_COUNT);
      const hover = hoverFromVector(dir.x * magnitude, dir.y * magnitude, POSTURE_COUNT, PRIORITY_COUNT);
      expect(hover.ring).toBe('posture');
      expect(hover.index).toBe(index);
    }
  });

  test('a full deflection addresses the priority ring at the aimed wedge', () => {
    for (let index = 0; index < PRIORITY_COUNT; index++) {
      const dir = aimAtWedge(index, PRIORITY_COUNT); // already unit length (magnitude 1)
      const hover = hoverFromVector(dir.x, dir.y, POSTURE_COUNT, PRIORITY_COUNT);
      expect(hover.ring).toBe('priority');
      expect(hover.index).toBe(index);
    }
  });

  test('the band boundaries are inclusive toward the outer ring', () => {
    // Exactly at FIRE_BAND leaves fire (→ posture); exactly at POSTURE_BAND leaves
    // posture (→ priority). Verifies the boundary ownership the radial relies on.
    expect(hoverFromVector(0, -FIRE_BAND, POSTURE_COUNT, PRIORITY_COUNT).ring).toBe('posture');
    expect(hoverFromVector(0, -POSTURE_BAND, POSTURE_COUNT, PRIORITY_COUNT).ring).toBe('priority');
  });
});
