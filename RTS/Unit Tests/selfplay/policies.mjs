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
 * perturb. These values are the OUTPUT of a ROBUST training run (train.mjs: pop 24,
 * 14 generations, 28 workers, 9000-tick matches, bounded win-rate scorer aggregated
 * WORST-CASE over an 8-opponent league — passive/rush/self-mirror + 3 scripted
 * archetypes + 2 evolved champions). Adopted because it beats the prior hand-set
 * default on a DISJOINT held-out gauntlet's worst case (+0.089 vs −0.144; gauntlet
 * improvement +0.233) and has NO losing matchup across all 10 distinct opponents —
 * i.e. it is robust against varied, competent play (the proxy for "strong vs humans").
 * It fixed the prior default's exploitable hole (losing to a patient turtle/boomer).
 *
 * The evolved strategy is "mass, commit ~70% (keep a reserve), play controlled
 * (defensive/holdGround), peel a large home-defense force against counterattacks,
 * focus-fire the weakest nearby enemy, and pilot the King's aura to the front".
 * Notably the optimizer turned ABILITIES OFF (useAbilities:false → egg/tongue/hiss
 * unused; useSacrificialSwarm is then inert) — it was more robust relying on
 * positioning, focus-fire, home defense, and the King aura than on ability micro.
 * Re-run train.mjs to evolve a fresh set. Units: ticks at 60/s, counts, fractions.
 */
export const COMMANDER_DEFAULTS = Object.freeze({
  decisionIntervalTicks: 90,    // re-plan cadence (~1.5s)
  minAttackForce: 16,           // mass a large force before committing (beats piecemeal feeding)
  aggression: 0.6945005618829754, // fraction of the mobile army sent on the attack (keeps a reserve)
  targetPriority: 'nearest',    // 'nearest' | 'value' | 'weakest' — which objective to kill
  stageDepth: 0.1654629908431992, // staging point: fraction from own home toward the enemy
  retreatForceRatio: 0.3939323195832534, // pull back if force falls below this × peak
  rallyReinforcements: false,   // (evolved off) do not force-rally Queen spawns to the staging point
  attackerStance: 'defensive',  // committed units engage within a leash, don't over-chase
  reserveStance: 'holdGround',  // home reserve holds, attacks only what comes to it

  // --- Abilities (animal-specific special moves) ---------------------------
  useAbilities: false,          // (evolved OFF) more robust without egg/tongue/hiss micro
  abilityIntervalTicks: 60,     // (inert while useAbilities is false)
  abilityEngageRange: 20.398192749735674, // (inert while useAbilities is false)
  useSacrificialSwarm: true,    // (inert: gated behind useAbilities, which is off)

  // --- Monarch piloting (carry the King's damage aura to the front) --------
  pilotKing: true,              // (evolved ON) drive one King behind the attack so its aura buffs the front
  pilotRetreatHpFraction: 0.5171171501089611, // pull that King home (then release) once its HP falls below this
  pilotTrailDepth: 0.5799570437419825, // King's hold point as a fraction from home toward the army centroid

  // --- Tactical depth (raise the ceiling vs reactive/competent play) -------
  focusFireWeakest: true,       // (evolved ON) attackers clear the weakest enemy animal in range, then push
  focusFireRange: 26.086897654919923, // how close that weak enemy must be to the army centroid to be focused
  defenseResponseRatio: 0.4477148059362968, // peel ~45% of the army home to intercept a base threat
  defenseTriggerRange: 25.168284994699356, // an enemy unit within this of our objectives counts as a threat
});

// The commander's coarse phase. Massing concentrates force at the staging point;
// attacking commits it onto one objective; retreating pulls survivors back to
// re-mass after a failed push.
const PHASE = Object.freeze({ MASSING: 'massing', ATTACKING: 'attacking', RETREATING: 'retreating' });

/** Linear interpolate between two positions by fraction t (0 = a, 1 = b). */
function lerpPosition(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

// A piloted monarch is "home" once within this XZ distance of its objectives'
// centroid — at which point the commander releases control and it reverts to a
// stationary, auto-defending objective.
const PILOT_ARRIVE_DISTANCE = 6;
const PILOT_ARRIVE_DISTANCE_SQ = PILOT_ARRIVE_DISTANCE * PILOT_ARRIVE_DISTANCE;
// Within this distance of its goal the drive vector is scaled down, so the
// persistent pilot heading does not overshoot between throttled updates.
const PILOT_SLOWDOWN_DISTANCE = 10;

/**
 * A `pilotMove` command that steers `unit` toward `goal`. The drive vector is a
 * unit heading (the engine clamps speed to it), eased toward zero near the goal so
 * the persistent vector does not overshoot between the commander's throttled
 * updates. A unit already on its goal is told to hold.
 */
function pilotDriveTo(unit, goal) {
  const dx = goal.x - unit.position.x;
  const dz = goal.z - unit.position.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.0001) return { type: 'pilotMove', payload: { x: 0, z: 0 } };
  const speedScale = Math.min(1, distance / PILOT_SLOWDOWN_DISTANCE);
  return {
    type: 'pilotMove',
    payload: { x: (dx / distance) * speedScale, z: (dz / distance) * speedScale },
  };
}

