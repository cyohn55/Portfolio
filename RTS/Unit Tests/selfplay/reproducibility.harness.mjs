// Reproducibility guard for the self-play fitness function.
//
// An optimizer is only sound if `score(params)` is deterministic: the same
// params and seeds must always yield the same number. This harness asserts that
// by scoring the SAME subject policy twice on one warmed simulation instance and
// requiring byte-identical per-seed scores. It is the regression test for the
// two determinism fixes the harness depends on:
//   1. clearing the module-level distance memo each match (state.ts), and
//   2. the warm-up match that absorbs the first-match cold start (selfPlay).
// If either regresses, a later match's outcome starts depending on what ran
// before it and this harness fails loudly.
//
// Run from the RTS project root:
//   node "Unit Tests/selfplay/reproducibility.harness.mjs"

import { loadSimulationApi } from './bundleStore.mjs';
import { evaluate } from './selfPlay.mjs';
import { makePassivePolicy, makeRushPolicy } from './policies.mjs';

const SEEDS = [0x1000193, 0x2000326, 0x3000489];
const MAX_TICKS = 4000;

async function main() {
  const api = await loadSimulationApi();

  const options = {
    api,
    makeSubject: () => makeRushPolicy(),
    makeOpponent: () => makePassivePolicy(),
    seeds: SEEDS,
    maxTicks: MAX_TICKS,
  };

  const first = evaluate(options);
  const second = evaluate(options);

  const firstScores = first.perSeed.map((entry) => entry.score);
  const secondScores = second.perSeed.map((entry) => entry.score);

  const mismatch = firstScores.findIndex((score, index) => score !== secondScores[index]);
  if (mismatch === -1) {
    console.log(`PASS: identical per-seed scores across two evaluations.`);
    console.log(`  scores: [${firstScores.join(', ')}]  mean=${first.meanScore.toFixed(3)}`);
    process.exit(0);
  }

  console.error(`FAIL: score for seed ${SEEDS[mismatch].toString(16)} differed between runs.`);
  console.error(`  run 1: ${firstScores[mismatch]}`);
  console.error(`  run 2: ${secondScores[mismatch]}`);
  process.exit(1);
}

main().catch((error) => {
  console.error('Reproducibility harness threw:', error);
  process.exit(2);
});
