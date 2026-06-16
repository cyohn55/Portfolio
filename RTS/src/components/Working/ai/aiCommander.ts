// In-game AI commander: the trained macro+tactical strategy, ported to drive the
// single-player AI opponent so it actually maneuvers instead of fighting purely
// emergently.
//
// This is the TypeScript twin of the self-play harness policy
// (`Unit Tests/selfplay/policies.mjs::makeCommanderPolicy`). The harness is where
// the knobs are TRAINED — it bundles the same `state.ts` sim for Node and evolves
// COMMANDER_DEFAULTS against an opponent pool. This file is what SHIPS: it issues
// the same commands through the same bus (`applyNetCommand` → the case dispatch in
// state.ts) a human or a lockstep peer uses. Keep the two in sync: when the harness
// re-trains, paste the new COMMANDER_DEFAULTS and mirror any decide() change here.
//
// Determinism / multiplayer: every action goes through `applyNetCommand`, so it is
// already the deterministic input path. It is still driven ONLY in single-player
// (`netMode === 'single'`): a 1v1 lockstep match is human-vs-human with no AI, and
// running an un-broadcast commander on one peer would desync. `runAiCommanders`
// enforces that gate.

import type { Unit, Position3D, UnitStance } from '../../../game/types';
import type { NetCommand } from '../net/netMessages';
import { useGameStore, applyNetCommand } from '../../../game/state';

// ---------------------------------------------------------------------------
// Trained knobs (output of train.mjs). Mirror of the harness COMMANDER_DEFAULTS.
// ---------------------------------------------------------------------------

interface CommanderParams {
  decisionIntervalTicks: number;
  minAttackForce: number;
  aggression: number;
  targetPriority: 'nearest' | 'value' | 'weakest';
  stageDepth: number;
  retreatForceRatio: number;
  rallyReinforcements: boolean;
  attackerStance: UnitStance;
  reserveStance: UnitStance;
  abilityIntervalTicks: number;
  abilityEngageRange: number;
  hissOutnumberRatio: number;
  pilotKing: boolean;
  pilotRetreatHpFraction: number;
  pilotTrailDepth: number;
  focusFireWeakest: boolean;
  focusFireRange: number;
  defenseResponseRatio: number;
  defenseTriggerRange: number;
  // --- Turtle-wall tactic + dynamic state machine -------------------------
  holdForce: number;            // army size to advance from massing to a forward chokepoint hold
  chokepointDepth: number;      // fraction home->enemy for the contested hold line
  wallDepth: number;            // fraction home->enemy for the defensive wall screening our bases
  wallSpacing: number;          // world-unit gap between Turtles along a wall line
  defendOverwhelmRatio: number; // fall back to a full base defense when near-home enemies >= army * this
}

// Robust trained defaults (champ-robust-v2; mirror of policies.mjs COMMANDER_DEFAULTS).
// Output of a pop24/gen14 worst-case win-rate run over the 9-opponent league incl. the
// prior champion; adopted because it beats champ-robust-v1 on a held-out gauntlet
// (+0.210 worst-case) and head-to-head, with NO losing matchup across 11 opponents.
// Aggressive forward-staging, full King-aura commit, and hard home defense. ABILITIES
// are no longer a trained on/off knob: every animal special move (eggs, tongues, Owl
// abduction, Bee swarm, Cat hiss, Turtle shell) is an always-on capability cast by a
// tactical rule (see decideAbilities) for full parity with the player — the optimizer
// only tunes the cast cadence + engage/outnumber thresholds. Keep in sync with policies.mjs.
export const COMMANDER_DEFAULTS: Readonly<CommanderParams> = Object.freeze({
  decisionIntervalTicks: 150,
  minAttackForce: 11,
  aggression: 0.9844837637519124,
  targetPriority: 'weakest',
  stageDepth: 0.9,
  retreatForceRatio: 0.2048337263255682,
  rallyReinforcements: false,
  attackerStance: 'aggressive',
  reserveStance: 'defensive',
  abilityIntervalTicks: 33,
  abilityEngageRange: 15.38178817954167,
  hissOutnumberRatio: 2.210666061290999,
  pilotKing: true,
  pilotRetreatHpFraction: 0.15869486635345748,
  pilotTrailDepth: 1,
  focusFireWeakest: false,
  focusFireRange: 17.21554254751271,
  defenseResponseRatio: 0.4276908636548028,
  defenseTriggerRange: 37.63603393313922,
  // Hand-tuned defaults for the turtle-wall tactic (not yet evolved). holdForce < the
  // attack force so the army contests the midline chokepoint while it builds; the wall
  // screens our bases at ~22% out from home, the hold line sits on the ~55% midline.
  holdForce: 6,
  chokepointDepth: 0.55,
  wallDepth: 0.22,
  wallSpacing: 3,
  defendOverwhelmRatio: 0.9,
});

