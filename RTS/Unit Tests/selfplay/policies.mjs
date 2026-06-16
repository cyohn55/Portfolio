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

// Animals that fly — an Owl cannot pluck these out of the air, so they are excluded
// as abduction targets (mirrors the engine's pickup eligibility check).
const AIR_ANIMALS = new Set(['Bee', 'Owl']);

// A Turtle braces in its shell only as a last stand: below this HP fraction AND
// locally outnumbered. Shelling grants no damage reduction in the current sim, so a
// healthy turtle is always left free to fight rather than pinned in place.
const TURTLE_LAST_STAND_HP_FRACTION = 0.35;

/**
 * Default knobs for the macro commander (champ-robust-v2). OUTPUT of a robust run
 * (train.mjs: pop 24, 14 generations, 28 workers, 9000-tick matches, bounded win-rate
 * scorer aggregated WORST-CASE over the 9-opponent league incl. the prior champion).
 * Adopted because it beats the prior default (champ-robust-v1) on the DISJOINT
 * held-out gauntlet's worst case (+0.205 vs −0.005; improvement +0.210), beats v1
 * head-to-head, and has NO losing matchup across all 11 opponents — robust against
 * varied, competent play (the proxy for "strong vs humans").
 *
 * Strategy: aggressive forward-staging (stageDepth 0.9, aggression ~0.98,
 * minAttackForce 11, target the WEAKEST objective), commit the King's aura fully into
 * the army (pilotTrailDepth 1.0, retreat it only near death), defend home hard
 * (defenseResponseRatio ~0.43, wide trigger). ABILITIES are no longer an on/off knob:
 * every animal special move is an always-on capability (full parity with the player),
 * cast when its tactical trigger fires (see decideAbilities). The optimizer can only
 * tune the cast cadence and the engage/outnumber thresholds, never disable an ability.
 * (Historical note: offensive eggs/tongues once evolved OFF as a trained knob —
 * weak *value* in the current balance, since a caster often does more by just
 * attacking. They now fire by tactical rule regardless, for parity; rebalancing the
 * abilities themselves is the lever to make them net-positive.) Re-run train.mjs to
 * evolve a fresh set. Units: ticks at 60/s, counts, fractions.
 */
