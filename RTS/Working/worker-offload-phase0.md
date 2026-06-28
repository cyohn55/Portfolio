# Phase 0 — Decouple the sim behind a command-in / snapshot-out boundary

Goal: make the simulation reachable **only** through a serializable command bus
(writes) and a single read-only snapshot accessor (reads), with **zero** worker
yet. When this is done, flipping the worker switch in Phase 1 is mechanical.

The blocker today is that `useGameStore` (`src/game/state.ts:785`, `Store =
GameState & { ... }`) conflates four concerns that the worker boundary splits
apart. Phase 0 is fundamentally **partitioning the store along that line**, then
forcing every call site onto the correct side.

---

## 1. Partition every Store member into a bucket

| Bucket | Lives after offload | Members (from `Store`) |
|---|---|---|
| **A. Sim state (authoritative)** | Worker only | `units`, `players`, `projectiles`, `unitOrders`, `queenPatrols`, `queenRallyTargets`, `matchStats`, `gameOver`, `winner`, `matchStarted`, `lastSpawnAtMsByQueenId`, `lastRegenAtMsByUnitId`, `pilotedUnitIdByOwner`, `pilotMoveByOwner`, `pilotedFireTeamByOwner`, `fireTeams`, `bridgeState`, `movementHeldUnitId` (sim-replicated via the `setMovementHold` command), plus internal machinery: `rng`, `matchSeed`, `spatialGrid`, `tickCounter`, `lastRegenCheckMs`, `lastWinCheckMs`, `aiThinkingOffset`, `movementDirectionCache`, `targetCache`, `unitCountCache`, `deadUnitsToRemove` |
| **B. Sim actions → become commands** | Worker only (invoked via posted `NetCommand`) | `tick`, `moveCommand`, `setPatrol`, `setQueenRally`, `attackTarget`, `setBehavior`, `setFormation`, `adjustFormation`, `callPlay`, `toggleTurtleShell`, `throwEggs`, `fireTongues`, `hiss`, `swarm`, `pickup`, `deliverCargo`, `placeRalliedUnits`, `setMovementHold`, `applyPilotSelection`, `applyPilotMove`, `applyRallyMonarch`, `applyPlaceRallied`, `applyReleaseControl`, `applyPilotFireTeam`, `updateBridgeAnimations`, `startMatch`, `startMultiplayerMatch` |
| **C. Local-UI state (mirror / purely local)** | Main thread | `selectedUnitIds`, `selectedAnimalPool`, `pilotedUnitId`, `pilotedFireTeamId`, `unitPlacementCount`, `unitPlacementCursor`, `localPlayerId`, `matchStartNonce`, `currentScreen`, `isPaused` + their setters (`selectUnits`, `addToSelection`, `clearSelection`, `incrementUnitPlacement`, `resetUnitPlacement`, `setUnitPlacementCursor`, `transitionToScreen`, `unpauseGame`, `togglePause`) |
| **D. Settings / config (never touches worker)** | Main thread | `lightingSettings`, `shadowsEnabled`, `healthBarsEnabled`, `unitAurasEnabled`, `musicEnabled`, `keyboardBindings`, `controllerBindings`, `keyboardBindingModes`, `controllerBindingModes`, `controlSpeeds` + their setters |
| **A′. Sim config (deterministic — worker)** | Worker only, set via command | `optimizations`, `ultraPerformanceMode` — **NOT UI settings.** The tick reads `optimizations.{aiThrottling,regenThrottling,winCheckThrottling}` (`state.ts:1891,2181,3136`) to gate throttling, which changes sim outcomes. In MP both peers must hold identical values or they desync, so these are deterministic sim config: `toggleOptimization` must become a command, not a free local toggle. |

**Key realization:** the piloting subsystem already prototypes the exact split we
need everywhere. `pilotedUnitId` is documented as *"LOCAL player's pilot, used
only by the UI"* (Bucket C) while the sim drives monarchs from
`pilotedUnitIdByOwner` (Bucket A), fed by `applyPilotMove`/`setPilot` commands
(Bucket B). Generalize that pattern: **local intent is a command; authoritative
result is a snapshot field.**

