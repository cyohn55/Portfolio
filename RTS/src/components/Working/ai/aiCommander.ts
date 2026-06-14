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
  useAbilities: boolean;
  abilityIntervalTicks: number;
  abilityEngageRange: number;
  useSacrificialSwarm: boolean;
  pilotKing: boolean;
  pilotRetreatHpFraction: number;
  pilotTrailDepth: number;
}

export const COMMANDER_DEFAULTS: Readonly<CommanderParams> = Object.freeze({
  decisionIntervalTicks: 148,
  minAttackForce: 16,
  aggression: 0.9213423751635212,
  targetPriority: 'nearest',
  stageDepth: 0.1,
  retreatForceRatio: 0.32416440044338585,
  rallyReinforcements: true,
  attackerStance: 'aggressive',
  reserveStance: 'defensive',
  useAbilities: true,
  abilityIntervalTicks: 15,
  abilityEngageRange: 15.117344208562205,
  useSacrificialSwarm: false,
  pilotKing: false,
  pilotRetreatHpFraction: 0.5538331261148441,
  pilotTrailDepth: 0.3964942713463351,
});

// Strategic worth of an objective when targetPriority is 'value': Queens (the unit
// factories) outrank Kings (a damage aura) outrank Bases (inert win pieces).
const OBJECTIVE_VALUE_BY_KIND: Record<string, number> = { Queen: 3, King: 2, Base: 1 };

// The coarse phase: massing concentrates force at the staging point, attacking
// commits it onto one objective, retreating pulls survivors back to re-mass.
type Phase = 'massing' | 'attacking' | 'retreating';

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

  /** Macro orchestration: advance the mass→attack→retreat machine and command the army. */
  private decideMacro(role: string, observation: Observation): NetCommand[] {
    const params = this.params;
    const army = observation.ownMobileUnits(role);
    const objectives = observation.enemyObjectives(role);
    if (objectives.length === 0 || army.length === 0) return [];

    const home = observation.ownObjectivesCentroid(role);
    const stagingPoint = lerpPosition(home, centroid(objectives), params.stageDepth);
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

    // Phase transitions.
    if (this.phase === 'massing' && army.length >= params.minAttackForce) {
      this.phase = 'attacking';
      this.peakAttackForce = army.length;
    } else if (this.phase === 'attacking') {
      this.peakAttackForce = Math.max(this.peakAttackForce, army.length);
      if (army.length < this.peakAttackForce * params.retreatForceRatio) this.phase = 'retreating';
    } else if (this.phase === 'retreating' && army.length >= params.minAttackForce) {
      this.phase = 'attacking';
      this.peakAttackForce = army.length;
    }

    const armyIds = army.map((unit) => unit.id);

    if (this.phase === 'attacking') {
      const objective = chooseObjective(objectives, centroid(army), params.targetPriority);
      if (!objective) return commands;
      const committedCount = Math.max(1, Math.round(army.length * params.aggression));
      const committed = army
        .slice()
        .sort((a, b) => distanceSquared(a.position, objective.position) - distanceSquared(b.position, objective.position))
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
      // Massing or retreating: gather the army at the staging point defensively.
      commands.push({ type: 'setBehavior', payload: { unitIds: armyIds, behavior: { stance: params.reserveStance } } });
      commands.push({ type: 'moveUnits', payload: { unitIds: armyIds, target: { ...stagingPoint } } });
    }
    return commands;
  }

  /** Cast abilities over the whole army once an enemy is close; the sim self-filters. */
  private decideAbilities(role: string, observation: Observation): NetCommand[] {
    const params = this.params;
    if (!params.useAbilities) return [];

    const army = observation.ownMobileUnits(role);
    if (army.length === 0) return [];

    const armyCentroid = centroid(army);
    const target = observation.nearestEnemyAnimal(role, armyCentroid);
    if (!target) return [];
    if (distanceSquared(armyCentroid, target.position) > params.abilityEngageRange * params.abilityEngageRange) return [];

    const unitIds = army.map((unit) => unit.id);
    const aimPoint = { ...target.position };
    const commands: NetCommand[] = [
      { type: 'throwEggs', payload: { unitIds, target: aimPoint } },
      { type: 'fireTongues', payload: { unitIds, cursor: aimPoint } },
      { type: 'hiss', payload: { unitIds } },
    ];
    if (params.useSacrificialSwarm && this.phase === 'attacking') {
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
