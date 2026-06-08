# Conquest Mode — Handoff

Everything lives in `RTS/src/components/Working/conquest/` unless noted. The Quick
Play systems to mirror are in `RTS/src/game/state.ts`, `RTS/src/game/types.ts`, and
`RTS/src/components/Working/unitBehavior.ts`.

The fullest single source of truth for decisions and the done/todo split is the
auto-memory note `rts-conquest-mode`.

## Context / decisions already made

- **Goal:** make Conquest as full-featured as Quick Play, ported **incrementally**
  (the user's explicit choice — do NOT try to land it all at once).
- **Control paradigm chosen:** "Mirror Quick Play 1:1" — keep monarch-piloting AND
  layer Quick Play's selection / stance / fire / priority / ability systems on top.
  (The alternative "full top-down RTS / drop piloting" was rejected.)
- **King/Queen:** every army has **both** a King and a Queen. (Done.)
- **Open question never answered:** should the **Queen spawn/grow units over time**,
  and should growth be tied to owned farmable tiles? Confirm with the user before
  building Increment 5.

## Already done (shipped to `main`)

- Nebula skybox (equirectangular texture on an inverted sphere) + lighting rig —
  `ConquestScreen.tsx`.
- Combat + **army capture** mechanic — `ConquestField.tsx`, `conquestCombat.ts`,
  `conquestState.ts` (`conquerArmy`, `armyController`, `outcome`, `lastCapture`).
- Single-animal army selection — `ConquestLobby.tsx`.
- **Increment 1: King + Queen + auras** — King (HP×3 / dmg×3 / slower, gold damage
  aura), Queen (HP×2 / faster, green heal aura); capture requires downing **both**
  monarchs; per-army leader-following; aura discs + allegiance rings.

---

## Remaining work (recommended order)

### Increment 2 — Stance / fire mode / target priority
- Port `unitBehavior.ts` (`UnitStance`, `FireMode`, `TargetPriority`, `UnitBehavior`,
  `defaultBehaviorFor`) into the Conquest auto-combat.
- Integration points in `ConquestField.tsx`:
  - target selection (currently `selectNearestEnemy` in `conquestCombat.ts` — extend
    to honor `priority`),
  - the engage/chase step (honor `stance`: defensive/skirmish/guard return to an
    anchor; aggressive chases further),
  - the attack gate (honor `fire: 'hold'` = never auto-acquires).
- Add a `behavior` field to the spawn/live unit; seed via `defaultBehaviorFor(animal, kind)`.
- Needs a **UI to change** stance/fire/priority. Quick Play uses a radial menu +
  the `setBehavior` command. Decide per-army vs per-selected-unit (depends on the
  Increment 4 selection UI).

### Increment 3 — Per-animal abilities
- Six abilities in `state.ts`: Turtle shell (`isShelled`), Chicken egg
  (`throwEggs` / projectiles), Frog tongue (`fireTongues` / `updateFrogTongues`),
  Cat hiss (`hiss` + knockback), Bee swarm (`swarm` / `updateBeeSwarms`), Owl pickup
  (`pickup` / `updateOwlPickups`). The per-unit type fields already exist in `types.ts`.
- **Decide the trigger** in Conquest's piloting context. Quick Play uses simultaneous
  primary+secondary mouse press on the selected unit; map this to the piloted monarch
  (or to selection from Increment 4). Confirm with the user.
- Each ability must be **re-derived for sphere space** (positions are 3D-on-sphere,
  not flat XZ). The `state.ts` implementations assume the flat battlemap, so port the
  logic, do not copy it verbatim.

### Increment 4 — Unit selection UI
- Quick Play: click/drag select (`selectedUnitIds`), right-click move/attack orders.
  In Conquest this must work through the third-person chase cam on a sphere (raycast
  to the globe, project orders onto tiles). Largest UX design piece — confirm the
  desired feel with the user.
- Unblocks the "manual" half of Increments 2 & 3 (issuing stances/abilities to chosen
  units).

### Increment 5 — Queen unit growth / spawning
- Quick Play: `lastSpawnAtMsByQueenId`, queens spawn units on an interval (see
  `state.ts` ~line 1351). Also `queenRallyTargets` (rally point) and `queenPatrols`.
- The original Conquest TODO wanted growth tied to **owned farmable (grassland)
  tiles** — confirm. Meaningful only once tile-claiming (Increment 6) exists.

### Increment 6 — Tile claiming by occupation
- Currently `tileOwners` only changes on capture. Quick Play has no analogue. Design:
  units occupying/passing a claimable tile flip its owner; drives territory %, Queen
  growth, and win pressure.

---

## Lower-priority / polish

- **Roaming AI:** AI armies currently **hold at spawn** (only fight when you march in).
  Quick Play AI logic is in `state.ts` (`aiThinkingOffset`, AI movement). Port a simple
  "monarch seeks nearest enemy army" behavior.
- **G key (toggle King/Queen):** currently both `A` and `G` just cycle (`cycleMonarch`).
  Quick Play distinguishes cycle-monarch vs toggle-K/Q — wire `pilotToggleMonarch`
  separately.
- **HP / health feedback:** Quick Play has `healthBarsEnabled` floating bars; Conquest
  shows none. Consider HP bars or a downed-monarch visual (downed monarchs currently
  just show the idle pose).
- **King/Queen visual distinction:** only ring size + aura color today. Quick Play bakes
  team-colored crowns/tiaras (memory `rts-royal-crown-accessories`) — port to mark King
  vs Queen vs unit.
- **Capture attribution:** conqueror = `lastAttackerController` of the downed King/Queen;
  could be stale in edge cases (attacker itself captured mid-fight). Low risk; revisit if
  it misbehaves.
- **Balance:** combat/aura values are only **logic-tested**, never playtested (Playwright
  disabled per user). Needs real-play tuning of `AGGRO_RANGE`, `CHASE_SPEED`, `AURA_RADIUS`,
  heal/regen rates, squad size.

---

## Cross-cutting constraints (read before editing)

- **Verification:** Playwright / headless-browser is **disabled** (user pref). Verify with
  `npx tsc --noEmit -p tsconfig.json` + `npm run build` + an **esbuild→Node harness** for
  pure logic. Pattern: bundle a test script with
  `npx esbuild file.mjs --bundle --platform=node --format=cjs --define:import.meta.env.DEV=false --define:import.meta.env.BASE_URL='"/"'`
  then `node`. Use `--format=cjs`, NOT esm — firebase's dynamic `require` breaks esm
  bundles. Specs: `RTS/Unit Tests/conquest-{combat,state,field}.spec.ts`.
- **Deploy pipeline:** the site serves `RTS/dist` directly. After any `src` change you must
  `npm run build` **and commit `RTS/dist`**, then push to `main`. The remote auto-updates
  often, so `git fetch && git rebase origin/main` before pushing.
- **Determinism contract:** if you ever touch the `tick` path in `state.ts`, follow the
  seeded `simRng` / `simClockMs` / `nextEntityId` rules (see `RTS/CLAUDE.md`). Conquest
  combat currently uses the **real-time clock**, so **Conquest multiplayer is not built** —
  making it MP-safe is its own future task.
- **Keep `liveUnits` stable:** in `ConquestField.tsx`, the `liveUnits` useMemo must **not**
  depend on `armyController` / control state — capture mutates `controllerId` in place.
  Rebuilding teleports every unit back to spawn.
- **File-placement rules** (user's global guide): new components go in a `Working/` folder;
  tests go in `Unit Tests/`. Conquest already lives under `Working/conquest/`.

## Conquest file map

- `conquestState.ts` — Zustand store. `ConquestUnitKind` ('king'|'queen'|'unit'),
  `ConquestUnitSpawn`, `armyController` (capture overrides), `conquerArmy`, `outcome`,
  `lastCapture`, `cycleMonarch` (cycles controlled monarchs), `effectiveController`.
- `conquestCombat.ts` — pure helpers: `conquestStatsFor(animal, kind)`,
  `selectNearestEnemy`, `isWithinAttackRange`, `isAttackReady`, `regenAmount`,
  `kingBuffedDamage`, `queenHealAmount`, `isWithinAura`; constants `AGGRO_RANGE`,
  `CHASE_SPEED`, `AURA_RADIUS`, `KING_DAMAGE_MULTIPLIER`, `QUEEN_HEAL_FRACTION_PER_SECOND`.
- `ConquestField.tsx` — per-frame sim (drive, leader-follow, targets, auras, attacks,
  heal/regen, casualties+capture, transforms, camera) + allegiance rings + aura discs.
- `ConquestScreen.tsx` — Canvas, `NebulaSkybox`, lighting, roster, tile inspector,
  capture banner, victory/defeat overlay.
- `ConquestLobby.tsx` — single-animal pick + seed/AI config.
- `ConquestGlobe.tsx`, `conquestGlobeGeometry.ts`, `goldbergWorld.ts`, `conquestBiomes.ts`,
  `conquestAnimation.ts`, `conquestPose.ts` — world geometry, biomes, and animation.
