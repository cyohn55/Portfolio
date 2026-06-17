// Pure, deterministic formation-shape geometry for fire teams.
//
// A fire team is a set of army Units sharing a fireTeamId (see types.ts). A
// *formation* gives each member a target SLOT — an offset in the team's local
// frame (right, forward) projected around a team anchor + facing — so the squad
// holds a recognizable shape (line, wedge, column, ...) instead of collapsing to
// one point and relying on the separation pass to spread it out. This module owns
// only the geometry: given a shape, a member count, and a spacing it returns the
// ordered slot offsets, and projects a single offset into world space around an
// anchor + heading. The tick in state.ts is the only place these world slots are
// applied to unit move orders; nothing here mutates state.
//
// Determinism contract (mirrors unitBehavior.ts): nothing here reads wall-clock
// time or Math.random, and slot order is purely positional. A caller that hands
// members over in a stable order (sorted by entity id) therefore gets an identical
// slot assignment on both lockstep peers.

import type { FormationShape, FireTeamRole, Position3D } from '../../game/types';

// The shape + role vocabulary is owned by game/types.ts (the single source of
// truth shared with the game state and the setFormation command). Re-exported
// here so callers that work in terms of formation geometry can import both the
// types and the functions from one place.
//   line:        abreast across the facing — maximum frontage / firing line
//   column:      single file along the facing — threads chokepoints and bridges
//   wedge:       arrowhead, lead at the tip, wings trailing back — assault
//   box:         hollow square perimeter — all-around defense, monarch inside
//   echelonLeft: staggered diagonal trailing back-left — refused flank
//   echelonRight:staggered diagonal trailing back-right
//   skirmish:    loose multi-row grid at wide spacing — disperses vs. AoE
export type { FormationShape, FireTeamRole };

// A slot in the team's local frame. `right` is signed distance along the facing's
// right-hand axis (left is negative); `forward` is signed distance along the
// heading (behind the anchor is negative). Both are world units.
export interface SlotOffset {
  right: number;
  forward: number;
}

// --- Tuning constants -------------------------------------------------------
// Default inter-slot spacing per shape, in world units. Gathered here (not buried
// in the tick) so a balance pass has one place to tune. Skirmish spreads wide to
// blunt area effects; column packs tight to fit a bridge deck. Starting points,
// expected to move with playtesting.

const DEFAULT_SPACING: Record<FormationShape, number> = {
  line: 6,
  column: 6,
  wedge: 6,
  box: 6,
  echelonLeft: 6,
  echelonRight: 6,
  skirmish: 12,
};

// Maximum members placed across a single skirmish/box row before wrapping to the
// next rank, so a large team forms a believable block rather than one long line.
const SKIRMISH_ROW_WIDTH = 5;

/** The default inter-slot spacing a shape uses when the caller supplies none. */
export function defaultSpacingFor(shape: FormationShape): number {
  return DEFAULT_SPACING[shape];
}

// --- Slot geometry ----------------------------------------------------------

// Centered positions along one axis: for n slots returns n values spaced `spacing`
// apart and symmetric about 0 (so the formation's centroid stays on the anchor).
// Example: n=3 -> [-spacing, 0, spacing]; n=2 -> [-spacing/2, spacing/2].
function centeredAxis(count: number, spacing: number): number[] {
  const positions: number[] = [];
  const half = (count - 1) / 2;
  for (let index = 0; index < count; index++) {
    positions.push((index - half) * spacing);
  }
  return positions;
}

function lineSlots(count: number, spacing: number): SlotOffset[] {
  return centeredAxis(count, spacing).map((right) => ({ right, forward: 0 }));
}

function columnSlots(count: number, spacing: number): SlotOffset[] {
  // Slot 0 is the lead at the anchor; each subsequent member trails directly
  // behind it (negative forward), so the file points along the heading.
  const slots: SlotOffset[] = [];
  for (let index = 0; index < count; index++) {
    slots.push({ right: 0, forward: -index * spacing });
  }
  return slots;
}

function wedgeSlots(count: number, spacing: number): SlotOffset[] {
  // Slot 0 is the tip at the anchor. Remaining members fill outward in mirrored
  // pairs that step back one rank and out one column per pair, forming a "V" that
  // opens behind the heading.
  const slots: SlotOffset[] = [{ right: 0, forward: 0 }];
  let rank = 1;
  let placed = 1;
  while (placed < count) {
    const back = -rank * spacing;
    const side = rank * spacing;
    slots.push({ right: -side, forward: back });
    placed++;
    if (placed < count) {
      slots.push({ right: side, forward: back });
      placed++;
    }
    rank++;
  }
  return slots;
}

function gridSlots(count: number, spacing: number, rowWidth: number): SlotOffset[] {
  // A centered block: fill left-to-right across a rank, then drop back a rank.
  // The whole grid is re-centered on both axes so its centroid sits on the anchor.
  const rows = Math.ceil(count / rowWidth);
  const slots: SlotOffset[] = [];
  for (let index = 0; index < count; index++) {
    const row = Math.floor(index / rowWidth);
    const col = index % rowWidth;
    const colsInRow = Math.min(rowWidth, count - row * rowWidth);
    const rightOffset = (col - (colsInRow - 1) / 2) * spacing;
    const forwardOffset = -(row - (rows - 1) / 2) * spacing;
    slots.push({ right: rightOffset, forward: forwardOffset });
  }
  return slots;
}

