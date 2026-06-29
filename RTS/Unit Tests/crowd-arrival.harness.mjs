/**
 * Crowd-arrival harness (headless Node, no browser).
 *
 * Guards the fix for "the animals keep jittering and knocking each other around as they close in
 * on the destination." A loose (non-formation) group ordered onto ONE point cannot reach the
 * tight 0.5 arrival radius once teammates pack the spot: the spacing passes shove each unit back
 * out, and because friendly crowding never trips the (enemy-only) stuck-abandon, the order is
 * never cleared — so the group oscillates on the point forever. `hasSettledIntoCrowd` (state.ts)
 * lets a stalled unit settle behind the teammate ahead of it, so the group packs outward and
 * comes to rest.
 *
 * This drives the REAL deterministic sim (same bundle/seed machinery as the other harnesses):
 * it orders every movable unit of one side onto a single point and then asserts the end-state
 * the fix guarantees and the bug violates —
 *   1. every commanded order is CLEARED (the oscillation cannot end while an order remains),
 *   2. the crowd is STABLE in the final ticks (no per-tick jitter), and
 *   3. units are SPACED, not stacked on the point, and clustered near the destination.
 * Kings and queens are checked explicitly (the reported worst offenders). Without the fix the
 * orders never clear and the stability check fails, so this fails loudly on a regression.
 *
 * Run from the RTS project root:
 *   node "Unit Tests/crowd-arrival.harness.mjs"
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_ENTRY = resolve(HERE, '../src/game/state.ts');

const SEED = 0x1234abcd;
const DT = 1 / 60;
const ROLE = 'p0';
const LINEUPS = { p0: ['Bear', 'Fox', 'Bee'], p1: ['Cat', 'Owl', 'Frog'] };

// A single shared destination just in front of p0's spawn line (its monarchs open near
// x∈[-57,69], z∈[116,210]) so the whole side converges quickly onto ONE point — the dog-pile
// trigger. y is the click plane.
const DESTINATION = { x: 0, y: 0.25, z: 150 };
const TICKS = 1600;           // ample time for even the slowest royal to march in from spawn and settle
const STABLE_WINDOW = 60;     // assert no jitter across the final second of ticks
const STABLE_EPSILON = 0.05;  // max per-tick movement (world units) that still counts as "at rest"
const MIN_PAIR_SPACING = 2.0; // conservative floor proving units are not stacked on the point
const CLUSTER_RADIUS = 60;    // settled units should rest near the destination, not scatter

const stubLeaderboard = {
  name: 'stub-leaderboard',
  setup(b) {
    b.onResolve({ filter: /(leaderboard|leaderboardRemote|firebaseClient)$/ }, (args) => ({
      path: args.path,
      namespace: 'stub-leaderboard',
    }));
    b.onLoad({ filter: /.*/, namespace: 'stub-leaderboard' }, () => ({
      contents: 'export default {}; export const getDb = () => null;',
      loader: 'js',
    }));
  },
};

