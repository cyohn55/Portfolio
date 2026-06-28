// Transient main-thread UI/session state (Bucket C-presentation), split out of the
// monolithic game store (src/game/state.ts) so the deterministic simulation can
// later move into a Web Worker without dragging screen-routing state across the
// wire (see Working/worker-offload-phase0.md).
//
// Distinct from uiSettingsStore.ts (Bucket D — PERSISTED display/audio/input
// settings): this store holds NON-persisted, per-session UI state. Neither store
// ever enters the tick, so a per-tick snapshot from the sim worker can replace the
// sim mirror wholesale without ever clobbering either.
//
// `currentScreen` is pure top-level routing (menu / lobby / playing / postgame /
// leaderboard / conquest…). The simulation never reads it — it is written only by
// `transitionToScreen` from the UI, exactly as it was on the old game store, so the
// cutover is behaviour-neutral.

import { create } from 'zustand';

export type GameScreen =
  | 'menu'
  | 'lobby'
  | 'multiplayer'
  | 'playing'
  | 'postgame'
  | 'leaderboard'
  | 'conquestLobby'
  | 'conquest';

type UiStore = {
  currentScreen: GameScreen;
  transitionToScreen: (screen: GameScreen) => void;

  // Single-player pause. Local-only UI state: the simulation tick must NOT read it
  // (the worker can't see main-thread state) — the game loop gates tick advancement
  // on this instead. Multiplayer never pauses (lockstep can't), so it stays false
  // there. `setPaused` is the explicit setter used by lifecycle/pause-menu sites;
  // `unpauseGame`/`togglePause` are the named conveniences the UI already used.
  isPaused: boolean;
  setPaused: (paused: boolean) => void;
  unpauseGame: () => void;
  togglePause: () => void;
};

export const useUiStore = create<UiStore>((set) => ({
  currentScreen: 'menu',
  transitionToScreen: (screen) => set({ currentScreen: screen }),

  isPaused: false,
  setPaused: (paused) => set({ isPaused: paused }),
  unpauseGame: () => set({ isPaused: false }),
  togglePause: () => set((state) => ({ isPaused: !state.isPaused })),
}));