function boxSlots(count: number, spacing: number): SlotOffset[] {
  // Hollow square perimeter sized to hold every member, distributed evenly around
  // the ring so the interior stays open (room for the monarch). Falls back to a
  // single centered slot for a lone member.
  if (count <= 1) return [{ right: 0, forward: 0 }];
  const perSide = Math.ceil(count / 4);
  const extent = (perSide * spacing) / 2;
  const ring: SlotOffset[] = [];
  // Walk the four edges; corners are shared so we step (perSide) points per edge.
  const step = (2 * extent) / perSide;
  for (let i = 0; i < perSide; i++) ring.push({ right: -extent + i * step, forward: extent }); // front edge, L->R
  for (let i = 0; i < perSide; i++) ring.push({ right: extent, forward: extent - i * step }); // right edge, front->back
  for (let i = 0; i < perSide; i++) ring.push({ right: extent - i * step, forward: -extent }); // back edge, R->L
  for (let i = 0; i < perSide; i++) ring.push({ right: -extent, forward: -extent + i * step }); // left edge, back->front
  return ring.slice(0, count);
}

function echelonSlots(count: number, spacing: number, toLeft: boolean): SlotOffset[] {
  // Diagonal stagger: slot 0 leads at the anchor; each subsequent member steps
  // back one rank and out one column to the refused side, forming a "/" or "\".
  const sideSign = toLeft ? -1 : 1;
  const slots: SlotOffset[] = [];
  for (let index = 0; index < count; index++) {
    slots.push({ right: sideSign * index * spacing, forward: -index * spacing });
  }
  return slots;
}

/**
 * The ordered slot offsets for a formation shape holding `count` members. Index 0
 * is the lead/anchor-most slot (tip of a wedge, head of a column, front-left of a
 * line). `spacing` overrides the shape default. Returns exactly `count` offsets;
 * an empty array for count <= 0.
 */
export function slotOffsets(
  shape: FormationShape,
  count: number,
  spacing: number = defaultSpacingFor(shape)
): SlotOffset[] {
  if (count <= 0) return [];
  switch (shape) {
    case 'line':
      return lineSlots(count, spacing);
    case 'column':
      return columnSlots(count, spacing);
    case 'wedge':
      return wedgeSlots(count, spacing);
    case 'box':
      return boxSlots(count, spacing);
    case 'echelonLeft':
      return echelonSlots(count, spacing, true);
    case 'echelonRight':
      return echelonSlots(count, spacing, false);
    case 'skirmish':
      return gridSlots(count, spacing, SKIRMISH_ROW_WIDTH);
  }
}

// --- World projection -------------------------------------------------------

/**
 * Project a team-local slot offset into world XZ around an anchor, rotated by the
 * team's heading. `facingRad` follows the unit `rotation` convention (radians
 * about +Y, 0 = facing +Z): forward maps to (sin, cos) and right to (cos, -sin),
 * so a member's slot rotates with the formation as the King re-faces it. The
 * returned y is the anchor's y (slots are planar; terrain height is resolved by
 * the mover, not here).
 */
export function worldSlot(
  anchor: Position3D,
  facingRad: number,
  offset: SlotOffset
): Position3D {
  const sin = Math.sin(facingRad);
  const cos = Math.cos(facingRad);
  return {
    x: anchor.x + offset.forward * sin + offset.right * cos,
    y: anchor.y,
    z: anchor.z + offset.forward * cos - offset.right * sin,
  };
}

/**
 * The heading a fresh formation orients to when the caller supplies none: the mean
 * of the members' current facings. Averaged as direction vectors (summing sin/cos
 * then atan2) so it is correct across the -π/π wrap, where naive angular averaging
 * is not. Returns 0 for an empty set. Callers pass members in a stable order so the
 * vector sum is identical on both lockstep peers.
 */
export function meanHeading(rotations: readonly number[]): number {
  if (rotations.length === 0) return 0;
  let sumSin = 0;
  let sumCos = 0;
  for (const rotation of rotations) {
    sumSin += Math.sin(rotation);
    sumCos += Math.cos(rotation);
  }
  return Math.atan2(sumSin, sumCos);
}

/**
 * The centroid of member positions — the anchor a formation centers on. Summed in
 * the order given (callers pass a stably-ordered member list so two lockstep peers
 * accumulate identically) and projected onto the XZ plane with y = 0, since slots
 * are planar and terrain height is resolved by the mover. Returns the origin for an
 * empty set.
 */
export function centroidOf(positions: readonly Position3D[]): Position3D {
  if (positions.length === 0) return { x: 0, y: 0, z: 0 };
  let sumX = 0;
  let sumZ = 0;
  for (const position of positions) {
    sumX += position.x;
    sumZ += position.z;
  }
  return { x: sumX / positions.length, y: 0, z: sumZ / positions.length };
}

/**
 * Assign a world slot to each fire-team member, keyed by unit id. Members are
 * sorted by id first so the mapping is identical on both lockstep peers regardless
 * of array order; the i-th member by id then takes the i-th slot of the shape.
 */
export function assignSlots(
  memberIds: readonly string[],
  shape: FormationShape,
  anchor: Position3D,
  facingRad: number,
  spacing: number = defaultSpacingFor(shape)
): Record<string, Position3D> {
  const ordered = [...memberIds].sort();
  const offsets = slotOffsets(shape, ordered.length, spacing);
  const assignment: Record<string, Position3D> = {};
  ordered.forEach((id, index) => {
    assignment[id] = worldSlot(anchor, facingRad, offsets[index]);
  });
  return assignment;
}
