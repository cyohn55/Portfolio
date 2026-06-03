/**
 * edgePanIndicator — single source of truth for which screen edges are currently
 * "hot" for edge-pan, plus a tiny pub/sub bridge from the camera (inside the R3F
 * Canvas) to the DOM chevron overlay (outside it).
 *
 * Two concerns share this module so they can never disagree:
 *
 *  1. {@link computeActiveEdges} is the pure geometry that decides, for a cursor
 *     position and viewport, which edge bands the cursor is touching. CameraController
 *     uses it to drive edge-pan, and the same booleans are published here so the
 *     on-screen chevrons light up exactly when (and only when) the pan trigger fires.
 *
 *  2. The {@link edgePanIndicator} singleton carries those booleans across the Canvas
 *     boundary. CameraController writes them every frame (cheaply — writes that don't
 *     change the state notify nobody); the overlay subscribes and re-renders only on a
 *     real transition. Mirrors the module-singleton input-bridge pattern already used
 *     by gamepadInput / pilotInput, keeping the per-frame camera loop free of React
 *     re-renders.
 */

/** Which screen-edge bands the cursor is currently inside. */
export interface EdgePanEdges {
  top: boolean;
  bottom: boolean;
  left: boolean;
  right: boolean;
}

const NO_EDGES: EdgePanEdges = { top: false, bottom: false, left: false, right: false };

/**
 * Decide which edge bands the cursor occupies. Left/right and top/bottom are each
 * mutually exclusive (a cursor can't be in both side bands at once), matching the
 * camera's pan resolution; horizontal and vertical bands combine freely so corners
 * light up both adjacent chevrons. Pure — no DOM or scene-graph access — so it is
 * unit-testable and identical wherever it is called.
 */
export function computeActiveEdges(
  cursorX: number,
  cursorY: number,
  viewportWidth: number,
  viewportHeight: number,
  margin: number,
): EdgePanEdges {
  const left = cursorX <= margin;
  const top = cursorY <= margin;
  return {
    left,
    // `right` only when not already in the left band, so a degenerate viewport
    // narrower than 2 * margin resolves to a single horizontal direction.
    right: !left && cursorX >= viewportWidth - margin,
    top,
    bottom: !top && cursorY >= viewportHeight - margin,
  };
}

function edgesEqual(a: EdgePanEdges, b: EdgePanEdges): boolean {
  return a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;
}

type Listener = () => void;

class EdgePanIndicator {
  private edges: EdgePanEdges = NO_EDGES;
  private readonly listeners = new Set<Listener>();

  /**
   * Publish the latest active edges. The stored object reference only changes when
   * the booleans actually change, so per-frame writes from an unchanged cursor are
   * free and {@link getEdges} stays referentially stable for useSyncExternalStore.
   */
  setEdges(next: EdgePanEdges): void {
    if (edgesEqual(this.edges, next)) return;
    this.edges = { ...next };
    for (const listener of this.listeners) listener();
  }

  /** Read the live edge state (stable reference between real changes). */
  getEdges(): EdgePanEdges {
    return this.edges;
  }

  /** Subscribe to edge-state transitions; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Clear all hot edges (e.g. when the camera unmounts) so no chevron lingers. */
  reset(): void {
    this.setEdges(NO_EDGES);
  }
}

export const edgePanIndicator = new EdgePanIndicator();
