/**
 * dottedArrow — a tiny, framework-free DOM helper for the dotted-line-with-arrowhead
 * indicators the Queen gestures draw: the gold patrol route and the blue spawn-rally
 * line. Shared by the mouse path (HexInteraction) and the controller path
 * (GamepadController) so the two input layers can never draw divergent indicators.
 *
 * The line itself is a zero-height div whose dotted top border is the visible stroke;
 * the arrowhead is a child glyph pinned to the far end so it inherits the parent's
 * rotation and points along the line. Positioning is done in screen pixels — each
 * caller projects its own world points (mouse cursor vs. controller reticle) first.
 */

// Stroke colors for the two indicators. The Queen's patrol route is gold (matching
// her gold ring); her spawn-rally line is blue so the two gestures read as distinct.
export const PATROL_ARROW_COLOR = '#ffd700';
export const RALLY_ARROW_COLOR = '#1e90ff';
// The fire-team quick-direct aim arrow: neon green, matching the Directing/formation
// system so the two ways of moving a formation read as the same family.
export const DIRECT_ARROW_COLOR = '#39ff14';

/** A point in screen pixels (client coordinates). */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** Build a hidden dotted-line-with-arrowhead element in the given stroke color. */
export function createDottedArrow(strokeColor: string): HTMLDivElement {
  const arrow = document.createElement('div');
  arrow.style.position = 'absolute';
  arrow.style.height = '0px';
  arrow.style.borderTop = `3px dotted ${strokeColor}`;
  arrow.style.transformOrigin = 'left center';
  arrow.style.pointerEvents = 'none';
  arrow.style.display = 'none';
  arrow.style.zIndex = '1001';

  const arrowHead = document.createElement('span');
  arrowHead.innerHTML = '➤'; // ➤ points along the line's +x axis
  arrowHead.style.position = 'absolute';
  arrowHead.style.right = '0px';
  arrowHead.style.top = '50%';
  arrowHead.style.transform = 'translate(50%, -50%)';
  arrowHead.style.color = strokeColor;
  arrowHead.style.fontSize = '18px';
  arrowHead.style.lineHeight = '0';
  arrow.appendChild(arrowHead);

  return arrow;
}

/**
 * Build a hidden, arrowhead-free connector drawn as a fixed number of equal
 * SEGMENTS (dashes) — the controller's monarch→cursor leash. Unlike a dotted
 * border (whose dot count grows with length), positionSegmentedLine tiles one
 * dash+gap exactly `segments` times across the span, so it always reads as the
 * same number of segments regardless of distance. Hidden with hideDottedArrow.
 */
export function createSegmentedLine(): HTMLDivElement {
  const line = document.createElement('div');
  line.style.position = 'absolute';
  line.style.height = '3px';
  line.style.transformOrigin = 'left center';
  line.style.pointerEvents = 'none';
  line.style.display = 'none';
  line.style.zIndex = '1001';
  line.style.backgroundRepeat = 'repeat-x';
  return line;
}

/**
 * Stretch/rotate a segmented line from `start` to `end` (screen px), tiled into
 * exactly `segments` dashes in `color`. Each tile is ~60% dash, 40% gap.
 */
export function positionSegmentedLine(
  line: HTMLDivElement | null,
  start: ScreenPoint,
  end: ScreenPoint,
  segments: number,
  color: string,
): void {
  if (!line) return;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  const period = segments > 0 ? length / segments : length;

  line.style.left = `${start.x}px`;
  line.style.top = `${start.y}px`;
  line.style.width = `${length}px`;
  line.style.transform = `rotate(${angle}rad)`;
  line.style.backgroundImage =
    `linear-gradient(to right, ${color} 0, ${color} 60%, transparent 60%, transparent 100%)`;
  line.style.backgroundSize = `${period}px 100%`;
  line.style.display = 'block';
}

/** Stretch and rotate an arrow so it spans from `start` to `end` (both in screen px). */
export function positionDottedArrow(arrow: HTMLDivElement | null, start: ScreenPoint, end: ScreenPoint): void {
  if (!arrow) return;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);

  arrow.style.left = `${start.x}px`;
  arrow.style.top = `${start.y}px`;
  arrow.style.width = `${length}px`;
  arrow.style.transform = `rotate(${angle}rad)`;
  arrow.style.display = 'block';
}

/** Hide an arrow (the gesture ended or was cancelled). */
export function hideDottedArrow(arrow: HTMLDivElement | null): void {
  if (arrow) arrow.style.display = 'none';
}

/**
 * Build a hidden, pill-shaped button badge — the glyph (A / B / X / Y) that floats
 * over a fire team while the Left Bumper is held, telling the player which button
 * directs which team. The glyph text and any "armed" highlight are set per frame by
 * the caller (the team→button assignment can change as teams form/disband), so this
 * only fixes the shape. Centered on its anchor point by positionBadge.
 */
export function createButtonBadge(color: string): HTMLDivElement {
  const badge = document.createElement('div');
  badge.style.position = 'absolute';
  badge.style.minWidth = '22px';
  badge.style.height = '22px';
  badge.style.padding = '0 4px';
  badge.style.boxSizing = 'border-box';
  badge.style.display = 'none';
  badge.style.alignItems = 'center';
  badge.style.justifyContent = 'center';
  badge.style.borderRadius = '6px';
  badge.style.border = `2px solid ${color}`;
  badge.style.background = 'rgba(0, 0, 0, 0.65)';
  badge.style.color = color;
  badge.style.font = 'bold 14px monospace';
  badge.style.lineHeight = '1';
  badge.style.pointerEvents = 'none';
  badge.style.zIndex = '1002';
  // Centered on the anchor regardless of its rendered width.
  badge.style.transform = 'translate(-50%, -50%)';
  return badge;
}

/** Center a button badge on `point` (screen px) and show it. */
export function positionBadge(badge: HTMLDivElement | null, point: ScreenPoint): void {
  if (!badge) return;
  badge.style.left = `${point.x}px`;
  badge.style.top = `${point.y}px`;
  badge.style.display = 'flex';
}