/** The unit in `units` nearest `position`; null on an empty list. Ties break on id. */
function nearestUnitTo(units, position, read) {
  let best = null;
  let bestDistance = Infinity;
  for (const unit of units) {
    const distance = read.distanceSquared(position, unit.position);
    if (distance < bestDistance || (distance === bestDistance && (best === null || unit.id < best.id))) {
      bestDistance = distance;
      best = unit;
    }
  }
  return best;
}

/** The lowest-HP unit in `units` within `range` of `position`; null if none. Ties break on id. */
function weakestWithin(units, position, range, read) {
  const rangeSquared = range * range;
  let best = null;
  for (const unit of units) {
    if (read.distanceSquared(position, unit.position) > rangeSquared) continue;
    if (best === null || unit.hp < best.hp || (unit.hp === best.hp && unit.id < best.id)) best = unit;
  }
  return best;
}

/**
 * Decide which abilities to cast this tick (a pure function of the observation).
 * Eligibility — animal type and cooldown — is enforced by the engine, so this
 * issues each ability over the whole mobile army and lets the sim keep only the
 * Chickens/Frogs/Cats (and, when opted in, Bees) that can actually act. Abilities
 * are spent only when an enemy animal is within `abilityEngageRange` of the army,
 * so their short cooldowns are available for the moment contact is joined.
 *
 * @returns {NetCommand[]}
 */
function decideAbilities(params, role, read, phase) {
  if (!params.useAbilities) return [];

  const army = read.ownMobileUnits(role);
  if (army.length === 0) return [];

  const armyCentroid = read.centroid(army);
  const target = read.nearestEnemyAnimal(role, armyCentroid);
  if (!target) return [];
  if (read.distanceSquared(armyCentroid, target.position) > params.abilityEngageRange * params.abilityEngageRange) {
    return [];
  }

  const unitIds = army.map((unit) => unit.id);
  const aimPoint = { ...target.position };
  const commands = [
    { type: 'throwEggs', payload: { unitIds, target: aimPoint } },  // Chickens
    { type: 'fireTongues', payload: { unitIds, cursor: aimPoint } }, // Frogs
    { type: 'hiss', payload: { unitIds } },                          // Cats (radial knockback)
  ];

  // The Bee dive is sacrificial — a coin flip that kills both the bee and its
  // target — so it is only ever spent while actually pressing an attack, and only
  // when the optimizer has opted in.
  if (params.useSacrificialSwarm && phase === PHASE.ATTACKING) {
    commands.push({ type: 'swarm', payload: { unitIds } });
  }

  return commands;
}

/**
 * A monarch pilot: while attacking, drives ONE of this side's Kings just behind
 * the army so the King's damage aura buffs the front line, then retreats it home
 * and releases control when its HP gets low or the attack ends.
 *
 * Holds the id of the King it is currently driving in its closure so it commits to
 * one monarch (rather than churning `setPilot` as the army shifts) and issues the
 * one-shot setPilot / releaseControl commands only on the engage and disengage
 * transitions. That latch is derived purely from deterministic observations and a
 * fresh pilot is built per match, so it never leaks across games.
 *
 * @param {typeof COMMANDER_DEFAULTS} params
 */
