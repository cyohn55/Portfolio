// Feature test: the Turtle-wall tactic + dynamic state machine.
//
// Validates the macro commander (Unit Tests/selfplay/policies.mjs), the TRAINED twin
// of the shipping in-game AI (src/components/Working/ai/aiCommander.ts). Both files
// implement the identical logic, so exercising the twin's public `decide` output (the
// real NetCommands it emits) covers the shipping behavior without a browser.
//
// The commander is driven exactly as the self-play harness drives it: a read-only
// observation over a unit list (the same helper shape as selfPlay.mjs::makeObservation)
// and `decide({ role, tick, read })`. Every expectation is DERIVED from the inputs and
// the published COMMANDER_DEFAULTS — no hard-coded outputs.
//
// Run: node "Unit Tests/turtle-wall-tactic.spec.mjs"

import { makeCommanderPolicy, COMMANDER_DEFAULTS } from './selfplay/policies.mjs';

// --- Tiny assertion harness (no test framework: this runs under plain node) -------

let passed = 0;
const failures = [];

function check(label, condition) {
  if (condition) {
    passed += 1;
  } else {
    failures.push(label);
  }
}

function approx(actual, expected, tolerance = 1e-6) {
  return Math.abs(actual - expected) <= tolerance;
}

// --- Observation builder (mirrors selfPlay.mjs::makeObservation over a live array) -

const OBJECTIVE_KINDS = new Set(['Base', 'King', 'Queen']);

function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function centroid(units) {
  if (units.length === 0) return { x: 0, y: 0, z: 0 };
  const sum = units.reduce(
    (acc, unit) => ({ x: acc.x + unit.position.x, y: acc.y + unit.position.y, z: acc.z + unit.position.z }),
    { x: 0, y: 0, z: 0 },
  );
  return { x: sum.x / units.length, y: sum.y / units.length, z: sum.z / units.length };
}

// `world.units` is mutated by some scenarios between decide() calls; the helpers read
// it live so the commander always sees the latest positions/shell state.
function makeObservation(world) {
  const living = () => world.units.filter((unit) => unit.hp > 0);
  return {
    distanceSquared,
    centroid,
    ownMobileUnits: (role) => living().filter((u) => u.ownerId === role && u.kind === 'Unit'),
    ownQueens: (role) => living().filter((u) => u.ownerId === role && u.kind === 'Queen'),
    ownKings: (role) => living().filter((u) => u.ownerId === role && u.kind === 'King'),
    enemyObjectives: (role) => living().filter((u) => u.ownerId !== role && OBJECTIVE_KINDS.has(u.kind)),
    enemyMobileUnits: (role) => living().filter((u) => u.ownerId !== role && u.kind === 'Unit'),
    enemyAnimals: (role) => living().filter((u) => u.ownerId !== role && u.kind !== 'Base'),
    ownObjectivesCentroid: (role) =>
      centroid(living().filter((u) => u.ownerId === role && OBJECTIVE_KINDS.has(u.kind))),
    nearestEnemyAnimal: (role, from) => {
      let best = null;
      let bestD = Infinity;
      for (const u of living()) {
        if (u.ownerId === role || u.kind === 'Base') continue;
        const d = distanceSquared(from, u.position);
        if (d < bestD) {
          bestD = d;
          best = u;
        }
      }
      return best;
    },
    nearestEnemyObjective: (role, from) => {
      let best = null;
      let bestD = Infinity;
      for (const u of living()) {
        if (u.ownerId === role || !OBJECTIVE_KINDS.has(u.kind)) continue;
        const d = distanceSquared(from, u.position);
        if (d < bestD) {
          bestD = d;
          best = u;
        }
      }
      return best;
    },
  };
}

// --- Scenario fixtures ------------------------------------------------------------

// Own home sits on the -Z side, the enemy mass on +Z, so the home->enemy heading is
// +Z and the wall (perpendicular) runs along the X axis — a clean axis to assert on.
const HOME_Z = -100;
const ENEMY_Z = 100;
const MACRO_TICK = COMMANDER_DEFAULTS.decisionIntervalTicks; // a tick that fires the macro layer

