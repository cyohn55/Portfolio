// Deterministic node test: the Turtle "shell" damage mitigation.
//
// A shelled Turtle must take only SHELL_DAMAGE_TAKEN_FRACTION of incoming damage (its
// defensive payoff), while an otherwise-identical UNSHELLED Turtle takes the full
// amount. This drives the REAL bundled simulation (src/game/state.ts) — the exact tick
// code that ships — and asserts on the resulting HP, so it validates actual component
// behavior with no mocked or hard-coded damage numbers.
//
// Damage is delivered via injected EGG projectiles rather than melee: the egg-impact
// path (updateProjectiles) applies the damage with NO knockback and NO target
// re-acquisition, so the shell's per-hit mitigation is the ONLY variable between the
// two turtles. (Melee entangles knockback — a shelled turtle resists being shoved and
// so stays in range and takes more total hits — which is a separate behavior.)
//
// Run: node "Unit Tests/turtle-shell-mitigation.spec.mjs"
// (Node, not Playwright — headless-browser checks are disabled in this environment.)

import assert from 'node:assert/strict';
import { loadSimulationApi } from './selfplay/bundleStore.mjs';

const SIM_DT_SECONDS = 1 / 60;
const EGG_DAMAGE = 100;          // a large, easy-to-read hit so mitigation is obvious
const SHELLED_TURTLE = { id: 'turtle-shelled', x: 200, z: 200 };
const BARE_TURTLE = { id: 'turtle-bare', x: 200, z: 120 };

// Two identical Turtles — one shelled, one not — each sitting under one stationary
// enemy egg. An immovable Base per side keeps both sides "in the game" so the match
// does not end mid-test. Placed far apart, away from the moat/bridges, so the two hits
// never interact and terrain plays no role.
function buildUnits() {
  const makeBase = (id, ownerId, x, z) => ({
    id, ownerId, animal: 'Bear', kind: 'Base',
    position: { x, y: 0, z }, hp: 10000, maxHp: 10000,
    attackDamage: 0, moveSpeed: 0, attackRange: 4,
    attackCooldownMs: 1000, lastAttackAtMs: 0, rotation: 0,
  });
  // A huge HP pool so neither turtle dies on the hit — the test reads the PROPORTIONAL
  // drop, not who dies first.
  const makeTurtle = (id, ownerId, x, z, isShelled) => ({
    id, ownerId, animal: 'Turtle', kind: 'Unit',
    position: { x, y: 0.25, z }, hp: 1_000_000, maxHp: 1_000_000,
    attackDamage: 0, moveSpeed: 0, attackRange: 0,
    attackCooldownMs: 100000, lastAttackAtMs: 0, rotation: 0, isShelled,
  });
  return [
    makeBase('p0-base', 'p0', 250, 250),
    makeBase('p1-base', 'p1', -250, -250),
    makeTurtle(SHELLED_TURTLE.id, 'p0', SHELLED_TURTLE.x, SHELLED_TURTLE.z, true),
    makeTurtle(BARE_TURTLE.id, 'p0', BARE_TURTLE.x, BARE_TURTLE.z, false),
  ];
}

// One enemy egg parked exactly on each turtle (zero velocity), so on the next tick the
// egg-impact check resolves a hit at distance 0 and applies the (mitigated) damage.
function buildProjectiles() {
  const makeEgg = (id, target) => ({
    id, ownerId: 'p1', // enemy of the p0 turtles
    position: { x: target.x, y: 1.5, z: target.z },
    velocity: { x: 0, y: 0, z: 0 },
    traveled: 0, maxRange: 60, damage: EGG_DAMAGE,
  });
  return [makeEgg('egg-shelled', SHELLED_TURTLE), makeEgg('egg-bare', BARE_TURTLE)];
}

async function run() {
  const api = await loadSimulationApi();
  const { useGameStore } = api;
  const { buildLineups } = await import('./selfplay/selfPlay.mjs');

  // Boot a real match (initializes config, spatial grid, clocks, …) then overwrite the
  // unit list with our controlled duel — the same injection pattern the feature specs use.
  const lineups = buildLineups({ api, SeededRng: api.SeededRng, seed: 1 });
  const realLog = console.log;
  console.log = () => {};
  try {
    useGameStore.getState().startMultiplayerMatch({ localRole: 'p0', seed: 1, lineups });
    useGameStore.setState({
      units: buildUnits(),
      projectiles: buildProjectiles(),
      unitOrders: {}, queenPatrols: {}, selectedUnitIds: [],
      deadUnitsToRemove: [], targetCache: {},
    });

    const hpOf = (id) => {
      const u = useGameStore.getState().units.find((unit) => unit.id === id);
      return u ? u.hp : 0;
    };
    const shelledStart = hpOf(SHELLED_TURTLE.id);
    const bareStart = hpOf(BARE_TURTLE.id);

    // One tick resolves both egg impacts (each egg sits on its turtle).
    useGameStore.getState().tick(SIM_DT_SECONDS, Date.now() + SIM_DT_SECONDS * 1000);

    const shelledDrop = shelledStart - hpOf(SHELLED_TURTLE.id);
    const bareDrop = bareStart - hpOf(BARE_TURTLE.id);
    return { shelledDrop, bareDrop };
  } finally {
    console.log = realLog;
  }
}

run()
  .then(({ shelledDrop, bareDrop }) => {
    // Both turtles must actually be under fire — otherwise the test proves nothing.
    assert.ok(bareDrop > 0, `the unshelled turtle should take damage (took ${bareDrop})`);
    assert.ok(shelledDrop > 0, `the shelled turtle should still take some damage (took ${shelledDrop})`);

    // The shell must mitigate: the shelled turtle takes strictly LESS than the bare one,
    // at roughly the configured 0.35 fraction. The ratio is asserted against a band (not
    // an exact number) so the test reads the real outcome rather than re-deriving it.
    assert.ok(
      shelledDrop < bareDrop,
      `shelled turtle (${shelledDrop}) must take less than bare turtle (${bareDrop})`,
    );
    const ratio = shelledDrop / bareDrop;
    assert.ok(
      ratio > 0.25 && ratio < 0.45,
      `shell mitigation ratio ${ratio.toFixed(3)} should be ~0.35 (0.25–0.45 band)`,
    );

    console.log(
      `PASS turtle-shell-mitigation: bare took ${bareDrop}, shelled took ${shelledDrop} ` +
      `(ratio ${ratio.toFixed(3)} ≈ 0.35)`,
    );
  })
  .catch((error) => {
    console.error('FAIL turtle-shell-mitigation:', error.message);
    process.exit(1);
  });