### Action: split the store into two stores
- `useSimMirrorStore` — Buckets A + C-mirrors, written **only** by snapshot ingest.
- `useUiStore` — Buckets C-local + D, written directly by the UI (no worker).

Settings (D) must move out first because they're interleaved into the same
`create()` today and would otherwise get clobbered every snapshot.

---

## 2. Write side — route everything through the command bus

There is already a serializable input boundary: `NetCommand` (`net/netMessages.ts:52`)
and `applyNetCommand(playerId, command)` (`state.ts:4308`). MP already funnels
through it. Phase 0 makes **single-player do the same**, so there is one and only
one path into the sim.

### Direct write call sites to re-route (Bucket B invocations)

| File | Lines | Calls | Disposition |
|---|---|---|---|
| `Working/GamepadController.tsx` | 340,350,355,364,397,413,419,589,594,627,803,1391 | `placeRalliedUnits`, `setQueenRally`, `setPatrol`, `moveCommand`, + local `incrementUnitPlacement`/`setUnitPlacementCursor`/`setMovementHold`/`resetUnitPlacement` | Sim calls → `dispatch(NetCommand)`. The `unitPlacement*` / `movementHold` ones are **Bucket C (local)** — leave on `useUiStore`. |
| `KeyboardShortcuts.tsx` | 128,134 | `incrementUnitPlacement` (C, local), `placeRalliedUnits` (B → command) | Split per bucket |
| `HexInteraction.tsx` | 65–78 (hook handles) | `moveCommand`, `setPatrol`, `setQueenRally`, `toggleTurtleShell`, `throwEggs`, `fireTongues`, `hiss`, `swarm`, `pickup`, `deliverCargo` (all B) + `clearSelection`, `selectUnits`, `addToSelection`, `setMovementHold` (C, local) | The big one. Every B-handle becomes `dispatch(cmd)`; selection stays local. |
| `Working/net/multiplayerSession.ts` | 138,151 | `startMultiplayerMatch` (B), `transitionToScreen` (C) | Match-lifecycle commands |
| `Working/net/netMatch.ts` | 52 | `tick` via adapter | Already the adapter seam — becomes "post tick" in Phase 1 |
| `App.tsx`, `PostGameScreen.tsx`, `AnimalSelectionLobby.tsx` | various | `initializeGame`, `startMatch`, `chooseAnimalsForLocal` (B, lifecycle) | Lifecycle commands |

### Deliverable: one dispatch funnel
Introduce `dispatchCommand(cmd: NetCommand)` on the **main thread** that today
calls `applyNetCommand(localPlayerId, cmd)` synchronously (in-thread, no behavior
change), and in Phase 1 becomes `worker.postMessage`. Replace **every** Bucket-B
call site above with it. After this step, `grep` for `.getState().moveCommand(`
(and the other 16 sim actions) outside `state.ts`/the funnel must return **zero**
hits — that grep is the Phase-0 done check for the write side.

### Hybrid handles (set local state AND issue a command)
`pilotMonarchById`, `pilotCycleMonarch`, `togglePilotMonarchKind`,
`rallyToMonarch`, `cycleFireTeam`, `clearPilot` each set a Bucket-C field
(`pilotedUnitId`) **and** must reach the sim (`applyPilotSelection` etc.). Split
each into: (1) `useUiStore` set for the local mirror (instant feedback), (2)
`dispatchCommand` for the authoritative effect. The local set is the optimistic
echo; the snapshot later confirms it.

---

## 3. Read side — one snapshot accessor

62 `getState()` read sites outside `state.ts`. They become reads of the
main-thread **mirror** (Bucket A/C), refreshed once per snapshot — i.e. up to one
frame stale. Audit them in three tiers:

