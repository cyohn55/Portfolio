# Self-play harness

Headless self-play for training/tuning the RTS AI opponent against the real
simulation. It drives the exact `src/game/state.ts` tick that ships in the
browser (bundled for Node via esbuild), so anything tuned here transfers to the
game.

## Why this works

The game is deterministic lockstep: the simulation is a pure function of a seed
plus an ordered command stream. That gives the optimizer a **low-variance
`score(params)`** — the same params and seeds always yield the same number, so a
small number of matches per evaluation is enough to compare two policies.

## Files

| File | Responsibility |
|---|---|
| `bundleStore.mjs` | Bundle `state.ts` (+ `SeededRng`) for Node. `buildSimulationBundle` builds it to a file (shared by worker threads); `loadSimulationApi` builds and imports it once. |
| `policies.mjs` | Commander policies: `makePassivePolicy` (shipping baseline — no commands), `makeRushPolicy` (naive: send everyone at the nearest objective), and `makeCommanderPolicy` (Layer B commander — mass → focused attack → rally → optional retreat, plus abilities + opt-in King piloting, with tunable knobs). **Grow Layer B here.** |
| `selfPlay.mjs` | `runMatch` (one game), the scorers `scoreOutcome` (margin) + `scoreOutcomeWinRate` (bounded) + `resolveScorer`, `buildLineups`, and `evaluate`. |
| `opponents.mjs` | `TRAINING_POOL` (passive + rush + self-mirror + scripted archetypes + champion league) and a disjoint held-out `GAUNTLET_POOL`, plus `makeOpponentByName` — one source of truth for the serial trainer and the parallel workers. |
| `champions.json` + `league.mjs` | The champion league: strong, distinct evolved param sets the trainer must all beat; `loadChampions`/`appendChampion` grow it over time. |
| `runSelfPlay.mjs` | Runnable demo: passive vs. rush vs. (trained) commander. |
| `commanderGenome.mjs` | Declarative `GENE_SPEC` mapping the commander knobs to a `[0,1]^d` search space; `decodeGenome`/`encodeParams`/`defaultGenome`. |
| `optimizer.mjs` | Generic, dependency-free (μ+λ) evolution strategy over `[0,1]^d`. Async: evaluates a whole generation in one batch (so it can be scored in parallel). Seeded → reproducible; knows nothing about the game. |
| `evalWorker.mjs` | Worker-thread entry: imports the pre-built sim once (its own isolated instance) and scores `(genome, opponent, seeds)` tasks. |
| `workerPool.mjs` | Fixed-size pool of warm `evalWorker` threads; streams a task batch across idle workers, results aligned to input order. |
| `train.mjs` | Evolves the commander knobs against the training pool (worst-case `winRate`, in parallel across workers), reports tuned vs default worst-case on the held-out gauntlet, and gates adoption on it. |
| `replay.mjs` | Ingest recorded human games: `makeReplayPolicy` (a recorded side as a drop-in opponent), `resimulateReplay` (lossless re-sim check). |
| `reproducibility.harness.mjs` | Asserts `score(params)` is deterministic. Run after any `state.ts` tick-path change. |

## Robust fitness (why the AI doesn't just farm one opponent)

Earlier runs with an unbounded margin scorer + equal-weighted pool average produced a
commander that won the *average* by blowing out the naive `rush` (score → 210) while
*regressing* against competent play — useless against humans. Two changes fix that:

- **Bounded `winRate` scorer** (`OPT_SCORING=winRate`, default): +1 win / −1 loss, a
  `tanh`-squashed surviving-force margin for timeouts, plus a tiny speed bonus on wins.
  No opponent can be farmed for an unbounded score.
- **Worst-case aggregation**: a candidate's fitness is the **minimum** mean score
  across the pool — "be good against your hardest matchup". Combined with a *diverse*
  pool + champion **league**, this selects for robustness, which is the proxy for
  "strong vs a competent, varied human". Adoption is gated on the **held-out gauntlet**
  worst-case (`train.mjs` prints `ADOPT? YES/NO`), so a pool-overfit can't sneak in.

