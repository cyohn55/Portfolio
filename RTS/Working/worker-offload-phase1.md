# Phase 1 — Flip the worker switch

Goal: run the deterministic simulation in a Web Worker. Phase 0 made this
**mechanical** by forcing every write through `dispatchCommand` (one funnel) and
every read through `getSimSnapshot()` (one seam), with the boundary guarded
(`snapshot-boundary.guard.mjs`) and the sim's mirror fields derived main-thread
(`syncLocalPilotMirror` / `syncLocalSelectionMirror`). Phase 1 swaps the two ends of
those seams from in-thread calls to worker messages.

The work splits into one **prerequisite** (a real sim behaviour decision that can't
be deferred), then the migration proper in **safe increments** — each
behaviour-neutral and gated by the existing harness suite.

---

## P1-PRE — DONE (2026-06-28). Sever the last sim READ of a Bucket-C field

**Resolved with option (A)** (user decision): single-player movement-priority now derives
from `unitOrders`, identical to lockstep — `movementPriorityIds = new Set(Object.keys(
draft.unitOrders))` at `state.ts:~1473`. The sim no longer reads ANY Bucket-C field.
Behaviour change: a *selected but order-less* unit (e.g. a piloted monarch) no longer gets
make-way priority until it has an active order.
- **Verification:** `tsc` + `vite build` clean; the relative-comparison harnesses
  (dispatch-equivalence, two-peer, pilot determinism, pilot/selection mirror derivation)
  stayed green unchanged; `sim-checksum-baseline` digest was UNCHANGED (its scripted units
  all carry move orders, so the priority set is identical either way); only
  `pilot-handle-equivalence` shifted — exactly the piloted order-less King (K-2) losing
  priority — and its golden was re-blessed (c9d773db… → bb4ef00d…) with the change documented
  inline. The boundary guard still confines sim reads to state.ts + the 6 allowlisted files.

## (original P1-PRE plan, for reference) Sever the last sim READ of a Bucket-C field

`state.ts:~1495` still reads `selectedUnitIds` to seed single-player
movement-priority:

```ts
const isLockstepMatch = commandRouter !== null;
const movementPriorityIds = new Set(
  isLockstepMatch ? Object.keys(draft.unitOrders) : draft.selectedUnitIds
);
```

This is the ONLY place the sim still reads a Bucket-C (main-thread) field. A worker
tick cannot see the main-thread selection, so this must go before the sim moves.
Lockstep already derives priority from `unitOrders`; only single-player still uses
selection. Options:

- **(A) Unify SP onto the lockstep `unitOrders` rule.** One rule everywhere; the sim
  reads only Bucket-A. **Behaviour change in SP:** a *selected but order-less* unit
  loses its "push through idle teammates / royal make-way" priority until it has an
  active order. Simplest, and arguably the better rule. Not visible to the harnesses
  (all lockstep), so it needs a *new* SP-priority harness or a manual check.
- **(B) Feed selection into the worker as an SP-only, non-networked command.** Keeps
  current SP behaviour exactly, but adds selection to the sim's input surface (a new
  command + apply handler) — re-entangles what Phase 0 worked to separate.
- **(C) Compute the priority set on the main thread and pass it with the tick
  message.** SP-only side input to the tick; keeps behaviour, keeps selection out of
  the persistent sim state, but the tick signature grows a per-frame param.

**Recommendation: (A)** — it deletes the coupling outright and matches MP. It is a
deliberate, documented gameplay tweak (no longer a pure refactor), so re-bless the
checksum goldens and add an SP-priority assertion. **Decision needed from the user
before proceeding.**

---

## P1-1 — Split `useGameStore` into the three stores (§1 of phase 0), still main-thread

Behaviour-neutral cutover, no worker yet — this is the bulk of the line-count and the
riskiest mechanical step, so it lands first and on its own.

