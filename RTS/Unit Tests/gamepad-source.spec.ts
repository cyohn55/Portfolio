import { test, expect } from '@playwright/test';
import {
  type BridgedGamepad,
  FORWARDED_STALE_MS,
  pickGamepadSource,
} from '../src/components/Working/gamepadSource';

/**
 * These tests exercise the real gamepad-bridge merge policy (pickGamepadSource)
 * against the actual data shapes the host page forwards and the browser reports.
 * The merge policy is what makes a controller work inside the portfolio iframe:
 * Chrome only exposes the pad to the host document, which relays a snapshot into
 * the iframe; this function decides, each frame, whether to trust the iframe's own
 * (native) reading or the host's forwarded one. Nothing is hard-coded into the
 * function under test — the staleness threshold is imported from the module.
 *
 * Run with: npx playwright test --config "Unit Tests/playwright.config.ts"
 */

// Build a connected pad with the structural shape every RTS consumer reads.
function connectedPad(overrides: Partial<BridgedGamepad> = {}): BridgedGamepad {
  return {
    index: 0,
    connected: true,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    ...overrides,
  };
}

const FRESH_AGE_MS = 0;
const STALE_AGE_MS = FORWARDED_STALE_MS + 1;

test('native reading wins whenever the document sees a connected pad', () => {
  const native = [connectedPad({ index: 0 })];
  const forwarded = [connectedPad({ index: 1 })];

  // Even with a fresh forwarded snapshot present, the document's own pad is used —
  // a standalone run (or a legitimately focused iframe) must not be overridden.
  const chosen = pickGamepadSource(native, forwarded, FRESH_AGE_MS);

  expect(chosen).toBe(native);
});

test('fresh forwarded snapshot is used when the document has no connected pad', () => {
  // The embed case: the iframe's own getGamepads() returns only empty slots, so
  // the host-forwarded snapshot must drive the controller.
  const native: (BridgedGamepad | null)[] = [null, null, null, null];
  const forwarded = [connectedPad()];

  const chosen = pickGamepadSource(native, forwarded, FRESH_AGE_MS);

  expect(chosen).toBe(forwarded);
  const pad = chosen[0];
  expect(pad?.connected).toBe(true);
});

test('a forwarded pad held just under the threshold still counts as fresh', () => {
  const native: (BridgedGamepad | null)[] = [null];
  const forwarded = [connectedPad()];

  const chosen = pickGamepadSource(native, forwarded, FORWARDED_STALE_MS - 1);

  expect(chosen).toBe(forwarded);
});

test('a stale forwarded snapshot is dropped so the controller goes dark, not frozen', () => {
  const native: (BridgedGamepad | null)[] = [null, null];
  const forwarded = [connectedPad()];

  // Past the staleness window (host stopped forwarding / pad unplugged): fall back
  // to the empty native list rather than replaying the last reported state.
  const chosen = pickGamepadSource(native, forwarded, STALE_AGE_MS);

  expect(chosen).toBe(native);
  expect(chosen.some((pad) => pad && pad.connected)).toBe(false);
});

test('an empty forwarded snapshot never masks the (also empty) native reading', () => {
  const native: (BridgedGamepad | null)[] = [null, null, null, null];
  const forwarded: BridgedGamepad[] = [];

  const chosen = pickGamepadSource(native, forwarded, FRESH_AGE_MS);

  expect(chosen).toBe(native);
});

test('a disconnected native slot does not block the forwarded fallback', () => {
  // getGamepads() can report a slot that exists but is no longer connected; that
  // must not count as "the document has a pad" and suppress the host relay.
  const native = [connectedPad({ connected: false })];
  const forwarded = [connectedPad({ index: 1 })];

  const chosen = pickGamepadSource(native, forwarded, FRESH_AGE_MS);

  expect(chosen).toBe(forwarded);
});
