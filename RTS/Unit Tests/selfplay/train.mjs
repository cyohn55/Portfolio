// Trainer: evolve the macro commander's knobs to beat an opponent pool.
//
// Wires the generic optimizer to the self-play fitness. A candidate's fitness is
// its mean score across an OPPONENT POOL (passive + rush + self-mirror) over a set
// of TRAINING seeds — the pool guards against overfitting to one opponent, the
// seed average against overfitting to one map. The evolved best is then reported
// on a disjoint VALIDATION seed set, so the headline number is out-of-sample.
//
// Matches are independent, so each generation's candidates are scored in PARALLEL
// across worker threads (each worker holds its own isolated sim instance). The run
// stays bit-for-bit reproducible: the optimizer draws all of a generation's
// genomes from the seeded rng before any evaluation, and a match's score never
// depends on which worker ran it. Set OPT_WORKERS=1 for the simple in-process path.
//
// Run from the RTS project root (env vars optional):
//   node "Unit Tests/selfplay/train.mjs"
//   OPT_WORKERS=8 OPT_GENS=8 OPT_POP=12 OPT_TRAIN_SEEDS=4 OPT_MAX_TICKS=9000 node "Unit Tests/selfplay/train.mjs"

import { availableParallelism } from 'node:os';
import { buildSimulationBundle } from './bundleStore.mjs';
import { evaluate, resolveScorer } from './selfPlay.mjs';
import { makeCommanderPolicy } from './policies.mjs';
import { TRAINING_POOL, GAUNTLET_POOL } from './opponents.mjs';
import { optimize } from './optimizer.mjs';
import { createWorkerPool } from './workerPool.mjs';
import { decodeGenome, defaultGenome, GENOME_DIMENSION } from './commanderGenome.mjs';

// Scoring: 'winRate' (bounded ±1; default) makes the worst-case aggregation below
// select for ROBUSTNESS — a candidate can't win by farming one weak opponent for an
// unbounded margin. 'margin' is the legacy unbounded scorer. A candidate's fitness
// is the WORST (minimum) of its mean per-seed scores across the pool, i.e. "be good
// against your hardest matchup".
const SCORING_MODE = process.env.OPT_SCORING ?? 'winRate';
const SCORER = resolveScorer(SCORING_MODE);
const worstCase = (values) => values.reduce((min, value) => Math.min(min, value), Infinity);

const POPULATION = Number(process.env.OPT_POP ?? 8);
const GENERATIONS = Number(process.env.OPT_GENS ?? 5);
const TRAIN_SEED_COUNT = Number(process.env.OPT_TRAIN_SEEDS ?? 3);
const VAL_SEED_COUNT = Number(process.env.OPT_VAL_SEEDS ?? 4);
const MAX_TICKS = Number(process.env.OPT_MAX_TICKS ?? 5000);
const OPT_SEED = Number(process.env.OPT_SEED ?? 1);
// Default to one worker per core, but never more than the per-generation task
// count (genomes × opponents) — extra workers would just sit idle. OPT_WORKERS=1
// forces the serial in-process path.
const REQUESTED_WORKERS = Number(process.env.OPT_WORKERS ?? availableParallelism());
const MAX_USEFUL_WORKERS = POPULATION * TRAINING_POOL.length;
const WORKER_COUNT = Math.max(1, Math.min(REQUESTED_WORKERS, MAX_USEFUL_WORKERS));

// Disjoint training and validation match seeds, spread across the 32-bit space so
// lineups vary. Different multipliers keep the two sets non-overlapping.
const buildSeeds = (count, salt) =>
  Array.from({ length: count }, (_unused, index) => ((index + 1) * 0x1000193 + salt) >>> 0);
const TRAIN_SEEDS = buildSeeds(TRAIN_SEED_COUNT, 0);
const VALIDATION_SEEDS = buildSeeds(VAL_SEED_COUNT, 0x55555555);

/**
 * Worst-case score of `makeSubject` (as p0) across `pool` over `seeds`, evaluated
 * in-process on one sim instance. Used for the (serial) validation/gauntlet reports
 * and the OPT_WORKERS=1 path. Fitness = the MINIMUM per-opponent mean score (the
 * hardest matchup); the per-opponent breakdown is returned for reporting.
 */
function poolFitness(api, makeSubject, seeds, pool) {
  const perOpponent = pool.map((opponent) => ({
    name: opponent.name,
    meanScore: evaluate({
      api,
      makeSubject,
      makeOpponent: opponent.make,
      seeds,
      maxTicks: MAX_TICKS,
      scorer: SCORER,
    }).meanScore,
  }));
  const fitness = worstCase(perOpponent.map((entry) => entry.meanScore));
  return { fitness, perOpponent };
}

function formatBreakdown(perOpponent) {
  return perOpponent.map((entry) => `${entry.name}=${entry.meanScore.toFixed(3)}`).join('  ');
}

/**
 * A batch fitness function backed by the worker pool: fan every (genome, opponent)
 * matchup out as an independent task, then fold each genome's per-opponent scores
 * back into its mean fitness. Tasks are scored over the TRAINING seeds. Results
 * come back aligned to task order, so the fold is a fixed-order sum — identical to
 * `poolFitness`'s serial reduce, which keeps the parallel run reproducible.
 */
