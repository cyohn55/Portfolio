import { test, expect } from '@playwright/test';
import type { Position3D } from '../src/game/types';
import {
  type FormationShape,
  assignSlots,
  centroidOf,
  defaultSpacingFor,
  meanHeading,
  slotOffsets,
  worldSlot,
} from '../src/components/Working/formations';

/**
 * Validates the pure formation-shape geometry against the module's real outputs —
 * no slot positions are hard-coded; each assertion derives the expected property
 * (count, symmetry, spacing, rotation) from the inputs the way the game will. The
 * tick in state.ts applies these world slots to unit orders, so proving the
 * geometry deterministic and well-formed here keeps the heavier game loop honest.
 * Run with: npx playwright test --config "Unit Tests/playwright.config.ts"
 */

const ALL_SHAPES: FormationShape[] = [
  'line',
  'column',
  'wedge',
  'box',
  'echelonLeft',
  'echelonRight',
  'skirmish',
];

const EPSILON = 1e-9;

function distance2D(a: Position3D, b: Position3D): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

test.describe('slotOffsets — shape geometry', () => {
  test('returns exactly one slot per member for every shape and size', () => {
    for (const shape of ALL_SHAPES) {
      for (const count of [1, 2, 3, 5, 8, 13]) {
        expect(slotOffsets(shape, count).length, `${shape} x${count}`).toBe(count);
      }
    }
  });

  test('yields nothing for a non-positive count', () => {
    for (const shape of ALL_SHAPES) {
      expect(slotOffsets(shape, 0)).toEqual([]);
      expect(slotOffsets(shape, -3)).toEqual([]);
    }
  });

  test('column files straight back along the heading', () => {
    const spacing = defaultSpacingFor('column');
    const slots = slotOffsets('column', 4);
    // Lead sits on the anchor; each follower trails one spacing further back.
    expect(slots[0].right).toBeCloseTo(0);
    expect(slots[0].forward).toBeCloseTo(0);
    slots.forEach((slot, index) => {
      expect(slot.right).toBeCloseTo(0);
      expect(slot.forward).toBeCloseTo(-index * spacing);
    });
  });

  test('wedge keeps its tip on the anchor and opens behind it', () => {
    const slots = slotOffsets('wedge', 5);
    expect(slots[0]).toEqual({ right: 0, forward: 0 });
    // Every other member trails the tip (never ahead of the heading).
    for (const slot of slots.slice(1)) {
      expect(slot.forward).toBeLessThan(0);
    }
    // Wings are mirrored: the signed-right offsets sum to zero across the V.
    const rightSum = slots.reduce((sum, slot) => sum + slot.right, 0);
    expect(rightSum).toBeCloseTo(0);
  });

  test('line and skirmish stay centered on the anchor', () => {
    // Their bounding box is centered on the anchor (true even when a skirmish
    // grid's final rank is partially filled), so the squad straddles the point.
    for (const shape of ['line', 'skirmish'] as FormationShape[]) {
      const slots = slotOffsets(shape, 6);
      const rights = slots.map((o) => o.right);
      const forwards = slots.map((o) => o.forward);
      expect((Math.min(...rights) + Math.max(...rights)) / 2, `${shape} right`).toBeCloseTo(0);
      expect((Math.min(...forwards) + Math.max(...forwards)) / 2, `${shape} forward`).toBeCloseTo(0);
    }
  });

  test('echelon left and right are mirror images across the heading', () => {
    const left = slotOffsets('echelonLeft', 5);
    const right = slotOffsets('echelonRight', 5);
    left.forEach((slot, index) => {
      expect(slot.forward).toBeCloseTo(right[index].forward);
      expect(slot.right).toBeCloseTo(-right[index].right);
    });
  });

  test('skirmish spreads wider than line for the same team', () => {
    // The whole point of skirmish is dispersal vs. area effects.
    expect(defaultSpacingFor('skirmish')).toBeGreaterThan(defaultSpacingFor('line'));
  });

  test('a custom spacing scales the slot geometry proportionally', () => {
    const base = slotOffsets('line', 5, 4);
    const wide = slotOffsets('line', 5, 8);
    base.forEach((slot, index) => {
      expect(wide[index].right).toBeCloseTo(slot.right * 2);
    });
  });

  test('no two members share a slot in any shape', () => {
    for (const shape of ALL_SHAPES) {
      const slots = slotOffsets(shape, 9);
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          const apart = Math.hypot(
            slots[i].right - slots[j].right,
            slots[i].forward - slots[j].forward
          );
          expect(apart, `${shape} slots ${i},${j}`).toBeGreaterThan(EPSILON);
        }
      }
    }
  });
});