| Tier | Tolerates 1-frame stale? | Sites (by file, count) | Action |
|---|---|---|---|
| **Render/visual** | Yes | `UnitsLayer.tsx` (2), `Minimap.tsx`, `PerformanceOptimizer.tsx` (`units.length`), `UnitPlacementIndicator.tsx` (2), `DirectingRadial.tsx` (2), HUD/PostGame selectors | No logic change — just read the mirror. Re-point at SoA buffer in Phase 1. |
| **Input → read-back same frame** | **No — risk** | `GamepadController.tsx` (29), `HexInteraction.tsx` selection, `KeyboardShortcuts.tsx` (6) | These read live sim to decide the *next* command (e.g. "find the lone Queen under the cursor, then patrol her"). Must either (a) read from the snapshot taken at frame start (acceptable — sim can't have moved since last tick anyway), or (b) move the decision into the command and let the sim resolve it. Prefer (a); reserve (b) for anything reading a value the **same command** just changed. |
| **Net / harness** | N/A (already sim-side) | `net/multiplayerSession.ts` (2), `net/netMatch.ts`, `ai/aiCommander.ts`, `ai/replayRecorder.ts` (3) | Move **into** the worker in Phase 1 (they run alongside the tick). No mirror needed. |

`computeBridgeOccupancy` in `HexGrid.tsx`'s `updateFlagVisuals` reads
`getState().units` every frame — Tier 1 (visual), reads the mirror.

### Deliverable: `getSimSnapshot()`
A single accessor returning the current mirror. All Tier-1/2 reads go through it.
Forbid `useGameStore.getState().units` (and other Bucket-A fields) outside it via
an ESLint `no-restricted-syntax` rule — that rule is what keeps the boundary from
rotting back.

---

## 4. Enforce single source of truth

After offload, the mirror is **read-only**; every write is a command. Add a lint
rule banning `set(...)` / direct assignment to Bucket-A fields outside the snapshot
ingest. Any leftover direct mutation = ghost state / desync in Phase 1.

---

## 5. Verification (no worker yet)

Phase 0 must be a **pure refactor** — behavior identical. Validate with the
existing determinism harness pattern (`Unit Tests/lockstep-determinism.spec.ts`):

1. Bundle the store for Node (esbuild, `--define:import.meta.env.DEV=false`).
2. Run a fixed seeded command script through the **new `dispatchCommand` funnel**.
3. Assert per-tick `computeStateChecksum()` (`state.ts:4352`) is **bit-identical**
   to a run on the pre-refactor code with the same script.

Plus the two structural grep gates above (zero direct sim-action calls, zero
Bucket-A reads outside the accessor).

---

## Concrete task checklist (order matters)

- [x] **T1 — DONE.** Bucket D extracted to `src/game/uiSettingsStore.ts` (one
      standalone store) and fully cut over.
      - **T1a/T1b:** the store holds lighting, shadows, healthBars, unitAuras,
        music, controlSpeeds, AND keyboard/controller bindings (+modes), with
        faithful persistence — incl. the lighting "load-but-don't-write" quirk
        owned by `Settings.tsx`, and binding persistence delegated to
        `controlBindings.ts`. `optimizations`/`ultraPerformanceMode` deliberately
        kept in `state.ts` (Bucket A′ — read by the tick).
      - **T1c (cutover):** all 16 consumer components re-pointed at
        `useUiSettingsStore`; the slice (type fields, loaders, init, setters, and
        the now-unused `controlBindings` imports) deleted from `state.ts`
        (−268 lines). 4 reads that pulled a Bucket-D field off a shared
        `useGameStore.getState()` (UnitsLayer, GamepadController ×2) were split to
        source the setting from `useUiSettingsStore`.
      - **Verification:** `tsc` clean (exit 0); `vite build` clean (exit 0, dist
        regenerated); `Unit Tests/ui-settings-store.spec.ts` 6/6 passing; structural
        gates green (zero Bucket-D reads remain on `useGameStore`; zero Bucket-D
        fields remain on the `Store` type). Browser-based determinism spec not run
        (headless browser disabled in this env) — `state.ts` change is sim-path-
        neutral (removed non-tick settings only). Node-only spec runner:
        `npx playwright test --config Working/pw-nodeonly.config.ts <spec>`.
- [~] **T2** Extract Bucket C (local-UI). **Investigation (2026-06-27) found
      Bucket C is NOT uniformly extractable** — it splits in two:
      - **C-entangled — BLOCKED until T3/T4/T5:** `pilotedUnitId`,
        `pilotedFireTeamId`, `selectedUnitIds` are written by the `apply*ToDraft`
        NetCommand handlers (`state.ts:441/475/514/543`) which the tick itself
        invokes (the tick writes `pilotedFireTeamId` directly at ~`state.ts:2786`);
        `localPlayerId` is read sim-wide (70 refs). Moving these now would force the
        sim/command layer to write a main-thread store — impossible once the sim is
        in a worker. Correct fix (needs the snapshot, T5): the sim owns the
        authoritative `*ByOwner` maps (Bucket A, already present) and the main thread
        DERIVES these local mirrors from the snapshot. **Defer.**
      - **C-presentation — extractable now (no tick coupling):** `currentScreen`
        (+`transitionToScreen`), `isPaused`/`unpauseGame`/`togglePause`,
        `unitPlacementCount`/`unitPlacementCursor` (+gesture setters). Caveat: reset
        inside `startMatch`/`initializeGame`'s shared `set()`, so extraction must
        split those lifecycle resets into a main-thread cross-store call (not the
        tick — acceptable).
      - **Implication:** the high-value Bucket-C items (selection, piloting) follow
        the command bus. T3/T4 are the true unblocker — consider doing them before
        the rest of T2.
- [x] **T3 — DONE.** `dispatchCommand(command: NetCommand)` added to `state.ts` as
      the single funnel for locally-issued input. Gameplay commands delegate to the
      existing self-routing typed action; pilot/control commands route-then-pure-apply
      (mirroring the UI handles). `applyNetCommand` (the authoritative lockstep/AI/replay
      path) left untouched. Proven behaviour-neutral by
      `Unit Tests/dispatch-command-equivalence.harness.mjs` (Node, esbuild bundle):
      a scripted gameplay+pilot stream via `dispatchCommand` is byte-identical to the
      same stream via `applyNetCommand` for all 300 ticks. Existing two-peer + pilot
      determinism harnesses still green; tsc clean.
      - **T4 scope found:** ~13 clean 1:1 gameplay sites (moveUnits/setPatrol/
        setQueenRally/attackTarget) in HexInteraction, GamepadController, UnitsLayer;
        PLUS the ability handles dispatched via a shared indirection
        (`HexInteraction:418/435` bundles throwEggs/hiss/swarm/… into one handler);
        PLUS pilot handles (entangled with the deferred Bucket-C piloting work).
        Several sites sit in `useCallback` dep arrays (HexInteraction) needing cleanup.

      - **Audit (confirmed during T3):** `applyNetCommand` already handles 22 command
        types — every in-match Bucket-B action has a variant. No gameplay-command
        gaps. Only setup/lifecycle (`initializeGame`, `chooseAnimalsForLocal`,
        `startMatch`, `startMultiplayerMatch`) and the special
        `tick`/`updateBridgeAnimations` lack a command — handle those as a separate
        `control` channel, not tick-aligned commands.
- [ ] **T4** Re-route all Bucket-B call sites (§2 table) to `dispatchCommand`.
- [ ] **T5** Add `getSimSnapshot()`; re-point all 62 read sites (§3 tiers).
- [ ] **T6** Add the two ESLint guard rules (banned reads, banned writes).
- [ ] **T7** Determinism harness: assert checksum parity pre/post refactor.

T3+T4 are the spine; T1/T2 unblock them; T5 is the bulk of the line-count;
T6/T7 lock it in.