let nextId = 0;
function unit(ownerId, kind, animal, position, overrides = {}) {
  nextId += 1;
  return {
    id: `${ownerId}-${kind}-${animal}-${nextId}`,
    ownerId,
    kind,
    animal,
    position: { x: position.x, y: position.y ?? 0, z: position.z },
    hp: 100,
    maxHp: 100,
    isShelled: false,
    ...overrides,
  };
}

// A standard pair of opposing objective sets (Base + King + Queen on each side).
function objectives(ownerId, z) {
  return [
    unit(ownerId, 'Base', 'Bear', { x: 0, z }),
    unit(ownerId, 'King', 'Bear', { x: -10, z }),
    unit(ownerId, 'Queen', 'Bear', { x: 10, z }),
  ];
}

function commandsOfType(commands, type) {
  return commands.filter((c) => c.type === type);
}

// --- Scenario A: a partial force HOLDS a forward chokepoint with a Turtle wall -----

(() => {
  // holdForce <= army < minAttackForce → the commander should choose `holding`, not
  // attack. Include a clear majority of Turtles so the wall is the dominant action.
  const turtleCount = 4;
  const supportCount = Math.max(1, COMMANDER_DEFAULTS.holdForce - 1);
  const armySize = turtleCount + supportCount;
  check(
    'fixture: army is in the holding band [holdForce, minAttackForce)',
    armySize >= COMMANDER_DEFAULTS.holdForce && armySize < COMMANDER_DEFAULTS.minAttackForce,
  );

  const turtles = Array.from({ length: turtleCount }, (_, i) =>
    unit('p0', 'Unit', 'Turtle', { x: -20 + i * 2, z: HOME_Z + 5 }),
  );
  const support = Array.from({ length: supportCount }, (_, i) =>
    unit('p0', 'Unit', 'Bear', { x: 5 + i * 2, z: HOME_Z + 5 }),
  );
  const world = { units: [...objectives('p0', HOME_Z), ...objectives('p1', ENEMY_Z), ...turtles, ...support] };

  const policy = makeCommanderPolicy();
  const commands = policy.decide({ role: 'p0', tick: MACRO_TICK, read: makeObservation(world) });

  // Every Turtle is set to holdGround (attack in place, never leave the line).
  const holdGroundTurtleIds = new Set(
    commandsOfType(commands, 'setBehavior')
      .filter((c) => c.payload.behavior.stance === 'holdGround')
      .flatMap((c) => c.payload.unitIds),
  );
  check(
    'holding: all wall Turtles are set to holdGround',
    turtles.every((t) => holdGroundTurtleIds.has(t.id)),
  );

  // Each Turtle is given a move order to its own distinct slot (a wall, not a stack).
  const turtleMoves = commandsOfType(commands, 'moveUnits').filter(
    (c) => c.payload.unitIds.length === 1 && turtles.some((t) => t.id === c.payload.unitIds[0]),
  );
  check('holding: every Turtle is routed to a slot', turtleMoves.length === turtleCount);

  const slots = turtleMoves.map((c) => c.payload.target);
  // The wall is centered on the chokepoint = lerp(home, enemy, chokepointDepth).
  const chokeZ = HOME_Z + (ENEMY_Z - HOME_Z) * COMMANDER_DEFAULTS.chokepointDepth;
  check('holding: slots lie on the chokepoint line (z)', slots.every((s) => approx(s.z, chokeZ, 1e-3)));
  const meanX = slots.reduce((sum, s) => sum + s.x, 0) / slots.length;
  check('holding: the wall is centered on the chokepoint (x≈0)', approx(meanX, 0, 1e-6));

  // Slots are spread perpendicular to the home->enemy heading (along X here), evenly
  // spaced by wallSpacing — derived purely from the published knob.
  const xs = slots.map((s) => s.x).sort((a, b) => a - b);
  const gaps = xs.slice(1).map((x, i) => x - xs[i]);
  check(
    'holding: Turtles are evenly spaced by wallSpacing',
    gaps.every((g) => approx(g, COMMANDER_DEFAULTS.wallSpacing, 1e-6)),
  );

  // The non-Turtle support forms up behind the wall (not on it).
  const supportMove = commandsOfType(commands, 'moveUnits').find(
    (c) => c.payload.unitIds.length === support.length,
  );
  check('holding: the support army is given a forming-up move', Boolean(supportMove));
  if (supportMove) {
    check(
      'holding: support stages behind the chokepoint',
      Math.abs(supportMove.payload.target.z - HOME_Z) < Math.abs(chokeZ - HOME_Z),
    );
  }
})();

