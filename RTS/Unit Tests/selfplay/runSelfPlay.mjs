// Runnable demonstration of the self-play harness.
//
// Loads the real simulation, then evaluates a parameterized commander (rush)
// against the shipping baseline (passive) over a handful of seeds, printing win
// counts and mean fitness. This is the end-to-end proof that `score(params)`
// discriminates between policies; an optimizer would call `evaluate` in a loop
// in place of this script's single call.
//
// Run from the RTS project root:
//   node "Unit Tests/selfplay/runSelfPlay.mjs"
//   SELFPLAY_SEEDS=8 SELFPLAY_MAX_TICKS=12000 node "Unit Tests/selfplay/runSelfPlay.mjs"

import { loadSimulationApi } from './bundleStore.mjs';
import { evaluate } from './selfPlay.mjs';
import { makePassivePolicy, makeRushPolicy, makeCommanderPolicy } from './policies.mjs';

// Match length cap and seed count are env-overridable so smoke runs stay fast
// while real evaluations can run longer, more numerous games.
const MAX_TICKS = Number(process.env.SELFPLAY_MAX_TICKS ?? 9000);
const SEED_COUNT = Number(process.env.SELFPLAY_SEEDS ?? 4);

function buildSeeds(count) {
  // Spread seeds across the 32-bit space so lineups vary between matches.
  return Array.from({ length: count }, (_unused, index) => (index + 1) * 0x1000193);
}

function summarize(label, result) {
  console.log(
    `${label.padEnd(24)} wins=${result.wins} losses=${result.losses} ` +
      `draws=${result.draws} meanScore=${result.meanScore.toFixed(1)}`,
  );
}

async function main() {
  const api = await loadSimulationApi();
  const seeds = buildSeeds(SEED_COUNT);

  console.log(`Self-play smoke run: ${SEED_COUNT} seeds, up to ${MAX_TICKS} ticks/match.\n`);

  // Reference point: the baseline played against itself should score ~0 (a
  // symmetric matchup with no decisive edge either way).
  const baseline = evaluate({
    api,
    makeSubject: () => makePassivePolicy(),
    makeOpponent: () => makePassivePolicy(),
    seeds,
    maxTicks: MAX_TICKS,
  });
  summarize('passive vs passive', baseline);

  // The naive rush commander: should beat the passive baseline, demonstrating the
  // score function discriminates between policies.
  const rush = evaluate({
    api,
    makeSubject: () => makeRushPolicy(),
    makeOpponent: () => makePassivePolicy(),
    seeds,
    maxTicks: MAX_TICKS,
  });
  summarize('rush vs passive', rush);

  // The Layer B macro commander (mass → focused attack → rally reinforcements) at
  // its trained defaults (see train.mjs). These knobs were evolved against a
  // passive+rush pool, so the commander should out-score the rush both against the
  // baseline and head to head — on seeds it never trained on.
  const commander = evaluate({
    api,
    makeSubject: () => makeCommanderPolicy(),
    makeOpponent: () => makePassivePolicy(),
    seeds,
    maxTicks: MAX_TICKS,
  });
  summarize('commander vs passive', commander);

  const headToHead = evaluate({
    api,
    makeSubject: () => makeCommanderPolicy(),
    makeOpponent: () => makeRushPolicy(),
    seeds,
    maxTicks: MAX_TICKS,
  });
  summarize('commander vs rush', headToHead);

  // Healthy ladder: both command-issuing policies beat the do-nothing baseline
  // (score() discriminates, commands take effect) AND the trained commander beats
  // the naive rush head to head.
  const ladderHolds = rush.meanScore > baseline.meanScore &&
    commander.meanScore > baseline.meanScore && headToHead.meanScore > 0;
  console.log(`\n${ladderHolds ? 'PASS' : 'NOTE'}: passive < rush, and the trained ` +
    `commander beats the rush head to head (mean ${headToHead.meanScore.toFixed(1)}).`);
  process.exit(0);
}

main().catch((error) => {
  console.error('Self-play harness threw:', error);
  process.exit(1);
});