> **⚠️ VERIFICATION CONSTRAINT (2026-06-28).** P1-1's risk surface is React rendering
> reactivity across **58 reactive `useGameStore((s)=>…)` subscriptions in 15 files** (vs
> only 6 imperative `getState()` sites, already routed through `getSimSnapshot()`). The
> tsc-driven removal pattern (delete the field from `useGameStore` ⇒ tsc flags every
> consumer) guarantees no consumer is left reading a dead field, but it does NOT prove the
> migrated subscription still *re-renders at the right time* — and this store has a
> documented mutated-in-place reactivity quirk (see the "RTS mutated-state UI trap" memory:
> the tick mutates `units`/`matchStats`/`gameOver` in place and components lean on `units`
> to drive re-renders). Swapping the reactivity substrate from the live mutated store to an
> ingested mirror can perturb exactly those re-render edges. That class of bug is only
> catchable by running the app — and **Playwright/headless-browser verification is disabled
> in this environment** (see "RTS no Playwright verification" memory). So the reactive-sub
> migration must be paired with a manual in-browser pass (or a re-enabled browser check)
> before it can be called done; tsc + the sim harnesses are necessary but not sufficient.

### P1-1 progress — executing as verifiable slices (user chose "cutover, verify in-browser")

- **Slice 1 DONE (placement teardrop) — 2026-06-28.** `unitPlacementCount` /
  `unitPlacementCursor` moved off the sim store onto `useUiStore`. Chosen first because it
  is the smallest fully-main-thread C field (post-T2-D the sim neither reads nor writes it)
  with the most isolated render surface (just the teardrop indicator), so it proves the
  cross-store pattern end-to-end on low risk. The pure teardrop setters
  (`resetUnitPlacement` / `setUnitPlacementCursor`) now live directly on `useUiStore`; the
  two sim-reading orchestrators (`incrementUnitPlacement` / `placeRalliedUnits`) stay on the
  sim store (they read the piloted monarch's followers) but write the `useUiStore` setters.
  Lifecycle resets (initializeGame / startMatch), the pilot/selection handles (clearSelection,
  clearPilot, cycleFireTeam, beginLocalPilot), and the post-tick `syncLocalPilotMirror`
  death-release clear all call `useUiStore.getState().resetUnitPlacement()` cross-store.
  tsc-driven cutover (removed the two fields from the `Store` type ⇒ tsc flagged every
  consumer: UnitPlacementIndicator's 2 reactive subs → `useUiStore`; KeyboardShortcuts +
  GamepadController imperative reads + cursor/reset calls → `useUiStore`). `state.ts`
  re-exports `useUiStore` so the headless harnesses reach the same singleton.
  - **Verified:** tsc + vite build clean; all 8 sim harnesses green (selection-mirror
    derivation updated to drive placement via `useUiStore`). **Rendering NOT browser-verified
    (see constraint above).** → **In-browser checklist for the user:** pilot a King/Queen,
    HOLD the Deploy/rally key → the blue teardrop appears and its number climbs the ladder
    (1,5,10,…); release → that many followers peel off and the teardrop vanishes; on
    controller, hold the cursor-deploy trigger → the teardrop floats over the moving cursor
    and deploys there; deselect / switch monarch / let the piloted monarch die → the teardrop
    disappears immediately.
- **Slice 2 DONE (selectedUnitIds) — 2026-06-28.** The largest reactive surface. Moved
  `selectedUnitIds` + the pure setters `selectUnits` / `addToSelection` onto `useUiStore`.
  Safe because P1-PRE already severed the only sim read of selection, so it is now purely
  main-thread. The sim-reading orchestrators (clearSelection, rallyToMonarch, beginLocalPilot,
  cycleFireTeam, placeRalliedUnits) and the post-tick `syncLocalSelectionMirror` stay in
  state.ts but write the `useUiStore` setters; lifecycle resets (initializeGame / startMatch)
  call `useUiStore.getState().selectUnits([])` cross-store. tsc-driven cutover of all
  consumers:
  - Reactive subs → `useUiStore`: HexInteraction (selectedUnitIds + selectUnits + addToSelection),
    AnimalSelectionButtons, CameraController, BehaviorRadial, DirectingRadial.
  - Imperative reads → `useUiStore.getState().selectedUnitIds`: UnitsLayer (per-frame render
    read + right-click pick), CameraController (auto-follow centroid), GamepadController
    (loneSelectedQueen, cursor command, ability ctx).
  - `selectUnits` callers → `useUiStore`: KeyboardShortcuts (selectByAnimal / selectAll),
    GamepadController (primary-action / select-group / select-all / select-monarch-animal).
  - BehaviorRadial's `behaviorSignature` selector still subscribes to the sim store for
    `units` (re-runs each tick) but reads the selection from the component's `useUiStore`
    closure value, so it stays current with at most one tick of lag — fine for a wheel
    highlight.
  - **Verified:** tsc + vite build clean; all 8 sim harnesses + boundary guard green (the 5
    harnesses that selected units for legacy setup redirected to `useUiStore`; selection no
    longer affects any checksum). **Rendering NOT browser-verified.** → **In-browser checklist:**
    left-click / drag-select units → gold ring + HUD highlight track the selection; right-click
    → the selected army moves/attacks (not the piloted monarch); Shift-click adds; click empty
    ground deselects; the King/Queen selection buttons highlight the piloted monarch; the
    behavior + directing radials highlight the selected units' current postures; camera
    auto-follow eases onto the selection; reinforcements spawned behind a selected monarch join
    the selection.
- **Slice 3 DONE (pilotedUnitId / pilotedFireTeamId) — 2026-06-28.** The pilot UI mirror
  moved onto `useUiStore` (the authoritative `pilotedUnitIdByOwner` / `pilotedFireTeamByOwner`
  maps stay sim-side). Safe because since T2-C the sim already DERIVES the mirror rather than
  writing it. `syncLocalPilotMirror` now reads + writes the mirror on `useUiStore` (via the
  new `setPilotMirror` setter); the optimistic gesture writes (beginLocalPilot, clearPilot,
  clearSelection) use `useUiStore.setState`; lifecycle resets call `setPilotMirror(null, null)`.
  - **Also fixed a T2-C straggler:** `applyRallyToDraft` was still writing the mirror
    (`draft.pilotedFireTeamId = null`) directly from the sim; removed — the derivation from
    `pilotedFireTeamByOwner` is the heir.
  - tsc-driven cutover: reactive subs → `useUiStore` (HUD, DirectingRadial, UnitPlacementIndicator);
    imperative reads → `useUiStore.getState()` (CameraController, UnitsLayer, KeyboardShortcuts,
    GamepadController); the state.ts pilot gesture handles (pilotMonarchBySlot/ById/cycle,
    togglePilotMonarchKind, rallyToMonarch, cycleFireTeam, increment/placeRalliedUnits) read
    the mirror from `useUiStore`.
  - **Verified:** tsc + vite build clean; all 8 `.mjs` harnesses + boundary guard green
    (pilot-mirror + selection-mirror derivation harnesses updated to read the mirror on
    `useUiStore`). **Rendering NOT browser-verified.** → **In-browser checklist:** pilot a
    King/Queen (A / slot keys / on-screen buttons) → gold ring + HUD show the piloted monarch;
    G swaps King/Queen; A cycles animals; drive a fire team (cycleFireTeam) → camera follows
    the squad; on the piloted monarch's death the ring/HUD clear; the Directing radial
    highlights the driven fire team.
  - **Follow-up — disabled browser specs (Playwright off in this env):** several Playwright
    specs set/read the now-moved Bucket-C fields via `window.__rtsStore` (selection: queen-
    rally-spawn, monarch-reselect-followers; vestigial selection setup: turtle-shell-lock,
    dynamics, etc.). `__rtsUiStore` is now exposed (dev handle) so they can be re-pointed, and
    the selection/pilot DERIVATION behavior they covered is now covered by the runnable
    `selection-mirror-derivation` + `pilot-mirror-derivation` harnesses. The specs still need a
    mechanical re-point to `__rtsUiStore` (and a `syncLocalSelectionMirror` call for the spawn
    auto-select assertions) — deferred until Playwright is re-enabled, since they can't be run
    or verified headlessly here.
- **Slice 4 DONE (selectedAnimalPool) — 2026-06-28.** The pre-game lineup + its setter
  `chooseAnimalsForLocal` moved onto `useUiStore`. The sim reads it only ONCE at match setup
  (startMatch bakes the local player's units from it), never per-tick, so it is main-thread
  UI state. `startMatch` reads it cross-store (`useUiStore.getState().selectedAnimalPool`);
  `startMultiplayerMatch` seeds it cross-store before calling startMatch. tsc-driven cutover:
  AnimalSelectionButtons, UnitsLayer, PostGameScreen (reactive subs); KeyboardShortcuts,
  GamepadController (selectByAnimal / selectGroup reads); AnimalSelectionLobby + PostGameScreen
  (`chooseAnimalsForLocal`); replayRecorder (lineup capture). `useUiStore` takes a type-only
  `AnimalId` import (no cycle). **Verified:** tsc + vite build clean; all 8 `.mjs` harnesses +
  boundary guard green. **In-browser checklist:** lobby animal picks + "Play Again" lineup
  carry into the match; the King/Queen selection buttons + select-group keys map to the chosen
  3 animals.
- **Disabled browser specs RE-POINTED (P1-1 follow-up) — 2026-06-28.** With `__rtsUiStore`
  and a new `__rtsSyncLocalMirrors()` dev handle (runs the post-tick pilot+selection
  derivations a manual-ticking test needs) exposed, the genuinely-broken Playwright specs were
  fixed: `monarch-reselect-followers` (selection/pilot/pool now read+written on `__rtsUiStore`),
  `queen-rally-spawn` ×2 (the spawn auto-select tests baseline + run `__rtsSyncLocalMirrors`
  around the manual tick and read selection from `__rtsUiStore`), and `lockstep-determinism`
  (lineup seeded via `__rtsUiStore.chooseAnimalsForLocal`, unpause via `__rtsUiStore.unpauseGame`
  — the latter also fixing a stale T2-B `isPaused` reference). Still **NOT runnable here**
  (Playwright disabled), so these are correct-by-construction, not live-verified. Specs that
  only set `selectedUnitIds`/`isPaused` as inert setup and never read them back (move-command-*,
  queen-patrol-stale-path, turtle-shell-lock, bridge-combat-crossing, dynamics, unit-separation)
  were left untouched: the sim ignores selection since P1-PRE, so those keys are harmless
  phantoms and the specs still pass.
- **Remaining:** `localPlayerId` stays on the sim store (read sim-wide; becomes worker config
  in P1-2). With selection / pilot / placement / lineup all off the sim store, P1-1's
  Bucket-C extraction is essentially complete — what's left on the sim store the UI subscribes
  to is Bucket-A (units, players, gameOver, matchStats, …), which become the worker snapshot
  in P1-2.

- **Sim module (`state.ts`):** keeps Bucket A + A′ + the tick + all command handlers.
  Becomes "the simulation," unaware of any store split.
- **`useSimMirrorStore` (new, main thread):** holds the per-frame snapshot the UI
  renders from — Bucket A (read-only copy) + the C-mirrors (`selectedUnitIds`,
  `pilotedUnitId`, `pilotedFireTeamId`). Written ONLY by snapshot ingest + the
  `syncLocal*Mirror` derivations.
- **`useUiStore` (exists):** absorbs the remaining C-local fields
  (`unitPlacementCount/cursor`, `localPlayerId`, `matchStartNonce`). D already split
  (`useUiSettingsStore`).
- `getSimSnapshot()` returns `useSimMirrorStore.getState()` instead of the live store;
  the 20+ already-routed read sites change nowhere (they call the accessor).
- Pre-worker, "ingest" is a synchronous `set(simState)` after each tick — so this step
  is provably behaviour-neutral and the full harness suite must stay byte-identical.

## P1-2 — Stand up the worker, sim runs inside it

> **Approach chosen (user, 2026-06-28): Option B** — `useGameStore` STAYS the main-thread
> React store (it becomes the snapshot mirror); the sim is extracted to run in the worker.
> Components keep subscribing to `useGameStore` (≈0 churn), so the rendering risk — the part
> that can't be verified headlessly here — is minimised. The risk lives in the sim-extraction
> + protocol seam, which the `.mjs` determinism harnesses CAN verify.

### P1-2 progress — worker pipeline built + proven (NOT yet flipped) — 2026-06-28

Built the worker pipeline **additively** (the live loop still ticks in-thread), under
`src/components/Working/sim/`:
- **`simProtocol.ts`** — the serializable message types (`start` / `command` / `runTicks`
  main→worker; `snapshot` worker→main) and `SIM_SNAPSHOT_FIELDS`: the plain-data Bucket-A
  slice the mirror ingests, deliberately EXCLUDING the worker-internal machinery that must
  never cross the wire (the `SeededRng` + `SpatialGrid` class instances, the per-tick caches).
- **`simWorkerHost.ts`** — the testable bridge: `processSimRequest` forwards each request to
  the store's existing deterministic actions (`startMultiplayerMatch` / `dispatchCommand` /
  `tick`); `buildSimSnapshot` picks the snapshot fields + stamps the checksum/tick. Holds no
  state of its own (the `useGameStore` singleton in its module copy of `state.ts` IS the sim).
- **`sim.worker.ts`** — the thin Web Worker shell: `self.onmessage → processSimRequest`, then
  posts `buildSimSnapshot()`. No logic, so the host can be Node-tested in-thread.
- **Verified — `Unit Tests/sim-worker-determinism.harness.mjs`:** drives the *exact*
  sim-checksum-baseline script (same seed/lineups/commands) through the host's request API and
  asserts the per-tick checksum digest equals that harness's committed in-thread GOLDEN — proof
  the protocol/host are a **lossless, deterministic** driver (message-driven === in-thread). Also
  asserts the posted snapshot is `structuredClone`-able, preserves every unit's id/position/hp,
  and carries neither the RNG nor the spatial grid. tsc + vite build clean; the sim-worker dir
  added to the boundary guard (it's sim-side, owns the store legitimately). 9 harnesses green.

### Remaining P1-2 (the flip — needs in-browser verification)
- Main-thread ingest: `useGameStore.setState(snapshot.state)` each frame (the mirror); the
  `syncLocal*Mirror` passes run right after, unchanged.
- `dispatchCommand` → `worker.postMessage({kind:'command', …})`; HexGrid's SP accumulator →
  `postMessage({kind:'runTicks', …})` instead of calling `tick()` directly.
- Thread the lifecycle (`initializeGame` single-player lineup, match start) to the worker, and
  decide the sequencing for the AI commander + lockstep engine + replay recorder (P1-3 — they
  run alongside the tick, so they move worker-side or are re-plumbed). This is where rendering /
  timing / determinism-over-the-boundary must be checked in a real browser.

## P1-3 — Move the sim-side companions INTO the worker (§3 Tier-3)

`ai/aiCommander.ts`, `ai/replayRecorder.ts`, and the lockstep engine glue
(`net/netMatch.ts`, `net/lockstep.ts`) run alongside the tick, so they move worker-side
(they already read sim state and emit commands — no mirror needed). `pilotInput`
sampling stays main-thread and rides the per-frame `pilotMove` command, as today.

## P1-4 — Snapshot perf pass

Replace whole-state cloning with structure-of-arrays transferable buffers for the hot
fields (positions/hp/state), keyed by a stable unit index. This is where the worker
actually pays off (main thread stops doing O(n) sim work each frame).

---

## Verification (unchanged methodology)

Every increment must keep the Phase-0 gates green:
`snapshot-boundary.guard` + `sim-checksum-baseline` + `dispatch-command-equivalence` +
`pilot-handle-equivalence` + `pilot-mirror-derivation` + `selection-mirror-derivation` +
`lockstep-two-peer-determinism` + `lockstep-pilot-determinism`, plus `tsc` + `vite
build`. P1-PRE(A) is the one intentional sim-behaviour change → re-bless the baseline
golden and add an SP movement-priority assertion. The worker steps (P1-2+) need a new
harness that drives the sim THROUGH the worker message bus and asserts the snapshot
trajectory matches the in-thread golden.

Order: P1-PRE → P1-1 → P1-2 → P1-3 → P1-4. P1-1 is the spine; P1-PRE unblocks it.

---

## THE FLIP — P1-2 + P1-3 DONE (2026-06-29), behind an opt-in flag (default OFF)

The sim worker is now wired into the live game, gated by a runtime flag so the in-thread loop
stays the working default. Enable in-browser to verify: `localStorage.setItem('rtsSimWorker','1')`
or `window.__rtsUseSimWorker = true`, then reload + start a match.

**Terrain oracle (the prerequisite the additive pipeline missed).** The tick queries
`terrainValidator` (~15×) + the A* pathfinder, both THREE-raycast-backed and main-thread-only.
New `sim/terrainOracle.ts`: `serializeTerrain()` ships the pathfinder's exported grid
(`GridPathfinder.exportGrid/importGrid`, added) + sampled water/bridge/deck grids + per-side deck
Ys (`TerrainValidator.getDeckSurfaceYs`, added); `installTerrainOracle()` rebuilds a THREE-free
oracle worker-side. state.ts reads terrain through a new `activeTerrain` seam (`setActiveTerrain`).
The host re-syncs side-bridge crossability from the sim's bridgeState each batch.

**P1-2 (single-player).** `sim/simWorkerBridge.ts` (main-thread: owns the Worker, posts
start/command/runTicks, ingests snapshots → `ingestSimSnapshot`, latches the SP start via
`onSimMatchStart`, adopts it once terrain ready from HexGrid's loop —
`beginSinglePlayerIfPending`). `dispatchCommand` forwards to the worker via a `setSimWorkerSink`
seam. The AI commander runs worker-side (runAiCommanders before each tick in the host). HexGrid's
SP branch posts `runTicks`; the pilot/selection mirrors re-derive on snapshot arrival.

**P1-3 (multiplayer + AI relocation).** The `LockstepEngine` moved INTO the worker (engine↔sim
stays synchronous); the WebRTC transport + Firebase signaling stay main-thread, proxied over the
boundary (`WorkerTransport` + netSend/netRecv/netStatus/netUpdate/netCallback). `LockstepEngine`
now takes a structural `LockstepTransport`. `netMatch.startNetMatch` returns a proxy
`ActiveNetEngine{update()}` under the flag, so HexGrid's `netEngine.update()` drives either path
unchanged; the per-frame pilot vector ships in netUpdate.

**Verified (flag OFF = byte-identical):** tsc + full `npm run build` (emits `sim.worker-*.js`) +
all `.mjs` harnesses + boundary guard green. New: `terrain-oracle-roundtrip.harness.mjs`,
`lockstep-worker-determinism.harness.mjs` (two worker hosts cross-wired through the proxy →
byte-identical peers over 360 frames); `sim-worker-determinism` extended with an ingest round-trip.
NOT verified: rendering/timing/real-browser MP desync (Playwright off) — the default-OFF flag is
the safety net; needs an in-browser pass before being trusted.

**Known gaps:** replay capture is unsupported under the flag (descoped, dev-only; `exportReplay`
made worker-safe); Firebase/leaderboard is bundled into the worker (builds fine, runtime
window-access at game-over is an unverified live risk); the worker isn't torn down on
return-to-menu (idle/harmless, re-inits next match). P1-4 (transferable structure-of-arrays
snapshot perf pass) is still future.
