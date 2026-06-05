/**
 * TWO-PEER monarch-PILOTING determinism harness (headless Node, no browser).
 *
 * Companion to lockstep-two-peer-determinism.harness.mjs. That harness proves the
 * base simulation stays in lockstep across the two roles; this one proves the
 * monarch-piloting feature does too, now that it is networked rather than disabled
 * in multiplayer.
 *
 * Monarch piloting is the one input that is NOT a discrete gesture: the drive
 * vector changes every tick, so the lockstep engine appends a `pilotMove` command
 * to every outgoing frame and each peer drives BOTH players' piloted monarchs from
 * the received per-owner vectors. The risk is that any of the pilot state
 * (pilotedUnitIdByOwner / pilotMoveByOwner / the per-owner tick branch) leaks a
 * peer-local value into the shared tick path and silently desyncs the match.
 *
 * The harness simulates the two real peers: run A is the host ('p0'), run B is the
 * guest ('p1'). Both replay the IDENTICAL networked command stream — each peer
 * starts piloting its own animal-0 monarch, then both monarchs are driven every
 * tick by a deterministic, owner-specific drive vector (exactly what the engine
 * would ship as per-frame pilotMove commands), with a rally and a control release
 * mixed in. It then asserts byte-identical per-tick checksums across the two roles.
 * Because piloting moves a unit, a desync shows up as drifting monarch positions in
 * the checksum and fails loudly.
 *
 * Run from the RTS project root:
 *   node "Unit Tests/lockstep-pilot-determinism.harness.mjs"
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_ENTRY = resolve(HERE, '../src/game/state.ts');

const SEED = 0x5eed1234;
const TICKS = 600;
const DT = 1 / 60;
const LINEUPS = { p0: ['Bear', 'Fox', 'Bee'], p1: ['Cat', 'Owl', 'Frog'] };

// Tick at which each peer grabs (pilots) the King of its first animal.
const PILOT_START_TICK = 60;
// Tick at which each peer toggles a rally onto its piloted monarch.
const RALLY_TICK = 180;
// Tick at which each peer fully releases control (deselect semantics).
const RELEASE_TICK = 480;

// Same leaderboard stub as the sibling harness: importing the Firebase modules
// pulls in @grpc's dynamic require(), which breaks under ESM in Node.
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
  const outfile = resolve(mkdtempSync(resolve(tmpdir(), 'lockstep-pilot-')), 'store.mjs');
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

// The King of an owner's first-lineup animal — the monarch each peer pilots.
function firstKingId(store, role, animal) {
  const king = store
    .getState()
    .units.find((u) => u.ownerId === role && u.kind === 'King' && u.animal === animal);
  return king ? king.id : null;
}

// A deterministic, owner-specific drive vector for a tick: a slow circular sweep
// so the two owners push their monarchs in different, time-varying directions —
// any per-peer leak in how the vector is applied diverges the positions.
function driveVector(role, tick) {
  const phase = (role === 'p0' ? 0 : Math.PI / 2) + tick * 0.05;
  return { x: Math.cos(phase), z: Math.sin(phase) };
}

// Run one peer end to end and return its per-tick checksum list.
function runPeer(api, localRole) {
  const { useGameStore, applyNetCommand, computeStateChecksum, setCommandRouter } = api;
  // Arm a dummy router so the sim takes the lockstep path; commands still apply
  // via applyNetCommand, which bypasses the router by design.
  setCommandRouter(() => {});
  useGameStore.getState().startMultiplayerMatch({ localRole, seed: SEED, lineups: LINEUPS });

  // Each peer selects only its own units locally — the per-peer UI state that must
  // never influence the shared simulation.
  const ownNonBase = useGameStore
    .getState()
    .units.filter((u) => u.ownerId === localRole && u.kind !== 'Base')
    .map((u) => u.id);
  useGameStore.getState().selectUnits(ownNonBase);

  const p0King = firstKingId(useGameStore, 'p0', LINEUPS.p0[0]);
  const p1King = firstKingId(useGameStore, 'p1', LINEUPS.p1[0]);

  const perTick = [];
  for (let tick = 1; tick <= TICKS; tick++) {
    // --- Discrete pilot gestures (both peers, identical stream) ---------------
    if (tick === PILOT_START_TICK) {
      applyNetCommand('p0', { type: 'setPilot', payload: { unitId: p0King } });
      applyNetCommand('p1', { type: 'setPilot', payload: { unitId: p1King } });
    }
    if (tick === RALLY_TICK) {
      applyNetCommand('p0', { type: 'rallyMonarch', payload: { monarchId: p0King } });
      applyNetCommand('p1', { type: 'rallyMonarch', payload: { monarchId: p1King } });
    }
    if (tick === RELEASE_TICK) {
      applyNetCommand('p0', { type: 'releaseControl', payload: {} });
      applyNetCommand('p1', { type: 'releaseControl', payload: {} });
    }

    // --- Per-frame drive vector (what the engine ships every tick) ------------
    // Only meaningful while each owner is actively piloting; sending it always
    // mirrors the engine, which appends pilotMove to every frame.
    const driving = tick >= PILOT_START_TICK && tick < RELEASE_TICK;
    if (driving) {
      applyNetCommand('p0', { type: 'pilotMove', payload: driveVector('p0', tick) });
      applyNetCommand('p1', { type: 'pilotMove', payload: driveVector('p1', tick) });
    }

    useGameStore.getState().tick(DT, Date.now());
    perTick.push(computeStateChecksum());
  }
  setCommandRouter(null);
  return perTick;
}

async function main() {
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
    console.log(`PASS: piloted host (p0) and guest (p1) produced byte-identical state for all ${TICKS} ticks.`);
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
