// Deterministic node test: shelling turns a Turtle into a "living wall" an enemy cannot
// traverse, by closing the within-melee-range collision gap that an unshelled Turtle leaves
// open.
//
// This drives the REAL bundled simulation (src/game/state.ts) — the exact tick code that
// ships — so it validates the actual checkCollision behavior, not a mock. Every threshold is
// DERIVED from the scenario's own geometry (the Turtle's Z, the Chicken's start/goal), never
// from a hard-coded expected position.
//
// WHY the contrast is set up "already adjacent": checkCollision lets enemy units that are
// within ~2 units interpenetrate so they can close to melee range. An enemy that is already
// inside that band of an UNSHELLED Turtle therefore walks straight through it. Shelling closes
// that band (and holds the enemy at SHELL_BLOCK_RADIUS), so the same enemy is ejected and
// cannot pass. Starting the Chicken inside the band isolates exactly the behavior the shell
// toggles — it is the same gap that, on the Center_Bridge, let Chickens slip past a turtle line.
//
// The Chicken deals zero damage (it can never destroy its way through) and the Turtle deals
// zero damage (the Chicken can never die mid-test and skew the read), so the shell is the only
// variable. The scenario sits deep in p0's home territory (near the z=252 base, far from the
// central moat/bridges), so terrain never blocks the path.
//
// Run: node "Unit Tests/turtle-wall-blocking.spec.mjs"
// (Node, not Playwright — headless-browser checks are disabled in this environment.)

import assert from 'node:assert/strict';
import { loadSimulationApi } from './selfplay/bundleStore.mjs';

const SIM_DT_SECONDS = 1 / 60;
const SIM_TICKS = 300; // 5 seconds — ample for the Chicken to traverse if unobstructed

// Geometry (all on p0's dry home side, z in [220, 246]). The Chicken starts behind the Turtle
// line (largest Z) and is ordered to a goal in front of it (smallest Z), so "crossing" the
// wall is a strict decrease of the Chicken's Z below TURTLE_Z.
const TURTLE_Z = 235;
const GOAL_Z = 222;
const LANE_X = 0;

// The Chicken starts only 1 unit behind the lead Turtle — inside the within-melee gap. This is
// the configuration that separates "shelled" from "unshelled": an unshelled Turtle lets the
// adjacent enemy walk through; a shelled one ejects it.
const ADJACENT_GAP = 1;

// A short Turtle line spaced 3 units apart (a realistically tight group), centered on the lane
// and wider than any lateral drift, so the Chicken cannot simply round the ends.
const WALL_SPACING = 3;
const WALL_COLUMNS = 5;
const wallXs = Array.from(
  { length: WALL_COLUMNS },
  (_, i) => (i - (WALL_COLUMNS - 1) / 2) * WALL_SPACING,
);

const CHICKEN_ID = 'p0-chicken';

function makeBase(id, ownerId, x, z) {
  return {
    id, ownerId, animal: 'Bear', kind: 'Base',
    position: { x, y: 0.25, z }, hp: 10000, maxHp: 10000,
    attackDamage: 0, moveSpeed: 0, attackRange: 4,
    attackCooldownMs: 1000, lastAttackAtMs: 0, rotation: 0,
  };
}

// A wall Turtle: huge HP (the zero-damage Chicken can never break it) and ZERO damage (it never
// kills the Chicken and ends the run early). moveSpeed 0 keeps it planted on its slot.
function makeWallTurtle(id, x, z, shelled) {
  return {
    id, ownerId: 'p1', animal: 'Turtle', kind: 'Unit',
    position: { x, y: 0.25, z }, hp: 1_000_000, maxHp: 1_000_000,
    attackDamage: 0, moveSpeed: 0, attackRange: 0,
    attackCooldownMs: 100000, lastAttackAtMs: 0, rotation: 0, isShelled: shelled,
  };
}

// The mover: a player-owned Chicken whose move order is never interrupted by combat (Priority-1
// player orders), so it keeps pressing the wall rather than freezing to fight. Zero damage, so
// only a collision gap — never attrition — could let it through. Speed comes from the real
// ANIMALS roster so it is a faithful Chicken.
function makeChicken(api, startZ) {
  return {
    id: CHICKEN_ID, ownerId: 'p0', animal: 'Chicken', kind: 'Unit',
    position: { x: LANE_X, y: 0.25, z: startZ }, hp: 100000, maxHp: 100000,
    attackDamage: 0, moveSpeed: api.ANIMALS.Chicken.speed, attackRange: 4,
    attackCooldownMs: 900, lastAttackAtMs: 0, rotation: 0, isShelled: false,
  };
}

