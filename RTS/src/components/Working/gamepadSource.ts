// gamepadSource.ts
// -----------------------------------------------------------------------------
// Single source of truth for "the connected gamepad", resilient to the portfolio
// iframe embed.
//
// THE PROBLEM this solves:
// Chrome only reports a gamepad to a document once that document has (a) the
// page focused AND (b) received a gamepad button-press as its own user gesture.
// The RTS runs inside a same-origin `#rts-iframe` on the portfolio. A
// controller-only player has no way to give the *iframe* that activating gesture:
// gamepad input is not a focus gesture, so they can't move focus from the host
// page into the iframe with the controller alone. The host (top) document is the
// one the player actually pressed buttons in, so it is the only document Chrome
// exposes the pad to — the iframe's own `navigator.getGamepads()` stays empty
// forever and the controller appears completely dead in the embed.
//
// THE FIX:
// The host page (Portfolio/script.js) polls `navigator.getGamepads()` — which it
// CAN read, being the activated, focused top document — and forwards a small
// serialized snapshot into the iframe via `postMessage` each frame. This module
// caches that forwarded snapshot and merges it with the iframe's own reading, so
// every consumer (menu navigation, the in-canvas poller, Conquest, and the rebind
// capture) sees the pad no matter which document Chrome routed it to.
//
// Standalone (non-iframed) runs already hold focus and read their own pads
// directly; no forwarded messages ever arrive there, so the native reading always
// wins and this is a transparent no-op. Low coupling: the host/iframe contract is
// just the `{ type: 'rts:gamepad', pads }` message shape — neither side reaches
// into the other's DOM.
// -----------------------------------------------------------------------------

/**
 * The minimal gamepad shape every RTS consumer needs: connection flag, digital/
 * analog buttons, and analog axes. Both `GamepadLike` (controlBindings) and
 * `GamepadSnapshot` (uiGamepadNav) are structurally satisfied by this, so a
 * bridged pad can stand in for a native one everywhere.
 */
export interface BridgedGamepad {
  index: number;
  connected: boolean;
  buttons: ReadonlyArray<{ pressed: boolean; value: number }>;
  axes: ReadonlyArray<number>;
}

const GAMEPAD_MESSAGE_TYPE = 'rts:gamepad';

// A forwarded snapshot older than this (ms) is treated as stale and ignored, so an
// unplugged pad — or the host page halting its forward loop — lets the controller
// fall dark instead of freezing on the last reported state. The host forwards at
// animation-frame cadence (~16ms), so this tolerates a few dropped frames.
export const FORWARDED_STALE_MS = 250;

let forwardedPads: ReadonlyArray<BridgedGamepad | null> = [];
let forwardedAt = 0;
let listening = false;

function isEmbedded(): boolean {
  return typeof window !== 'undefined' && window.parent !== window;
}

/**
 * Begin accepting forwarded gamepad snapshots from the host page. Idempotent and
 * lazy — called from the read path so importing this module has no side effects in
 * environments (tests, SSR) without a window. A no-op when not embedded.
 */
function ensureListening(): void {
  if (listening || !isEmbedded()) return;
  listening = true;
  window.addEventListener('message', (event: MessageEvent) => {
    // Only trust snapshots from our host (the parent frame). We don't pin the
    // origin: the embed may move subdomains, and the payload is just input state.
    if (event.source !== window.parent) return;
    const data = event.data as { type?: string; pads?: unknown };
    if (!data || data.type !== GAMEPAD_MESSAGE_TYPE || !Array.isArray(data.pads)) return;
    forwardedPads = data.pads as ReadonlyArray<BridgedGamepad | null>;
    forwardedAt =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
  });
}

function nativeGamepads(): ReadonlyArray<BridgedGamepad | null> {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
  // navigator.getGamepads() returns a (possibly null-filled) GamepadList; the
  // native Gamepad type is a structural superset of BridgedGamepad.
  return Array.from(navigator.getGamepads()) as ReadonlyArray<BridgedGamepad | null>;
}

function hasConnectedPad(pads: ReadonlyArray<BridgedGamepad | null>): boolean {
  return pads.some((pad) => pad !== null && pad.connected);
}

/**
 * Pure merge policy (separated from global state so it can be tested directly):
 * the document's own reading wins whenever it sees a connected pad; otherwise the
 * host-forwarded snapshot is used, but only while it is fresh — a stale snapshot
 * (unplugged pad, or the host halting its forward loop) falls back to native so
 * the controller goes dark rather than freezing on the last reported state.
 *
 * @param forwardedAgeMs Time since the forwarded snapshot arrived, in ms.
 */
export function pickGamepadSource(
  native: ReadonlyArray<BridgedGamepad | null>,
  forwarded: ReadonlyArray<BridgedGamepad | null>,
  forwardedAgeMs: number,
): ReadonlyArray<BridgedGamepad | null> {
  if (hasConnectedPad(native)) return native;
  if (forwarded.length > 0 && forwardedAgeMs < FORWARDED_STALE_MS) return forwarded;
  return native;
}

/**
 * The active gamepad list, preferring the document's own reading and falling back
 * to the host-forwarded snapshot. Native wins whenever this document genuinely
 * sees a connected pad (standalone runs, or an iframe that legitimately holds
 * focus); the forwarded snapshot covers the embed case where only the host page
 * can read the pad.
 */
export function getBridgedGamepads(): ReadonlyArray<BridgedGamepad | null> {
  ensureListening();
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return pickGamepadSource(nativeGamepads(), forwardedPads, now - forwardedAt);
}

/** The first connected gamepad from {@link getBridgedGamepads}, or null. */
export function firstConnectedBridgedGamepad(): BridgedGamepad | null {
  for (const pad of getBridgedGamepads()) {
    if (pad && pad.connected) return pad;
  }
  return null;
}
