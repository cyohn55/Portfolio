// A small, dependency-free evolution strategy (ES) for black-box maximization.
//
// Single responsibility: given a fitness function over genomes in [0, 1]^d, find
// a high-fitness genome. It knows nothing about the game — the caller supplies
// `evaluate(genome) -> number` and the dimensionality. A (mu + lambda) ES with
// Gaussian mutation, truncation selection, and elitism is plenty for the handful
// of commander knobs and is obviously correct (no covariance bookkeeping to get
// subtly wrong, unlike a hand-rolled CMA-ES).
//
// Determinism: all randomness comes from the injected `rng()` (a () => [0, 1)),
// so an optimization run is reproducible from its seed. Because the fitness is
// itself deterministic, elites keep their score across generations rather than
// being re-evaluated — a free speed-up the determinism buys.

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** Standard-normal sample via Box-Muller, driven by the injected uniform rng. */
function gaussian(rng) {
  // Guard against log(0); rng() is in [0, 1).
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function randomGenome(dimension, rng) {
  return Array.from({ length: dimension }, () => rng());
}

/** A mutated copy of `genome`: add Gaussian noise of scale `sigma`, clamp to [0,1]. */
function mutate(genome, sigma, rng) {
  return genome.map((gene) => clamp01(gene + sigma * gaussian(rng)));
}

/**
 * Maximize fitness over genomes in [0, 1]^dimension. Async because a whole
 * generation's genomes are evaluated in ONE batch — `evaluatePopulation` lets the
 * caller score that batch in parallel (e.g. across worker threads). Genomes for a
 * generation are always generated (consuming `rng`) BEFORE evaluation, so the rng
 * draw order — and therefore the run — is identical whether the batch is scored
 * serially or in parallel.
 *
 * @param {object} options
 * @param {(genome: number[]) => number} [options.evaluate]  per-genome fitness (higher better).
 * @param {(genomes: number[][]) => (number[] | Promise<number[]>)} [options.evaluatePopulation]
 *        batch fitness, results aligned to input order. Preferred; falls back to mapping `evaluate`.
 * @param {number} options.dimension
 * @param {() => number} options.rng                       seeded uniform in [0, 1).
 * @param {number} [options.populationSize]                lambda.
 * @param {number} [options.generations]
 * @param {number} [options.eliteFraction]                 mu / lambda kept each gen.
 * @param {number} [options.sigmaStart]                    initial mutation scale.
 * @param {number} [options.sigmaEnd]                      final mutation scale (linear decay).
 * @param {number[][]} [options.seedGenomes]               genomes to inject into gen 0 (e.g. defaults).
 * @param {(info: object) => void} [options.onGeneration]  progress callback.
 * @returns {Promise<{ genome: number[], fitness: number, history: Array<{generation:number,bestFitness:number,meanFitness:number}> }>}
 */
export async function optimize({
  evaluate,
  evaluatePopulation,
  dimension,
  rng,
  populationSize = 8,
  generations = 6,
  eliteFraction = 0.34,
  sigmaStart = 0.18,
  sigmaEnd = 0.05,
  seedGenomes = [],
  onGeneration,
}) {
  if (!evaluatePopulation && !evaluate) {
    throw new Error('optimize requires evaluate or evaluatePopulation');
  }
  // One batch evaluator regardless of which the caller supplied.
  const scoreBatch = evaluatePopulation
    ? (genomes) => evaluatePopulation(genomes)
    : (genomes) => genomes.map(evaluate);

  const eliteCount = Math.max(1, Math.round(populationSize * eliteFraction));

  // Generation 0: the seed genomes (capped at the population), then random fill.
  const initialGenomes = [];
  for (const genome of seedGenomes.slice(0, populationSize)) initialGenomes.push(genome.map(clamp01));
  while (initialGenomes.length < populationSize) initialGenomes.push(randomGenome(dimension, rng));

  const initialFitness = await scoreBatch(initialGenomes);
  let population = initialGenomes.map((genome, index) => ({ genome, fitness: initialFitness[index] }));

  const history = [];
  for (let generation = 0; generation < generations; generation++) {
    population.sort((a, b) => b.fitness - a.fitness);

    const bestFitness = population[0].fitness;
    const meanFitness =
      population.reduce((sum, individual) => sum + individual.fitness, 0) / population.length;
    history.push({ generation, bestFitness, meanFitness });
    if (onGeneration) onGeneration({ generation, bestFitness, meanFitness, best: population[0] });

    if (generation === generations - 1) break;

    // Linearly anneal the mutation scale so late generations refine rather than roam.
    const sigma = sigmaStart + (sigmaEnd - sigmaStart) * (generation / (generations - 1));

    // (mu + lambda): keep the elites (with their scores — deterministic, no re-eval),
    // breed the rest by mutating a randomly chosen elite parent. Generate every
    // offspring genome first (this is the only rng-consuming step), then score the
    // whole batch at once so a parallel evaluator can fan it across workers.
    const elites = population.slice(0, eliteCount);
    const offspringGenomes = [];
    while (elites.length + offspringGenomes.length < populationSize) {
      const parent = elites[Math.floor(rng() * elites.length)];
      offspringGenomes.push(mutate(parent.genome, sigma, rng));
    }
    const offspringFitness = await scoreBatch(offspringGenomes);
    const offspring = offspringGenomes.map((genome, index) => ({ genome, fitness: offspringFitness[index] }));
    population = [...elites, ...offspring];
  }

  population.sort((a, b) => b.fitness - a.fitness);
  return { genome: population[0].genome, fitness: population[0].fitness, history };
}
