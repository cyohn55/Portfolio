/**
 * Pilot-handle trajectory harness (headless Node) — worker-offload T4 Tier-3.
 *
 * The hybrid pilot/control HANDLES (`pilotMonarchBySlot`, `pilotMonarchById`,
 * `pilotCycleMonarch`, `togglePilotMonarchKind`, `rallyToMonarch`,
 * `placeRalliedUnits`, `clearPilot`, `clearSelection`) each do two things: set the
 * local UI mirror, then issue the sim-authoritative effect. T4 Tier-3 routes that
 * second step through `dispatchCommand` instead of an inline
 * `routeCommand(cmd) ? return : set(applyX(...))` copy, so the worker switch is one
 * change. No existing harness drives these handles, so this one pins their absolute
 * per-tick `computeStateChecksum()` trajectory to a golden captured BEFORE the
 * re-route — proving the consolidation is byte-for-byte behaviour-neutral.
 *
 * Re-bless on intentional sim changes:
 *   CAPTURE_GOLDEN=1 node "Unit Tests/pilot-handle-equivalence.harness.mjs"
 *
 * Run from the RTS project root:
 *   node "Unit Tests/pilot-handle-equivalence.harness.mjs"
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
// Long enough that Queens have spawned army units (~every 600 ticks), so the
// rally / placement handles act on real followers rather than an empty army.
const TICKS = 720;
const DT = 1 / 60;
const ROLE = 'p0';
const LINEUPS = { p0: ['Bear', 'Fox', 'Bee'], p1: ['Cat', 'Owl', 'Frog'] };

// Golden captured from the pre-T4-Tier-3 build (the handles' inline route-or-apply).
const GOLDEN = {
  ticks: 720,
  finalChecksum: 't720#rng1753360372#B-0|p0|Base|760.000|73.500|252.000;B-12|p1|Base|360.000|1.000|-248.000;B-15|p1|Base|480.000|-74.000|-248.000;B-3|p0|Base|720.000|-2.000|252.000;B-6|p0|Base|320.000|-77.000|252.000;B-9|p1|Base|520.000|76.500|-248.000;K-11|p1|King|195.000|72.500|-232.000;K-14|p1|King|135.000|-3.000|-232.000;K-17|p1|King|180.000|-78.000|-232.000;K-2|p0|King|285.000|68.660|235.116;K-5|p0|King|270.000|-6.000|236.000;K-8|p0|King|120.000|-81.000|236.000;Q-1|p0|Queen|190.000|77.024|236.062;Q-10|p1|Queen|130.000|80.248|-232.071;Q-13|p1|Queen|90.000|5.000|-232.000;Q-16|p1|Queen|120.000|-70.252|-232.071;Q-4|p0|Queen|180.000|1.339|236.267;Q-7|p0|Queen|80.000|-73.000|236.000;U-18|p0|Unit|95.000|73.266|232.333;U-19|p0|Unit|90.000|-0.466|232.941;U-20|p0|Unit|40.000|-69.875|236.000;U-21|p1|Unit|65.000|84.095|-232.089;U-22|p1|Unit|45.000|8.125|-232.000;U-23|p1|Unit|60.000|-66.405|-232.089;U-24|p0|Unit|95.000|71.206|237.845;U-25|p0|Unit|90.000|-1.097|239.141;U-26|p0|Unit|40.000|-71.050|238.837;U-27|p1|Unit|65.000|82.187|-228.861;U-28|p1|Unit|45.000|6.950|-229.163;U-29|p1|Unit|60.000|-68.313|-228.861',
  digest: 'c9d773db9e2cbe7b409ddbd9c6e0d04b32ba5e9c259d179b8996ad68e5535c70',
};

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
  const outfile = resolve(mkdtempSync(resolve(tmpdir(), 'pilot-handle-')), 'store.mjs');
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

const monarchsOf = (store, role) =>
  store.getState().units.filter((u) => u.ownerId === role && (u.kind === 'King' || u.kind === 'Queen'));

// Drive the piloted monarch one tick (the sim reads pilotMoveByOwner). pilotMove is
// not a refactored handle — it just makes the trajectory sensitive to pilot state.
function drive(api, x, z) {
  api.dispatchCommand({ type: 'pilotMove', payload: { x, z } });
}

// Script of HANDLE calls keyed by tick, exercising every re-routed hybrid handle.
function runMatch(api) {
  const { useGameStore, computeStateChecksum } = api;
  const g = () => useGameStore.getState();
  g().startMultiplayerMatch({ localRole: ROLE, seed: SEED, lineups: LINEUPS });

  // A stable monarch id for the pilotMonarchById path (deterministic from the seed).
  const someMonarchId = monarchsOf(useGameStore, ROLE)[0]?.id ?? null;

  const perTick = [];
  for (let tick = 1; tick <= TICKS; tick++) {
    switch (tick) {
      case 5: g().pilotMonarchBySlot(0); break;            // setPilot
      // The rest fire after the first spawn wave so the army has followers.
      case 620: g().rallyToMonarch(); break;               // rallyMonarch (real followers)
      case 640: g().placeRalliedUnits(3); break;           // placeRallied (peels followers)
      case 650: g().togglePilotMonarchKind(); break;       // setPilot (sibling)
      case 660: g().pilotCycleMonarch(); break;            // setPilot (next animal)
      case 665: g().rallyToMonarch(); break;               // rallyMonarch (new animal's army)
      case 675: g().cycleFireTeam(); break;                // setPilotFireTeam (no-op w/o teams)
      case 685: g().clearPilot(); break;                   // setPilot null
      case 695: if (someMonarchId) g().pilotMonarchById(someMonarchId); break; // setPilot
      case 705: g().clearSelection(); break;               // releaseControl
      default: break;
    }
    // Keep the monarch moving while piloted so pilot state shows up in positions.
    if (tick >= 5 && tick < 685) drive(api, 1, 0);
    g().tick(DT, Date.now());
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
    console.log(`PASS: pilot-handle trajectory matches the committed baseline for all ${captured.ticks} ticks (digest ${captured.digest.slice(0, 12)}…).`);
    process.exit(0);
  }

  console.error(`FAIL: pilot-handle trajectory diverged from the baseline (fields: ${mismatch.join(', ')}).`);
  for (const k of mismatch) console.error(`  ${k}: expected ${GOLDEN[k]}  got ${captured[k]}`);
  console.error('If this change to sim behaviour is intentional, re-bless with CAPTURE_GOLDEN=1.');
  process.exit(1);
}

main().catch((error) => {
  console.error('FAIL: harness threw', error);
  process.exit(3);
});
