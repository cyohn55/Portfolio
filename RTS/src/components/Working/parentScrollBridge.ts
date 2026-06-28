// parentScrollBridge.ts
// -----------------------------------------------------------------------------
// When the RTS is embedded inside the portfolio page (loaded via the
// `#rts-iframe` element on the main site), the host page wants to know which
// screen the game is on so it can:
//
//   1. Scroll the game container fully into view when the player leaves the
//      title menu (so the viewport isn't half-cut at the bottom of the page).
//   2. Lock the parent's mouse-wheel scrolling while the player is in-game,
//      and release it when they return to the title menu.
//
// The bridge is one-way: the iframe broadcasts the current screen via
// `window.parent.postMessage`. The host listens in Portfolio/script.js (search
// for `rts:screen`). Standalone (non-iframed) RTS runs are unaffected — the
// guard against `window.parent === window` makes this a no-op outside the
// portfolio embed.
//
// We deliberately do NOT couple to the portfolio's DOM here. The contract is
// just the message shape; either side can change layout/styling independently.
// -----------------------------------------------------------------------------

import { useEffect } from 'react';
import { useUiStore, type GameScreen } from '../../game/uiStore';

type RtsScreen = GameScreen;

const SCREEN_MESSAGE_TYPE = 'rts:screen';

function isEmbedded(): boolean {
  // `window.parent === window` when this document is the top-level frame, so
  // there's no host page to notify. We avoid spamming postMessage in dev too.
  return typeof window !== 'undefined' && window.parent !== window;
}

function broadcastCurrentScreen(screen: RtsScreen): void {
  if (!isEmbedded()) return;
  try {
    // `'*'` for targetOrigin: RTS/dist is served from the same origin as the
    // portfolio in production, but we keep it permissive so this still works
    // if the embed ever moves to a different subdomain. The payload carries
    // no secrets — just which menu/lobby/playing screen is active.
    window.parent.postMessage({ type: SCREEN_MESSAGE_TYPE, screen }, '*');
  } catch {
    // Cross-origin policies can throw on postMessage in some browsers.
    // Silently ignore — the host listener simply won't engage scroll-lock,
    // which is no worse than how the page behaved before this bridge existed.
  }
}

/**
 * React hook that wires the RTS game store's `currentScreen` to a
 * `postMessage` broadcast aimed at the parent (host) window.
 *
 * Mount once near the root of the app (see App.tsx). The hook re-broadcasts
 * the current screen on mount so a hot-reload or late iframe attach still
 * synchronizes the host's scroll-lock state with the game's actual screen.
 */
export function useParentScrollBridge(): void {
  useEffect(() => {
    // Initial sync: tell the parent which screen we're currently on. This
    // matters on first iframe load (host hadn't received any messages yet)
    // and on hot-reload during development.
    broadcastCurrentScreen(useUiStore.getState().currentScreen);

    // Subscribe to store changes. Zustand v4's plain `subscribe(listener)`
    // calls the listener on every state update, so we filter for screen
    // transitions specifically to avoid postMessage on every tick.
    const unsubscribe = useUiStore.subscribe((state, prevState) => {
      if (state.currentScreen !== prevState.currentScreen) {
        broadcastCurrentScreen(state.currentScreen);
      }
    });

    // Keep input focus on the game while embedded. The Gamepad API only reports
    // controllers to the focused document, so if the player clicks the host page
    // (drifting focus to the parent) the controller would go dead until they click
    // back. Re-grabbing focus on any pointer/key interaction with the game keeps
    // the pad live. The parent (script.js) focuses the iframe on load and on screen
    // changes; this is the in-frame counterpart that recovers from focus drift.
    // No-op when not embedded (standalone runs already hold focus).
    const grabFocus = () => {
      if (!isEmbedded()) return;
      try {
        window.focus();
      } catch {
        // Focusing across an origin boundary can throw — safe to ignore.
      }
    };
    window.addEventListener('pointerdown', grabFocus);
    window.addEventListener('keydown', grabFocus);

    return () => {
      unsubscribe();
      window.removeEventListener('pointerdown', grabFocus);
      window.removeEventListener('keydown', grabFocus);
    };
  }, []);
}