// --- Scenario B: a Turtle braces (shells) once it reaches its wall slot -----------

(() => {
  // Army in the holding band [holdForce, minAttackForce) so the wall is raised.
  const turtles = Array.from({ length: 4 }, (_, i) =>
    unit('p0', 'Unit', 'Turtle', { x: -10 + i * 2, z: HOME_Z + 5 }),
  );
  const support = Array.from({ length: Math.max(1, COMMANDER_DEFAULTS.holdForce - 2) }, (_, i) =>
    unit('p0', 'Unit', 'Bear', { x: i * 2, z: HOME_Z + 5 }),
  );
  check(
    'bracing fixture: army is in the holding band',
    turtles.length + support.length >= COMMANDER_DEFAULTS.holdForce &&
      turtles.length + support.length < COMMANDER_DEFAULTS.minAttackForce,
  );
  const world = { units: [...objectives('p0', HOME_Z), ...objectives('p1', ENEMY_Z), ...turtles, ...support] };
  const observation = makeObservation(world);
  const policy = makeCommanderPolicy();

  // Macro tick: establishes the wall plan and routes each Turtle to its slot.
  const planCommands = policy.decide({ role: 'p0', tick: MACRO_TICK, read: observation });
  const slotByTurtle = new Map(
    commandsOfType(planCommands, 'moveUnits')
      .filter((c) => c.payload.unitIds.length === 1 && turtles.some((t) => t.id === c.payload.unitIds[0]))
      .map((c) => [c.payload.unitIds[0], c.payload.target]),
  );
  check('bracing: a slot was planned for each Turtle', slotByTurtle.size === turtles.length);

  // Shelling happens on the faster ability cadence. Pick successive ability-only ticks
  // AFTER the macro plan tick (multiples of abilityIntervalTicks, never a macro tick) so
  // the wall plan set above persists in the commander between calls.
  const ability = COMMANDER_DEFAULTS.abilityIntervalTicks;
  const abilityTickAfter = (n) => {
    let t = (Math.floor(MACRO_TICK / ability) + n) * ability;
    while (t % COMMANDER_DEFAULTS.decisionIntervalTicks === 0) t += ability; // keep it ability-only
    return t;
  };
  const enRouteTick = abilityTickAfter(1);
  const arrivedTick = abilityTickAfter(2);
  const stableTick = abilityTickAfter(3);
  check(
    'bracing fixture: chosen ticks fire the ability layer only',
    [enRouteTick, arrivedTick, stableTick].every(
      (t) => t % ability === 0 && t % COMMANDER_DEFAULTS.decisionIntervalTicks !== 0 && t > MACRO_TICK,
    ),
  );

  // While still marching (away from slots), the ability layer must NOT shell them — a
  // shelled Turtle is pinned and would never reach the line.
  const enRoute = policy.decide({ role: 'p0', tick: enRouteTick, read: observation });
  check(
    'bracing: Turtles in transit are not shelled',
    commandsOfType(enRoute, 'toggleTurtleShell').length === 0,
  );

  // Move each Turtle onto its slot, then run an ability tick: each should now brace.
  for (const turtle of turtles) {
    const slot = slotByTurtle.get(turtle.id);
    turtle.position = { x: slot.x, y: slot.y, z: slot.z };
  }
  const arrived = policy.decide({ role: 'p0', tick: arrivedTick, read: observation });
  const shelledIds = new Set(commandsOfType(arrived, 'toggleTurtleShell').flatMap((c) => c.payload.unitIds));
  check('bracing: every arrived Turtle is told to shell', turtles.every((t) => shelledIds.has(t.id)));

  // Reflect the shell into state; the next ability tick must be stable (no re-toggle).
  for (const turtle of turtles) turtle.isShelled = true;
  const stable = policy.decide({ role: 'p0', tick: stableTick, read: observation });
  check(
    'bracing: an already-braced wall does not oscillate its shells',
    commandsOfType(stable, 'toggleTurtleShell').length === 0,
  );
})();

// --- Scenario C: an overwhelmed side DEFENDS its bases with a Turtle wall ----------

