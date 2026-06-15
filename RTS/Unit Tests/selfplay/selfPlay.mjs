// Self-play engine: run two commander policies against each other in the real
// simulation, headlessly, and turn the result into a scalar fitness.
//
// This is the foundation the optimization loop hangs off. `runMatch` plays one
// deterministic game; `scoreOutcome` reduces a game to a number for one side;
// `evaluate` averages that number over many seeds to give the low-variance
// `score(params)` that an optimizer (CMA-ES / GA / bandit) calls. Nothing here
// knows about any particular optimizer — keep it that way.
//
// Reproducibility note: every match in a process is independent only because the
// simulation resets all of its per-match state on startMatch. Building this
// harness surfaced one map (lastRegenAtMsByUnitId) that startMatch failed to
// reset, which let a prior match's regen timing leak into the next and made the
// same seed score differently; that is fixed in state.ts. reproducibility.harness
// guards against any such regression.

// Fixed simulation timestep. The tick derives its clock purely from the tick
// counter times this dt, so using a constant dt keeps every match reproducible.
const SIMULATION_DT_SECONDS = 1 / 60;

// The two roles the simulation always builds. The map is mirror-symmetric across
// them (p0 south, p1 north), so neither side has a positional advantage.
const ROLES = Object.freeze(['p0', 'p1']);

// Unit kinds that, while alive, keep a side in the game. Wiping all of an
// opponent's is the win condition, so they are the strategic objectives.
const OBJECTIVE_KINDS = Object.freeze(new Set(['Base', 'King', 'Queen']));

/** Default fitness weights. Named and exposed so scoring intent is explicit. */
export const SCORE_DEFAULTS = Object.freeze({
  winBonus: 1000,        // flat reward for eliminating the opponent
  lossPenalty: 1000,     // flat penalty for being eliminated
  royalWeight: 50,       // per surviving-objective advantage (own minus enemy)
  armyWeight: 1,         // per surviving-mobile-unit advantage (own minus enemy)
  speedCostPerTick: 0.02, // shaves a win's reward by how long it took (faster wins rank higher)
});

function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function centroid(units) {
  if (units.length === 0) return { x: 0, y: 0, z: 0 };
  const sum = units.reduce(
    (acc, unit) => {
      acc.x += unit.position.x;
      acc.y += unit.position.y;
      acc.z += unit.position.z;
      return acc;
    },
    { x: 0, y: 0, z: 0 },
  );
  return { x: sum.x / units.length, y: sum.y / units.length, z: sum.z / units.length };
}

/**
 * Build the read-only observation helpers a policy uses, bound to the live store.
 * Each call reads current state, so policies always see the latest tick.
 */
function makeObservation(useGameStore) {
  const livingUnits = () => useGameStore.getState().units.filter((unit) => unit.hp > 0);
  return {
    distanceSquared,
    centroid,
    // This side's mobile army (spawned Units, not the stationary Base/King/Queen).
    ownMobileUnits: (role) =>
      livingUnits().filter((unit) => unit.ownerId === role && unit.kind === 'Unit'),
    // This side's Queens (the unit factories) — needed to rally fresh spawns.
    ownQueens: (role) =>
      livingUnits().filter((unit) => unit.ownerId === role && unit.kind === 'Queen'),
    // This side's Kings (each projects a stationary damage aura) — the monarch
    // pilot drives one forward to carry that aura to the front line.
    ownKings: (role) =>
      livingUnits().filter((unit) => unit.ownerId === role && unit.kind === 'King'),
    // The enemy animal (any kind except the immovable Base) nearest a position —
    // the aim point for the abilities, none of which affect Bases.
    nearestEnemyAnimal: (role, fromPosition) => {
      let nearest = null;
      let nearestDistanceSquared = Infinity;
      for (const unit of livingUnits()) {
        if (unit.ownerId === role || unit.kind === 'Base') continue;
        const candidateDistance = distanceSquared(fromPosition, unit.position);
        if (candidateDistance < nearestDistanceSquared) {
          nearestDistanceSquared = candidateDistance;
          nearest = unit;
        }
      }
      return nearest;
    },
    // Everything that, while alive, keeps the ENEMY in the game (the attack targets).
    enemyObjectives: (role) =>
      livingUnits().filter((unit) => unit.ownerId !== role && OBJECTIVE_KINDS.has(unit.kind)),
    // The enemy's mobile army (spawned Units) — the force the home-defense peel reacts to.
    enemyMobileUnits: (role) =>
      livingUnits().filter((unit) => unit.ownerId !== role && unit.kind === 'Unit'),
    // Every enemy animal (anything but the immovable Base) — focus-fire candidates,
    // so a low-HP exposed Queen/King can be sniped, not just mobile units.
    enemyAnimals: (role) =>
      livingUnits().filter((unit) => unit.ownerId !== role && unit.kind !== 'Base'),
    // Centroid of this side's own objectives — its defensive "home".
    ownObjectivesCentroid: (role) =>
      centroid(livingUnits().filter((unit) => unit.ownerId === role && OBJECTIVE_KINDS.has(unit.kind))),
    nearestEnemyObjective: (role, fromPosition) => {
      let nearest = null;
      let nearestDistanceSquared = Infinity;
      for (const unit of livingUnits()) {
        if (unit.ownerId === role || !OBJECTIVE_KINDS.has(unit.kind)) continue;
        const candidateDistance = distanceSquared(fromPosition, unit.position);
        if (candidateDistance < nearestDistanceSquared) {
          nearestDistanceSquared = candidateDistance;
          nearest = unit;
        }
      }
      return nearest;
    },
  };
}

