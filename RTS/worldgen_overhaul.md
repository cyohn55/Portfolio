# Conquest Worldgen Overhaul — Handoff

**Goal:** make Conquest's procedurally-generated planets noticeably more *varied*
(each seed feels like a different world) and higher *quality* (coherent continents,
mountain ranges, rivers, believable climate) — without breaking determinism, the
renderer contract, or the 12 pentagon spawn nodes.

This doc is self-contained. Read "Current architecture" and "Hard constraints"
first, then execute the phases in order. Each phase is independently shippable.

---

## 0. Orientation: run / verify / deploy

All paths below are relative to `RTS/` unless noted. Worldgen lives in
`src/components/Working/conquest/`.

- **Dev server:** `npm run dev` (client on Vite port, server on 3001). Note: a dev
  server may already be running on :3001; that's fine.
- **Typecheck (primary gate):** `npx tsc --noEmit -p tsconfig.json`
- **Production build (second gate):** `npm run build` (runs `vite build` + server tsc).
- **Browser/Playwright tests are effectively disabled** in this environment — the
  Playwright config spins up a webServer on :3001 and fails with `EADDRINUSE` when a
  dev server is up, and many specs can't import `game/state.ts` under Node (a
  `SpatialGrid` `exports is not defined` issue). **Verify worldgen logic with an
  esbuild→Node harness instead** (see "Testing" below). The worldgen modules
  (`seededNoise`, `conquestBiomes`, `goldbergWorld`) are pure and import only
  `three` + the seeded RNG, so they bundle and run cleanly in Node.
- **Deploy:** `RTS/dist` is committed and served directly. To ship: `npm run build`
  → commit `RTS/dist` (+ src) → push `main`. Always `git fetch && git rebase
  origin/main` first — the remote auto-updates often (email-to-portfolio bot).
- **File-placement convention (from repo CLAUDE.md):** new components go in
  `Working/`, tests go in `Unit Tests/`. Don't add files elsewhere without being told.

---

## 1. Current architecture

### Data flow
```
ConquestLobby (seed + roster) ──► useConquestStore.generate(setup)
  setup = { seed, subdivisions, humanAnimal, aiCount, worldGen? }
    │
    ├─ buildGoldbergWorld(subdivisions)         → GoldbergWorld { tiles[], pentagonIds[] }
    │     (goldbergWorld.ts — pure geometry: icosahedron→geodesic→dual)
    │
    └─ classifyWorld(tiles, seed, worldGen)      → TileBiome[]   (one per tile, by tile.id)
          (conquestBiomes.ts — samples SeededNoise; classifies each tile)
                │
                ▼
   store { world, biomes, ... }
                │
   ┌────────────┴───────────────┐
   ▼                            ▼
conquestGlobeGeometry.ts      ConquestField.tsx
  (renders mesh: reads          (sim: reads BIOMES[].passableBy / farmable /
   BIOMES[].color +              claimable for movement, claiming, growth)
   tileTopRadius)
```

### Files (worldgen-relevant)
| File | Responsibility | Key exports |
|---|---|---|
| `goldbergWorld.ts` | Tile graph. Icosahedron → geodesic subdivide → dual. **Has the neighbor adjacency graph** (use it for rivers/smoothing). | `buildGoldbergWorld(subdivisions)`, `GoldbergTile {id, sides, center, corners, neighbors, area}`, `GoldbergWorld {tiles, pentagonIds, subdivisions}` |
| `seededNoise.ts` | Seeded Perlin + fBm. Deterministic via `SeededRng` (Fisher–Yates permutation). | `SeededNoise(seed)`, `.noise(x,y,z)`, `.fbm(x,y,z,octaves=4)` |
| `conquestBiomes.ts` | Biome taxonomy + per-tile classification. **One source of truth for renderer (color/elevationOffset) AND sim (passableBy/farmable/claimable).** | `BiomeId`, `BIOMES` table, `WorldGenParams`, `DEFAULT_WORLDGEN`, `TileBiome`, `classifyTile(center, noise, params)`, `classifyWorld(tiles, seed, params)` |
| `conquestState.ts` | Store. `generate(setup)` is the entry point; deterministic from `seed`. | `ConquestSetup`, `DEFAULT_CONQUEST_SUBDIVISIONS = 3`, `generate` |
| `ConquestLobby.tsx` | Match config UI. Currently exposes **seed + roster only**. | — |
| `conquestGlobeGeometry.ts` | Builds the render mesh from world + biomes. | `buildGlobeGeometry`, `tileTopRadius`, `resolveTileColor`, `DEFAULT_GLOBE_OPTIONS` |

