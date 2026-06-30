/**
 * Sim-worker pilot-drive harness (headless Node) — guards the single-player worker-flip
 * monarch/fire-team drive path.
 *
 * THE BUG THIS GUARDS: under the single-player sim-worker flip, the per-frame monarch-drive
 * vector lives in the MAIN thread's `pilotInput` singleton (fed by the keyboard/stick). The
 * worker runs the authoritative tick but has no input devices of its own, so its own
 * `pilotInput` stays zero. The drive vector was shipped to the worker only for MULTIPLAYER
 * (`netUpdate.pilot`); the single-player `runTicks` request omitted it. Result: `setPilot`
 * was forwarded (the monarch is selected and the camera follows), but the worker's
 * `pilotMoveByOwner` never received the drive vector, so a piloted King/Queen — and likewise
 * a driven fire team — could be selected yet never move. The fix ships `pilot` with
 * `runTicks` and rides it onto the worker's `pilotInput` before each tick, mirroring the
 * multiplayer path.
 *
 * Unlike sim-worker-determinism.harness.mjs (which drives piloting through explicit
 * `pilotMove` COMMANDS — a path that never exercised the bug), this harness drives through
 * the REAL gameplay channel: `runTicks { pilot }`. It asserts a piloted monarch advances
 * along the drive direction when piloted, and holds station when the vector is zero.
 *
 * Run from the RTS project root:
 *   node "Unit Tests/sim-worker-pilot-drive.harness.mjs"
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_ENTRY = resolve(HERE, '../src/components/Working/sim/simWorkerHost.ts');

const SEED = 0x1234abcd;
const NOW = 1_000; // wall clock; the sim overrides it with its tick-derived clock
const ROLE = 'p0';
const LINEUPS = { p0: ['Bear', 'Fox', 'Bee'], p1: ['Cat', 'Owl', 'Frog'] };
const DRIVE_TICKS = 90;
// A piloted monarch driven hard along +x for 90 ticks must clearly outrun any incidental
// drift; the in-thread fire-team-drive harness sees ~5–10u over a comparable window.
const MIN_EXPECTED_ADVANCE = 3.0;
const MAX_IDLE_DRIFT = 0.5;

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

async function bundleHost() {
  const outfile = resolve(mkdtempSync(resolve(tmpdir(), 'sim-worker-pilot-')), 'host.mjs');
  await build({
    entryPoints: [HOST_ENTRY],
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

const firstMonarch = (store, role) =>
  store.getState().units.find((u) => u.ownerId === role && (u.kind === 'King' || u.kind === 'Queen')) ?? null;
const monarchPos = (store, id) => {
  const u = store.getState().units.find((unit) => unit.id === id);
  return u ? { x: u.position.x, z: u.position.z } : null;
};

const failures = [];
const check = (label, cond, detail) => {
  if (cond) console.log(`PASS  ${label}${detail ? `  ${detail}` : ''}`);
  else { console.log(`FAIL  ${label}${detail ? `  ${detail}` : ''}`); failures.push(label); }
};

// Advance the worker N ticks with a fixed per-frame drive vector, exactly as the real loop
// posts runTicks each animation frame, and return the net displacement of `monarchId`.
function driveAndMeasure(api, store, monarchId, pilot) {
  const before = monarchPos(store, monarchId);
  for (let i = 0; i < DRIVE_TICKS; i++) {
    api.processSimRequest({ kind: 'runTicks', count: 1, nowMs: NOW, pilot });
  }
  const after = monarchPos(store, monarchId);
  return { advanceX: after.x - before.x, totalXZ: Math.hypot(after.x - before.x, after.z - before.z) };
}

async function main() {
  const realLog = console.log;
  console.log = () => {};
  const api = await import(await bundleHost());
  const { processSimRequest, useGameStore } = api;

  processSimRequest({ kind: 'start', localRole: ROLE, seed: SEED, lineups: LINEUPS });
  const monarch = firstMonarch(useGameStore, ROLE);

  // Grab the monarch (the real setPilot gesture) so the tick's pilot-drive branch runs.
  processSimRequest({ kind: 'command', command: { type: 'setPilot', payload: { unitId: monarch?.id ?? null } } });

  // 1) Driven along +x via the runTicks pilot vector, the piloted monarch must advance.
  const driven = driveAndMeasure(api, useGameStore, monarch.id, { x: 1, z: 0 });

  // 2) With a zero vector the same piloted monarch holds station (no auto-AI drift) — proof
  //    the movement above came from the shipped vector, not some other mover.
  const idle = driveAndMeasure(api, useGameStore, monarch.id, { x: 0, z: 0 });

  console.log = realLog;

  check('a monarch was spawned to pilot', monarch !== null, monarch ? `(${monarch.id})` : '(none)');
  check(
    'piloted monarch advances along the runTicks drive vector',
    driven.advanceX >= MIN_EXPECTED_ADVANCE,
    `mean +x = ${driven.advanceX.toFixed(3)} (need ≥ ${MIN_EXPECTED_ADVANCE})`,
  );
  check(
    'piloted monarch holds station with a zero drive vector',
    idle.totalXZ <= MAX_IDLE_DRIFT,
    `drift = ${idle.totalXZ.toFixed(3)} (need ≤ ${MAX_IDLE_DRIFT})`,
  );

  console.log('');
  if (failures.length > 0) {
    console.log(`FAIL: ${failures.length} assertion(s) failed — the worker single-player drive path is broken.`);
    process.exit(1);
  }
  console.log('PASS: the single-player worker rides the runTicks pilot vector onto the tick — piloted units move.');
}

main().catch((err) => { console.error(err); process.exit(1); });