// Step the sim with the Chicken ordered to the far goal; return how close it ever got to the
// goal (its minimum Z) and where it ended.
async function runScenario(api, { units, startZ }) {
  const { useGameStore } = api;
  const { buildLineups } = await import('./selfplay/selfPlay.mjs');

  const lineups = buildLineups({ api, SeededRng: api.SeededRng, seed: 1 });
  const realLog = console.log;
  console.log = () => {};
  try {
    useGameStore.getState().startMultiplayerMatch({ localRole: 'p0', seed: 1, lineups });
    useGameStore.setState({
      units,
      projectiles: [],
      unitOrders: { [CHICKEN_ID]: { x: LANE_X, y: 0, z: GOAL_Z } },
      queenPatrols: {}, selectedUnitIds: [],
      deadUnitsToRemove: [], targetCache: {},
    });

    const chickenZ = () => {
      const u = useGameStore.getState().units.find((unit) => unit.id === CHICKEN_ID);
      return u ? u.position.z : Number.NaN;
    };

    let minZ = chickenZ();
    let nowMs = Date.now();
    for (let i = 0; i < SIM_TICKS; i += 1) {
      nowMs += SIM_DT_SECONDS * 1000;
      useGameStore.getState().tick(SIM_DT_SECONDS, nowMs);
      const z = chickenZ();
      if (z < minZ) minZ = z;
    }
    return { minZ, endZ: chickenZ() };
  } finally {
    console.log = realLog;
  }
}

// --- Scenario A: a single Turtle the Chicken is already adjacent to (the melee-gap contrast) --
function singleTurtleScenario(api, shelled) {
  const startZ = TURTLE_Z + ADJACENT_GAP;
  return {
    startZ,
    units: [
      makeBase('p0-base', 'p0', -2, 252),
      makeBase('p1-base', 'p1', 1, -248),
      makeWallTurtle('p1-turtle', LANE_X, TURTLE_Z, shelled),
      makeChicken(api, startZ),
    ],
  };
}

// --- Scenario B: a shelled line seals an APPROACHING Chicken's lane (the headline behavior) ---
function shelledLineScenario(api) {
  const startZ = TURTLE_Z + 10; // approaches from well behind the line
  return {
    startZ,
    units: [
      makeBase('p0-base', 'p0', -2, 252),
      makeBase('p1-base', 'p1', 1, -248),
      ...wallXs.map((x) => makeWallTurtle(`p1-wall-${x}`, x, TURTLE_Z, true)),
      makeChicken(api, startZ),
    ],
  };
}

async function run() {
  const api = await loadSimulationApi();
  const shelledSingle = await runScenario(api, singleTurtleScenario(api, true));
  const bareSingle = await runScenario(api, singleTurtleScenario(api, false));
  const shelledLine = await runScenario(api, shelledLineScenario(api));
  return { shelledSingle, bareSingle, shelledLine };
}

run()
  .then(({ shelledSingle, bareSingle, shelledLine }) => {
    // CONTRAST (Scenario A): an enemy already adjacent to an UNSHELLED Turtle walks through it
    // and reaches the far side — proving the within-melee gap is open without the shell.
    assert.ok(
      bareSingle.minZ < TURTLE_Z - 3,
      `unshelled Turtle must stay permeable: adjacent Chicken only reached z ${bareSingle.minZ.toFixed(2)} (turtle at ${TURTLE_Z})`,
    );

    // The SAME adjacent enemy cannot pass a SHELLED Turtle — it is ejected back out and never
    // crosses. This is the gap-closing the shell adds.
    assert.ok(
      shelledSingle.minZ > TURTLE_Z,
      `shelled Turtle must block: the Chicken crossed to z ${shelledSingle.minZ.toFixed(2)} (turtle at ${TURTLE_Z})`,
    );
    assert.ok(
      shelledSingle.endZ > TURTLE_Z + ADJACENT_GAP,
      `shelled Turtle should eject the adjacent Chicken outward past its start (ended at z ${shelledSingle.endZ.toFixed(2)})`,
    );

    // HEADLINE (Scenario B): a shelled line seals the lane against an APPROACHING Chicken — it
    // advances from its start but is stopped on the near side, never crossing the wall plane.
    assert.ok(
      shelledLine.minZ < TURTLE_Z + 10,
      `approaching Chicken should set off toward the wall (min z ${shelledLine.minZ.toFixed(2)})`,
    );
    assert.ok(
      shelledLine.minZ > TURTLE_Z,
      `shelled line must seal the lane: the Chicken crossed to z ${shelledLine.minZ.toFixed(2)} (wall at ${TURTLE_Z})`,
    );

    console.log(
      `PASS turtle-wall-blocking: unshelled Turtle let the adjacent Chicken through to ` +
      `z=${bareSingle.minZ.toFixed(2)}; shelling held it at z=${shelledSingle.minZ.toFixed(2)} ` +
      `and a shelled line sealed an approaching Chicken at z=${shelledLine.minZ.toFixed(2)} (wall ${TURTLE_Z}).`,
    );
  })
  .catch((error) => {
    console.error('FAIL turtle-wall-blocking:', error.message);
    process.exit(1);
  });
