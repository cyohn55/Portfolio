// Commander policies: the decision layer the self-play loop optimizes.
//
// A policy's single responsibility is to map an observation of the live
// simulation to a list of NetCommands for one side. It never mutates state —
// the engine applies the returned commands through the real command bus
// (applyNetCommand), exactly as a remote human peer's inputs are applied.
//
// This file is the seam where the future "AI commander" (Layer B) grows. Today
// the shipping opponent issues NO commands — its units only fight autonomously
// when an enemy wanders into range. `makePassivePolicy` reproduces that as the
// honest baseline; `makeRushPolicy` is a minimal real commander that proves the
// seam and gives the optimizer something to beat. Add richer policies here.

/**
 * @typedef {{ type: string, payload: object }} NetCommand
 *
 * @typedef {Object} PolicyContext
 * @property {'p0'|'p1'} role  - the side this policy commands.
 * @property {number} tick     - 1-based index of the tick about to run.
 * @property {object} rng      - this policy's own SeededRng (reproducible).
 * @property {object} read     - read-only observation helpers (see runMatch).
 *
 * @typedef {Object} Policy
 * @property {string} name
 * @property {(ctx: PolicyContext) => NetCommand[]} decide
 */

/**
 * The shipping opponent: issues nothing. Units rely entirely on the autonomous
 * stance engine. This is the baseline every trained policy must outperform.
 *
 * @returns {Policy}
 */
export function makePassivePolicy() {
  return {
    name: 'passive',
    decide: () => [],
  };
}

/**
 * Default knobs for the rush commander. Exposed (not inlined) so the optimizer
 * can perturb each field and so their meaning is self-documenting. All values
 * are in simulation units: ticks at 60 ticks/second, counts of units, fractions.
 */
export const RUSH_DEFAULTS = Object.freeze({
  decisionIntervalTicks: 90,  // re-issue orders ~every 1.5s; avoids order spam
  aggression: 1,              // fraction of the mobile army committed to the push
  minArmyToPush: 1,           // hold until at least this many mobile units exist
  focusFire: true,            // attack the nearest enemy royal vs. move onto it
});

/**
 * A minimal but real commander: periodically commits a fraction of its mobile
 * army against the nearest surviving enemy objective (Base/King/Queen). With
 * focusFire it issues an attack order; otherwise an attack-move onto the target.
 *
 * This is intentionally simple — its purpose is to (a) exercise every part of
 * the harness end to end and (b) be a parameterized policy whose knobs the
 * optimizer can tune. Replace/extend its `decide` as Layer B matures.
 *
 * @param {Partial<typeof RUSH_DEFAULTS>} [overrides]
 * @returns {Policy}
 */
export function makeRushPolicy(overrides = {}) {
  const params = { ...RUSH_DEFAULTS, ...overrides };
  return {
    name: 'rush',
    decide: ({ role, tick, read }) => {
      // Only think on decision ticks to mirror the real AI's throttled cadence
      // and to keep the command stream sparse.
      if (tick % params.decisionIntervalTicks !== 0) return [];

      const army = read.ownMobileUnits(role);
      if (army.length < params.minArmyToPush) return [];

      const objective = read.nearestEnemyObjective(role, read.centroid(army));
      if (!objective) return [];

      // Commit the configured fraction of the army, ordered by proximity to the
      // objective so the front line leads the push.
      const committedCount = Math.max(1, Math.round(army.length * params.aggression));
      const committed = army
        .slice()
        .sort(
          (a, b) =>
            read.distanceSquared(a.position, objective.position) -
            read.distanceSquared(b.position, objective.position),
        )
        .slice(0, committedCount)
        .map((unit) => unit.id);

      if (params.focusFire) {
        return [{ type: 'attackTarget', payload: { unitIds: committed, targetId: objective.id } }];
      }
      return [
        {
          type: 'moveUnits',
          payload: { unitIds: committed, target: { ...objective.position } },
        },
      ];
    },
  };
}

// ---------------------------------------------------------------------------
// Macro commander (Layer B). A real, stateful strategy with meaningful knobs.
// ---------------------------------------------------------------------------

// How an objective's strategic worth is ranked when `targetPriority` is 'value'.
// Queens are factories (killing one stops the enemy's reinforcement economy), so
// they outrank Kings (a damage aura) and Bases (inert win-condition pieces).
const OBJECTIVE_VALUE_BY_KIND = Object.freeze({ Queen: 3, King: 2, Base: 1 });

/**
 * Default knobs for the macro commander. Every field is a lever the optimizer can
 * perturb. These values are the OUTPUT of a training run (train.mjs: 6 generations
 * vs a passive+rush pool, validated on held-out seeds) — the evolved strategy is
 * "mass a large force, then commit fully and aggressively at the nearest
 * objective", which beats both the passive baseline and the naive rush out of
 * sample. Re-run train.mjs to evolve a fresh set. Units: ticks at 60/s, counts of
 * units, fractions in [0, 1].
 */
export const COMMANDER_DEFAULTS = Object.freeze({
  decisionIntervalTicks: 131,   // re-plan cadence (~2.2s); keeps the command stream sparse
  minAttackForce: 16,           // mass a large force before committing (beats piecemeal feeding)
  aggression: 1,               // fraction of the mobile army sent on the attack
  targetPriority: 'nearest',    // 'nearest' | 'value' | 'weakest' — which objective to kill
                                // ('nearest' avoids marching the army deep past the enemy line)
  stageDepth: 0.285,            // staging point: fraction from own home toward the enemy
  retreatForceRatio: 0.112,     // pull back if force falls below this × peak (0 = never retreat)
  rallyReinforcements: true,    // rally Queen spawns to the staging point so they join the front
  attackerStance: 'aggressive', // stance for committed units (chase far, engage en route)
  reserveStance: 'aggressive',  // stance for the home reserve
});