// Strategic worth of an objective when targetPriority is 'value': Queens (the unit
// factories) outrank Kings (a damage aura) outrank Bases (inert win pieces).
const OBJECTIVE_VALUE_BY_KIND: Record<string, number> = { Queen: 3, King: 2, Base: 1 };

// Animals that fly — an Owl cannot pluck these out of the air, so they are excluded
// as abduction targets (mirrors the engine's pickup eligibility check).
const AIR_ANIMALS: ReadonlySet<string> = new Set(['Bee', 'Owl']);

// A Turtle braces in its shell when hurt below this HP fraction AND locally
// outnumbered — trading its offense/mobility for heavy damage mitigation
// (SHELL_DAMAGE_TAKEN_FRACTION in state.ts) to tank for the army, then unshelling once
// the pressure lifts. A healthy turtle is left free to fight.
const TURTLE_SHELL_HP_FRACTION = 0.5;

// The coarse phase. massing concentrates force at the staging point; holding contests
// a forward chokepoint with a Turtle wall for map control once a partial force exists;
// attacking commits the army onto one objective; retreating pulls survivors back to
// re-mass; defending is a full fallback (preempts the others) that screens our own
// bases with a Turtle wall when the enemy presses them in force.
type Phase = 'massing' | 'holding' | 'attacking' | 'retreating' | 'defending';

// A heading in the XZ plane (y is ignored — the wall is laid out on the ground).
interface Axis {
  x: number;
  z: number;
}

// A Turtle within this XZ distance of its assigned wall slot is "in position" and is
// braced (shelled) to hold the line; until then it stays mobile and walks to the slot,
// since a shelled Turtle is pinned in place (see toggleTurtleShell in state.ts).
const WALL_SLOT_ARRIVAL_DISTANCE_SQ = 3 * 3;

// While holding a chokepoint, the non-Turtle support army forms up at this fraction of
// the way from home to the wall — close enough to back the wall, behind its front.
const WALL_SUPPORT_DEPTH = 0.85;

// A piloted King is "home" once within this XZ distance of its objectives'
// centroid, at which point control is released and it reverts to a stationary,
// auto-defending objective. Within the slowdown distance the drive vector is eased
// so the persistent pilot heading does not overshoot between throttled updates.
const PILOT_ARRIVE_DISTANCE_SQ = 6 * 6;
const PILOT_SLOWDOWN_DISTANCE = 10;

// Kinds that, while alive, keep a side in the game — the strategic objectives.
const OBJECTIVE_KINDS: ReadonlySet<string> = new Set(['Base', 'King', 'Queen']);

// ---------------------------------------------------------------------------
// Geometry + observation helpers (read-only views over the live unit list).
// ---------------------------------------------------------------------------

function distanceSquared(a: Position3D, b: Position3D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function centroid(units: readonly Unit[]): Position3D {
  if (units.length === 0) return { x: 0, y: 0, z: 0 };
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const unit of units) {
    sx += unit.position.x;
    sy += unit.position.y;
    sz += unit.position.z;
  }
  return { x: sx / units.length, y: sy / units.length, z: sz / units.length };
}

function lerpPosition(a: Position3D, b: Position3D, t: number): Position3D {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/** Unit XZ heading from `from` to `to`; a stable default when the two coincide. */
function facingAxis(from: Position3D, to: Position3D): Axis {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) return { x: 0, z: 1 };
  return { x: dx / length, z: dz / length };
}

/**
 * Assign each Turtle a slot on a line wall centered at `center` and laid out
 * perpendicular to `facing`, evenly spaced by `spacing` and centered on the line.
 * Turtles are ordered by id so the assignment is deterministic — identical across
 * peers and stable across re-plans, so a Turtle keeps the same slot between ticks.
 */
