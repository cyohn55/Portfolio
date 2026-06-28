/**
 * Sim checksum baseline harness (headless Node, no browser) — worker-offload T7.
 *
 * The companion `dispatch-command-equivalence.harness.mjs` proves the new
 * `dispatchCommand` funnel is byte-identical to `applyNetCommand` *within one
 * build*. This harness pins the OTHER axis: the absolute per-tick trajectory of a
 * fixed seeded command script. It runs that script through `dispatchCommand` and
 * asserts the resulting per-tick `computeStateChecksum()` sequence reproduces a
 * committed golden digest.
 *
 * Why this is the "pre/post refactor parity" gate the plan (§5) calls for: the
 * golden below was captured from the refactored Phase-0 code. Because Phase 0 is a
 * pure refactor (command-in / snapshot-out plumbing only — no sim-logic change),
 * that trajectory equals the pre-refactor one. From here it guards the rest of the
 * offload: when the sim moves behind a worker in Phase 1, this script must still
 * reproduce the same digit — any drift is a real behaviour change, not plumbing.
 *
 * Re-blessing: if you intentionally change sim behaviour, regenerate the golden:
 *   CAPTURE_GOLDEN=1 node "Unit Tests/sim-checksum-baseline.harness.mjs"
 * and paste the printed values into GOLDEN. An accidental change fails loudly.
 *
 * Run from the RTS project root:
 *   node "Unit Tests/sim-checksum-baseline.harness.mjs"
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_ENTRY = resolve(HERE, '../src/game/state.ts');

const SEED = 0x1234abcd;
const TICKS = 300;
const DT = 1 / 60;
const ROLE = 'p0';
const LINEUPS = { p0: ['Bear', 'Fox', 'Bee'], p1: ['Cat', 'Owl', 'Frog'] };

// The committed golden: a digest of the full per-tick checksum sequence, plus the
// final-tick checksum and tick count as human-readable cross-checks. Captured from
// the Phase-0 build via CAPTURE_GOLDEN=1 (see header).
const GOLDEN = {
  ticks: 300,
  finalChecksum: 't300#rng2513078436#B-0|p0|Base|760.000|73.500|252.000;B-12|p1|Base|360.000|1.000|-248.000;B-15|p1|Base|480.000|-74.000|-248.000;B-3|p0|Base|720.000|-2.000|252.000;B-6|p0|Base|320.000|-77.000|252.000;B-9|p1|Base|520.000|76.500|-248.000;K-11|p1|King|195.000|72.500|-232.000;K-14|p1|King|135.000|-3.000|-232.000;K-17|p1|King|180.000|-78.000|-232.000;K-2|p0|King|285.000|61.800|209.227;K-5|p0|King|270.000|-4.245|187.281;K-8|p0|King|120.000|-57.543|170.428;Q-1|p0|Queen|190.000|69.266|210.015;Q-10|p1|Queen|130.000|80.500|-232.000;Q-13|p1|Queen|90.000|5.000|-232.000;Q-16|p1|Queen|120.000|-70.000|-232.000;Q-4|p0|Queen|180.000|2.269|148.251;Q-7|p0|Queen|80.000|-34.128|116.832;U-18|p0|Unit|95.000|72.453|210.214;U-19|p0|Unit|90.000|5.387|148.615;U-20|p0|Unit|40.000|-31.174|117.323;U-21|p1|Unit|65.000|83.938|-232.000;U-22|p1|Unit|45.000|8.125|-232.000;U-23|p1|Unit|60.000|-66.563|-232.000',
  digest: '51d55e8637250b5d5664d39889de24bc13492e89518dd8d8c6af6591ab15bfce',
};

// Stub the Firebase leaderboard modules (pull in @grpc, which breaks under ESM) so
// only the simulation is bundled — mirrors the other determinism harnesses.
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
  const outfile = resolve(mkdtempSync(resolve(tmpdir(), 'baseline-')), 'store.mjs');
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

const ownedNonBase = (store, role) =>
  store.getState().units.filter((u) => u.ownerId === role && u.kind !== 'Base').map((u) => u.id);

const firstMonarch = (store, role) =>
  store.getState().units.find((u) => u.ownerId === role && (u.kind === 'King' || u.kind === 'Queen'))?.id ?? null;

// A fixed command stream resolved once from the deterministic opening (seed +
// lineups are fixed). Exercises gameplay + pilot/control families so the baseline
// covers both structural paths through dispatchCommand.
function buildScript(store) {
  const units = ownedNonBase(store, ROLE);
  const monarch = firstMonarch(store, ROLE);
  const byTick = new Map();
  const at = (tick, ...cmds) => byTick.set(tick, [...(byTick.get(tick) ?? []), ...cmds]);

  at(40, { type: 'setBehavior', payload: { unitIds: units, behavior: { stance: 'defensive' } } });
  at(50, { type: 'setMovementHold', payload: { unitId: units[0] ?? null } });
  at(55, { type: 'setMovementHold', payload: { unitId: null } });
  at(60, { type: 'moveUnits', payload: { unitIds: units, target: { x: 0, y: 0.25, z: 0 } } });
  if (monarch) {
    at(90, { type: 'setPilot', payload: { unitId: monarch } });
    for (let t = 91; t <= 150; t++) at(t, { type: 'pilotMove', payload: { x: 1, z: 0 } });
    at(151, { type: 'releaseControl', payload: {} });
  }
  at(200, { type: 'moveUnits', payload: { unitIds: units, target: { x: 5, y: 0.25, z: 5 } } });
  return byTick;
}

function runMatch(api) {
  const { useGameStore, computeStateChecksum, dispatchCommand } = api;
  useGameStore.getState().startMultiplayerMatch({ localRole: ROLE, seed: SEED, lineups: LINEUPS });
  useGameStore.getState().selectUnits(ownedNonBase(useGameStore, ROLE));

  const script = buildScript(useGameStore);
  const perTick = [];
  for (let tick = 1; tick <= TICKS; tick++) {
    for (const command of script.get(tick) ?? []) dispatchCommand(command);
    useGameStore.getState().tick(DT, Date.now());
    perTick.push(computeStateChecksum());
  }
  return perTick;
}

async function main() {
  const realLog = console.log;
  console.log = () => {};
  const api = await import(await bundleStore());
  const perTick = runMatch(api);
  const finalUnits = api.useGameStore.getState().units.length;
  console.log = realLog;

  if (finalUnits === 0) {
    console.error('FAIL: no units simulated — the match did not start.');
    process.exit(2);
  }

  const captured = {
    ticks: perTick.length,
    finalChecksum: perTick[perTick.length - 1],
    digest: createHash('sha256').update(perTick.join('\n')).digest('hex'),
  };

  if (process.env.CAPTURE_GOLDEN) {
    console.log('Captured baseline — paste into GOLDEN:');
    console.log(JSON.stringify(captured, null, 2));
    process.exit(0);
  }

  if (GOLDEN.digest === '__CAPTURE__') {
    console.error('FAIL: GOLDEN is unset. Run CAPTURE_GOLDEN=1 and paste the values in.');
    process.exit(2);
  }

  const mismatch = Object.keys(GOLDEN).filter((k) => GOLDEN[k] !== captured[k]);
  if (mismatch.length === 0) {
    console.log(`PASS: sim trajectory matches the committed baseline for all ${captured.ticks} ticks (digest ${captured.digest.slice(0, 12)}…).`);
    process.exit(0);
  }

  console.error(`FAIL: sim trajectory diverged from the baseline (fields: ${mismatch.join(', ')}).`);
  for (const k of mismatch) console.error(`  ${k}: expected ${GOLDEN[k]}  got ${captured[k]}`);
  console.error('If this change to sim behaviour is intentional, re-bless with CAPTURE_GOLDEN=1.');
  process.exit(1);
}

main().catch((error) => {
  console.error('FAIL: harness threw', error);
  process.exit(3);
});
