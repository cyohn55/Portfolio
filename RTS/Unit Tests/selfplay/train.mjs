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
import { evaluate } from './selfPlay.mjs';
import { makeCommanderPolicy } from './policies.mjs';
import { OPPONENT_POOL } from './opponents.mjs';
import { optimize } from './optimizer.mjs';
import { createWorkerPool } from './workerPool.mjs';
import { decodeGenome, defaultGenome, GENOME_DIMENSION } from './commanderGenome.mjs';

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
const MAX_USEFUL_WORKERS = POPULATION * OPPONENT_POOL.length;
const WORKER_COUNT = Math.max(1, Math.min(REQUESTED_WORKERS, MAX_USEFUL_WORKERS));

// Disjoint training and validation match seeds, spread across the 32-bit space so
// lineups vary. Different multipliers keep the two sets non-overlapping.
const buildSeeds = (count, salt) =>
  Array.from({ length: count }, (_unused, index) => ((index + 1) * 0x1000193 + salt) >>> 0);
const TRAIN_SEEDS = buildSeeds(TRAIN_SEED_COUNT, 0);
const VALIDATION_SEEDS = buildSeeds(VAL_SEED_COUNT, 0x55555555);

/**
 * Mean score of `makeSubject` (as p0) across the opponent pool over `seeds`,
 * evaluated in-process on one sim instance. Used for the (serial) validation
 * report and the OPT_WORKERS=1 path. Returns the scalar fitness plus the
 * per-opponent breakdown for reporting.
 */
function poolFitness(api, makeSubject, seeds) {
  const perOpponent = OPPONENT_POOL.map((opponent) => ({
    name: opponent.name,
    meanScore: evaluate({
      api,
      makeSubject,
      makeOpponent: opponent.make,
      seeds,
      maxTicks: MAX_TICKS,
    }).meanScore,
  }));
  const fitness = perOpponent.reduce((sum, entry) => sum + entry.meanScore, 0) / perOpponent.length;
  return { fitness, perOpponent };
}

function formatBreakdown(perOpponent) {
  return perOpponent.map((entry) => `${entry.name}=${entry.meanScore.toFixed(1)}`).join('  ');
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
      for (const opponent of OPPONENT_POOL) {
        tasks.push({ genome, opponentName: opponent.name, seeds: TRAIN_SEEDS, maxTicks: MAX_TICKS });
      }
    }
    const results = await pool.runTasks(tasks);

    const opponentCount = OPPONENT_POOL.length;
    return genomes.map((_genome, genomeIndex) => {
      let sum = 0;
      for (let opponentIndex = 0; opponentIndex < opponentCount; opponentIndex++) {
        sum += results[genomeIndex * opponentCount + opponentIndex].meanScore;
      }
      return sum / opponentCount;
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
      `vs pool [${OPPONENT_POOL.map((o) => o.name).join(', ')}] ` +
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
      console.log(`  gen ${generation}: best=${bestFitness.toFixed(1)} mean=${meanFitness.toFixed(1)}`);
    },
  };
  if (parallel) {
    optimizeOptions.evaluatePopulation = makeParallelEvaluator(pool);
  } else {
    optimizeOptions.evaluate = (genome) =>
      poolFitness(api, () => makeCommanderPolicy(decodeGenome(genome)), TRAIN_SEEDS).fitness;
  }

  let result;
  try {
    result = await optimize(optimizeOptions);
  } finally {
    if (pool) await pool.close();
  }

  const tunedParams = decodeGenome(result.genome);

  // Out-of-sample report: tuned vs. the hand-set default, both on validation seeds.
  const tunedVal = poolFitness(api, () => makeCommanderPolicy(tunedParams), VALIDATION_SEEDS);
  const defaultVal = poolFitness(api, () => makeCommanderPolicy(), VALIDATION_SEEDS);

  console.log(`\n=== Validation (held-out seeds) ===`);
  console.log(`  default commander : fitness=${defaultVal.fitness.toFixed(1)}  [${formatBreakdown(defaultVal.perOpponent)}]`);
  console.log(`  tuned commander   : fitness=${tunedVal.fitness.toFixed(1)}  [${formatBreakdown(tunedVal.perOpponent)}]`);
  const delta = tunedVal.fitness - defaultVal.fitness;
  console.log(`  improvement       : ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`);

  console.log(`\n=== Tuned params (paste into makeCommanderPolicy) ===`);
  console.log(JSON.stringify(tunedParams, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error('Trainer threw:', error);
  process.exit(1);
});
