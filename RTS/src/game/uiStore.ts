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

// Position of the cursor-deploy teardrop, mirroring the sim's Position3D shape without
// importing the sim store (uiStore stays a leaf module the worker-bound state.ts can
// depend on, never the reverse). x/z are world coordinates; y is unused for the cursor.
export type PlacementCursor = { x: number; y: number; z: number };

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

  // Hold-to-deploy teardrop indicator: how many followers the held Deploy gesture has
  // designated (`unitPlacementCount`) and, for the controller cursor-deploy, the ground
  // point the teardrop floats over (`unitPlacementCursor`, null = float over the piloted
  // monarch). Pure local-UI state — the simulation neither reads nor writes it (the
  // actual deploy order is issued separately via the placeRallied command). It lived on
  // the sim store until worker-offload P1-1; the sim-reading orchestrators that drive it
  // (incrementUnitPlacement / placeRalliedUnits in state.ts) now write these setters.
  // The LOCAL player's current unit selection. Pure main-thread UI state since
  // worker-offload P1-PRE severed the last sim read of it (single-player movement
  // priority now derives from unitOrders): the simulation neither reads nor writes the
  // selection. It is set directly by gestures (selectUnits / addToSelection here) and by
  // the sim-reading orchestrators in state.ts (clearSelection, rallyToMonarch,
  // beginLocalPilot, cycleFireTeam, placeRalliedUnits) and the post-tick
  // syncLocalSelectionMirror, all of which call these setters. Moved off the sim store in
  // P1-1 so the worker can't be asked to write it.
  selectedUnitIds: string[];
  selectUnits: (unitIds: string[]) => void;
  addToSelection: (unitIds: string[]) => void;

  // The LOCAL player's pilot UI mirror: which monarch (pilotedUnitId) or deployed fire
  // team (pilotedFireTeamId) the player is driving, or null. Used only by the UI (the gold
  // ring, the camera follow, the radials) — the SIMULATION drives from the authoritative
  // per-owner maps (pilotedUnitIdByOwner / pilotedFireTeamByOwner, Bucket-A on the sim
  // store), never these. Since T2-C the sim no longer writes the mirror; the main thread
  // DERIVES it from those maps each frame via syncLocalPilotMirror (state.ts), and gestures
  // echo it optimistically. Moved off the sim store in P1-1 (this slice) so the worker can't
  // be asked to write it. setPilotMirror is the per-frame derivation write; the optimistic
  // single-field gesture writes go through setState directly from state.ts.
  pilotedUnitId: string | null;
  pilotedFireTeamId: string | null;
  setPilotMirror: (pilotedUnitId: string | null, pilotedFireTeamId: string | null) => void;

  unitPlacementCount: number;
  unitPlacementCursor: PlacementCursor | null;
  setUnitPlacementCount: (count: number) => void;
  setUnitPlacementCursor: (point: PlacementCursor | null) => void;
  // Cancel a placement hold that ended without deploying (a quick tap, a deselect, or the
  // monarch dying): clear both fields, but only touch each when it is non-default so an
  // idle frame never fires a needless re-render of the teardrop indicator.
  resetUnitPlacement: () => void;
};

export const useUiStore = create<UiStore>((set) => ({
  currentScreen: 'menu',
  transitionToScreen: (screen) => set({ currentScreen: screen }),

  isPaused: false,
  setPaused: (paused) => set({ isPaused: paused }),
  unpauseGame: () => set({ isPaused: false }),
  togglePause: () => set((state) => ({ isPaused: !state.isPaused })),

  selectedUnitIds: [],
  selectUnits: (unitIds) => set({ selectedUnitIds: unitIds }),
  addToSelection: (unitIds) =>
    set((state) => ({ selectedUnitIds: Array.from(new Set([...state.selectedUnitIds, ...unitIds])) })),

  pilotedUnitId: null,
  pilotedFireTeamId: null,
  setPilotMirror: (pilotedUnitId, pilotedFireTeamId) => set({ pilotedUnitId, pilotedFireTeamId }),

  unitPlacementCount: 0,
  unitPlacementCursor: null,
  setUnitPlacementCount: (count) => set({ unitPlacementCount: count }),
  setUnitPlacementCursor: (point) => set({ unitPlacementCursor: point }),
  resetUnitPlacement: () =>
    set((state) => ({
      unitPlacementCount: state.unitPlacementCount !== 0 ? 0 : state.unitPlacementCount,
      unitPlacementCursor: state.unitPlacementCursor !== null ? null : state.unitPlacementCursor,
    })),
}));
