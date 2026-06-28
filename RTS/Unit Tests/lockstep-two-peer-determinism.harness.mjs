/**
 * TWO-PEER lockstep determinism harness (headless Node, no browser).
 *
 * Why this exists separately from lockstep-determinism.spec.ts: that spec replays
 * the SAME peer twice (one localPlayerId, one selection), so it can only catch
 * non-determinism that differs run-to-run on a single machine — never state that
 * differs BETWEEN the two peers. The "units won't move in multiplayer" bug lived
 * exactly there: the collision/separation passes (checkCollision,
 * separateOverlappingUnits, clearPathForSelectedRoyals) read `selectedUnitIds` and
 * `localPlayerId`, both of which differ per peer (each player selects only its own
 * units, selection is never networked, and localPlayerId is 'p0' on the host but
 * 'p1' on the guest). The peers resolved collisions differently, unit positions
 * drifted apart, and the desync checksum silently stopped the lockstep engine —
 * which players experienced as a frozen sim that ignored their move orders.
 *
 * This harness simulates the two real peers: run A is the host ('p0') with p0's
 * units selected locally, run B is the guest ('p1') with p1's units selected
 * locally. Both replay the IDENTICAL networked command stream (what lockstep
 * exchanges) with the command router armed, then it asserts byte-identical
 * per-tick checksums. It compares the engine against itself across the two roles,
 * so it stays valid as the simulation evolves and fails loudly the moment any
 * per-peer local state leaks back into the shared tick path.
 *
 * Run from the RTS project root:
 *   node "Unit Tests/lockstep-two-peer-determinism.harness.mjs"
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_ENTRY = resolve(HERE, '../src/game/state.ts');

const SEED = 0x1234abcd;
const TICKS = 600;
const DT = 1 / 60;
const LINEUPS = { p0: ['Bear', 'Fox', 'Bee'], p1: ['Cat', 'Owl', 'Frog'] };

// The Firebase-backed leaderboard modules are never on the per-tick path, but
// importing them pulls in @grpc, which uses dynamic require() and breaks under
// ESM in Node. Replace them with an empty module so only the simulation is bundled.
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
  const outfile = resolve(mkdtempSync(resolve(tmpdir(), 'lockstep-')), 'store.mjs');
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

function ownedNonBase(store, role) {
  return store
    .getState()
    .units.filter((u) => u.ownerId === role && u.kind !== 'Base')
    .map((u) => u.id);
}

// Run one peer end to end and return its per-tick checksum list.
function runPeer(api, localRole) {
  const { useGameStore, useUiStore, applyNetCommand, computeStateChecksum, setCommandRouter } = api;
  // Arm a dummy command router so the sim takes the lockstep path; commands still
  // apply via applyNetCommand, which bypasses the router by design.
  setCommandRouter(() => {});
  useGameStore.getState().startMultiplayerMatch({ localRole, seed: SEED, lineups: LINEUPS });

  // This peer selects only ITS OWN units locally — the per-peer UI state that must
  // no longer influence the shared simulation (now on useUiStore, P1-1; sim ignores it).
  useUiStore.getState().selectUnits(ownedNonBase(useGameStore, localRole));

  const p0Units = ownedNonBase(useGameStore, 'p0');
  const p1Units = ownedNonBase(useGameStore, 'p1');

  const perTick = [];
  for (let tick = 1; tick <= TICKS; tick++) {
    // Identical ordered command stream on both peers, exercising friendly
    // push-through and the royal make-way shove for both sides.
    if (tick === 120) {
      applyNetCommand('p0', { type: 'moveUnits', payload: { unitIds: p0Units, target: { x: 0, y: 0.25, z: 0 } } });
    }
    if (tick === 200) {
      applyNetCommand('p1', { type: 'moveUnits', payload: { unitIds: p1Units, target: { x: 0, y: 0.25, z: 5 } } });
    }
    useGameStore.getState().tick(DT, Date.now());
    perTick.push(computeStateChecksum());
  }
  setCommandRouter(null);
  return perTick;
}

async function main() {
  // Silence the simulation's verbose console.log during the run; restore after.
  const realLog = console.log;
  console.log = () => {};
  const api = await import(await bundleStore());
  const runHost = runPeer(api, 'p0');
  const runGuest = runPeer(api, 'p1');
  const finalUnits = api.useGameStore.getState().units.length;
  console.log = realLog;

  if (finalUnits === 0) {
    console.error('FAIL: no units simulated — the match did not start.');
    process.exit(2);
  }

  const firstDivergence = runHost.findIndex((hash, i) => hash !== runGuest[i]);
  if (firstDivergence === -1) {
    console.log(`PASS: host (p0) and guest (p1) produced byte-identical state for all ${TICKS} ticks.`);
    process.exit(0);
  }

  console.error(`FAIL: peers diverged at tick ${firstDivergence + 1}`);
  console.error(`  host : ${runHost[firstDivergence]}`);
  console.error(`  guest: ${runGuest[firstDivergence]}`);
  process.exit(1);
}

main().catch((error) => {
  console.error('FAIL: harness threw', error);
  process.exit(3);
});