async function bundleStore() {
  const outfile = resolve(mkdtempSync(resolve(tmpdir(), 'crowd-')), 'store.mjs');
  await build({
    entryPoints: [STATE_ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'node',
    define: { 'import.meta.env.DEV': 'false' },
    outfile,
    plugins: [stubLeaderboard],
    logLevel: 'silent',
  });
  return outfile;
}

const movableUnits = (store, role) =>
  store.getState().units.filter((u) => u.ownerId === role && u.kind !== 'Base');

const horizontalDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function runScenario(api) {
  const { useGameStore, dispatchCommand } = api;
  useGameStore.getState().startMultiplayerMatch({ localRole: ROLE, seed: SEED, lineups: LINEUPS });

  const commandedIds = movableUnits(useGameStore, ROLE).map((u) => u.id);

  // Pin the side to its anchors so nothing roams off to fight — isolate the crowd-arrival path —
  // then order the WHOLE group onto one point (the exact dog-pile the bug oscillates on).
  dispatchCommand({ type: 'setBehavior', payload: { unitIds: commandedIds, behavior: { stance: 'defensive' } } });
  dispatchCommand({ type: 'moveUnits', payload: { unitIds: commandedIds, target: DESTINATION } });

  // Snapshot each commanded unit's position every tick so we can measure end-of-run jitter.
  const previousById = new Map();
  let maxRecentStep = 0;
  for (let tick = 1; tick <= TICKS; tick++) {
    useGameStore.getState().tick(DT, Date.now());

    const inStableWindow = tick > TICKS - STABLE_WINDOW;
    for (const unit of movableUnits(useGameStore, ROLE)) {
      const previous = previousById.get(unit.id);
      if (inStableWindow && previous) {
        maxRecentStep = Math.max(maxRecentStep, horizontalDistance(unit.position, previous));
      }
      previousById.set(unit.id, { x: unit.position.x, z: unit.position.z });
    }
  }

  return { api, commandedIds, maxRecentStep };
}

function evaluate({ api, commandedIds, maxRecentStep }) {
  const { useGameStore } = api;
  const state = useGameStore.getState();
  const orders = state.unitOrders;
  const survivors = movableUnits(useGameStore, ROLE).filter((u) => commandedIds.includes(u.id));

  const failures = [];

  // 1. No order may remain — an unresolved order means the unit is still trying to reach the
  //    occupied point, i.e. still oscillating.
  const stillOrdered = commandedIds.filter((id) => orders[id] !== undefined);
  if (stillOrdered.length > 0) {
    failures.push(`${stillOrdered.length}/${commandedIds.length} units still hold an order (never settled): ${stillOrdered.join(', ')}`);
    for (const id of stillOrdered) {
      const u = survivors.find((s) => s.id === id);
      const order = orders[id];
      if (u && order) {
        failures.push(`    ${id} ${u.kind} pos=(${u.position.x.toFixed(1)},${u.position.z.toFixed(1)}) ` +
          `order=(${order.x.toFixed(1)},${order.z.toFixed(1)}) distToOrder=${horizontalDistance(u.position, order).toFixed(2)} ` +
          `state=${u.unitState} moveSpeed=${u.moveSpeed} collAttempts=${u.collisionAttempts ?? 0} ` +
          `pausedUntil=${u.movementPausedUntilMs ?? '-'} firstBlocked=${u.firstBlockedAtMs ?? '-'} pathStuck=${u.pathStuckTicks ?? 0}`);
      }
    }
    failures.push('    --- all commanded units ---');
    for (const u of survivors) {
      failures.push(`    ${u.id} ${u.kind} pos=(${u.position.x.toFixed(1)},${u.position.z.toFixed(1)}) ordered=${orders[u.id] !== undefined}`);
    }
  }

  // Kings and queens were the reported worst offenders — assert they settled specifically.
  const royalsStillOrdered = survivors.filter((u) => (u.kind === 'King' || u.kind === 'Queen') && orders[u.id] !== undefined);
  if (royalsStillOrdered.length > 0) {
    failures.push(`${royalsStillOrdered.length} King/Queen still jittering on the point: ${royalsStillOrdered.map((u) => u.id).join(', ')}`);
  }

  // 2. The crowd must be at rest in the final ticks — the direct "stopped jittering" signal.
  if (maxRecentStep > STABLE_EPSILON) {
    failures.push(`crowd still moving in the final ${STABLE_WINDOW} ticks: max step ${maxRecentStep.toFixed(4)} > ${STABLE_EPSILON}`);
  }

  // 3. Units are packed (spaced), not stacked on the destination, and stayed near it.
  let minPairSpacing = Infinity;
  for (let i = 0; i < survivors.length; i++) {
    for (let j = i + 1; j < survivors.length; j++) {
      minPairSpacing = Math.min(minPairSpacing, horizontalDistance(survivors[i].position, survivors[j].position));
    }
  }
  if (survivors.length > 1 && minPairSpacing < MIN_PAIR_SPACING) {
    failures.push(`units stacked on the point: closest pair ${minPairSpacing.toFixed(3)} < ${MIN_PAIR_SPACING}`);
  }

  const farFromDestination = survivors.filter((u) => horizontalDistance(u.position, DESTINATION) > CLUSTER_RADIUS);
  if (farFromDestination.length > 0) {
    failures.push(`${farFromDestination.length} units settled far (> ${CLUSTER_RADIUS}) from the destination`);
  }

  return { failures, survivors: survivors.length, minPairSpacing };
}

async function main() {
  const realLog = console.log;
  console.log = () => {};
  const api = await import(await bundleStore());
  const run = runScenario(api);
  const { failures, survivors, minPairSpacing } = evaluate(run);
  console.log = realLog;

  if (survivors === 0) {
    console.error('FAIL: no commanded units survived — the scenario did not run as intended.');
    process.exit(2);
  }

  if (failures.length === 0) {
    console.log(
      `PASS: ${survivors} units ordered onto one point all settled (orders cleared, crowd at rest, ` +
      `closest pair ${minPairSpacing.toFixed(2)}u) — no crowd-arrival jitter.`,
    );
    process.exit(0);
  }

  console.error('FAIL: crowd-arrival jitter not resolved:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

main().catch((error) => {
  console.error('FAIL: harness threw', error);
  process.exit(3);
});
