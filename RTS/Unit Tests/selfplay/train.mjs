// Trainer: evolve the macro commander's knobs to beat an opponent pool.
//
// Wires the generic optimizer to the self-play fitness. A candidate's fitness is
// its mean score across an OPPONENT POOL (passive + rush) over a set of TRAINING
// seeds — the pool guards against overfitting to one opponent, the seed average
// against overfitting to one map. The evolved best is then reported on a disjoint
// VALIDATION seed set, so the headline number is out-of-sample.
//
// Run from the RTS project root (env vars optional):
//   node "Unit Tests/selfplay/train.mjs"
//   OPT_GENS=8 OPT_POP=12 OPT_TRAIN_SEEDS=4 OPT_MAX_TICKS=9000 node "Unit Tests/selfplay/train.mjs"

import { loadSimulationApi } from './bundleStore.mjs';
import { evaluate } from './selfPlay.mjs';
import { makePassivePolicy, makeRushPolicy, makeCommanderPolicy } from './policies.mjs';
import { optimize } from './optimizer.mjs';
import { decodeGenome, defaultGenome, GENOME_DIMENSION } from './commanderGenome.mjs';

const POPULATION = Number(process.env.OPT_POP ?? 8);
const GENERATIONS = Number(process.env.OPT_GENS ?? 5);
const TRAIN_SEED_COUNT = Number(process.env.OPT_TRAIN_SEEDS ?? 3);
const VAL_SEED_COUNT = Number(process.env.OPT_VAL_SEEDS ?? 4);
const MAX_TICKS = Number(process.env.OPT_MAX_TICKS ?? 5000);
const OPT_SEED = Number(process.env.OPT_SEED ?? 1);

// Disjoint training and validation match seeds, spread across the 32-bit space so
// lineups vary. Different multipliers keep the two sets non-overlapping.
const buildSeeds = (count, salt) =>
  Array.from({ length: count }, (_unused, index) => ((index + 1) * 0x1000193 + salt) >>> 0);
const TRAIN_SEEDS = buildSeeds(TRAIN_SEED_COUNT, 0);
const VALIDATION_SEEDS = buildSeeds(VAL_SEED_COUNT, 0x55555555);

// The opponent pool a candidate must do well against. Each entry is a factory so
// a fresh opponent is built per match. The self-mirror (the current trained
// commander) is the key entry: it forces a candidate to beat a competent macro
// opponent — not just passive/rush — which is what justifies the riskier levers
// (King piloting, the sacrificial Bee dive) that a weak pool leaves switched off.
const OPPONENT_POOL = [
  { name: 'passive', make: () => makePassivePolicy() },
  { name: 'rush', make: () => makeRushPolicy() },
  { name: 'mirror', make: () => makeCommanderPolicy() },
];

/**
 * Mean score of `makeSubject` (as p0) across the opponent pool over `seeds`.
 * Returns the scalar fitness plus the per-opponent breakdown for reporting.
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

async function main() {
  const api = await loadSimulationApi();

  // Optimizer randomness comes from the seeded game RNG, so a run is reproducible.
  const optRng = new api.SeededRng(OPT_SEED);
  const rng = () => optRng.next();

  console.log(
    `Training commander: pop=${POPULATION} gens=${GENERATIONS} ` +
      `train=${TRAIN_SEED_COUNT} val=${VAL_SEED_COUNT} maxTicks=${MAX_TICKS} ` +
      `vs pool [${OPPONENT_POOL.map((o) => o.name).join(', ')}]\n`,
  );

  const result = optimize({
    evaluate: (genome) => poolFitness(api, () => makeCommanderPolicy(decodeGenome(genome)), TRAIN_SEEDS).fitness,
    dimension: GENOME_DIMENSION,
    rng,
    populationSize: POPULATION,
    generations: GENERATIONS,
    seedGenomes: [defaultGenome()],
    onGeneration: ({ generation, bestFitness, meanFitness }) => {
      console.log(`  gen ${generation}: best=${bestFitness.toFixed(1)} mean=${meanFitness.toFixed(1)}`);
    },
  });

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
