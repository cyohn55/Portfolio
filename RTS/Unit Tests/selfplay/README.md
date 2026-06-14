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
| `bundleStore.mjs` | Bundle `state.ts` (+ `SeededRng`) for Node and import it once. |
| `policies.mjs` | Commander policies: `makePassivePolicy` (shipping baseline — no commands), `makeRushPolicy` (naive: send everyone at the nearest objective), and `makeCommanderPolicy` (Layer B macro commander — mass → focused attack → rally → optional retreat, with tunable knobs). **Grow Layer B here.** |
| `selfPlay.mjs` | `runMatch` (one game), `scoreOutcome` (game → scalar), `buildLineups`, and `evaluate` (the averaged `score(params)`). |
| `runSelfPlay.mjs` | Runnable demo: passive vs. rush vs. (trained) commander. |
| `commanderGenome.mjs` | Declarative `GENE_SPEC` mapping the commander knobs to a `[0,1]^d` search space; `decodeGenome`/`encodeParams`/`defaultGenome`. |
| `optimizer.mjs` | Generic, dependency-free (μ+λ) evolution strategy over `[0,1]^d`. Seeded → reproducible; knows nothing about the game. |
| `train.mjs` | Evolves the commander knobs against an opponent pool over training seeds, validates on held-out seeds, prints the tuned params. |
| `reproducibility.harness.mjs` | Asserts `score(params)` is deterministic. Run after any `state.ts` tick-path change. |

## Run

```bash
# from the RTS project root
node "Unit Tests/selfplay/runSelfPlay.mjs"
SELFPLAY_SEEDS=8 SELFPLAY_MAX_TICKS=12000 node "Unit Tests/selfplay/runSelfPlay.mjs"
node "Unit Tests/selfplay/reproducibility.harness.mjs"

# Evolve the commander's knobs (env vars optional; a real run takes minutes):
node "Unit Tests/selfplay/train.mjs"
OPT_POP=12 OPT_GENS=8 OPT_TRAIN_SEEDS=4 OPT_MAX_TICKS=9000 node "Unit Tests/selfplay/train.mjs"
```

## Training (the optimizer loop)

`train.mjs` is the loop that closes the headroom. Fitness = a candidate's mean
score across an **opponent pool** (passive + rush) over a set of **training
seeds** — the pool guards against overfitting to one opponent, the seed average
against one map. A seeded (μ+λ) evolution strategy (`optimizer.mjs`) searches the
normalized knob space (`commanderGenome.mjs`), seeded from the current defaults,
then the evolved best is reported on **disjoint validation seeds**.

The shipped `COMMANDER_DEFAULTS` are the output of one such run. It evolved
"mass a large force (`minAttackForce: 16`), then commit fully and aggressively at
the nearest objective" — which beats both passive and rush out of sample (and on
the demo's third, independent seed set). To push further: add a self-mirror to
`OPPONENT_POOL` so it must beat a competent commander, raise `OPT_GENS`/`OPT_POP`,
and widen the seed sets.

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
  `state.ts`). Its knobs (`COMMANDER_DEFAULTS`: `minAttackForce`, `aggression`,
  `targetPriority`, `stageDepth`, `retreatForceRatio`, stances, …) span a wide
  outcome range — e.g. `targetPriority: 'value'` chases Queens deep and loses
  badly, while `'nearest'` wins — so an optimizer has real headroom. Its shipped
  defaults are **optimizer-trained** (see Training below) and beat both the passive
  baseline and the naive rush out of sample. Extend `decide` with abilities
  (`throwEggs`/`hiss`/`swarm`/…) and monarch piloting next. For an AI in real
  multiplayer, run the commander **host-only and broadcast its commands**, or it
  will desync.

## Determinism contract for this harness

`score(params)` is only sound if each match is fully independent. That requires
`state.ts` to reset all per-match state on `startMatch`. Building this harness
surfaced one map (`lastRegenAtMsByUnitId`) that `startMatch` failed to reset,
which let a prior match's regen timing leak into the next and made the same seed
score differently. It is fixed; `reproducibility.harness.mjs` guards it. If you
add new per-entity (id-keyed) maps to the tick path, reset them in `startMatch`
too, then re-run that harness.