function makeParallelEvaluator(pool) {
  return async (genomes) => {
    const tasks = [];
    for (const genome of genomes) {
      for (const opponent of TRAINING_POOL) {
        tasks.push({
          genome,
          opponentName: opponent.name,
          seeds: TRAIN_SEEDS,
          maxTicks: MAX_TICKS,
          scoringMode: SCORING_MODE,
        });
      }
    }
    const results = await pool.runTasks(tasks);

    // Worst-case fold: each genome's fitness is its hardest matchup (min over
    // opponents). Fixed task order → deterministic, matching poolFitness's min.
    const opponentCount = TRAINING_POOL.length;
    return genomes.map((_genome, genomeIndex) => {
      const scores = [];
      for (let opponentIndex = 0; opponentIndex < opponentCount; opponentIndex++) {
        scores.push(results[genomeIndex * opponentCount + opponentIndex].meanScore);
      }
      return worstCase(scores);
    });
  };
}

async function main() {
  // Build the sim bundle once; the main thread imports it for the serial paths
  // (validation, OPT_WORKERS=1) and every worker imports the same file to get its
  // own isolated instance.
  const bundlePath = await buildSimulationBundle();
  const api = await import(bundlePath);

  // Optimizer randomness comes from the seeded game RNG, so a run is reproducible.
  const optRng = new api.SeededRng(OPT_SEED);
  const rng = () => optRng.next();

  const parallel = WORKER_COUNT > 1;
  console.log(
    `Training commander: pop=${POPULATION} gens=${GENERATIONS} ` +
      `train=${TRAIN_SEED_COUNT} val=${VAL_SEED_COUNT} maxTicks=${MAX_TICKS} ` +
      `score=${SCORING_MODE}(worst-case) ` +
      `vs pool [${TRAINING_POOL.map((o) => o.name).join(', ')}] ` +
      `${parallel ? `parallel x${WORKER_COUNT}` : 'serial'}\n`,
  );

  const pool = parallel ? await createWorkerPool({ bundlePath, size: WORKER_COUNT }) : null;
  const optimizeOptions = {
    dimension: GENOME_DIMENSION,
    rng,
    populationSize: POPULATION,
    generations: GENERATIONS,
    seedGenomes: [defaultGenome()],
    onGeneration: ({ generation, bestFitness, meanFitness }) => {
      console.log(`  gen ${generation}: best=${bestFitness.toFixed(3)} mean=${meanFitness.toFixed(3)}`);
    },
  };
  if (parallel) {
    optimizeOptions.evaluatePopulation = makeParallelEvaluator(pool);
  } else {
    optimizeOptions.evaluate = (genome) =>
      poolFitness(api, () => makeCommanderPolicy(decodeGenome(genome)), TRAIN_SEEDS, TRAINING_POOL).fitness;
  }

  let result;
  try {
    result = await optimize(optimizeOptions);
  } finally {
    if (pool) await pool.close();
  }

  const tunedParams = decodeGenome(result.genome);
  const makeTuned = () => makeCommanderPolicy(tunedParams);
  const makeDefault = () => makeCommanderPolicy();

  // Two out-of-sample reports on held-out seeds:
  //  - TRAINING pool: in-sample opponents, out-of-sample seeds (sanity that the run
  //    actually lifted what it optimized).
  //  - GAUNTLET pool: strategies NEVER trained against — the generalization measure
  //    and the adoption gate. Worst-case here is the headline "robust vs the unknown".
  const tunedTrain = poolFitness(api, makeTuned, VALIDATION_SEEDS, TRAINING_POOL);
  const defaultTrain = poolFitness(api, makeDefault, VALIDATION_SEEDS, TRAINING_POOL);
  const tunedGauntlet = poolFitness(api, makeTuned, VALIDATION_SEEDS, GAUNTLET_POOL);
  const defaultGauntlet = poolFitness(api, makeDefault, VALIDATION_SEEDS, GAUNTLET_POOL);

  console.log(`\n=== Validation (held-out seeds) — fitness = WORST-CASE ${SCORING_MODE} ===`);
  console.log(`  [training pool — in-sample opponents]`);
  console.log(`    default : worst-case=${defaultTrain.fitness.toFixed(3)}  [${formatBreakdown(defaultTrain.perOpponent)}]`);
  console.log(`    tuned   : worst-case=${tunedTrain.fitness.toFixed(3)}  [${formatBreakdown(tunedTrain.perOpponent)}]`);
  console.log(`  [GAUNTLET — held-out opponents (adoption gate)]`);
  console.log(`    default : worst-case=${defaultGauntlet.fitness.toFixed(3)}  [${formatBreakdown(defaultGauntlet.perOpponent)}]`);
  console.log(`    tuned   : worst-case=${tunedGauntlet.fitness.toFixed(3)}  [${formatBreakdown(tunedGauntlet.perOpponent)}]`);

  const gauntletDelta = tunedGauntlet.fitness - defaultGauntlet.fitness;
  console.log(`\n  gauntlet improvement : ${gauntletDelta >= 0 ? '+' : ''}${gauntletDelta.toFixed(3)}`);
  console.log(
    `  ADOPT? ${gauntletDelta > 0
      ? 'YES — tuned beats default worst-case on HELD-OUT opponents (robustly better)'
      : 'NO — does not beat default worst-case on held-out opponents; keep defaults'}`,
  );

  console.log(`\n=== Tuned params (paste into BOTH policies.mjs and aiCommander.ts) ===`);
  console.log(JSON.stringify(tunedParams, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error('Trainer threw:', error);
  process.exit(1);
});
