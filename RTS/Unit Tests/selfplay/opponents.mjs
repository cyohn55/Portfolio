// The opponent pools a training candidate is measured against.
//
// Single responsibility: name the reference opponents and how to build a fresh one.
// Kept in its own module because BOTH the trainer (`train.mjs`) and the evaluation
// workers (`evalWorker.mjs`) must agree on exactly the same opponents — a policy
// factory can't be sent across the worker boundary, so each side rebuilds an opponent
// from this shared registry by name.
//
// Two disjoint pools:
//   * TRAINING_POOL — what the trainer optimizes WORST-CASE against. A diverse set so
//     a candidate must beat many strong/varied strategies (a human is exactly that),
//     not just exploit one weak opponent: the do-nothing baseline, a naive rush, a
//     self-mirror, three scripted archetypes, and the evolved champion league.
//   * GAUNTLET_POOL — held-out strategies NEVER trained against, used only for the
//     final generalization report + the adoption gate. If a candidate's worst-case
//     here beats the shipped default's, it generalized rather than overfit.
//
// Each entry is `{ name, make }` with `make` a factory (fresh opponent per match).

import { makePassivePolicy, makeRushPolicy, makeCommanderPolicy } from './policies.mjs';
import { loadChampions } from './league.mjs';

// Scripted archetypes the candidate trains against. All are parameterizations of the
// macro commander — no new policy code — chosen to span the strategic space a human
// might play: an early timing attack, a patient turtle, and an ability-heavy harasser.
const TRAINING_ARCHETYPES = {
  'aggressive-timing': { minAttackForce: 6, aggression: 1, decisionIntervalTicks: 45, reserveStance: 'aggressive', retreatForceRatio: 0 },
  'defensive-turtle': { minAttackForce: 16, aggression: 0.7, attackerStance: 'defensive', reserveStance: 'holdGround', retreatForceRatio: 0.5, stageDepth: 0.08 },
  'ability-harasser': { minAttackForce: 8, aggression: 0.9, decisionIntervalTicks: 60, abilityIntervalTicks: 12, abilityEngageRange: 26 },
};

// Held-out archetypes used ONLY for the gauntlet — distinct from the training set so
// they measure generalization: a very patient max-mass "boomer" and an earliest-
// possible all-in blitz with full ability use.
const GAUNTLET_ARCHETYPES = {
  'macro-boomer': { minAttackForce: 16, aggression: 1, decisionIntervalTicks: 150, reserveStance: 'defensive', retreatForceRatio: 0.6, stageDepth: 0.05 },
  'all-in-blitz': { minAttackForce: 2, aggression: 1, decisionIntervalTicks: 30, reserveStance: 'aggressive', retreatForceRatio: 0, abilityIntervalTicks: 10, abilityEngageRange: 28 },
};

const commanderFactory = (params) => () => makeCommanderPolicy(params);

const archetypeEntries = (archetypes) =>
  Object.entries(archetypes).map(([name, params]) => ({ name, make: commanderFactory(params) }));

export const TRAINING_POOL = [
  { name: 'passive', make: () => makePassivePolicy() },
  { name: 'rush', make: () => makeRushPolicy() },
  { name: 'mirror', make: () => makeCommanderPolicy() },
  ...archetypeEntries(TRAINING_ARCHETYPES),
  ...loadChampions().map((champion) => ({ name: champion.name, make: commanderFactory(champion.params) })),
];

export const GAUNTLET_POOL = archetypeEntries(GAUNTLET_ARCHETYPES);

// Back-compat alias: existing callers import OPPONENT_POOL as "the training pool".
export const OPPONENT_POOL = TRAINING_POOL;

// One registry over BOTH pools so a worker can resolve any opponent by name.
const REGISTRY = new Map([...TRAINING_POOL, ...GAUNTLET_POOL].map((entry) => [entry.name, entry.make]));

/** Build a fresh opponent policy by name (training or gauntlet); throws if unknown. */
export function makeOpponentByName(name) {
  const make = REGISTRY.get(name);
  if (!make) throw new Error(`Unknown opponent: ${name}`);
  return make();
}