// The commander's coarse phase. Massing concentrates force at the staging point;
// attacking commits it onto one objective; retreating pulls survivors back to
// re-mass after a failed push.
const PHASE = Object.freeze({ MASSING: 'massing', ATTACKING: 'attacking', RETREATING: 'retreating' });

/** Linear interpolate between two positions by fraction t (0 = a, 1 = b). */
function lerpPosition(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * Pick the objective to attack from `objectives` under the configured priority,
 * measuring distance from `fromPosition`. Ties break on id so the choice is
 * deterministic regardless of unit iteration order.
 */
function chooseObjective(objectives, fromPosition, priority, read) {
  const scoreOf = (objective) => {
    switch (priority) {
      case 'nearest':
        return -read.distanceSquared(fromPosition, objective.position);
      case 'weakest':
        return -objective.hp;
      case 'value':
      default:
        // Prefer high value, then nearer, as a smooth tiebreak within a value tier.
        return OBJECTIVE_VALUE_BY_KIND[objective.kind] * 1e9 -
          read.distanceSquared(fromPosition, objective.position);
    }
  };
  let best = null;
  let bestScore = -Infinity;
  for (const objective of objectives) {
    const score = scoreOf(objective);
    if (score > bestScore || (score === bestScore && (best === null || objective.id < best.id))) {
      bestScore = score;
      best = objective;
    }
  }
  return best;
}

/**
 * A stateful macro commander that masses its army, commits it as a focused blow
 * against a chosen objective, and retreats to re-mass when a push is being worn
 * down — issuing real commands (attack-move, focus-fire, stance, queen-rally)
 * through the same bus a human uses.
 *
 * Holds per-match state in its closure (current phase, the peak force of the
 * active push). That state is derived purely from deterministic observations, and
 * a fresh policy is built per match by `evaluate`, so it never leaks across games.
 *
 * This is the policy with real tuning headroom: massing vs. dribbling, which
 * objective to prioritise, how deep to stage, and when to cut losses are all
 * knobs an optimizer can explore. Extend `decide` with abilities next.
 *
 * @param {Partial<typeof COMMANDER_DEFAULTS>} [overrides]
 * @returns {Policy}
 */
export function makeCommanderPolicy(overrides = {}) {
  const params = { ...COMMANDER_DEFAULTS, ...overrides };
  let phase = PHASE.MASSING;
  let peakAttackForce = 0;

  return {
    name: 'commander',
    decide: ({ role, tick, read }) => {
      if (tick % params.decisionIntervalTicks !== 0) return [];

      const army = read.ownMobileUnits(role);
      const objectives = read.enemyObjectives(role);
      if (objectives.length === 0 || army.length === 0) return [];

      // Staging point: between this side's home and the enemy's mass, governed by
      // stageDepth. The army gathers here, and reinforcements are rallied here.
      const home = read.ownObjectivesCentroid(role);
      const enemyCentroid = read.centroid(objectives);
      const stagingPoint = lerpPosition(home, enemyCentroid, params.stageDepth);

      const commands = [];

      // Keep the unit factories feeding the front rather than the base.
      if (params.rallyReinforcements) {
        for (const queen of read.ownQueens(role)) {
          commands.push({
            type: 'setQueenRally',
            payload: { queenId: queen.id, target: { mode: 'point', position: { ...stagingPoint } } },
          });
        }
      }

      // --- Phase transitions -------------------------------------------------
      if (phase === PHASE.MASSING && army.length >= params.minAttackForce) {
        phase = PHASE.ATTACKING;
        peakAttackForce = army.length;
      } else if (phase === PHASE.ATTACKING) {
        peakAttackForce = Math.max(peakAttackForce, army.length);
        if (army.length < peakAttackForce * params.retreatForceRatio) {
          phase = PHASE.RETREATING;
        }
      } else if (phase === PHASE.RETREATING && army.length >= params.minAttackForce) {
        // Re-massed after a failed push; commit again.
        phase = PHASE.ATTACKING;
        peakAttackForce = army.length;
      }

      const armyIds = army.map((unit) => unit.id);

      // --- Phase actions -----------------------------------------------------
      if (phase === PHASE.ATTACKING) {
        const objective = chooseObjective(objectives, read.centroid(army), params.targetPriority, read);
        const committedCount = Math.max(1, Math.round(army.length * params.aggression));
        const committed = army
          .slice()
          .sort(
            (a, b) =>
              read.distanceSquared(a.position, objective.position) -
              read.distanceSquared(b.position, objective.position),
          )
          .slice(0, committedCount);
        const committedIds = committed.map((unit) => unit.id);
        const committedSet = new Set(committedIds);
        const reserveIds = armyIds.filter((id) => !committedSet.has(id));

        commands.push({ type: 'setBehavior', payload: { unitIds: committedIds, behavior: { stance: params.attackerStance } } });
        commands.push({ type: 'attackTarget', payload: { unitIds: committedIds, targetId: objective.id } });
        if (reserveIds.length > 0) {
          commands.push({ type: 'setBehavior', payload: { unitIds: reserveIds, behavior: { stance: params.reserveStance } } });
          commands.push({ type: 'moveUnits', payload: { unitIds: reserveIds, target: { ...stagingPoint } } });
        }
      } else {
        // Massing or retreating: gather the whole army at the staging point under
        // a defensive posture so it fights if attacked but does not over-extend.
        commands.push({ type: 'setBehavior', payload: { unitIds: armyIds, behavior: { stance: params.reserveStance } } });
        commands.push({ type: 'moveUnits', payload: { unitIds: armyIds, target: { ...stagingPoint } } });
      }

      return commands;
    },
  };
}