function planTurtleWall(
  turtles: readonly Unit[],
  center: Position3D,
  facing: Axis,
  spacing: number,
): Map<string, Position3D> {
  const ordered = turtles.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Perpendicular to the facing heading in the XZ plane: the line the wall runs along.
  const perpendicularX = -facing.z;
  const perpendicularZ = facing.x;
  const lastIndex = ordered.length - 1;
  const slots = new Map<string, Position3D>();
  ordered.forEach((turtle, index) => {
    const offset = (index - lastIndex / 2) * spacing;
    slots.set(turtle.id, {
      x: center.x + perpendicularX * offset,
      y: center.y,
      z: center.z + perpendicularZ * offset,
    });
  });
  return slots;
}

/** Read-only views a commander uses, all derived from one snapshot of the units. */
class Observation {
  private readonly living: Unit[];

  constructor(units: readonly Unit[]) {
    this.living = units.filter((unit) => unit.hp > 0);
  }

  ownMobileUnits(role: string): Unit[] {
    return this.living.filter((unit) => unit.ownerId === role && unit.kind === 'Unit');
  }

  ownQueens(role: string): Unit[] {
    return this.living.filter((unit) => unit.ownerId === role && unit.kind === 'Queen');
  }

  ownKings(role: string): Unit[] {
    return this.living.filter((unit) => unit.ownerId === role && unit.kind === 'King');
  }

  enemyObjectives(role: string): Unit[] {
    return this.living.filter((unit) => unit.ownerId !== role && OBJECTIVE_KINDS.has(unit.kind));
  }

  // The enemy's mobile army (spawned Units) — what the home-defense peel reacts to.
  enemyMobileUnits(role: string): Unit[] {
    return this.living.filter((unit) => unit.ownerId !== role && unit.kind === 'Unit');
  }

  // Every enemy animal (anything but the immovable Base) — focus-fire candidates.
  enemyAnimals(role: string): Unit[] {
    return this.living.filter((unit) => unit.ownerId !== role && unit.kind !== 'Base');
  }

  ownObjectivesCentroid(role: string): Position3D {
    return centroid(this.living.filter((unit) => unit.ownerId === role && OBJECTIVE_KINDS.has(unit.kind)));
  }

  /** Nearest enemy animal (any kind except the immovable Base) — the ability aim point. */
  nearestEnemyAnimal(role: string, from: Position3D): Unit | null {
    let nearest: Unit | null = null;
    let nearestDistance = Infinity;
    for (const unit of this.living) {
      if (unit.ownerId === role || unit.kind === 'Base') continue;
      const distance = distanceSquared(from, unit.position);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = unit;
      }
    }
    return nearest;
  }
}

/** The objective to attack under `priority`, measured from `from`; ties break on id. */
function chooseObjective(
  objectives: readonly Unit[],
  from: Position3D,
  priority: CommanderParams['targetPriority'],
): Unit | null {
  const scoreOf = (objective: Unit): number => {
    switch (priority) {
      case 'nearest':
        return -distanceSquared(from, objective.position);
      case 'weakest':
        return -objective.hp;
      case 'value':
      default:
        return OBJECTIVE_VALUE_BY_KIND[objective.kind] * 1e9 - distanceSquared(from, objective.position);
    }
  };
  let best: Unit | null = null;
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

/** The unit nearest `position`; null on an empty list. Ties break on id. */
function nearestUnitTo(units: readonly Unit[], position: Position3D): Unit | null {
  let best: Unit | null = null;
  let bestDistance = Infinity;
  for (const unit of units) {
    const distance = distanceSquared(position, unit.position);
    if (distance < bestDistance || (distance === bestDistance && (best === null || unit.id < best.id))) {
      bestDistance = distance;
      best = unit;
    }
  }
  return best;
}

/** The lowest-HP unit within `range` of `position`; null if none. Ties break on id. */
function weakestWithin(units: readonly Unit[], position: Position3D, range: number): Unit | null {
  const rangeSquared = range * range;
  let best: Unit | null = null;
  for (const unit of units) {
    if (distanceSquared(position, unit.position) > rangeSquared) continue;
    if (best === null || unit.hp < best.hp || (unit.hp === best.hp && unit.id < best.id)) best = unit;
  }
  return best;
}

/** A `pilotMove` command steering `unit` toward `goal`, eased to avoid overshoot. */
function pilotDriveTo(unit: Unit, goal: Position3D): NetCommand {
  const dx = goal.x - unit.position.x;
  const dz = goal.z - unit.position.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.0001) return { type: 'pilotMove', payload: { x: 0, z: 0 } };
  const speedScale = Math.min(1, distance / PILOT_SLOWDOWN_DISTANCE);
  return { type: 'pilotMove', payload: { x: (dx / distance) * speedScale, z: (dz / distance) * speedScale } };
}

