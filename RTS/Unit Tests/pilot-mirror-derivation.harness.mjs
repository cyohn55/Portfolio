/**
 * Pilot-mirror derivation harness (headless Node) — worker-offload T2 (pilot mirror).
 *
 * The simulation no longer writes the LOCAL player's pilot UI mirror
 * (`pilotedUnitId` / `pilotedFireTeamId`); those fields are now DERIVED on the main
 * thread from the authoritative per-owner maps by `syncLocalPilotMirror()` (HexGrid
 * runs it each frame after the tick). This guards that contract — which no
 * checksum-based harness can see, since the mirror is local UI and never enters
 * `computeStateChecksum`:
 *
 *   1. After a pilot gesture, the derived mirror equals `*ByOwner[localPlayerId]`.
 *   2. When the tick death-releases a piloted monarch (clears the `*ByOwner` slot),
 *      the derivation propagates that to the mirror — the field the HUD/camera read.
 *
 * Run from the RTS project root:
 *   node "Unit Tests/pilot-mirror-derivation.harness.mjs"
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
  const outfile = resolve(mkdtempSync(resolve(tmpdir(), 'pilot-mirror-')), 'store.mjs');
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

const failures = [];
const check = (label, cond) => {
  if (!cond) failures.push(label);
};

async function main() {
  const realLog = console.log;
  console.log = () => {};
  const api = await import(await bundleStore());
  const { useGameStore, useUiStore, dispatchCommand, syncLocalPilotMirror } = api;
  const g = () => useGameStore.getState();
  // The pilot mirror (pilotedUnitId / pilotedFireTeamId) lives on useUiStore (P1-1).
  const ui = () => useUiStore.getState();

  g().startMultiplayerMatch({ localRole: ROLE, seed: SEED, lineups: LINEUPS });
  const tick = () => { g().tick(DT, Date.now()); syncLocalPilotMirror(); };
  // Settle a few ticks so the opening is stable.
  for (let i = 0; i < 5; i++) tick();

  console.log = realLog;

  const aKing = g().units.find((u) => u.ownerId === ROLE && u.kind === 'King');
  if (!aKing) {
    console.error('FAIL: no local King to pilot — match did not start as expected.');
    process.exit(2);
  }

  // 1) Pilot a monarch via the command path, then derive: mirror tracks *ByOwner.
  dispatchCommand({ type: 'setPilot', payload: { unitId: aKing.id } });
  syncLocalPilotMirror();
  check('pilot sets *ByOwner[local]', g().pilotedUnitIdByOwner[ROLE] === aKing.id);
  check('derived pilotedUnitId equals *ByOwner[local]', ui().pilotedUnitId === aKing.id);

  // 2) Sanity: the mirror is DERIVED, not sim-written. Corrupt it, re-derive, and it
  //    snaps back to the authoritative value (proves syncLocalPilotMirror is the source).
  useUiStore.setState({ pilotedUnitId: 'bogus-id' });
  syncLocalPilotMirror();
  check('derivation corrects a stale mirror', ui().pilotedUnitId === aKing.id);

  // 3) Death-release: kill the piloted King the way the combat path marks a death
  //    (hp 0 + queued in deadUnitsToRemove, which gates the tick's death pass), then
  //    tick. The tick clears *ByOwner and the derivation must propagate that null.
  const king = g().units.find((u) => u.id === aKing.id);
  king.hp = 0;
  g().deadUnitsToRemove.push(king.id);
  tick();
  check('tick death-releases *ByOwner[local]', g().pilotedUnitIdByOwner[ROLE] === null);
  check('derived pilotedUnitId cleared on death', ui().pilotedUnitId === null);

  if (failures.length === 0) {
    console.log('PASS: pilot mirror is correctly derived from *ByOwner (incl. tick death-release).');
    process.exit(0);
  }
  console.error('FAIL: pilot mirror derivation broke these invariants:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

main().catch((error) => {
  console.error('FAIL: harness threw', error);
  process.exit(3);
});
