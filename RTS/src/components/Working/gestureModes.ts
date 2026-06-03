/**
 * gestureModes — the activation-mode vocabulary and the shared, framework-free
 * gesture state machine that lets a single bound input drive an action by Tap,
 * Double-Tap, Hold, or Chord. It is intentionally free of React, Three.js, and the
 * store so it can be unit tested in isolation and reused by every input layer
 * (keyboard, mouse, controller).
 *
 * A "mode" is how the player triggers an action's bound input:
 *   - tap        : a quick press-and-release.
 *   - double-tap : two quick taps within DOUBLE_TAP_WINDOW_MS.
 *   - hold       : the input held past HOLD_ACTIVATION_MS (fires on the threshold,
 *                  with a paired release callback so a held action can deploy on
 *                  press and commit on release).
 *   - chord      : a multi-input token (e.g. "mouse:left+mouse:right") whose atoms
 *                  are all pressed together. Chord firing is a simple rising-edge on
 *                  the combined token and is handled by each input layer directly;
 *                  it does not use the tap/hold timing machine below.
 *
 * The same physical input may be bound to several actions as long as their modes
 * differ (tap vs. double-tap vs. hold) — exactly how the classic Space gesture
 * (tap = rally, double-tap = select all, hold = deploy) decomposes. Each input
 * layer builds one resolver per token, wiring that token's per-mode callbacks, and
 * feeds it raw press/release edges.
 */

export type ActivationMode = 'tap' | 'double-tap' | 'hold' | 'chord';

/** Display order for the Settings radial and any mode picker. */
export const ACTIVATION_MODES: readonly ActivationMode[] = ['tap', 'double-tap', 'hold', 'chord'];

/** New bindings start as a plain Tap unless a default explicitly says otherwise. */
export const DEFAULT_ACTIVATION_MODE: ActivationMode = 'tap';

/** Human-readable labels for the radial. */
export const ACTIVATION_MODE_LABELS: Record<ActivationMode, string> = {
  tap: 'Tap',
  'double-tap': 'Double-Tap',
  hold: 'Hold',
  chord: 'Chord',
};

/** Short hint shown under each radio so the player knows what the mode does. */
export const ACTIVATION_MODE_HINTS: Record<ActivationMode, string> = {
  tap: 'Quick press',
  'double-tap': 'Two quick presses',
  hold: 'Press and hold',
  chord: 'Two inputs at once',
};

/** Held at least this long (ms) counts as a Hold rather than a Tap. */
export const HOLD_ACTIVATION_MS = 300;

/** Two presses within this window (ms) count as a Double-Tap. */
export const DOUBLE_TAP_WINDOW_MS = 350;

/** A guard so persisted/unknown strings resolve to a real mode. */
export function isActivationMode(value: unknown): value is ActivationMode {
  return value === 'tap' || value === 'double-tap' || value === 'hold' || value === 'chord';
}

/** The per-mode callbacks a single token's resolver fires. All are optional. */
export interface TokenGestureConfig {
  onTap?: () => void;
  onDoubleTap?: () => void;
  /** Fired when the hold threshold is reached (the press is still down). */
  onHoldStart?: () => void;
  /** Fired when a hold is released (only after onHoldStart fired). */
  onHoldEnd?: () => void;
  holdActivationMs?: number;
  doubleTapWindowMs?: number;
}

export interface TokenGestureResolver {
  /** Raw rising edge of the bound token. `now` is injectable for tests. */
  press(now?: number): void;
  /** Raw falling edge of the bound token. */
  release(now?: number): void;
  /** Abandon any pending timing (focus loss, disconnect, rebind). */
  reset(): void;
}

/**
 * Build a resolver for one token, given the callbacks for whichever modes are
 * bound to it. The machine disambiguates tap / double-tap / hold:
 *   - A pure Tap binding (no double-tap or hold sharing the token) fires on press,
 *     for snappy discrete actions.
 *   - When a double-tap also shares the token, a tap is deferred until the
 *     double-tap window lapses so one input can't fire both.
 *   - A hold fires onHoldStart at the threshold and onHoldEnd on release.
 */