// ---------------------------------------------------------------------------
// The commander: one stateful instance per AI owner, rebuilt each match.
// ---------------------------------------------------------------------------

class AiCommander {
  private readonly params: CommanderParams;
  private phase: Phase = 'massing';
  private peakAttackForce = 0;
  private pilotedKingId: string | null = null;
  // Current Turtle-wall assignment (turtle id -> its slot), rebuilt each macro tick
  // while holding/defending and read by the faster ability layer to brace each Turtle
  // once it reaches its slot. Empty whenever no wall is being held.
  private wallSlotById: Map<string, Position3D> = new Map();

  constructor(params: CommanderParams = COMMANDER_DEFAULTS) {
    this.params = params;
  }

  /** Commands for `role` at simulation tick `tick` (read against `observation`). */
  decide(role: string, tick: number, observation: Observation): NetCommand[] {
    const params = this.params;
    const onMacroTick = tick % params.decisionIntervalTicks === 0;
    const onAbilityTick = tick % params.abilityIntervalTicks === 0;
    if (!onMacroTick && !onAbilityTick) return [];

    const commands: NetCommand[] = [];
    if (onMacroTick) commands.push(...this.decideMacro(role, observation));
    if (onAbilityTick) {
      commands.push(...this.decideAbilities(role, observation));
      commands.push(...this.decidePilot(role, observation));
    }
    return commands;
  }

  /**
   * Macro orchestration: advance the state machine and issue the commands for the
   * resulting phase. Rebuilds the Turtle-wall assignment each call (cleared first, so
   * leaving a wall phase frees the Turtles), which the faster ability layer then reads
   * to brace each Turtle once it has reached its slot.
   */
  private decideMacro(role: string, observation: Observation): NetCommand[] {
    const params = this.params;
    const army = observation.ownMobileUnits(role);
    const objectives = observation.enemyObjectives(role);
    this.wallSlotById.clear();
    if (objectives.length === 0 || army.length === 0) return [];

    const home = observation.ownObjectivesCentroid(role);
    const enemyCentroid = centroid(objectives);
    const stagingPoint = lerpPosition(home, enemyCentroid, params.stageDepth);
    // The wall faces from home toward the enemy mass; Turtles line up perpendicular.
    const facing = facingAxis(home, enemyCentroid);
    const commands: NetCommand[] = [];

    // Keep the unit factories feeding the front rather than the base.
    if (params.rallyReinforcements) {
      for (const queen of observation.ownQueens(role)) {
        commands.push({
          type: 'setQueenRally',
          payload: { queenId: queen.id, target: { mode: 'point', position: { ...stagingPoint } } },
        });
      }
    }

    // Home-threat assessment: the enemy mobile force pressing our objectives. A force
    // that rivals our whole army at home triggers the full `defending` fallback; a
    // smaller incursion is handled by the lighter peel inside the attacking phase.
    const threatRangeSquared = params.defenseTriggerRange * params.defenseTriggerRange;
    const homeThreats = observation
      .enemyMobileUnits(role)
      .filter((enemy) => distanceSquared(enemy.position, home) <= threatRangeSquared);
    const overwhelmed =
      homeThreats.length > 0 && homeThreats.length >= Math.max(1, army.length * params.defendOverwhelmRatio);

    this.advancePhase(army.length, overwhelmed);

    switch (this.phase) {
      case 'defending':
        commands.push(...this.commandDefense(army, home, enemyCentroid, facing, homeThreats));
        break;
      case 'holding':
        commands.push(...this.commandHold(army, home, enemyCentroid, facing));
        break;
      case 'attacking':
        commands.push(...this.commandAttack(role, observation, army, objectives, home, stagingPoint, homeThreats));
        break;
      default: {
        // Massing or retreating: gather the army at the staging point defensively.
        const armyIds = army.map((unit) => unit.id);
        commands.push({ type: 'setBehavior', payload: { unitIds: armyIds, behavior: { stance: params.reserveStance } } });
        commands.push({ type: 'moveUnits', payload: { unitIds: armyIds, target: { ...stagingPoint } } });
      }
    }
    return commands;
  }