export const COMMANDER_DEFAULTS = Object.freeze({
  decisionIntervalTicks: 150,   // slow re-plan cadence (~2.5s)
  minAttackForce: 11,           // commit at a moderate mass
  aggression: 0.9844837637519124, // send nearly the whole army on the attack
  targetPriority: 'weakest',    // 'nearest' | 'value' | 'weakest' — kill the weakest objective first
  stageDepth: 0.9,              // stage FAR forward, near the enemy (aggressive)
  retreatForceRatio: 0.2048337263255682, // retreat only after heavy losses
  rallyReinforcements: false,   // do not force-rally Queen spawns to the staging point
  attackerStance: 'aggressive', // committed units chase and engage
  reserveStance: 'defensive',   // home reserve holds a leash

  // --- Abilities (animal-specific special moves) ---------------------------
  // Every ability is now an ALWAYS-ON capability (full parity with the player) —
  // decideAbilities decides WHEN to cast each one tactically. Only the cast cadence
  // and the engage/outnumber thresholds are tuned (and even these can no longer turn
  // an ability off). See decideAbilities for each ability's trigger.
  abilityIntervalTicks: 33,     // cadence for ability casts
  abilityEngageRange: 15.38178817954167, // sensing radius for offense + the outnumber check
  hissOutnumberRatio: 2.210666061290999, // hiss when nearby enemies outnumber friendlies by ~2.2:1

  // --- Monarch piloting (carry the King's damage aura to the front) --------
  pilotKing: true,              // drive one King into the army so its aura buffs the front
  pilotRetreatHpFraction: 0.15869486635345748, // commit the King hard — pull back only when nearly dead
  pilotTrailDepth: 1,           // King rides at the army centroid (max aura coverage)

  // --- Tactical depth (raise the ceiling vs reactive/competent play) -------
  focusFireWeakest: false,      // (this optimum) attackers push the objective rather than snipe units
  focusFireRange: 17.21554254751271, // (inert while focusFireWeakest is false)
  defenseResponseRatio: 0.4276908636548028, // peel ~43% of the army home to intercept a base threat
  defenseTriggerRange: 37.63603393313922, // wide radius counting an enemy near our objectives as a threat
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
 * Eligibility — animal type, owner, cooldown, alive — is enforced by the engine, so
 * this issues each ability over the whole mobile army and the sim keeps only the
 * eligible casters. Every player ability is represented here (full parity); each is
 * an always-on capability gated by a tactical trigger, not a trained on/off knob:
 *
 *  OFFENSIVE — pile onto the focus target (weakest enemy near the army, else nearest):
 *   - Chicken eggs + Frog tongues: cast while the focus target is in engage range.
 *   - Owl abduction: snatch the weakest GRABBABLE (non-air) enemy near the army, lift
 *     it out of the fight and drop it for fall damage — the strongest single-target
 *     removal in the kit.
 *   - Bee swarm: sacrificial dive while pressing an attack with a target in range.
 *  DEFENSIVE — only when the army is locally OUTNUMBERED (a shove/brace while winning
 *  would just scatter the enemy we are killing):
 *   - Cat hiss: radial knockback to peel attackers off.
 *   - Turtle shell: a near-dead, outnumbered turtle braces in place (resisting
 *     knockback) instead of being chased down. Shelling grants no damage reduction in
 *     the current sim, so it is reserved for a doomed straggler and never pulls a
 *     healthy turtle out of an attack.
 *
 * @returns {NetCommand[]}
 */
function decideAbilities(params, role, read, phase) {
  const army = read.ownMobileUnits(role);
  if (army.length === 0) return [];

  const unitIds = army.map((unit) => unit.id);
  const armyCentroid = read.centroid(army);
  const engageRangeSquared = params.abilityEngageRange * params.abilityEngageRange;
  const enemyAnimals = read.enemyAnimals(role);
  const commands = [];

  // The unit the army is concentrating on: the weakest enemy near the army, else the
  // nearest. Offensive abilities aim here so casters pile onto what we're killing.
  const focus =
    weakestWithin(enemyAnimals, armyCentroid, params.focusFireRange, read) ??
    read.nearestEnemyAnimal(role, armyCentroid);
  const focusInRange =
    focus && read.distanceSquared(armyCentroid, focus.position) <= engageRangeSquared;

  // OFFENSIVE — Chicken eggs + Frog tongues, aimed at the focus target.
  if (focusInRange) {
    const aimPoint = { x: focus.position.x, y: focus.position.y, z: focus.position.z };
    commands.push({ type: 'throwEggs', payload: { unitIds, target: aimPoint } });
    commands.push({ type: 'fireTongues', payload: { unitIds, cursor: aimPoint } });
  }

  // OFFENSIVE — Owl abduction. Target the weakest grabbable (non-air) enemy near the
  // army; the engine sends each idle Owl to snatch the closest unit of that type+owner.
  const abductTarget = weakestWithin(
    enemyAnimals.filter((enemy) => !AIR_ANIMALS.has(enemy.animal)),
    armyCentroid,
    params.abilityEngageRange,
    read,
  );
  if (abductTarget) {
    commands.push({
      type: 'pickup',
      payload: { unitIds, targetAnimal: abductTarget.animal, targetOwnerId: abductTarget.ownerId },
    });
  }

  // Local force balance near the army, shared by the defensive triggers below.
  let enemiesNear = 0;
  for (const enemy of enemyAnimals) {
    if (read.distanceSquared(enemy.position, armyCentroid) <= engageRangeSquared) enemiesNear += 1;
  }
  let friendsNear = 0;
  for (const unit of army) {
    if (read.distanceSquared(unit.position, armyCentroid) <= engageRangeSquared) friendsNear += 1;
  }
  const locallyOutnumbered =
    enemiesNear > 0 && enemiesNear >= friendsNear * params.hissOutnumberRatio;

  // DEFENSIVE — Cat hiss: peel attackers off only when locally outnumbered.
  if (locallyOutnumbered) {
    commands.push({ type: 'hiss', payload: { unitIds } });
  }

  // DEFENSIVE — Turtle shell last stand. Toggle only the turtles whose current shell
  // state differs from the desired one, so the toggle never oscillates each tick.
  const shellToggleIds = [];
  for (const unit of army) {
    if (unit.animal !== 'Turtle') continue;
    const doomed =
      locallyOutnumbered && unit.hp / unit.maxHp < TURTLE_LAST_STAND_HP_FRACTION;
    const wantShelled = doomed && phase !== PHASE.ATTACKING;
    if (Boolean(unit.isShelled) !== wantShelled) shellToggleIds.push(unit.id);
  }
  if (shellToggleIds.length > 0) {
    commands.push({ type: 'toggleTurtleShell', payload: { unitIds: shellToggleIds } });
  }

  // OFFENSIVE — Bee swarm: sacrificial dive while pressing an attack with a target near.
  if (phase === PHASE.ATTACKING && focusInRange) {
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
