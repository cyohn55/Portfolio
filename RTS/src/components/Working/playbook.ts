// The King's playbook — pure, deterministic definitions for the callPlay command
// (see state.ts) and its UI (the Plays page of DirectingRadial).
//
// A "play" is a football-style call that re-shapes and re-postures every one of the
// King's formed fire teams at once, by each team's POSITIONAL ROLE. Roles are
// auto-classified from where a team sits in the army (its anchor's offset along the
// army's right axis), so the King just calls "Pincer" and the flanking teams peel
// out while the center holds — no manual role tagging. This module owns only the
// data + the (side-effect-free) classification math; state.ts applies it.

import type { FormationShape, PlaybookId, UnitStance } from '../../game/types';

export type { PlaybookId };

// The three positional roles a team is classified into along the army's frontage.
export type PositionalRole = 'leftWing' | 'center' | 'rightWing';

// What a play does to a team in a given role: the shape it takes and the posture
// its members adopt.
export interface RolePlay {
  shape: FormationShape;
  stance: UnitStance;
}

export type Play = Record<PositionalRole, RolePlay>;

// Each play's per-role shape + stance. Kept deliberately small and readable so a
// balance pass has one place to tune the King's options.
export const PLAYBOOK: Record<PlaybookId, Play> = {
  // All-out advance: wings echelon outward and press, center punches with a wedge.
  assault: {
    leftWing: { shape: 'echelonLeft', stance: 'aggressive' },
    center: { shape: 'wedge', stance: 'aggressive' },
    rightWing: { shape: 'echelonRight', stance: 'aggressive' },
  },
  // Dig in: everyone forms a firing line and holds the ground they stand on.
  hold: {
    leftWing: { shape: 'line', stance: 'holdGround' },
    center: { shape: 'line', stance: 'holdGround' },
    rightWing: { shape: 'line', stance: 'holdGround' },
  },
  // Double envelopment: wings swing in to flank while the center pins in place.
  pincer: {
    leftWing: { shape: 'echelonLeft', stance: 'aggressive' },
    center: { shape: 'line', stance: 'holdGround' },
    rightWing: { shape: 'echelonRight', stance: 'aggressive' },
  },
  // Disengage: thin lines that pull back to their anchors rather than commit.
  fallBack: {
    leftWing: { shape: 'line', stance: 'defensive' },
    center: { shape: 'line', stance: 'defensive' },
    rightWing: { shape: 'line', stance: 'defensive' },
  },
  // Turtle up: hollow squares, weapons-tight, all-around defense.
  turtle: {
    leftWing: { shape: 'box', stance: 'holdGround' },
    center: { shape: 'box', stance: 'holdGround' },
    rightWing: { shape: 'box', stance: 'holdGround' },
  },
};

export interface PlaybookEntry {
  id: PlaybookId;
  label: string;
  icon: string;
  hint: string;
}

// UI order + labels for the playbook bar.
export const PLAYBOOK_OPTIONS: readonly PlaybookEntry[] = [
  { id: 'assault', label: 'Assault', icon: '⚔️', hint: 'All teams press: wings echelon out, center wedges in' },
  { id: 'pincer', label: 'Pincer', icon: '🦀', hint: 'Wings flank while the center pins the enemy' },
  { id: 'hold', label: 'Hold', icon: '🛡️', hint: 'Firing lines hold the ground they stand on' },
  { id: 'turtle', label: 'Turtle', icon: '🐢', hint: 'Hollow squares, all-around defense' },
  { id: 'fallBack', label: 'Fall Back', icon: '🏃', hint: 'Thin lines pull back to their anchors' },
];

// Classify a team into a positional role from how far its anchor sits to the side
// of the army centroid, measured along the army's RIGHT axis (so it is independent
// of which way the army faces). A team within `band` of center is the center; left
// of it is the left wing, right of it the right wing. Pure so it is unit-testable
// and identical on both lockstep peers.
export function classifyRole(rightOffset: number, band: number): PositionalRole {
  if (rightOffset < -band) return 'leftWing';
  if (rightOffset > band) return 'rightWing';
  return 'center';
}

// The right-axis component of a vector (dx,dz) for a given facing — the signed
// sideways distance used by classifyRole. worldSlot's right axis is (cos f, -sin f).
export function rightAxisComponent(dx: number, dz: number, facing: number): number {
  return dx * Math.cos(facing) - dz * Math.sin(facing);
}