  /**
   * Advance the massing -> holding -> attacking -> retreating cycle, with a `defending`
   * override that preempts everything while we are overwhelmed at home. The army grows
   * through massing into a forward chokepoint hold (`holding`), commits to an assault
   * at full strength (`attacking`), and retreats to re-mass when a push is worn down.
   * Mutates `phase`/`peakAttackForce`.
   */
  private advancePhase(armySize: number, overwhelmed: boolean): void {
    const params = this.params;
    if (overwhelmed) {
      this.phase = 'defending';
      return;
    }
    switch (this.phase) {
      case 'massing':
        if (armySize >= params.minAttackForce) this.commitAttack(armySize);
        else if (armySize >= params.holdForce) this.phase = 'holding';
        break;
      case 'holding':
        if (armySize >= params.minAttackForce) this.commitAttack(armySize);
        else if (armySize < params.holdForce) this.phase = 'massing';
        break;
      case 'attacking':
        this.peakAttackForce = Math.max(this.peakAttackForce, armySize);
        if (armySize < this.peakAttackForce * params.retreatForceRatio) this.phase = 'retreating';
        break;
      case 'retreating':
        if (armySize >= params.minAttackForce) this.commitAttack(armySize);
        else if (armySize >= params.holdForce) this.phase = 'holding';
        break;
      case 'defending':
        // Threat cleared — re-enter the offensive cycle at the level our force allows.
        if (armySize >= params.minAttackForce) this.commitAttack(armySize);
        else if (armySize >= params.holdForce) this.phase = 'holding';
        else this.phase = 'massing';
        break;
    }
  }

  /** Enter the attacking phase, seeding the peak-force watermark used to detect a rout. */
  private commitAttack(armySize: number): void {
    this.phase = 'attacking';
    this.peakAttackForce = armySize;
  }

  /**
   * HOLDING: contest a forward chokepoint between the two homes for map control —
   * Turtles brace into a shelled wall across the crossing while the rest of the army
   * forms up just behind it under a defensive posture.
   */
  private commandHold(army: Unit[], home: Position3D, enemyCentroid: Position3D, facing: Axis): NetCommand[] {
    const params = this.params;
    const chokepoint = lerpPosition(home, enemyCentroid, params.chokepointDepth);
    const turtles = army.filter((unit) => unit.animal === 'Turtle');
    const support = army.filter((unit) => unit.animal !== 'Turtle');
    const commands: NetCommand[] = [];

    if (turtles.length > 0) commands.push(...this.commandTurtleWall(turtles, chokepoint, facing));
    if (support.length > 0) {
      const supportPoint = lerpPosition(home, chokepoint, WALL_SUPPORT_DEPTH);
      const supportIds = support.map((unit) => unit.id);
      commands.push({ type: 'setBehavior', payload: { unitIds: supportIds, behavior: { stance: params.reserveStance } } });
      commands.push({ type: 'moveUnits', payload: { unitIds: supportIds, target: supportPoint } });
    }
    return commands;
  }