function makeMonarchPilot(params) {
  let pilotedKingId = null;

  return {
    decide(role, read, phase) {
      if (!params.pilotKing) return [];

      const kings = read.ownKings(role);
      // Drop the latch if the King we were driving died (the engine releases a
      // dead pilot's control on its own).
      let king = pilotedKingId ? kings.find((candidate) => candidate.id === pilotedKingId) : null;
      if (pilotedKingId && !king) pilotedKingId = null;

      const army = read.ownMobileUnits(role);
      const home = read.ownObjectivesCentroid(role);
      const attacking = phase === PHASE.ATTACKING && army.length > 0;
      const commands = [];

      // Engage: when an attack is on and no King is yet committed, pick the one
      // nearest the army (whose aura reaches the front soonest) — but only if it is
      // healthy enough to risk forward.
      if (attacking && !king) {
        const candidate = nearestUnitTo(kings, read.centroid(army), read);
        if (!candidate) return [];
        if (candidate.hp / candidate.maxHp < params.pilotRetreatHpFraction) return [];
        commands.push({ type: 'setPilot', payload: { unitId: candidate.id } });
        pilotedKingId = candidate.id;
        king = candidate;
      }

      if (!king) return commands;

      const healthy = king.hp / king.maxHp >= params.pilotRetreatHpFraction;
      if (attacking && healthy) {
        // Hold behind the army so the aura overlaps the front without making the
        // King the spearhead.
        const goal = lerpPosition(home, read.centroid(army), params.pilotTrailDepth);
        commands.push(pilotDriveTo(king, goal));
      } else if (read.distanceSquared(king.position, home) < PILOT_ARRIVE_DISTANCE_SQ) {
        // Back home: release so the King reverts to a stationary, auto-defending
        // objective.
        commands.push({ type: 'releaseControl', payload: {} });
        pilotedKingId = null;
      } else {
        commands.push(pilotDriveTo(king, home));
      }

      return commands;
    },
  };
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
  const pilot = makeMonarchPilot(params);

  // The macro layer's army-orchestration commands for one re-plan tick. Mutates the
  // closure's `phase`/`peakAttackForce` as it advances the mass→attack→retreat state
  // machine. Returns no commands when there is nothing to command (no army or the
  // enemy has no objectives left).
  function decideMacro(role, read) {
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

    // --- Phase transitions ---------------------------------------------------
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

    // --- Phase actions -------------------------------------------------------
    if (phase === PHASE.ATTACKING) {
      // (1) Reactive home defense: if an enemy force is pressuring our objectives,
      // peel the units nearest home back to intercept it instead of racing bases.
      let defenderIds = [];
      if (params.defenseResponseRatio > 0) {
        const threatRangeSquared = params.defenseTriggerRange * params.defenseTriggerRange;
        const threats = read
          .enemyMobileUnits(role)
          .filter((enemy) => read.distanceSquared(enemy.position, home) <= threatRangeSquared);
        if (threats.length > 0) {
          const defenderCount = Math.min(
            army.length,
            Math.max(1, Math.round(army.length * params.defenseResponseRatio)),
          );
          const defenders = army
            .slice()
            .sort((a, b) => read.distanceSquared(a.position, home) - read.distanceSquared(b.position, home))
            .slice(0, defenderCount);
          defenderIds = defenders.map((unit) => unit.id);
          const threatTarget = nearestUnitTo(threats, home, read);
          commands.push({ type: 'setBehavior', payload: { unitIds: defenderIds, behavior: { stance: 'aggressive' } } });
          commands.push({ type: 'attackTarget', payload: { unitIds: defenderIds, targetId: threatTarget.id } });
        }
      }

      // The attacking force is whatever is not pinned defending home.
      const defenderSet = new Set(defenderIds);
      const attackers = army.filter((unit) => !defenderSet.has(unit.id));

      if (attackers.length > 0) {
        const attackerCentroid = read.centroid(attackers);
        const objective = chooseObjective(objectives, attackerCentroid, params.targetPriority, read);

        // (2) Focus-fire: prefer clearing the weakest enemy animal near the attackers
        // (snipe a low-HP unit or exposed Queen/King) before sieging the objective.
        let targetId = objective.id;
        let aimPosition = objective.position;
        if (params.focusFireWeakest) {
          const weak = weakestWithin(read.enemyAnimals(role), attackerCentroid, params.focusFireRange, read);
          if (weak) {
            targetId = weak.id;
            aimPosition = weak.position;
          }
        }

        const committedCount = Math.max(1, Math.round(attackers.length * params.aggression));
        const committed = attackers
          .slice()
          .sort(
            (a, b) =>
              read.distanceSquared(a.position, aimPosition) -
              read.distanceSquared(b.position, aimPosition),
          )
          .slice(0, committedCount);
        const committedIds = committed.map((unit) => unit.id);
        const committedSet = new Set(committedIds);
        const reserveIds = attackers.filter((unit) => !committedSet.has(unit.id)).map((unit) => unit.id);

        commands.push({ type: 'setBehavior', payload: { unitIds: committedIds, behavior: { stance: params.attackerStance } } });
        commands.push({ type: 'attackTarget', payload: { unitIds: committedIds, targetId } });
        if (reserveIds.length > 0) {
          commands.push({ type: 'setBehavior', payload: { unitIds: reserveIds, behavior: { stance: params.reserveStance } } });
          commands.push({ type: 'moveUnits', payload: { unitIds: reserveIds, target: { ...stagingPoint } } });
        }
      }
    } else {
      // Massing or retreating: gather the whole army at the staging point under
      // a defensive posture so it fights if attacked but does not over-extend.
      commands.push({ type: 'setBehavior', payload: { unitIds: armyIds, behavior: { stance: params.reserveStance } } });
      commands.push({ type: 'moveUnits', payload: { unitIds: armyIds, target: { ...stagingPoint } } });
    }

    return commands;
  }

  return {
    name: 'commander',
    decide: ({ role, tick, read }) => {
      const onMacroTick = tick % params.decisionIntervalTicks === 0;
      const onAbilityTick = tick % params.abilityIntervalTicks === 0;
      if (!onMacroTick && !onAbilityTick) return [];

      const commands = [];

      // Macro orchestration first so the phase it sets is the one the faster
      // ability/pilot layer reacts to this same tick.
      if (onMacroTick) commands.push(...decideMacro(role, read));

      // Abilities and monarch piloting run on their own faster cadence so the
      // commander can act inside the macro re-plan window (short ability cooldowns,
      // a King that must trail a moving front).
      if (onAbilityTick) {
        commands.push(...decideAbilities(params, role, read, phase));
        commands.push(...pilot.decide(role, read, phase));
      }

      return commands;
    },
  };
}
