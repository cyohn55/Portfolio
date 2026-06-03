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