  /**
   * DEFENDING: the enemy is pressing our bases in force. Brace a Turtle wall just in
   * front of home to blunt the assault, and send the rest of the army at the nearest
   * attacker under a home-anchored defensive posture so it intercepts without chasing
   * off the map.
   */
  private commandDefense(
    army: Unit[],
    home: Position3D,
    enemyCentroid: Position3D,
    facing: Axis,
    threats: Unit[],
  ): NetCommand[] {
    const params = this.params;
    const wallCenter = lerpPosition(home, enemyCentroid, params.wallDepth);
    const turtles = army.filter((unit) => unit.animal === 'Turtle');
    const defenders = army.filter((unit) => unit.animal !== 'Turtle');
    const commands: NetCommand[] = [];

    if (turtles.length > 0) commands.push(...this.commandTurtleWall(turtles, wallCenter, facing));
    if (defenders.length > 0) {
      const defenderIds = defenders.map((unit) => unit.id);
      const threatTarget = nearestUnitTo(threats, home);
      // Defensive stance: the defenders engage the incursion but return to home ground
      // (the move order below re-homes their anchor near the bases) instead of chasing.
      commands.push({ type: 'setBehavior', payload: { unitIds: defenderIds, behavior: { stance: 'defensive' } } });
      if (threatTarget) commands.push({ type: 'attackTarget', payload: { unitIds: defenderIds, targetId: threatTarget.id } });
      else commands.push({ type: 'moveUnits', payload: { unitIds: defenderIds, target: wallCenter } });
    }
    return commands;
  }

  /**
   * Lay `turtles` out as a line wall centered on `center`, perpendicular to `facing`,
   * each anchored on its own slot and set to holdGround so it strikes whatever enters
   * range without leaving the line. Records each slot in `wallSlotById` so the ability
   * layer braces (shells) the Turtle once it arrives — a shelled Turtle is pinned, so
   * it must walk to the slot unshelled first.
   */
  private commandTurtleWall(turtles: Unit[], center: Position3D, facing: Axis): NetCommand[] {
    const slots = planTurtleWall(turtles, center, facing, this.params.wallSpacing);
    const commands: NetCommand[] = [];
    for (const turtle of turtles) {
      const slot = slots.get(turtle.id);
      if (!slot) continue;
      this.wallSlotById.set(turtle.id, slot);
      commands.push({ type: 'setBehavior', payload: { unitIds: [turtle.id], behavior: { stance: 'holdGround' } } });
      // Walk an un-braced Turtle onto its slot; a braced (shelled) one is already pinned.
      if (!turtle.isShelled && distanceSquared(turtle.position, slot) > WALL_SLOT_ARRIVAL_DISTANCE_SQ) {
        commands.push({ type: 'moveUnits', payload: { unitIds: [turtle.id], target: { ...slot } } });
      }
    }
    return commands;
  }

  /**
   * ATTACKING: commit the army onto a chosen objective. A fraction nearest home peels
   * to intercept any enemy pressuring our bases (a lighter response than the full
   * `defending` fallback); the remainder pushes the objective, optionally sniping the
   * weakest exposed enemy first, with a reserve held at the staging point.
   */
  private commandAttack(
    role: string,
    observation: Observation,
    army: Unit[],
    objectives: Unit[],
    home: Position3D,
    stagingPoint: Position3D,
    homeThreats: Unit[],
  ): NetCommand[] {
    const params = this.params;
    const commands: NetCommand[] = [];

    // (1) Reactive home defense: peel the units nearest home to intercept an incursion.
    let defenderIds: string[] = [];
    if (params.defenseResponseRatio > 0 && homeThreats.length > 0) {
      const defenderCount = Math.min(
        army.length,
        Math.max(1, Math.round(army.length * params.defenseResponseRatio)),
      );
      const defenders = army
        .slice()
        .sort((a, b) => distanceSquared(a.position, home) - distanceSquared(b.position, home))
        .slice(0, defenderCount);
      defenderIds = defenders.map((unit) => unit.id);
      const threatTarget = nearestUnitTo(homeThreats, home);
      if (threatTarget) {
        commands.push({ type: 'setBehavior', payload: { unitIds: defenderIds, behavior: { stance: 'aggressive' } } });
        commands.push({ type: 'attackTarget', payload: { unitIds: defenderIds, targetId: threatTarget.id } });
      }
    }

    // The attacking force is whatever is not pinned defending home.
    const defenderSet = new Set(defenderIds);
    const attackers = army.filter((unit) => !defenderSet.has(unit.id));
    if (attackers.length === 0) return commands;

    const attackerCentroid = centroid(attackers);
    const objective = chooseObjective(objectives, attackerCentroid, params.targetPriority);
    if (!objective) return commands;

    // (2) Focus-fire: prefer clearing the weakest enemy animal near the attackers
    // (snipe a low-HP unit or exposed Queen/King) before sieging the objective.
    let targetId = objective.id;
    let aimPosition = objective.position;
    if (params.focusFireWeakest) {
      const weak = weakestWithin(observation.enemyAnimals(role), attackerCentroid, params.focusFireRange);
      if (weak) {
        targetId = weak.id;
        aimPosition = weak.position;
      }
    }

    const committedCount = Math.max(1, Math.round(attackers.length * params.aggression));
    const committed = attackers
      .slice()
      .sort((a, b) => distanceSquared(a.position, aimPosition) - distanceSquared(b.position, aimPosition))
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
    return commands;
  }

