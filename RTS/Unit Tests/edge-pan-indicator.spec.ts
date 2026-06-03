import { test, expect } from '@playwright/test';
import {
  computeActiveEdges,
  edgePanIndicator,
  type EdgePanEdges,
} from '../src/components/Working/edgePanIndicator';

/**
 * Pure-logic tests for the edge-pan indicator. They validate the two guarantees the
 * camera + chevron overlay depend on:
 *
 *  1. computeActiveEdges flags exactly the edge bands the cursor occupies — interior
 *     positions light nothing, each side band lights only its edge, corners light both
 *     adjacent edges, and opposing bands never light simultaneously even in a degenerate
 *     viewport (matching the camera's mutually-exclusive horizontal/vertical pan).
 *  2. The singleton only notifies subscribers on a real state transition and exposes a
 *     referentially stable snapshot between changes (the contract useSyncExternalStore
 *     relies on to avoid render loops), and reset() clears every edge.
 *
 * Inputs are derived from each test's own viewport/margin rather than hard-coded screen
 * coordinates, so the assertions exercise the real boundary arithmetic.
 */

const VIEWPORT_WIDTH = 1920;
const VIEWPORT_HEIGHT = 1080;
const MARGIN = 24;

test('a cursor in the interior lights no edges', () => {
  const edges = computeActiveEdges(
    VIEWPORT_WIDTH / 2,
    VIEWPORT_HEIGHT / 2,
    VIEWPORT_WIDTH,
    VIEWPORT_HEIGHT,
    MARGIN,
  );

  expect(edges).toEqual({ top: false, bottom: false, left: false, right: false });
});

test('each side band lights only its own edge', () => {
  const midY = VIEWPORT_HEIGHT / 2;
  const midX = VIEWPORT_WIDTH / 2;

  // Just inside each band (margin is inclusive), well clear of any other edge.
  expect(computeActiveEdges(MARGIN, midY, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, MARGIN)).toEqual({
    left: true,
    right: false,
    top: false,
    bottom: false,
  });
  expect(
    computeActiveEdges(VIEWPORT_WIDTH - MARGIN, midY, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, MARGIN),
  ).toEqual({ left: false, right: true, top: false, bottom: false });
  expect(computeActiveEdges(midX, MARGIN, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, MARGIN)).toEqual({
    left: false,
    right: false,
    top: true,
    bottom: false,
  });
  expect(
    computeActiveEdges(midX, VIEWPORT_HEIGHT - MARGIN, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, MARGIN),
  ).toEqual({ left: false, right: false, top: false, bottom: true });
});

test('a position one pixel outside the band does not light the edge', () => {
  const justOutside = computeActiveEdges(
    MARGIN + 1,
    VIEWPORT_HEIGHT / 2,
    VIEWPORT_WIDTH,
    VIEWPORT_HEIGHT,
    MARGIN,
  );
  expect(justOutside.left).toBe(false);
});

test('a corner lights both adjacent edges', () => {
  const topLeft = computeActiveEdges(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, MARGIN);
  expect(topLeft).toEqual({ left: true, right: false, top: true, bottom: false });

  const bottomRight = computeActiveEdges(
    VIEWPORT_WIDTH,
    VIEWPORT_HEIGHT,
    VIEWPORT_WIDTH,
    VIEWPORT_HEIGHT,
    MARGIN,
  );
  expect(bottomRight).toEqual({ left: false, right: true, top: false, bottom: true });
});

test('opposing bands never light together in a viewport narrower than twice the margin', () => {
  // Width 30 < 2 * margin(24): every x is in both bands' raw range; the resolver must
  // still pick a single horizontal direction (left wins, mirroring the camera pan).
  const edges = computeActiveEdges(15, 15, 30, 30, MARGIN);
  expect(edges.left && edges.right).toBe(false);
  expect(edges.top && edges.bottom).toBe(false);
  expect(edges.left).toBe(true);
  expect(edges.top).toBe(true);
});

test('the singleton notifies only on a real transition and is stable otherwise', () => {
  edgePanIndicator.reset();

  let notifications = 0;
  const unsubscribe = edgePanIndicator.subscribe(() => {
    notifications += 1;
  });

  const hotRight: EdgePanEdges = { top: false, bottom: false, left: false, right: true };

  edgePanIndicator.setEdges(hotRight);
  expect(notifications).toBe(1);

  const snapshotAfterChange = edgePanIndicator.getEdges();

  // An identical update must not notify and must not swap the snapshot reference.
  edgePanIndicator.setEdges({ top: false, bottom: false, left: false, right: true });
  expect(notifications).toBe(1);
  expect(edgePanIndicator.getEdges()).toBe(snapshotAfterChange);

  unsubscribe();
  edgePanIndicator.setEdges({ top: true, bottom: false, left: false, right: false });
  // After unsubscribing, no further notifications reach this listener.
  expect(notifications).toBe(1);
});

test('reset clears every edge', () => {
  edgePanIndicator.setEdges({ top: true, bottom: true, left: true, right: true });
  edgePanIndicator.reset();

  expect(edgePanIndicator.getEdges()).toEqual({
    top: false,
    bottom: false,
    left: false,
    right: false,
  });
});