### What's currently constant / hardcoded (the variety ceiling)
- **`DEFAULT_WORLDGEN = { oceanLevel: 0.48, moistureScale: 1.0 }`** and `generate`
  passes `setup.worldGen ?? DEFAULT_WORLDGEN`. The lobby never sets `worldGen`, so
  **every planet uses the exact same sea level and climate balance.** The seed only
  reshuffles the noise field — it never changes the world's *character*. This is the
  single biggest variety limiter.
- **`subdivisions` is fixed** at `DEFAULT_CONQUEST_SUBDIVISIONS = 3` (362 tiles).
  `buildGoldbergWorld` already clamps `1..6`; the size is just never exposed.
- **fBm is hardcoded** in `seededNoise.ts`: `amplitude = 0.5` start, `*= 0.5` per
  octave (gain 0.5), `frequency *= 2` (lacunarity 2). No ridged variant, no warping.
- **`classifyTile` fields:** `elevation = fbm(...,5)`, `moisture = fbm(...+50,4) *
  moistureScale`, `temperature = 1 - |center.y|^1.6` (latitude only). `NOISE_FREQUENCY
  = 1.5`. `pickBiome` is an if/else cascade: ocean `< oceanLevel-0.1`, lake `<
  oceanLevel`, snow `temp < 0.22`, mountain `> oceanLevel + 0.65*(1-oceanLevel)`,
  desert `moisture < 0.38`, forest `moisture > 0.58`, else grassland.
- **Mountains are isolated peaks** (just `elevation > threshold`), not ranges.
- **Rivers/lakes** are only "shallow water by elevation"; no flow.
- **`tileTopRadius` IGNORES biome elevation** (the `_tileBiome` arg is unused — see
  its comment: "retained for when per-biome elevation is reintroduced"). So the relief
  hook already exists; the planet currently renders as a flat-tiled sphere.

---

## 2. Hard constraints — MUST follow