/** Count, per role, the surviving objectives and mobile units at match end. */
function tallyForces(units) {
  const tally = {};
  for (const role of ROLES) tally[role] = { objectives: 0, army: 0 };
  for (const unit of units) {
    if (unit.hp <= 0 || !tally[unit.ownerId]) continue;
    if (OBJECTIVE_KINDS.has(unit.kind)) tally[unit.ownerId].objectives += 1;
    else if (unit.kind === 'Unit') tally[unit.ownerId].army += 1;
  }
  return tally;
}

/**
 * Play one full match between two policies and return its outcome.
 *
 * Commands are applied through the real lockstep command bus (applyNetCommand),
 * so this drives the exact code path a networked human input would. The subject
 * policy commands p0; the opponent commands p1.
 *
 * @returns {{ winner: string|null, gameOver: boolean, timedOut: boolean,
 *   ticks: number, forces: object, matchStats: object }}
 */
export function runMatch({ api, seed, lineups, subjectPolicy, opponentPolicy, maxTicks }) {
  const { useGameStore, applyNetCommand } = api;
  const policyByRole = { p0: subjectPolicy, p1: opponentPolicy };
  const observation = makeObservation(useGameStore);

  // Silence the simulation's verbose per-tick logging for the duration; restore
  // it no matter how the match ends.
  const realLog = console.log;
  console.log = () => {};
  try {
    useGameStore.getState().startMultiplayerMatch({ localRole: 'p0', seed, lineups });

    let executedTicks = 0;
    for (let tick = 1; tick <= maxTicks; tick++) {
      for (const role of ROLES) {
        const commands = policyByRole[role].decide({
          role,
          tick,
          read: observation,
        });
        for (const command of commands) applyNetCommand(role, command);
      }
      useGameStore.getState().tick(SIMULATION_DT_SECONDS, Date.now());
      executedTicks = tick;
      if (useGameStore.getState().gameOver) break;
    }

    const state = useGameStore.getState();
    return {
      winner: state.winner,
      gameOver: state.gameOver,
      timedOut: !state.gameOver,
      ticks: executedTicks,
      forces: tallyForces(state.units),
      matchStats: { ...state.matchStats },
    };
  } finally {
    console.log = realLog;
  }
}

/**
 * Reduce one match outcome to a scalar fitness for `role` (higher is better).
 * Combines the decisive win/loss terms with continuous surviving-force terms so
 * the optimizer still gets gradient from matches that hit the tick cap.
 */
export function scoreOutcome(outcome, role, weights = SCORE_DEFAULTS) {
  const enemyRole = ROLES.find((candidate) => candidate !== role);
  const objectiveAdvantage =
    outcome.forces[role].objectives - outcome.forces[enemyRole].objectives;
  const armyAdvantage = outcome.forces[role].army - outcome.forces[enemyRole].army;

  let score = weights.royalWeight * objectiveAdvantage + weights.armyWeight * armyAdvantage;
  if (outcome.gameOver && outcome.winner === role) {
    score += weights.winBonus - weights.speedCostPerTick * outcome.ticks;
  } else if (outcome.gameOver && outcome.winner === enemyRole) {
    score -= weights.lossPenalty;
  }
  return score;
}

// Win-rate scorer tuning. The decisive ±1 tiers dominate; a timed-out game maps its
// surviving-force margin through tanh into (−cap, +cap) so a near-win still ranks
// above a near-loss WITHOUT ever reaching a clean win/loss. A small speed preference
// rides on top of a win only (it can never lift a non-win into the win tier), so
// faster wins rank higher. This bounded shape is the point: unlike the margin scorer,
// no opponent can be "farmed" for an unbounded score, so a worst-case aggregation
// across the pool selects for genuine robustness rather than blowout-vs-one-opponent.
export const WIN_RATE_TIMEOUT_SCALE = 150; // surviving-force margin that maps to ~tanh(1)
export const WIN_RATE_TIMEOUT_CAP = 0.9;   // ceiling/floor on a timed-out game's score
export const WIN_RATE_SPEED_PREF = 0.1;    // max bonus added to a win for finishing fast
export const WIN_RATE_SPEED_REF_TICKS = 18000; // ticks past which the speed bonus is 0