  /**
   * Decide which abilities to cast (mirror of policies.mjs decideAbilities). Every
   * player ability is represented here for full parity; each is an always-on
   * capability gated by a tactical trigger, and the sim self-filters every cast to the
   * eligible casters (right animal, owner, off-cooldown, alive):
   *  OFFENSIVE — aimed at the focus target: Chicken eggs, Frog tongues, Owl abduction
   *    (lift the weakest grabbable enemy out of the fight and drop it for fall damage),
   *    and the sacrificial Bee swarm while attacking.
   *  DEFENSIVE — Cat hiss (radial knockback peel) only when locally OUTNUMBERED, and the
   *    Turtle shell. A Turtle assigned to a wall (the holding/defending macro phases)
   *    braces the moment it reaches its slot and stays braced to hold the line; any
   *    other Turtle braces only when hurt AND outnumbered, tanking for the army at the
   *    cost of its own offense/mobility, then unshells once it recovers or the pressure
   *    lifts. (Wall slots are assigned by decideMacro via `wallSlotById`.)
   */
  private decideAbilities(role: string, observation: Observation): NetCommand[] {
    const params = this.params;
    const army = observation.ownMobileUnits(role);
    if (army.length === 0) return [];

    const unitIds = army.map((unit) => unit.id);
    const armyCentroid = centroid(army);
    const engageRangeSquared = params.abilityEngageRange * params.abilityEngageRange;
    const enemyAnimals = observation.enemyAnimals(role);
    const commands: NetCommand[] = [];

    // The unit the army is concentrating on: the weakest enemy near the army, else the
    // nearest. Offensive abilities aim here so casters pile onto what we're killing.
    const focus =
      weakestWithin(enemyAnimals, armyCentroid, params.focusFireRange) ??
      observation.nearestEnemyAnimal(role, armyCentroid);
    const focusInRange =
      focus !== null && distanceSquared(armyCentroid, focus.position) <= engageRangeSquared;

    // OFFENSIVE — Chicken eggs + Frog tongues, aimed at the focus target.
    if (focus && focusInRange) {
      const aimPoint = { ...focus.position };
      commands.push({ type: 'throwEggs', payload: { unitIds, target: aimPoint } });
      commands.push({ type: 'fireTongues', payload: { unitIds, cursor: aimPoint } });
    }

    // OFFENSIVE — Owl abduction. Target the weakest grabbable (non-air) enemy near the
    // army; the engine sends each idle Owl to snatch the closest unit of that type+owner.
    const abductTarget = weakestWithin(
      enemyAnimals.filter((enemy) => !AIR_ANIMALS.has(enemy.animal)),
      armyCentroid,
      params.abilityEngageRange,
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
      if (distanceSquared(enemy.position, armyCentroid) <= engageRangeSquared) enemiesNear += 1;
    }
    let friendsNear = 0;
    for (const unit of army) {
      if (distanceSquared(unit.position, armyCentroid) <= engageRangeSquared) friendsNear += 1;
    }
    const locallyOutnumbered =
      enemiesNear > 0 && enemiesNear >= friendsNear * params.hissOutnumberRatio;

    // DEFENSIVE — Cat hiss: peel attackers off only when locally outnumbered.
    if (locallyOutnumbered) {
      commands.push({ type: 'hiss', payload: { unitIds } });
    }

    // DEFENSIVE — Turtle shell. A Turtle assigned to a wall (holding/defending) braces
    // as soon as it reaches its slot and stays braced to hold the line; every other
    // Turtle braces only when hurt AND locally outnumbered, unshelling once it recovers
    // or the pressure lifts. Toggle only the Turtles whose current shell state differs
    // from the desired one, so the toggle never oscillates each tick.
    const shellToggleIds: string[] = [];
    for (const unit of army) {
      if (unit.animal !== 'Turtle') continue;
      const wallSlot = this.wallSlotById.get(unit.id);
      const wantShelled = wallSlot
        ? distanceSquared(unit.position, wallSlot) <= WALL_SLOT_ARRIVAL_DISTANCE_SQ
        : locallyOutnumbered && unit.hp / unit.maxHp < TURTLE_SHELL_HP_FRACTION;
      if (Boolean(unit.isShelled) !== wantShelled) shellToggleIds.push(unit.id);
    }
    if (shellToggleIds.length > 0) {
      commands.push({ type: 'toggleTurtleShell', payload: { unitIds: shellToggleIds } });
    }

    // OFFENSIVE — Bee swarm: sacrificial dive while pressing an attack with a target near.
    if (this.phase === 'attacking' && focusInRange) {
      commands.push({ type: 'swarm', payload: { unitIds } });
    }
    return commands;
  }