(() => {
  const turtles = Array.from({ length: 3 }, (_, i) =>
    unit('p0', 'Unit', 'Turtle', { x: -6 + i * 2, z: HOME_Z + 5 }),
  );
  const defenders = [unit('p0', 'Unit', 'Bear', { x: 0, z: HOME_Z + 5 })];

  // A large enemy mobile force right on top of home: more than army * defendOverwhelmRatio
  // within defenseTriggerRange → must trigger the full `defending` fallback.
  const armySize = turtles.length + defenders.length;
  const attackerCount = Math.ceil(armySize * COMMANDER_DEFAULTS.defendOverwhelmRatio) + 3;
  const attackers = Array.from({ length: attackerCount }, (_, i) =>
    unit('p1', 'Unit', 'Wolf', { x: -4 + i, z: HOME_Z + 8 }),
  );
  const world = {
    units: [...objectives('p0', HOME_Z), ...objectives('p1', ENEMY_Z), ...turtles, ...defenders, ...attackers],
  };

  const policy = makeCommanderPolicy();
  const commands = policy.decide({ role: 'p0', tick: MACRO_TICK, read: makeObservation(world) });

  // The Turtle wall is built near home (wallDepth fraction out), NOT at the far
  // chokepoint — it is screening the bases.
  const turtleMoves = commandsOfType(commands, 'moveUnits').filter(
    (c) => c.payload.unitIds.length === 1 && turtles.some((t) => t.id === c.payload.unitIds[0]),
  );
  check('defending: a Turtle wall is raised at home', turtleMoves.length === turtles.length);
  const wallZ = HOME_Z + (ENEMY_Z - HOME_Z) * COMMANDER_DEFAULTS.wallDepth;
  const chokeZ = HOME_Z + (ENEMY_Z - HOME_Z) * COMMANDER_DEFAULTS.chokepointDepth;
  if (turtleMoves.length > 0) {
    const meanZ = turtleMoves.reduce((sum, c) => sum + c.payload.target.z, 0) / turtleMoves.length;
    check('defending: the wall sits at wallDepth (close to home)', approx(meanZ, wallZ, 1e-3));
    check('defending: the wall is nearer home than the offensive chokepoint', Math.abs(wallZ - HOME_Z) < Math.abs(chokeZ - HOME_Z));
  }

  // The non-Turtle defenders are sent to attack the incursion (a real target id).
  const attack = commandsOfType(commands, 'attackTarget').find((c) =>
    defenders.some((d) => c.payload.unitIds.includes(d.id)),
  );
  check('defending: non-Turtle defenders attack the incursion', Boolean(attack));
  if (attack) {
    check('defending: the attack target is an enemy mobile unit', attackers.some((a) => a.id === attack.payload.targetId));
  }
})();

// --- Scenario D: the state machine climbs massing -> holding -> attacking ----------

(() => {
  // The same commander instance must transition as its army grows, proving the phases
  // are dynamic (not a one-shot decision).
  const policy = makeCommanderPolicy();

  function runWithArmy(size, tickIndex) {
    nextId += 1; // keep ids unique across snapshots
    const army = Array.from({ length: size }, (_, i) => unit('p0', 'Unit', 'Bear', { x: i, z: HOME_Z + 5 }));
    const world = { units: [...objectives('p0', HOME_Z), ...objectives('p1', ENEMY_Z), ...army] };
    return { commands: policy.decide({ role: 'p0', tick: tickIndex, read: makeObservation(world) }), army };
  }

  // Below holdForce → massing: the whole army is gathered with a single group move.
  const tiny = runWithArmy(Math.max(1, COMMANDER_DEFAULTS.holdForce - 2), MACRO_TICK);
  const tinyGroupMove = commandsOfType(tiny.commands, 'moveUnits').find((c) => c.payload.unitIds.length === tiny.army.length);
  check('state machine: a sub-holdForce army masses as one group', Boolean(tinyGroupMove));

  // At >= minAttackForce → attacking: it commits with an attackTarget on an objective.
  const big = runWithArmy(COMMANDER_DEFAULTS.minAttackForce + 2, MACRO_TICK * 2);
  const attackObjective = commandsOfType(big.commands, 'attackTarget');
  check('state machine: a full army commits to an attack', attackObjective.length > 0);
})();

// --- Report -----------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks passed.`);
