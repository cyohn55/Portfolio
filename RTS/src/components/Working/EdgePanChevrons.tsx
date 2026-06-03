import { useSyncExternalStore } from 'react';
import { edgePanIndicator, type EdgePanEdges } from './edgePanIndicator';

/**
 * EdgePanChevrons — yellow directional chevrons that appear inside the screen-edge
 * pan-trigger bands while the cursor is touching them, and vanish the instant it
 * leaves. Each chevron points outward in the direction the camera scrolls for that
 * edge, giving the classic RTS edge-scroll affordance.
 *
 * The component owns no logic of its own: it simply reflects the active-edge state
 * published by CameraController through {@link edgePanIndicator}, so a chevron is
 * lit exactly when that edge's pan trigger is firing (never while piloting a monarch
 * or when the cursor is off the game canvas). The overlay is purely presentational
 * and non-interactive (pointer-events: none) so it never intercepts game input.
 */

const CHEVRON_COLOR = '#ffd500';

// Inset (px) of each chevron from its screen edge — keeps the glyph inside the
// pan-trigger band rather than flush against the very edge.
const EDGE_INSET = 8;

type Direction = 'up' | 'down' | 'left' | 'right';

// Polyline points for a chevron pointing each direction within a 28 x 28 viewBox.
const CHEVRON_POINTS: Record<Direction, string> = {
  right: '9,5 21,14 9,23',
  left: '19,5 7,14 19,23',
  up: '5,19 14,7 23,19',
  down: '5,9 14,21 23,9',
};

interface ChevronProps {
  direction: Direction;
  visible: boolean;
  /** Absolute-position style anchoring the chevron to its edge. */
  position: React.CSSProperties;
}

function Chevron({ direction, visible, position }: ChevronProps) {
  return (
    <svg
      width={28}
      height={28}
      viewBox="0 0 28 28"
      aria-hidden="true"
      style={{
        position: 'absolute',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.12s ease-out',
        // A soft dark glow keeps the yellow legible over both bright and dark terrain.
        filter: 'drop-shadow(0 0 3px rgba(0, 0, 0, 0.8))',
        ...position,
      }}
    >
      <polyline
        points={CHEVRON_POINTS[direction]}
        fill="none"
        stroke={CHEVRON_COLOR}
        strokeWidth={4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function subscribe(listener: () => void): () => void {
  return edgePanIndicator.subscribe(listener);
}

function getSnapshot(): EdgePanEdges {
  return edgePanIndicator.getEdges();
}

export function EdgePanChevrons() {
  const edges = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        zIndex: 50,
      }}
    >
      <Chevron
        direction="right"
        visible={edges.right}
        position={{ top: '50%', right: EDGE_INSET, transform: 'translateY(-50%)' }}
      />
      <Chevron
        direction="left"
        visible={edges.left}
        position={{ top: '50%', left: EDGE_INSET, transform: 'translateY(-50%)' }}
      />
      <Chevron
        direction="up"
        visible={edges.top}
        position={{ left: '50%', top: EDGE_INSET, transform: 'translateX(-50%)' }}
      />
      <Chevron
        direction="down"
        visible={edges.bottom}
        position={{ left: '50%', bottom: EDGE_INSET, transform: 'translateX(-50%)' }}
      />
    </div>
  );
}