## Human replays (record real games, re-simulate, harden)

The sim is deterministic lockstep, so a single-player game is fully captured by
`(seed, lineups, per-tick command stream)`. In the browser dev console:
`__rtsReplay.start()`, play a single-player match, and the game auto-exports a
`rts-replay-*.json` at the end (local-only; nothing is uploaded). Feed it to the
harness via `replay.mjs`: `resimulateReplay` replays BOTH sides and asserts the
recorded outcome reproduces exactly; `makeReplayPolicy` turns a recorded human into a
drop-in opponent for a "human gauntlet". **Caveat — open loop:** a replayed human
emits their *original* commands, which against a different AI are no longer live
reactions; so this measures resilience to human strategy/timing/aggression, not
closed-loop human reactions. Mine replays into archetype/champion opponents to harden
the league; true closed-loop measurement is online only.

## Run

```bash
# from the RTS project root
node "Unit Tests/selfplay/runSelfPlay.mjs"
SELFPLAY_SEEDS=8 SELFPLAY_MAX_TICKS=12000 node "Unit Tests/selfplay/runSelfPlay.mjs"
node "Unit Tests/selfplay/reproducibility.harness.mjs"

# Evolve the commander's knobs (env vars optional; runs across all cores by default):
node "Unit Tests/selfplay/train.mjs"
OPT_WORKERS=8 OPT_POP=12 OPT_GENS=8 OPT_TRAIN_SEEDS=4 OPT_MAX_TICKS=9000 node "Unit Tests/selfplay/train.mjs"
OPT_WORKERS=1 node "Unit Tests/selfplay/train.mjs"   # serial in-process path
```

### Parallelism

Matches are independent, so each generation's `(genome × opponent)` evaluations are
fanned across `OPT_WORKERS` worker threads (default: one per core). The sim bundle
is built once and each worker imports it to get its **own** isolated instance, so
parallel matches never share the `useGameStore` singleton. The run is still
**bit-for-bit reproducible**: the optimizer draws all of a generation's genomes from
the seeded rng before any scoring, and a match's score is independent of which
worker runs it (verified — parallel and `OPT_WORKERS=1` produce identical output for
the same `OPT_SEED`). The bundle build + the serial validation tail are fixed costs,
so the speed-up grows with run length.

## Training (the optimizer loop)

`train.mjs` is the loop that closes the headroom. Fitness = a candidate's mean
score across an **opponent pool** (passive + rush) over a set of **training
seeds** — the pool guards against overfitting to one opponent, the seed average
against one map. A seeded (μ+λ) evolution strategy (`optimizer.mjs`) searches the
normalized knob space (`commanderGenome.mjs`), seeded from the current defaults,
then the evolved best is reported on **disjoint validation seeds**.

The shipped `COMMANDER_DEFAULTS` are the output of one such run over the full
16-knob space (8 generations, pop 14). It evolved "mass a large force
(`minAttackForce: 16`), stage near home, commit almost fully at the nearest
objective, and spend abilities the moment contact joins" — beating the prior
hand-set default out of sample (validation fitness **50.5 vs 39.0**; the rush
matchup flipped from −4.4 to +20.2). The optimizer kept abilities ON (a fast
15-tick cast cadence) but left the sacrificial Bee dive and King piloting OFF:
neither earned its risk.