  /** Drive one King behind the army so its aura buffs the front; retreat when hurt. */
  private decidePilot(role: string, observation: Observation): NetCommand[] {
    const params = this.params;
    if (!params.pilotKing) return [];

    const kings = observation.ownKings(role);
    let king = this.pilotedKingId ? kings.find((candidate) => candidate.id === this.pilotedKingId) ?? null : null;
    if (this.pilotedKingId && !king) this.pilotedKingId = null; // died mid-pilot

    const army = observation.ownMobileUnits(role);
    const home = observation.ownObjectivesCentroid(role);
    const attacking = this.phase === 'attacking' && army.length > 0;
    const commands: NetCommand[] = [];

    if (attacking && !king) {
      const candidate = nearestUnitTo(kings, centroid(army));
      if (!candidate) return [];
      if (candidate.hp / candidate.maxHp < params.pilotRetreatHpFraction) return [];
      commands.push({ type: 'setPilot', payload: { unitId: candidate.id } });
      this.pilotedKingId = candidate.id;
      king = candidate;
    }

    if (!king) return commands;

    const healthy = king.hp / king.maxHp >= params.pilotRetreatHpFraction;
    if (attacking && healthy) {
      const goal = lerpPosition(home, centroid(army), params.pilotTrailDepth);
      commands.push(pilotDriveTo(king, goal));
    } else if (distanceSquared(king.position, home) < PILOT_ARRIVE_DISTANCE_SQ) {
      commands.push({ type: 'releaseControl', payload: {} });
      this.pilotedKingId = null;
    } else {
      commands.push(pilotDriveTo(king, home));
    }
    return commands;
  }
}

// ---------------------------------------------------------------------------
// Per-match driver. One commander per AI owner, rebuilt when a new match starts.
// ---------------------------------------------------------------------------

let commandersByOwner: Map<string, AiCommander> = new Map();
let lastTickSeen = -1;

/** Forget all per-match commander state so the next tick rebuilds it cleanly. */
export function resetAiCommanders(): void {
  commandersByOwner = new Map();
  lastTickSeen = -1;
}

/**
 * Run every single-player AI owner's commander for the tick about to execute, and
 * apply its commands through the deterministic bus. Call once per fixed timestep,
 * immediately BEFORE `store.tick(...)`, so the orders take effect on that tick —
 * the same ordering the self-play harness uses.
 *
 * No-ops outside single-player (a lockstep match has no AI and would desync), and
 * while the match is over or not yet started.
 */
export function runAiCommanders(): void {
  const state = useGameStore.getState();
  if (state.netMode !== 'single' || !state.matchStarted || state.gameOver) return;

  const tick = state.tickCounter;
  // A new match resets the tick counter; drop stale commander state when it rewinds.
  if (tick < lastTickSeen) resetAiCommanders();
  lastTickSeen = tick;

  const observation = new Observation(state.units);
  for (const player of state.players) {
    if (!player.isAI) continue;
    let commander = commandersByOwner.get(player.id);
    if (!commander) {
      commander = new AiCommander();
      commandersByOwner.set(player.id, commander);
    }
    for (const command of commander.decide(player.id, tick, observation)) {
      applyNetCommand(player.id, command);
    }
  }
}
