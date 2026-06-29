/**
 * Sim-worker determinism harness (headless Node) — worker-offload P1-2.
 *
 * Proves the worker message pipeline is LOSSLESS and deterministic: a match driven purely
 * through the worker host's request API (`processSimRequest` start/command/runTicks) +
 * read back through `buildSimSnapshot` reproduces, tick for tick, the SAME checksum
 * trajectory as the in-thread `sim-checksum-baseline` golden. Because the host only
 * forwards to the store's existing deterministic actions, message-driven === in-thread —
 * this guards that the protocol/serialization seam never perturbs the simulation, the
 * core risk of Option B's "extract the sim into a worker" before the live loop is flipped.
 *
 * It also asserts the posted snapshot is structured-cloneable (no class instances / no RNG
 * or spatial grid leak across the wire) and that cloning preserves the checksummed unit
 * fields — i.e. the snapshot the main-thread mirror would ingest is faithful.
 *
 * The script + seed + lineups are byte-identical to sim-checksum-baseline.harness.mjs, and
 * the asserted digest is that harness's committed GOLDEN — so this fails loudly if the
 * worker host diverges from the in-thread path OR the baseline sim trajectory changes.
 *
 * Run from the RTS project root:
 *   node "Unit Tests/sim-worker-determinism.harness.mjs"
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_ENTRY = resolve(HERE, '../src/components/Working/sim/simWorkerHost.ts');

const SEED = 0x1234abcd;
const TICKS = 300;
const NOW = 1_000; // wall clock; the sim overrides it with its tick-derived clock
const ROLE = 'p0';
const LINEUPS = { p0: ['Bear', 'Fox', 'Bee'], p1: ['Cat', 'Owl', 'Frog'] };

// The committed digest from sim-checksum-baseline.harness.mjs (its in-thread golden). The
// worker-driven run must reproduce it exactly. Keep in sync if that baseline is re-blessed.
const BASELINE = {
  ticks: 300,
  digest: '174f32a000b210c049ffbc5c9deb6069e88394bb66c440d23d49668678af26a2',
  finalChecksum:
    't300#rng2513078436#B-0|p0|Base|760.000|73.500|252.000;B-12|p1|Base|360.000|1.000|-248.000;B-15|p1|Base|480.000|-74.000|-248.000;B-3|p0|Base|720.000|-2.000|252.000;B-6|p0|Base|320.000|-77.000|252.000;B-9|p1|Base|520.000|76.500|-248.000;K-11|p1|King|195.000|72.500|-232.000;K-14|p1|King|135.000|-3.000|-232.000;K-17|p1|King|180.000|-78.000|-232.000;K-2|p0|King|285.000|62.200|209.123;K-5|p0|King|270.000|-4.540|187.276;K-8|p0|King|120.000|-58.697|170.019;Q-1|p0|Queen|190.000|69.611|209.908;Q-10|p1|Queen|130.000|80.500|-232.000;Q-13|p1|Queen|90.000|5.000|-232.000;Q-16|p1|Queen|120.000|-70.000|-232.000;Q-4|p0|Queen|180.000|2.390|148.244;Q-7|p0|Queen|80.000|-34.002|117.054;U-18|p0|Unit|95.000|72.797|210.107;U-19|p0|Unit|90.000|5.516|148.608;U-20|p0|Unit|40.000|-31.071|117.537;U-21|p1|Unit|65.000|83.938|-232.000;U-22|p1|Unit|45.000|8.125|-232.000;U-23|p1|Unit|60.000|-66.563|-232.000',
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

async function bundleHost() {
  const outfile = resolve(mkdtempSync(resolve(tmpdir(), 'sim-worker-')), 'host.mjs');
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

const ownedNonBase = (store, role) =>
  store.getState().units.filter((u) => u.ownerId === role && u.kind !== 'Base').map((u) => u.id);
const firstMonarch = (store, role) =>
  store.getState().units.find((u) => u.ownerId === role && (u.kind === 'King' || u.kind === 'Queen'))?.id ?? null;

// Byte-identical to sim-checksum-baseline.harness.mjs's buildScript.
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

const failures = [];
const check = (label, cond) => { if (!cond) failures.push(label); };

async function main() {
  const realLog = console.log;
  console.log = () => {};
  const api = await import(await bundleHost());
  const { processSimRequest, buildSimSnapshot, ingestSimSnapshot, decodeUnits, useGameStore } = api;

  // Drive the whole match through the worker host's request API, exactly as the main
  // thread would post messages: start, then per tick { commands…, runTicks 1 }.
  processSimRequest({ kind: 'start', localRole: ROLE, seed: SEED, lineups: LINEUPS });
  const script = buildScript(useGameStore);

  const perTick = [];
  let lastSnapshot = null;
  for (let tick = 1; tick <= TICKS; tick++) {
    for (const command of script.get(tick) ?? []) {
      processSimRequest({ kind: 'command', command });
    }
    processSimRequest({ kind: 'runTicks', count: 1, nowMs: NOW });
    lastSnapshot = buildSimSnapshot();
    perTick.push(lastSnapshot.checksum);
  }
  console.log = realLog;

  const digest = createHash('sha256').update(perTick.join('\n')).digest('hex');

  // 1) The message-driven trajectory must equal the in-thread baseline golden, tick for
  //    tick — proof the host + protocol are a lossless, deterministic driver of the sim.
  check(`drove ${TICKS} ticks`, perTick.length === BASELINE.ticks);
  check('final-tick checksum matches the in-thread baseline', perTick[perTick.length - 1] === BASELINE.finalChecksum);
  check('per-tick digest matches the in-thread baseline', digest === BASELINE.digest);

  // 2) The posted snapshot must survive structured clone (no RNG / spatial-grid / class
  //    instances leaking across the wire) and preserve the checksummed unit fields, so the
  //    main-thread mirror would ingest a faithful copy.
  let cloned = null;
  try {
    cloned = structuredClone(lastSnapshot);
  } catch (error) {
    failures.push(`snapshot is not structured-cloneable: ${error?.message ?? error}`);
  }
  if (cloned) {
    const liveUnits = useGameStore.getState().units;
    // P1-4: units cross the wire structure-of-arrays encoded — hot columns in a transferable
    // Float32Array + lean cold objects. Decode the cloned snapshot and assert fidelity.
    const clonedUnits = decodeUnits(cloned.unitsHot, cloned.unitsCold);
    check('snapshot carries every unit (decoded)', clonedUnits.length === liveUnits.length);
    const samePositions = clonedUnits.every((u, i) =>
      u.id === liveUnits[i].id &&
      u.position.x === liveUnits[i].position.x &&
      u.position.y === liveUnits[i].position.y &&
      u.position.z === liveUnits[i].position.z &&
      u.rotation === liveUnits[i].rotation &&
      u.hp === liveUnits[i].hp);
    check('decoded snapshot preserves unit id/position/rotation/hp', samePositions);
    check('hot columns are a transferable ArrayBuffer', cloned.unitsHot.buffer instanceof ArrayBuffer);
    check('hot columns are packed (count*stride, f64)', cloned.unitsHot.buffer.byteLength === cloned.unitsHot.count * cloned.unitsHot.stride * 8);
    check('cold objects drop the sim-internal A* path cache', cloned.unitsCold.every((c) => !('pathWaypoints' in c) && !('pathIndex' in c)));
    check('snapshot state does NOT carry the units array', !('units' in cloned.state));
    check('snapshot does NOT carry the RNG instance', !('rng' in cloned.state));
    check('snapshot does NOT carry the spatial grid', !('spatialGrid' in cloned.state));
    check('snapshot checksum matches the final tick', cloned.checksum === perTick[perTick.length - 1]);
  }

  // 3) Snapshot → mirror ingest round-trip. This is what the live bridge does each frame:
  //    the worker posts a snapshot, the main thread ingests it into the read-only mirror.
  //    Take a (cloned, as-if-posted) snapshot, advance the sim further so the store diverges,
  //    then ingest the snapshot back and assert the store's Bucket-A fields are restored to
  //    the snapshot exactly — proof ingest faithfully reconstructs the mirror from plain data.
  if (cloned) {
    // The snapshot's units as the bridge would reconstruct them.
    const snapshotUnits = decodeUnits(cloned.unitsHot, cloned.unitsCold);

    const consoleOff = console.log; console.log = () => {};
    for (let i = 0; i < 30; i++) processSimRequest({ kind: 'runTicks', count: 1, nowMs: NOW });
    console.log = consoleOff;
    const advancedTick = useGameStore.getState().tickCounter;
    check('store advanced past the snapshot before ingest', advancedTick > cloned.tickCounter);

    ingestSimSnapshot(cloned);
    const mirror = useGameStore.getState();
    check('ingest restores tickCounter', mirror.tickCounter === cloned.tickCounter);
    check('ingest restores player count', mirror.players.length === cloned.state.players.length);
    const restoredUnits = mirror.units.length === snapshotUnits.length &&
      mirror.units.every((u, i) =>
        u.id === snapshotUnits[i].id &&
        u.position.x === snapshotUnits[i].position.x &&
        u.position.z === snapshotUnits[i].position.z &&
        u.hp === snapshotUnits[i].hp);
    check('ingest restores every unit id/position/hp from the snapshot', restoredUnits);
    check('ingest restores matchStats', JSON.stringify(mirror.matchStats) === JSON.stringify(cloned.state.matchStats));
  }

  if (failures.length === 0) {
    console.log(`PASS: worker-driven sim reproduces the in-thread baseline for all ${TICKS} ticks (digest ${digest.slice(0, 12)}…) and posts a faithful, cloneable snapshot.`);
    process.exit(0);
  }
  console.error('FAIL: worker pipeline broke these invariants:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

main().catch((error) => {
  console.error('FAIL: harness threw', error);
  process.exit(3);
});