`OPPONENT_POOL` now also includes a **self-mirror** (the current trained
commander) so a candidate must beat a competent macro opponent, not just
passive/rush. A finding from that: training against the 3-opponent pool produced
a candidate that beat the mirror head-to-head (mirror score 9 → 34) but
sacrificed its dominance over rush (74 → 31), a **net aggregate regression**
(validation 48.0 vs the shipped default's 58.1) — so the shipped defaults were
**kept**. Equal-weighting a near-symmetric mirror (whose best achievable score is
~0) against weak opponents rewards that trade; `train.mjs` prints the
`improvement` delta precisely so such a regression is caught before adoption. The
mirror also did **not** flip piloting/swarm on. To push further: weight the pool
(or score on win-rate) so the mirror doesn't dominate the objective, raise
`OPT_GENS`/`OPT_POP`, and widen the seed sets.

## How an optimizer plugs in

`evaluate` is the fitness function. An optimizer (CMA-ES / GA / bandit) proposes
a parameter vector, you map it onto a policy via a factory, and you read back the
mean score:

```js
import { loadSimulationApi } from './bundleStore.mjs';
import { evaluate } from './selfPlay.mjs';
import { makePassivePolicy, makeRushPolicy } from './policies.mjs';

const api = await loadSimulationApi();
const seeds = [/* fixed evaluation seeds */];

function score(params) {
  return evaluate({
    api,
    makeSubject: () => makeRushPolicy(params),   // the candidate under test (plays p0)
    makeOpponent: () => makePassivePolicy(),      // fixed reference opponent (plays p1)
    seeds,
    maxTicks: 9000,
  }).meanScore;
}
// optimizer.maximize(score)
```

Keep the tuned result as plain parameter data — it ships as data with zero
runtime ML dependency and adds no determinism risk.

## Two layers of "training"

- **Layer A — tune what exists.** Animal lineup, default stance, engage/chase
  radii, spawn cadence. Low ceiling: the shipping AI issues no commands, so even
  a perfectly tuned passive army never marches or counters the player.
- **Layer B — an AI commander.** `makeCommanderPolicy` is the first one: it masses
  its army at a staging point, commits a focused attack on a chosen objective,
  rallies Queen spawns to the front, and (optionally) retreats to re-mass — all via
  the same command bus a human uses (`applyNetCommand` → the `case` dispatch in
  `state.ts`). It runs a **macro layer** (re-plan on `decisionIntervalTicks`) and a
  faster **tactical layer** (`abilityIntervalTicks`):
  - *Abilities* (`decideAbilities`): EVERY animal special move is an always-on
    capability (full parity with the player) — not a trained on/off knob — cast by a
    tactical rule and issued over the whole army (the engine self-filters to the
    eligible casters off cooldown). OFFENSIVE, aimed at the focus target in
    `abilityEngageRange`: `throwEggs` (Chickens), `fireTongues` (Frogs), `pickup`
    (Owls abduct + drop the weakest grabbable enemy), and `swarm` (Bees) while
    attacking. DEFENSIVE, only when locally outnumbered (`hissOutnumberRatio`):
    `hiss` (Cats peel attackers) and `toggleTurtleShell` (a hurt, outnumbered Turtle
    braces to absorb most incoming damage — `SHELL_DAMAGE_TAKEN_FRACTION` in state.ts
    — tanking for the army). Only the cadence/thresholds are tunable.
  - *Monarch piloting* (`makeMonarchPilot`): when `pilotKing` is on, it drives one
    King just behind the advancing army (`pilotTrailDepth`) so its damage aura buffs
    the front, then retreats and releases it once its HP drops below
    `pilotRetreatHpFraction`.

  Its knobs (`COMMANDER_DEFAULTS`: `minAttackForce`, `aggression`, `targetPriority`,
  `stageDepth`, `retreatForceRatio`, stances, the ability/pilot knobs, …) span a
  wide outcome range — e.g. `targetPriority: 'value'` chases Queens deep and loses
  badly, while `'nearest'` wins — so an optimizer has real headroom. Its shipped
  defaults are **optimizer-trained** over all 16 knobs (see Training above). For an
  AI in real multiplayer, run the commander **host-only and broadcast its
  commands**, or it will desync.

## Determinism contract for this harness

`score(params)` is only sound if each match is fully independent. That requires
`state.ts` to reset all per-match state on `startMatch`. Building this harness
surfaced one map (`lastRegenAtMsByUnitId`) that `startMatch` failed to reset,
which let a prior match's regen timing leak into the next and made the same seed
score differently. It is fixed; `reproducibility.harness.mjs` guards it. If you
add new per-entity (id-keyed) maps to the tick path, reset them in `startMatch`
too, then re-run that harness.
