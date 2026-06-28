import { useEffect, useRef } from 'react';
import { useGameStore } from '../../game/state';
import { useUiStore } from '../../game/uiStore';
import {
  type GamepadSnapshot,
  type NavRepeatState,
  chooseNextIndex,
  createRepeatState,
  isBackPressed,
  isConfirmPressed,
  readNavDirection,
  stepRepeat,
  type NavRect,
} from './uiGamepadNav';
import { firstConnectedBridgedGamepad } from './gamepadSource';

/**
 * UINavigationController — a render-nothing component, mounted once for the whole
 * app, that lets a game controller drive the HTML menus with keyboard focus.
 *
 * The in-canvas GamepadController owns the pad during live play; this controller
 * owns it on the menu screens and on the modal overlays that pause play (the
 * pause menu, settings, the pre-match instructions, and the post-game screen).
 * Because those overlays only appear while the sim is paused or finished — states
 * in which GamepadController already ignores its gameplay buttons — the two
 * pollers never act on the same press.
 *
 * Navigation is fully generic and DOM-driven: it focuses real, visible focusable
 * elements and moves between them by on-screen geometry (uiGamepadNav), so new
 * menus need no wiring beyond marking any non-button click target with
 * `data-gamepad-focusable` and any cancel/back control with `data-gamepad-back`.
 */

// Screens with no 3D scene of their own — pure HTML the controller should drive.
const MENU_SCREENS: ReadonlySet<string> = new Set<string>([
  'menu',
  'lobby',
  'multiplayer',
  'leaderboard',
  'conquestLobby',
]);

// CSS-selector union of everything that can take focus. A non-button click
// target (e.g. an animal card) opts in with `data-gamepad-focusable`.
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[data-gamepad-focusable]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// Hold-to-repeat timing for focus moves: a snappy first step, a brief pause, then
// steady repeats — the cadence of holding an arrow key.
const NAV_INITIAL_DELAY_MS = 320;
const NAV_REPEAT_MS = 140;

// Class the controller toggles on the focused element so a controller user gets a
// clear focus ring even where the design suppresses the native outline.
const FOCUS_CLASS = 'gamepad-focused';

function isElementVisible(element: HTMLElement): boolean {
  // offsetParent is null for display:none (and fixed elements need the rect check
  // below anyway), so pair it with a real, on-screen bounding box.
  if (element.offsetParent === null && getComputedStyle(element).position !== 'fixed') {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Collect the visible focusable elements the controller may move between. When a
 * modal overlay is open, focus is confined to it so the controller never lands on
 * a control hidden behind the overlay.
 */
function collectFocusables(): HTMLElement[] {
  const modals = Array.from(
    document.querySelectorAll<HTMLElement>('[data-gamepad-modal]')
  ).filter(isElementVisible);
  const root: ParentNode = modals.length > 0 ? modals[modals.length - 1] : document.body;

  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    isElementVisible
  );
}

function elementRects(elements: ReadonlyArray<HTMLElement>): NavRect[] {
  return elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  });
}

/** The back/cancel control for the current screen or modal, if one is marked. */
function findBackTarget(): HTMLElement | null {
  const modals = Array.from(
    document.querySelectorAll<HTMLElement>('[data-gamepad-modal]')
  ).filter(isElementVisible);
  const root: ParentNode = modals.length > 0 ? modals[modals.length - 1] : document.body;
  const candidates = Array.from(root.querySelectorAll<HTMLElement>('[data-gamepad-back]'));
  const visible = candidates.find(isElementVisible);
  return visible ?? null;
}

function firstConnectedGamepad(): GamepadSnapshot | null {
  // Bridged read: in the portfolio embed the pad is only visible to the host page,
  // which forwards it into this iframe (see gamepadSource.ts).
  return firstConnectedBridgedGamepad() as unknown as GamepadSnapshot | null;
}

export function UINavigationController() {
  // Live activation flag, read inside the rAF loop without re-subscribing it.
  const activeRef = useRef(false);
  const currentScreen = useUiStore((state) => state.currentScreen);
  const isPaused = useUiStore((state) => state.isPaused);
  const gameOver = useGameStore((state) => state.gameOver);

  useEffect(() => {
    // Drive the controller on the menu screens, and on the modal overlays that
    // pause or end a match (pause menu, settings, instructions, post-game).
    const overlayActive =
      (currentScreen === 'playing' || currentScreen === 'conquest') && (isPaused || gameOver);
    activeRef.current = MENU_SCREENS.has(currentScreen) || overlayActive;
  }, [currentScreen, isPaused, gameOver]);

  useEffect(() => {
    let rafId = 0;
    let repeat: NavRepeatState = createRepeatState();
    let confirmWasDown = false;
    let backWasDown = false;
    let focusedElement: HTMLElement | null = null;

    const setFocus = (element: HTMLElement | null) => {
      if (focusedElement === element) return;
      if (focusedElement) focusedElement.classList.remove(FOCUS_CLASS);
      focusedElement = element;
      if (element) {
        element.classList.add(FOCUS_CLASS);
        element.focus({ preventScroll: false });
      }
    };

    const poll = () => {
      rafId = requestAnimationFrame(poll);

      if (!activeRef.current) {
        // Leaving controller-driven UI: drop the highlight and reset edges so a
        // stale press can't fire on the next menu we enter.
        setFocus(null);
        repeat = createRepeatState();
        confirmWasDown = false;
        backWasDown = false;
        return;
      }

      const pad = firstConnectedGamepad();
      if (!pad) return;

      const elements = collectFocusables();
      if (elements.length === 0) {
        setFocus(null);
        return;
      }

      // Track focus against the real active element so external focus changes
      // (clicks, tabbing) stay in sync with the controller.
      const active = document.activeElement as HTMLElement | null;
      let activeIndex = active ? elements.indexOf(active) : -1;
      if (activeIndex === -1 && focusedElement) {
        activeIndex = elements.indexOf(focusedElement);
      }
      if (activeIndex !== -1) {
        // Keep our highlight on whatever the document considers focused.
        if (focusedElement !== elements[activeIndex]) setFocus(elements[activeIndex]);
      } else {
        // Nothing of ours is focused yet — clear any stale highlight but do not
        // hijack focus until the user actually presses a direction or confirm.
        if (focusedElement) setFocus(null);
      }

      const direction = readNavDirection(pad);
      const { fire, state } = stepRepeat(
        repeat,
        direction,
        performance.now(),
        NAV_INITIAL_DELAY_MS,
        NAV_REPEAT_MS
      );
      repeat = state;

      if (fire) {
        if (activeIndex === -1) {
          setFocus(elements[0]);
        } else {
          const nextIndex = chooseNextIndex(elementRects(elements), activeIndex, direction!);
          if (nextIndex !== null) setFocus(elements[nextIndex]);
        }
      }

      const confirmDown = isConfirmPressed(pad);
      if (confirmDown && !confirmWasDown) {
        if (activeIndex === -1) {
          setFocus(elements[0]);
        } else {
          elements[activeIndex].click();
        }
      }
      confirmWasDown = confirmDown;

      const backDown = isBackPressed(pad);
      if (backDown && !backWasDown) {
        const backTarget = findBackTarget();
        if (backTarget) backTarget.click();
      }
      backWasDown = backDown;
    };

    rafId = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(rafId);
      if (focusedElement) focusedElement.classList.remove(FOCUS_CLASS);
    };
  }, []);

  return null;
}