1. **Determinism.** All randomness/noise MUST come from the seed via `SeededRng`
   (`src/components/Working/net/prng`) and `SeededNoise` — **never `Math.random()`**.
   A given `(seed, params)` must reproduce the exact same planet on every machine and
   in tests. (Conquest MP isn't built yet, but seed reproducibility + tests depend on
   this. See the repo's determinism contract memory for the broader rule.)
2. **Keep the worldgen modules pure.** `seededNoise.ts`, `conquestBiomes.ts`,
   `goldbergWorld.ts` import only `three` and the seeded RNG — no React, no store, no
   WebGL. This is what lets them run in a Node harness. Keep new worldgen logic in pure
   modules (new files in `Working/conquest/`), composed inside `classifyWorld`.
3. **`BIOMES` stays the one source of truth.** Renderer reads `color` +
   `elevationOffset`; sim reads `passableBy` + `farmable` + `claimable`. If you add a
   biome, fill ALL fields. Don't fork biome data into the renderer or sim.
4. **The 12 pentagon spawns must stay playable.** `classifyWorld` currently forces
   every `tile.sides === 5` tile to habitable grassland (claimable + farmable + ground-
   passable). Preserve that guarantee (or an equivalent: spawn tiles must be land,
   claimable, growth-capable, and reachable). Don't let a new ocean/mountain pass
   bury a spawn.
5. **Don't break the `TileBiome` shape consumed downstream.** `classifyWorld` returns
   `TileBiome[]` indexed by `tile.id`. `ConquestField` and `conquestGlobeGeometry`
   index it by `tile.id`. Adding fields to `TileBiome` is fine; removing/renaming
   `biome`/`elevation`/`moisture`/`temperature` is not (without updating consumers).
6. **`generate` signature is backward-compatible.** `setup.worldGen` is optional and
   defaults to `DEFAULT_WORLDGEN`. Keep it optional so nothing else breaks.
7. **Verify every phase:** `tsc` clean + `vite build` clean + a Node harness asserting
   real properties (not constants copied from the impl). Spec files in `Unit Tests/`.
8. **Performance:** worldgen runs once per match at `generate()` (not per frame), so
   it can be O(tiles · octaves) freely. But the neighbor-graph passes (rivers,
   smoothing) should stay roughly O(tiles · avg-degree) — the graph is small (362
   tiles at level 3, up to ~5762 at level 5).

---

## 3. The plan (phased, ordered by impact-per-effort)

Each phase: **what**, **where**, **acceptance criteria**, **tests**. Ship phases
independently. Phases 1 + 2 deliver the most visible win and are the recommended
starting point.

### Phase 1 — Seed-derived world parameters (biggest variety win)
**Problem:** `DEFAULT_WORLDGEN` is effectively constant, so every seed has the same
sea level + climate. **Fix:** derive the params from the seed so each seed is a
different *kind* of world.

- **Where:** `conquestBiomes.ts` (expand `WorldGenParams` + add a derive function);
  `conquestState.ts` (`generate` derives params when `setup.worldGen` is absent).
- **Do:**
  - Expand `WorldGenParams` with at least: `oceanLevel`, `moistureScale`,
    `mountainThreshold` (or a `mountainBias` 0..1), `temperatureFalloff` (the latitude
    exponent, currently fixed 1.6), and `noiseFrequency` (currently fixed 1.5).
  - Add `deriveWorldGenParams(seed: number): WorldGenParams` that samples each field
    from a `SeededRng(seed)` (use a distinct seed offset from the noise permutation so
    the rolls don't correlate with the terrain shape — e.g. `new SeededRng(seed ^
    0x9E3779B9)`). Suggested ranges (tune): `oceanLevel ∈ [0.40, 0.60]`, `moistureScale
    ∈ [0.7, 1.3]`, `mountainBias ∈ [0.45, 0.8]`, `temperatureFalloff ∈ [1.2, 2.2]`,
    `noiseFrequency ∈ [1.2, 2.2]`.
  - `pickBiome` reads the new params instead of the inline constants.
  - In `generate`, use `setup.worldGen ?? deriveWorldGenParams(setup.seed)`.
- **Acceptance:** two different seeds produce visibly different ocean coverage /
  biome mix; the same seed reproduces identical output. Spawns still habitable.
- **Tests:** `deriveWorldGenParams(s)` is deterministic (same seed → deep-equal
  params); params stay within declared ranges across many seeds; `classifyWorld` with
  two seeds yields different biome histograms but each seed is stable across two runs.

### Phase 2 — Domain warping + tunable fBm (organic coastlines)
**Problem:** raw Perlin gives "blobby" borders. **Fix:** warp the sample coordinates
by a second noise field — the single biggest "hand-authored vs. procedural" upgrade.

- **Where:** `seededNoise.ts` + `conquestBiomes.ts`.
- **Do:**
  - Parameterize `fbm` with `gain` and `lacunarity` (default to current 0.5 / 2 so
    existing behavior is unchanged), and add a `ridged` fBm variant (`1 - |noise|`
    accumulation) — Phase 4 uses it.
  - Add domain warping in `classifyTile`: before sampling elevation, offset the
    sample point by a low-amplitude vector built from a few extra noise lookups
    (`warp = warpStrength * (fbm(p + a), fbm(p + b), fbm(p + c))`), then sample
    elevation at `p + warp`. Keep `warpStrength` in `WorldGenParams` (seed-derived,
    small, e.g. `0.0..0.6` in unit-sphere space).
- **Acceptance:** coastlines and biome borders meander instead of forming smooth
  blobs; still deterministic.
- **Tests:** warping with `warpStrength = 0` is identical to no warp; output is
  seed-stable; fBm with default gain/lacunarity equals the pre-change fBm
  (regression-lock with a few sampled coordinates).

### Phase 3 — Continent mask (recognizable landmasses)
**Problem:** uniform noise scatters land/water. **Fix:** multiply elevation by a
very-low-frequency mask so land clumps into continents and real oceans.

- **Where:** `conquestBiomes.ts` (`classifyTile`).
- **Do:** sample a separate low-frequency fBm (2–3 octaves, low `noiseFrequency`)
  as a `continentMask ∈ [0,1]`; combine with the detail elevation (e.g. `elevation =
  detail * lerp(0.5, 1.0, continentMask)` or a shaped blend). Expose a
  `continentScale` param (seed-derived) so some worlds are pangaea, others archipelago.
- **Acceptance:** land forms a few large masses + oceans rather than salt-and-pepper.
- **Tests:** with a flat mask the result reduces to Phase 2; seed-stable; land
  fraction tracks `oceanLevel` monotonically.

### Phase 4 — Ridged mountains as ranges (chokepoints)
**Problem:** mountains are isolated `elevation > threshold` peaks. **Fix:** use the
ridged fBm from Phase 2 to form continuous spines — meaningful since mountains are
air-only impassable terrain (natural chokepoints).

- **Where:** `conquestBiomes.ts`.
- **Do:** sample a ridged field; where elevation is high AND the ridge is strong,
  classify `mountain`. Tune so ranges form arcs, not blobs. Mountains must remain
  `passableBy: AIR_ONLY` and `claimable: false` (already so in `BIOMES`).
- **Acceptance:** mountains visibly form connected ranges; no spawn pentagon becomes
  a mountain (Phase 0 guarantee holds).
- **Tests:** mountain tiles have higher average neighbor-mountain count than the old
  isolated-peak baseline (use the neighbor graph to measure clustering); seed-stable.

### Phase 5 — Rivers & lakes via downhill flow (uses the neighbor graph)
**Problem:** "lake" is just shallow-by-elevation. **Fix:** trace flow downhill across
`tile.neighbors` and carve river/lake tiles along the path.

- **Where:** new pure module `conquest/conquestHydrology.ts`; called from
  `classifyWorld` after elevation is known.
- **Do:** for each high-elevation source, walk to the lowest neighbor repeatedly
  (accumulate "flow"); tiles whose accumulated flow exceeds a threshold become
  river/lake. Handle local minima as lakes. Keep it deterministic (no RNG needed; if
  used, seed it). The Goldberg neighbor graph is exactly the right structure.
- **Acceptance:** branching river networks descend from highlands to the sea; rivers
  are water-passable corridors. Spawns stay habitable.
- **Tests:** rivers only flow downhill (each river tile's downstream neighbor has ≤
  elevation); river tiles are contiguous via neighbors; seed-stable.

### Phase 6 — Climate realism + Whittaker biome table
**Problem:** temperature is latitude-only; biome selection is an ad-hoc if/else.
**Fix:** add altitude cooling + continentality, and replace the cascade with a 2D
temperature×moisture lookup.

- **Where:** `conquestBiomes.ts`.
- **Do:**
  - `temperature` also drops with `elevation` (snow caps on mountains) and optionally
    with distance-from-water (interiors hotter/drier → natural deserts).
  - Replace `pickBiome`'s cascade with a Whittaker-style 2D lookup
    (`biomeFromClimate(temperature, moisture)`) → unlocks rainforest / savanna /
    taiga / tundra / shrubland with cleaner, tunable code. Add the new `BiomeId`s to
    `BIOMES` with full `color/passableBy/farmable/claimable/elevationOffset`.
- **Acceptance:** more biome variety; mountains get snow caps; interiors trend arid.
- **Tests:** `biomeFromClimate` is a total function over the [0,1]² climate square;
  every returned `BiomeId` exists in `BIOMES`; spawn tiles still resolve to a
  habitable land biome.

### Phase 7 — Coherence + polish (low risk, high readability)
- **Neighbor smoothing pass:** majority-vote each tile against its neighbors to
  remove lone-tile speckle (a single desert in a forest). Pure, uses the graph.
- **Transition biomes:** beach/coast on land tiles adjacent to water; tundra between
  snow and grass.
- **Continuous elevation rendering:** wire biome elevation back into `tileTopRadius`
  in `conquestGlobeGeometry.ts` (the `_tileBiome` arg + comment show the intended
  hook) so the planet gets real relief. **This is the one phase that also touches the
  renderer** — verify the mesh still seats units correctly (`ConquestField` seats
  units via `tileTopRadius`/`seatRadiusOnTile`, so relief changes unit heights; test
  in-app or keep the relief subtle).

### Phase 8 — Expose controls in the lobby (let players pick variety)
- **Where:** `ConquestLobby.tsx` + `ConquestSetup`.
- **Do:** add (a) **map size** → `subdivisions` (Small=2 / Medium=3 / Large=4;
  `buildGoldbergWorld` already clamps 1..6), and (b) optional **world archetype
  presets** (Continents / Islands / Pangaea / Frozen / Arid) that override
  `deriveWorldGenParams` with biased ranges. Pass through `generate(setup)`.
- **Acceptance:** lobby choices visibly change the generated planet; default
  (no preset) still uses the seed-derived params from Phase 1.
- **Tests:** each preset maps to params within its declared band; size maps to the
  expected tile count `10·4^s + 2`.

---

## 4. Testing pattern (worldgen is Node-friendly)

The worldgen modules bundle and run in Node. Use an esbuild→Node harness and/or a
`Unit Tests/*.spec.ts` (existing specs use `@playwright/test`'s `test`/`expect` as a
plain assertion lib for pure-Node logic — see `Unit Tests/conquest-world.spec.ts`,
`conquest-field.spec.ts`, `conquest-gamepad.spec.ts`).

Harness recipe (matches how prior conquest increments were verified):
```bash
# bundle a worldgen module for Node, then assert in a small script
npx esbuild src/components/Working/conquest/conquestBiomes.ts \
  --bundle --format=cjs --platform=node \
  --define:import.meta.env.DEV=false --outfile=/tmp/cq-worldgen.cjs
node /tmp/cq-check.cjs   # require('/tmp/cq-worldgen.cjs'); assert determinism, ranges, etc.
```
Use `--format=cjs` (NOT esm — a transitive Firebase dynamic `require` breaks esm
bundles in this repo). Assert **real properties** (determinism, biome histograms,
downhill-only rivers, mountain clustering, spawn habitability), never constants copied
from the implementation (repo CLAUDE.md rule).

**Determinism check (always include):** generate the world twice with the same seed
and assert the `TileBiome[]` arrays are deep-equal; generate with two seeds and assert
they differ.

---

## 5. Pitfalls / gotchas

- **Don't correlate the param RNG with the noise permutation.** If `deriveWorldGenParams`
  and `SeededNoise` both consume `SeededRng(seed)` from offset 0, the param rolls and
  terrain shape will move together. XOR the seed for the param RNG.
- **Pentagon spawn guarantee.** Any new ocean/mountain/river pass must run BEFORE or
  be overridden by the `tile.sides === 5 → habitable` forcing in `classifyWorld`.
  Re-assert it after every phase.
- **`tileTopRadius` is intentionally flat right now.** Don't assume the renderer shows
  elevation until Phase 7 wires it. Sim seating uses the same helper, so relief changes
  unit heights — keep it subtle or verify in-app.
- **`TileBiome.elevation/moisture/temperature` are consumed** (cached on the tile for
  inspection/rules). Keep populating them.
- **Build output.** `npm run build` rewrites `RTS/dist` (content-hashed bundle). Commit
  `dist` to ship; `git fetch && git rebase origin/main` first (remote auto-updates).
- **No `Math.random` anywhere in worldgen.** Easy to slip in for a "quick jitter" —
  it breaks reproducibility and the determinism tests.

---

## 6. Definition of done (per phase)
- [ ] Logic in a **pure** module under `Working/conquest/`, composed into
      `classifyWorld` / `generate`.
- [ ] All randomness via `SeededRng` / `SeededNoise`; no `Math.random`.
- [ ] 12 pentagon spawns still habitable + claimable + growth-capable.
- [ ] `npx tsc --noEmit -p tsconfig.json` clean.
- [ ] `npm run build` clean.
- [ ] Node harness + `Unit Tests/*.spec.ts` asserting determinism + the phase's real
      properties.
- [ ] (When shipping) `dist` rebuilt, committed, pushed to `main` after rebase.

---

## 7. Recommended order
**Phase 1 → 2** first (seed-derived params + domain warping) — the best
variety-and-quality per line of code, and they unblock everything else. Then 3
(continents) → 4 (ranges) → 5 (rivers) → 6 (climate/Whittaker) → 7 (polish) → 8
(lobby controls). Ship after each.