test.describe('worldSlot — projection around anchor + heading', () => {
  const anchor: Position3D = { x: 10, y: 2, z: -5 };

  test('a zero offset lands exactly on the anchor at any heading', () => {
    for (const facing of [0, Math.PI / 3, Math.PI, -Math.PI / 2]) {
      const at = worldSlot(anchor, facing, { right: 0, forward: 0 });
      expect(at.x).toBeCloseTo(anchor.x);
      expect(at.z).toBeCloseTo(anchor.z);
      expect(at.y).toBe(anchor.y);
    }
  });

  test('facing +Z (0 rad): forward moves +Z and right moves +X', () => {
    const forward = worldSlot(anchor, 0, { right: 0, forward: 7 });
    expect(forward.z).toBeCloseTo(anchor.z + 7);
    expect(forward.x).toBeCloseTo(anchor.x);
    const right = worldSlot(anchor, 0, { right: 3, forward: 0 });
    expect(right.x).toBeCloseTo(anchor.x + 3);
    expect(right.z).toBeCloseTo(anchor.z);
  });

  test('rotating the heading rotates the whole slot rigidly', () => {
    // A quarter turn (heading +X) should send a "forward" offset onto +X.
    const facing = Math.PI / 2;
    const at = worldSlot(anchor, facing, { right: 0, forward: 7 });
    expect(at.x).toBeCloseTo(anchor.x + 7);
    expect(at.z).toBeCloseTo(anchor.z);
  });

  test('rotation preserves the distance from the anchor', () => {
    const offset = { right: 4, forward: 3 }; // 5-unit hypotenuse
    for (const facing of [0, 1, 2.5, -1.2, Math.PI]) {
      const at = worldSlot(anchor, facing, offset);
      expect(distance2D(at, anchor)).toBeCloseTo(5);
    }
  });
});

test.describe('assignSlots — deterministic member mapping', () => {
  const anchor: Position3D = { x: 0, y: 0, z: 0 };

  test('maps every member to a distinct world slot', () => {
    const ids = ['u3', 'u1', 'u2', 'u5', 'u4'];
    const assignment = assignSlots(ids, 'line', anchor, 0);
    expect(Object.keys(assignment).sort()).toEqual([...ids].sort());
    const positions = Object.values(assignment);
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        expect(distance2D(positions[i], positions[j])).toBeGreaterThan(EPSILON);
      }
    }
  });

  test('is independent of input order (lockstep determinism)', () => {
    const ordered = ['a', 'b', 'c', 'd'];
    const shuffled = ['d', 'b', 'a', 'c'];
    const fromOrdered = assignSlots(ordered, 'wedge', anchor, 0.7);
    const fromShuffled = assignSlots(shuffled, 'wedge', anchor, 0.7);
    expect(fromShuffled).toEqual(fromOrdered);
  });

  test('respects the same spacing override the shape geometry uses', () => {
    // The lead (lowest id) sits on the anchor for a wedge; the spacing override
    // must flow through to the projected world positions, not just the offsets.
    const tight = assignSlots(['a', 'b', 'c'], 'wedge', anchor, 0, 4);
    const loose = assignSlots(['a', 'b', 'c'], 'wedge', anchor, 0, 8);
    expect(distance2D(loose.b, anchor)).toBeCloseTo(distance2D(tight.b, anchor) * 2);
  });
});

test.describe('meanHeading — default formation facing', () => {
  test('averages identical headings to that heading', () => {
    expect(meanHeading([1.2, 1.2, 1.2])).toBeCloseTo(1.2);
  });

  test('returns 0 for no members', () => {
    expect(meanHeading([])).toBe(0);
  });

  test('averages across the -pi/pi wrap without flipping to the opposite side', () => {
    // Two headings just either side of +/-pi average to pi, not to ~0 (which a
    // naive numeric mean of [pi-0.1, -(pi-0.1)] would wrongly produce).
    const justUnderPi = Math.PI - 0.1;
    const justOverNegPi = -(Math.PI - 0.1);
    expect(Math.abs(meanHeading([justUnderPi, justOverNegPi]))).toBeCloseTo(Math.PI);
  });

  test('two perpendicular headings average to the bisector', () => {
    expect(meanHeading([0, Math.PI / 2])).toBeCloseTo(Math.PI / 4);
  });
});

test.describe('centroidOf — formation anchor', () => {
  test('is the mean of member positions, flattened to y=0', () => {
    const center = centroidOf([
      { x: 0, y: 5, z: 0 },
      { x: 10, y: 1, z: 0 },
      { x: 5, y: 9, z: 30 },
    ]);
    expect(center.x).toBeCloseTo(5);
    expect(center.z).toBeCloseTo(10);
    expect(center.y).toBe(0);
  });

  test('is independent of summation order (lockstep determinism)', () => {
    const positions = [
      { x: 1, y: 0, z: 2 },
      { x: -4, y: 0, z: 9 },
      { x: 7, y: 0, z: -3 },
    ];
    const forward = centroidOf(positions);
    const reversed = centroidOf([...positions].reverse());
    expect(reversed).toEqual(forward);
  });

  test('returns the origin for no members', () => {
    expect(centroidOf([])).toEqual({ x: 0, y: 0, z: 0 });
  });
});
