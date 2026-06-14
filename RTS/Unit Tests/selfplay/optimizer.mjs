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
 * Maximize `evaluate` over genomes in [0, 1]^dimension.
 *
 * @param {object} options
 * @param {(genome: number[]) => number} options.evaluate  fitness (higher better).
 * @param {number} options.dimension
 * @param {() => number} options.rng                       seeded uniform in [0, 1).
 * @param {number} [options.populationSize]                lambda.
 * @param {number} [options.generations]
 * @param {number} [options.eliteFraction]                 mu / lambda kept each gen.
 * @param {number} [options.sigmaStart]                    initial mutation scale.
 * @param {number} [options.sigmaEnd]                      final mutation scale (linear decay).
 * @param {number[][]} [options.seedGenomes]               genomes to inject into gen 0 (e.g. defaults).
 * @param {(info: object) => void} [options.onGeneration]  progress callback.
 * @returns {{ genome: number[], fitness: number, history: Array<{generation:number,bestFitness:number,meanFitness:number}> }}
 */
export function optimize({
  evaluate,
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
  const eliteCount = Math.max(1, Math.round(populationSize * eliteFraction));

  // Generation 0: the seed genomes (capped at the population), then random fill.
  let population = [];
  for (const genome of seedGenomes.slice(0, populationSize)) {
    population.push({ genome: genome.map(clamp01) });
  }
  while (population.length < populationSize) {
    population.push({ genome: randomGenome(dimension, rng) });
  }
  for (const individual of population) {
    individual.fitness = evaluate(individual.genome);
  }

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
    // breed the rest by mutating a randomly chosen elite parent.
    const elites = population.slice(0, eliteCount);
    const offspring = [];
    while (elites.length + offspring.length < populationSize) {
      const parent = elites[Math.floor(rng() * elites.length)];
      const genome = mutate(parent.genome, sigma, rng);
      offspring.push({ genome, fitness: evaluate(genome) });
    }
    population = [...elites, ...offspring];
  }

  population.sort((a, b) => b.fitness - a.fitness);
  return { genome: population[0].genome, fitness: population[0].fitness, history };
}