export function createTokenGestureResolver(config: TokenGestureConfig): TokenGestureResolver {
  const holdMs = config.holdActivationMs ?? HOLD_ACTIVATION_MS;
  const windowMs = config.doubleTapWindowMs ?? DOUBLE_TAP_WINDOW_MS;
  const hasTap = !!config.onTap;
  const hasDoubleTap = !!config.onDoubleTap;
  const hasHold = !!(config.onHoldStart || config.onHoldEnd);

  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let tapConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  let holdActive = false;
  let pressOpen = false;
  let awaitingSecondTap = false;
  let lastPressAt = 0;

  const clearHoldTimer = () => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };
  const clearTapConfirm = () => {
    if (tapConfirmTimer !== null) {
      clearTimeout(tapConfirmTimer);
      tapConfirmTimer = null;
    }
  };

  const press = (now: number = Date.now()) => {
    // A second quick press completes a double tap.
    if (hasDoubleTap && awaitingSecondTap && now - lastPressAt <= windowMs) {
      clearTapConfirm();
      clearHoldTimer();
      awaitingSecondTap = false;
      pressOpen = false;
      config.onDoubleTap?.();
      return;
    }

    lastPressAt = now;
    awaitingSecondTap = false;
    clearTapConfirm();

    // Snappy path: a token that only does Tap fires immediately on press.
    if (hasTap && !hasDoubleTap && !hasHold) {
      pressOpen = false;
      config.onTap?.();
      return;
    }

    pressOpen = true;
    if (hasHold) {
      clearHoldTimer();
      holdTimer = setTimeout(() => {
        holdTimer = null;
        holdActive = true;
        config.onHoldStart?.();
      }, holdMs);
    }
  };

  const release = (now: number = Date.now()) => {
    clearHoldTimer();
    if (holdActive) {
      holdActive = false;
      pressOpen = false;
      config.onHoldEnd?.();
      return;
    }
    if (!pressOpen) return;
    pressOpen = false;

    // A quick press-release is a tap candidate. Defer it when a double-tap shares
    // the token so a single input never fires both; otherwise fire it now.
    if (hasDoubleTap) {
      awaitingSecondTap = true;
      clearTapConfirm();
      const remaining = Math.max(0, windowMs - (now - lastPressAt));
      tapConfirmTimer = setTimeout(() => {
        tapConfirmTimer = null;
        const wasAwaiting = awaitingSecondTap;
        awaitingSecondTap = false;
        if (wasAwaiting && hasTap) config.onTap?.();
      }, remaining);
    } else if (hasTap) {
      config.onTap?.();
    }
  };

  const reset = () => {
    clearHoldTimer();
    clearTapConfirm();
    holdActive = false;
    pressOpen = false;
    awaitingSecondTap = false;
    lastPressAt = 0;
  };

  return { press, release, reset };
}

/**
 * A built dispatch for one input layer: a resolver per token (covering its tap /
 * double-tap / hold actions, possibly several actions sharing the token) plus the
 * list of chord-mode actions, which each layer fires on the rising edge of the
 * (multi-atom) token rather than through the timing machine.
 */
export interface TokenDispatch {
  resolvers: Map<string, TokenGestureResolver>;
  chordActions: Array<{ token: string; actionId: string }>;
}

export interface BuildTokenDispatchParams {
  /** actionId -> input token (empty string = unbound, skipped). */
  bindings: Record<string, string>;
  /** actionId -> activation mode. */
  modes: Record<string, ActivationMode>;
  /** Which actions this layer owns; others are ignored. */
  actionIds: readonly string[];
  /**
   * Build the TokenGestureConfig contribution for one (action, mode). Returning
   * undefined skips the action. Contributions for actions sharing a token are
   * merged, so e.g. rally(tap) + selectAll(double-tap) + deploy(hold) on one token
   * become a single resolver wired on all three slots.
   */
  configFor: (actionId: string, mode: ActivationMode) => Partial<TokenGestureConfig> | undefined;
  holdActivationMs?: number;
  doubleTapWindowMs?: number;
}

/**
 * Turn a binding + mode map into per-token resolvers and a chord-action list. Pure
 * and device-agnostic: the caller supplies the per-(action, mode) callbacks via
 * `configFor`, so the same builder serves keyboard, mouse, and controller.
 */
export function buildTokenDispatch(params: BuildTokenDispatchParams): TokenDispatch {
  const byToken = new Map<string, TokenGestureConfig>();
  const chordActions: Array<{ token: string; actionId: string }> = [];

  for (const actionId of params.actionIds) {
    const token = params.bindings[actionId];
    if (!token) continue; // unbound
    const mode = params.modes[actionId] ?? DEFAULT_ACTIVATION_MODE;
    if (mode === 'chord') {
      chordActions.push({ token, actionId });
      continue;
    }
    const contribution = params.configFor(actionId, mode);
    if (!contribution) continue;
    byToken.set(token, { ...(byToken.get(token) ?? {}), ...contribution });
  }

  const resolvers = new Map<string, TokenGestureResolver>();
  for (const [token, config] of byToken) {
    resolvers.set(
      token,
      createTokenGestureResolver({
        ...config,
        holdActivationMs: params.holdActivationMs,
        doubleTapWindowMs: params.doubleTapWindowMs,
      })
    );
  }
  return { resolvers, chordActions };
}
