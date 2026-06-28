/**
 * dispatchCommand equivalence harness (headless Node, no browser).
 *
 * `dispatchCommand` (state.ts) is the new single funnel for locally-issued human
 * input — the input layer hands it a serializable NetCommand instead of calling
 * typed store methods, so the eventual worker split is a one-function change. This
 * harness proves that consolidation is behaviour-neutral: issuing a scripted
 * command stream through `dispatchCommand` must drive the simulation to exactly the
 * same per-tick state as issuing the identical stream through `applyNetCommand`
 * (the authoritative apply path used by lockstep/AI/replay).
 *
 * Both paths ultimately run the same apply logic; the only differences are local
 * mirror/routing bookkeeping, none of which the determinism checksum observes. So
 * byte-identical checksums across the two runs confirm `dispatchCommand` is a true
 * pass-through for every command family it covers — gameplay AND pilot/control.
 *
 * It compares the engine against itself (no hard-coded positions), so it stays
 * valid as the simulation evolves and fails the moment dispatchCommand diverges
 * from the authoritative path for any command type.
 *
 * Run from the RTS project root:
 *   node "Unit Tests/dispatch-command-equivalence.harness.mjs"
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_ENTRY = resolve(HERE, '../src/game/state.ts');

const SEED = 0x1234abcd;
const TICKS = 300;
const DT = 1 / 60;
const ROLE = 'p0';
const LINEUPS = { p0: ['Bear', 'Fox', 'Bee'], p1: ['Cat', 'Owl', 'Frog'] };

// The Firebase-backed leaderboard modules are never on the per-tick path, but
// importing them pulls in @grpc, which breaks under ESM in Node. Stub them out so
// only the simulation is bundled (mirrors the other determinism harnesses).
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
  const outfile = resolve(mkdtempSync(resolve(tmpdir(), 'dispatch-')), 'store.mjs');
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

/**
 * Build the scripted command stream for a started match. Resolved once from live
 * unit ids (deterministic across runs because the seed + lineups are fixed), then
 * replayed identically by both the dispatchCommand run and the applyNetCommand run.
 * Exercises gameplay commands (moveUnits) AND the pilot/control branch (setPilot,
 * a continuous pilotMove drive, releaseControl) — the two structurally different
 * paths inside dispatchCommand.
 */
function buildScript(store) {
  const units = ownedNonBase(store, ROLE);
  const monarch = firstMonarch(store, ROLE);
  const byTick = new Map();
  const at = (tick, ...cmds) => byTick.set(tick, [...(byTick.get(tick) ?? []), ...cmds]);

  at(60, { type: 'moveUnits', payload: { unitIds: units, target: { x: 0, y: 0.25, z: 0 } } });
  if (monarch) {
    at(90, { type: 'setPilot', payload: { unitId: monarch } });
    for (let t = 91; t <= 150; t++) at(t, { type: 'pilotMove', payload: { x: 1, z: 0 } });
    at(151, { type: 'releaseControl', payload: {} });
  }
  at(200, { type: 'moveUnits', payload: { unitIds: units, target: { x: 5, y: 0.25, z: 5 } } });
  return byTick;
}

// Run a full match, issuing each scripted command through `issue(command)`, and
// return the per-tick checksum list.
function runMatch(api, issue) {
  const { useGameStore, computeStateChecksum } = api;
  useGameStore.getState().startMultiplayerMatch({ localRole: ROLE, seed: SEED, lineups: LINEUPS });
  // Select own units locally, like a real player — never networked, never checksummed.
  useGameStore.getState().selectUnits(ownedNonBase(useGameStore, ROLE));

  const script = buildScript(useGameStore);
  const perTick = [];
  for (let tick = 1; tick <= TICKS; tick++) {
    for (const command of script.get(tick) ?? []) issue(command);
    useGameStore.getState().tick(DT, Date.now());
    perTick.push(computeStateChecksum());
  }
  return perTick;
}

async function main() {
  const realLog = console.log;
  console.log = () => {};
  const api = await import(await bundleStore());

  // Run A: the new local-input funnel. No command router armed, so dispatchCommand
  // applies locally (single-player), the path real human input takes.
  const viaDispatch = runMatch(api, (command) => api.dispatchCommand(command));

  // Run B: the authoritative apply path, attributing every command to the same owner.
  const viaApplyNet = runMatch(api, (command) => api.applyNetCommand(ROLE, command));

  const finalUnits = api.useGameStore.getState().units.length;
  console.log = realLog;

  if (typeof api.dispatchCommand !== 'function') {
    console.error('FAIL: dispatchCommand is not exported from state.ts');
    process.exit(2);
  }
  if (finalUnits === 0) {
    console.error('FAIL: no units simulated — the match did not start.');
    process.exit(2);
  }

  const divergence = viaDispatch.findIndex((hash, i) => hash !== viaApplyNet[i]);
  if (divergence === -1) {
    console.log(`PASS: dispatchCommand and applyNetCommand produced byte-identical state for all ${TICKS} ticks.`);
    process.exit(0);
  }

  console.error(`FAIL: paths diverged at tick ${divergence + 1}`);
  console.error(`  dispatchCommand : ${viaDispatch[divergence]}`);
  console.error(`  applyNetCommand : ${viaApplyNet[divergence]}`);
  process.exit(1);
}

main().catch((error) => {
  console.error('FAIL: harness threw', error);
  process.exit(3);
});
