// behaviorRadialModel — the shared, framework-free presentational model for the
// combat-posture radial: the option lists, colors, ring geometry, the small
// "uniform value across a selection" helper, and the injected stylesheet.
//
// Single responsibility: hold everything the radial RENDERS that is identical
// across game modes, so Quick Play's BehaviorRadial (store-driven) and Conquest's
// ConquestBehaviorRadial (event-bridged) draw the exact same rings from one source
// — no divergent option order, color, size, or CSS. Each component supplies its own
// data source and apply commands; this module only describes the picture.

import type { FireMode, TargetPriority, UnitStance } from '../../game/types';

export interface StanceOption {
  stance: UnitStance;
  icon: string;
  label: string;
  hint: string;
}

// Ordered for the inner (top) half of the ring, clockwise from the top. Only the
// five combat stances are offered; the positional stances (patrol/guard/escort)
// need a target-placement gesture and are set elsewhere, so they are omitted here.
export const STANCE_OPTIONS: readonly StanceOption[] = [
  { stance: 'aggressive', icon: '⚔️', label: 'Aggressive', hint: 'Hunt & chase enemies in vision' },
  { stance: 'skirmish', icon: '🏹', label: 'Skirmish', hint: 'Kite — fight at range, back off when closed on' },
  { stance: 'holdGround', icon: '🚩', label: 'Hold Ground', hint: 'Attack only what is in range; never move' },
  { stance: 'defensive', icon: '🛡️', label: 'Defensive', hint: 'Engage within a leash, then return home' },
  { stance: 'flee', icon: '🏃', label: 'Flee', hint: 'Never engage; retreat toward home' },
];

export interface PriorityOption {
  priority: TargetPriority;
  icon: string;
  label: string;
  hint: string;
}

// Ordered for the outer (bottom) half of the ring, clockwise from the top.
export const PRIORITY_OPTIONS: readonly PriorityOption[] = [
  { priority: 'nearest', icon: '📍', label: 'Nearest', hint: 'Closest enemy first' },
  { priority: 'lowestHp', icon: '🩸', label: 'Weakest', hint: 'Finish the lowest-HP enemy' },
  { priority: 'highestThreat', icon: '💥', label: 'Threat', hint: 'Highest damage-per-second first' },
  { priority: 'ranged', icon: '🎯', label: 'Ranged', hint: 'Longest-reach enemy first' },
  { priority: 'monarch', icon: '👑', label: 'Royalty', hint: 'Kings, Queens, and Bases first' },
];

// Three colors total, one per option type, so the ring an option belongs to is
// readable by color alone: center fire toggle → orange-red · posture ring → blue ·
// priority ring → purple.
export const FIRE_COLOR = '#fb5607';
export const POSTURE_COLOR = '#2563eb';
export const PRIORITY_COLOR = '#9333ea';

// Circle sizes (kept in sync with the CSS below) so the ring radius can be derived
// rather than hand-tuned — keeping the no-overlap guarantee as the sizes change.
export const NODE_DIAMETER = 76; // each posture / priority option circle

// Posture (top) and priority (bottom) share ONE ring. With equal group counts the
// options end up uniformly spaced; size the radius from the total option count so
// N circles evenly spaced clear each other: 2·R·sin(π/N) ≥ NODE_DIAMETER + CLEARANCE.
export const RING_SLOT_COUNT = STANCE_OPTIONS.length + PRIORITY_OPTIONS.length;
const RING_CLEARANCE = 16; // px gap between adjacent circles on the shared ring
export const RING_RADIUS = (NODE_DIAMETER + RING_CLEARANCE) / (2 * Math.sin(Math.PI / RING_SLOT_COUNT));
export const PANEL_SIZE = 2 * (RING_RADIUS + NODE_DIAMETER / 2) + 24; // fits the ring + margin

/**
 * The single shared value across the list, or null when they disagree ("mixed" —
 * shown so the player knows the selection is not uniform).
 */
export function uniform<T>(values: readonly T[]): T | null {
  if (values.length === 0) return null;
  const first = values[0];
  return values.every((value) => value === first) ? first : null;
}

/** The display label for a stance value (falls back to the raw key). */
export function labelForStance(stance: UnitStance): string {
  return STANCE_OPTIONS.find((option) => option.stance === stance)?.label ?? stance;
}

/** The fire toggle's effective value when the selection is uniform-or-empty. */
export function fireToggleNext(current: FireMode | null): FireMode {
  return (current ?? 'free') === 'free' ? 'hold' : 'free';
}

