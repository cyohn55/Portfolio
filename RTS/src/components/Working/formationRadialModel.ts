// formationRadialModel — the shared, framework-free presentational model for the
// formation "play wheel" (see the Shapes/Audibles pages of DirectingRadial.tsx).
//
// Single responsibility: hold everything the wheel RENDERS — the ordered shape
// options (icon / label / hint), the ring color, and the ring geometry — so the
// component stays a thin view over the setFormation command. The CSS is reused
// verbatim from behaviorRadialModel (the rts-stance-* classes), since the wheel is
// the same floating split-free ring of circles; only the option set and color
// differ, both supplied here.

import type { FormationShape } from '../../game/types';

export interface FormationOption {
  shape: FormationShape;
  icon: string;
  label: string;
  hint: string;
}

// Ordered clockwise from the top of the wheel. Mirrors the shape vocabulary in
// formations.ts; the icons hint at each shape's silhouette.
export const FORMATION_OPTIONS: readonly FormationOption[] = [
  { shape: 'line', icon: '▬', label: 'Line', hint: 'Abreast — maximum frontage / firing line' },
  { shape: 'wedge', icon: '🔺', label: 'Wedge', hint: 'Arrowhead — punch through, lead at the tip' },
  { shape: 'echelonRight', icon: '◢', label: 'Echelon R', hint: 'Staggered diagonal trailing back-right' },
  { shape: 'column', icon: '┃', label: 'Column', hint: 'Single file — threads bridges & chokepoints' },
  { shape: 'echelonLeft', icon: '◣', label: 'Echelon L', hint: 'Staggered diagonal trailing back-left' },
  { shape: 'box', icon: '⬛', label: 'Box', hint: 'Hollow square — all-around defense' },
  { shape: 'skirmish', icon: '⁙', label: 'Skirmish', hint: 'Loose grid — disperse vs. area attacks' },
];

// Green, distinct from the posture radial's fire/posture/priority hues so the
// wheel reads as its own system at a glance.
export const FORMATION_COLOR = '#0e9f6e';

// Circle size kept in sync with the reused .rts-stance-node CSS (76px) so the ring
// radius is derived, not hand-tuned: N circles evenly spaced clear each other when
// 2·R·sin(π/N) ≥ NODE_DIAMETER + CLEARANCE.
export const FORMATION_NODE_DIAMETER = 76;
const FORMATION_RING_CLEARANCE = 16;
export const FORMATION_RING_RADIUS =
  (FORMATION_NODE_DIAMETER + FORMATION_RING_CLEARANCE) / (2 * Math.sin(Math.PI / FORMATION_OPTIONS.length));
export const FORMATION_PANEL_SIZE = 2 * (FORMATION_RING_RADIUS + FORMATION_NODE_DIAMETER / 2) + 24;

/** The display label for a shape value (falls back to the raw key). */
export function labelForShape(shape: FormationShape): string {
  return FORMATION_OPTIONS.find((option) => option.shape === shape)?.label ?? shape;
}

// The mid-play "audibles" shown beneath the wheel — quick tweaks to an
// already-formed team (see CommandAdjustFormation). Focus-fire is intentionally
// absent here: it needs an enemy target, so it is triggered by attacking one with
// a formed team selected, not by a button.
export type FormationAudibleOp = 'rotateLeft' | 'rotateRight' | 'expand' | 'contract' | 'disband';

export interface FormationAudible {
  op: FormationAudibleOp;
  icon: string;
  label: string;
  hint: string;
}

export const AUDIBLES: readonly FormationAudible[] = [
  { op: 'rotateLeft', icon: '↺', label: 'Rotate L', hint: 'Pivot the formation a step counter-clockwise' },
  { op: 'rotateRight', icon: '↻', label: 'Rotate R', hint: 'Pivot the formation a step clockwise' },
  { op: 'expand', icon: '⤡', label: 'Expand', hint: 'Widen the spacing (disperse vs. area attacks)' },
  { op: 'contract', icon: '⤢', label: 'Contract', hint: 'Tighten the spacing (fit a chokepoint)' },
  { op: 'disband', icon: '✕', label: 'Disband', hint: 'Break formation; free the units' },
];