/**
 * Reduce one match outcome to a BOUNDED scalar in [-1, 1 + speedPref] for `role`:
 * +1 win (plus a small speed bonus), -1 loss, and a squashed surviving-force margin
 * for a timeout. Averaged over seeds this is essentially a win-rate, and because it
 * cannot blow up it is safe to aggregate across opponents by worst-case.
 */
export function scoreOutcomeWinRate(outcome, role) {
  const enemyRole = ROLES.find((candidate) => candidate !== role);
  if (outcome.gameOver && outcome.winner === role) {
    const speedBonus =
      WIN_RATE_SPEED_PREF * Math.max(0, 1 - outcome.ticks / WIN_RATE_SPEED_REF_TICKS);
    return 1 + speedBonus;
  }
  if (outcome.gameOver && outcome.winner === enemyRole) return -1;

  const objectiveAdvantage = outcome.forces[role].objectives - outcome.forces[enemyRole].objectives;
  const armyAdvantage = outcome.forces[role].army - outcome.forces[enemyRole].army;
  const margin = SCORE_DEFAULTS.royalWeight * objectiveAdvantage + SCORE_DEFAULTS.armyWeight * armyAdvantage;
  return WIN_RATE_TIMEOUT_CAP * Math.tanh(margin / WIN_RATE_TIMEOUT_SCALE);
}

// Named scorers so a worker (which can't be handed a function across the thread
// boundary) can select one by name. 'margin' is the original unbounded scorer;
// 'winRate' is the bounded, worst-case-safe scorer above.
const SCORERS = Object.freeze({ margin: scoreOutcome, winRate: scoreOutcomeWinRate });

/** Resolve a scoring-mode name to its scorer function; throws on an unknown name. */
export function resolveScorer(name) {
  const scorer = SCORERS[name];
  if (!scorer) throw new Error(`Unknown scoring mode: ${name}`);
  return scorer;
}

/**
 * Pick `count` distinct animals for a side using a seeded shuffle of the live
 * roster, so lineups are reproducible from the seed and never hard-coded.
 */
function buildLineup(animalRoster, rng, count) {
  const roster = [...animalRoster];
  for (let i = roster.length - 1; i > 0; i--) {
    const swapIndex = rng.nextInt(i + 1);
    [roster[i], roster[swapIndex]] = [roster[swapIndex], roster[i]];
  }
  return roster.slice(0, count);
}

/**
 * Build reproducible 3-animal lineups for both roles from a seed. The simulation
 * places one Base/Queen/King trio per lineup entry at the three fixed bases.
 */
export function buildLineups({ api, SeededRng, seed, animalsPerSide = 3 }) {
  const roster = Object.keys(api.ANIMALS);
  // Separate RNG streams per role so the two lineups are independent yet
  // deterministic from the match seed.
  const p0Rng = new SeededRng(seed ^ 0x9e3779b9);
  const p1Rng = new SeededRng(seed ^ 0x85ebca6b);
  return {
    p0: buildLineup(roster, p0Rng, animalsPerSide),
    p1: buildLineup(roster, p1Rng, animalsPerSide),
  };
}

/**
 * The `score(params)` foundation: average the subject policy's fitness over a
 * set of seeds against a fixed opponent. Determinism makes each seed a stable
 * data point, so a modest seed count yields a low-variance score.
 *
 * All matches share one simulation instance (`api`); each match fully resets the
 * simulation, so they are independent. `makeSubject` is a factory so callers can
 * pass a fresh, parameterized policy per evaluation (what an optimizer perturbs);
 * the opponent factory is likewise fresh per match.
 *
 * @returns {{ meanScore: number, wins: number, losses: number, draws: number,
 *   perSeed: Array<{ seed: number, score: number, outcome: object }> }}
 */
export function evaluate({
  api,
  makeSubject,
  makeOpponent,
  seeds,
  maxTicks,
  weights = SCORE_DEFAULTS,
  scorer = scoreOutcome,
  animalsPerSide = 3,
}) {
  const perSeed = [];
  let wins = 0;
  let losses = 0;
  let draws = 0;

  for (const seed of seeds) {
    const lineups = buildLineups({ api, SeededRng: api.SeededRng, seed, animalsPerSide });
    const outcome = runMatch({
      api,
      seed,
      lineups,
      subjectPolicy: makeSubject(),
      opponentPolicy: makeOpponent(),
      maxTicks,
    });
    const score = scorer(outcome, 'p0', weights);
    perSeed.push({ seed, score, outcome });

    if (outcome.winner === 'p0') wins += 1;
    else if (outcome.winner === 'p1') losses += 1;
    else draws += 1;
  }

  const meanScore = perSeed.reduce((sum, entry) => sum + entry.score, 0) / perSeed.length;
  return { meanScore, wins, losses, draws, perSeed };
}