// The injected stylesheet for the radial. Class names are prefixed `rts-stance-`
// because Vite concatenates every component's CSS into one global sheet — generic
// names would collide across components (see the rts-css-class-collision-trap note).
// Shared verbatim by both radials (never mounted at once), so the rings look identical.
export const BEHAVIOR_RADIAL_STYLE = `
.rts-stance-trigger {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  z-index: 1000; display: flex; align-items: center; gap: 8px;
  background: rgba(17,23,38,0.88); border: 1px solid rgba(88,120,255,0.5);
  border-radius: 10px; padding: 8px 14px; color: #e2e8f0;
  font-family: monospace; font-size: 13px; cursor: pointer;
  backdrop-filter: blur(10px); transition: border-color 0.15s, background 0.15s;
}
.rts-stance-trigger:hover { border-color: rgba(129,160,255,0.95); background: rgba(28,38,64,0.92); }
.rts-stance-trigger-icon { font-size: 16px; }
.rts-stance-trigger-key { color: #64748b; }

/* Full-screen click-catcher that closes the radial on an outside click. It is
   intentionally transparent (no dim, no blur) so the battlefield stays visible
   behind the floating rings while the radial is open. */
.rts-stance-backdrop {
  position: fixed; inset: 0; z-index: 1100; display: flex;
  align-items: center; justify-content: center; background: transparent;
}
/* No card: a transparent layout container so only the rings float on the scene. */
.rts-stance-panel {
  display: flex; flex-direction: column; align-items: center;
  padding: 0; color: #e2e8f0; font-family: monospace;
}
.rts-stance-header {
  font-size: 13px; color: #e2e8f0; letter-spacing: 0.5px; margin-bottom: 8px;
  text-shadow: 0 1px 4px rgba(0,0,0,0.95);
}

.rts-stance-ring { position: relative; }

/* Every option circle carries a vibrant background set inline — one color per
   type (fire / posture / priority), so its ring is readable by color alone and is
   always visible, not just when selected. The white text/icon + shadows keep the
   label legible on any hue floating directly over the battlefield (no backing
   card). The subtle light rim gives each colored circle definition against the
   scene. */
.rts-stance-node {
  position: absolute; top: 50%; left: 50%; width: 76px; height: 76px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
  border-radius: 50%; cursor: pointer; color: #fff;
  border: 2px solid rgba(255,255,255,0.4);
  box-shadow: 0 3px 12px rgba(0,0,0,0.6);
  transition: transform 0.1s, border-color 0.15s, filter 0.15s, box-shadow 0.15s;
}
/* Mouse hover brightens the circle (a background change can't win over the inline
   per-option color, so use a filter instead). */
.rts-stance-node:hover { filter: brightness(1.18); border-color: rgba(255,255,255,0.85); }
.rts-stance-node-icon { font-size: 22px; line-height: 1; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.9)); }
.rts-stance-node-label { font-size: 10px; font-weight: bold; text-align: center; text-shadow: 0 1px 3px rgba(0,0,0,0.95); }

/* Selected value on an axis: keep the option's own color, mark it with a crisp
   white ring + glow so "the current choice" reads without hiding the hue. */
.rts-stance-node-active {
  border-color: #fff;
  box-shadow: 0 0 0 3px rgba(255,255,255,0.95), 0 3px 14px rgba(0,0,0,0.6);
}

/* Controller right-stick aim highlight: a yellow ring with a dark separator so it
   stays visible on top of any option color (and distinct from the white selected
   ring). Listed last so it wins over the selected ring when both apply. */
.rts-stance-node-hover {
  border-color: #0b1020 !important;
  box-shadow: 0 0 0 3px #fde047, 0 0 0 6px rgba(0,0,0,0.55), 0 3px 14px rgba(0,0,0,0.6);
}

/* The center fire toggle is the same size as the option circles and inherits the
   shared circle background from .rts-stance-node above; it only needs its own
   centering transform (ring nodes get an inline transform; the center does not). */
.rts-stance-center {
  transform: translate(-50%, -50%);
}
.rts-stance-center-icon { font-size: 22px; line-height: 1; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.9)); }
.rts-stance-center-label { font-size: 9px; font-weight: bold; text-align: center; text-shadow: 0 1px 3px rgba(0,0,0,0.95); }

.rts-stance-footer {
  margin-top: 12px; font-size: 11px; color: #cbd5e1; text-align: center; max-width: 460px;
  text-shadow: 0 1px 4px rgba(0,0,0,0.95);
}
.rts-stance-key {
  display: inline-block; background: rgba(15,23,42,0.92); border: 1px solid rgba(203,213,225,0.7);
  border-radius: 5px; padding: 0 5px; color: #fff; font-weight: bold;
}
`;
