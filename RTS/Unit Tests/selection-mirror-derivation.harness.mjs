/**
 * Selection-mirror derivation harness (headless Node) — worker-offload T2 (selection +
 * placement mirror).
 *
 * The simulation no longer writes the LOCAL player's selection / placement UI mirror
 * (`selectedUnitIds`, `unitPlacementCount`, `unitPlacementCursor`) — those are
 * Bucket-C-local fields the worker-bound sim must not touch. Two main-thread passes,
 * run each frame after the tick (HexGrid's loop), keep them in sync:
 *
 *   - `syncLocalSelectionMirror()` folds a JUST-SPAWNED reinforcement that fell in
 *     behind a currently-selected monarch into the selection — the heir to the old
 *     in-tick spawn auto-select. It only ADDS (so a hand-deselected unit is NOT
 *     re-added), only for units that appeared THIS frame, and only when their monarch
 *     is selected.
 *   - `syncLocalPilotMirror()` (extended) clears the placement teardrop + drive intent
 *     when a sim event (e.g. a tick death-release of the piloted monarch) leaves the
 *     local player driving nothing — the reset that used to live inline in
 *     stopOwnerPilot.
 *
 * This guards those contracts directly, since neither field enters
 * `computeStateChecksum` (both are local UI) and so no checksum harness can see them.
 *
 * Run from the RTS project root:
 *   node "Unit Tests/selection-mirror-derivation.harness.mjs"
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
  const outfile = resolve(mkdtempSync(resolve(tmpdir(), 'selection-mirror-')), 'store.mjs');
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
  const { useGameStore, useUiStore, dispatchCommand, syncLocalPilotMirror, syncLocalSelectionMirror } = api;
  const g = () => useGameStore.getState();
  // Placement teardrop state lives on useUiStore (local-UI, P1-1), not the sim store.
  const ui = () => useUiStore.getState();
  const tick = () => {
    g().tick(DT, Date.now());
    syncLocalPilotMirror();
    syncLocalSelectionMirror();
  };

  g().startMultiplayerMatch({ localRole: ROLE, seed: SEED, lineups: LINEUPS });
  for (let i = 0; i < 5; i++) tick(); // settle the opening

  // A local Queen and the friendly King of the SAME animal, so the Queen's
  // reinforcements naturally fall in behind that King under a follow-rally.
  const queen = g().units.find((u) => u.ownerId === ROLE && u.kind === 'Queen');
  const king = queen
    ? g().units.find((u) => u.ownerId === ROLE && u.kind === 'King' && u.animal === queen.animal)
    : null;
  if (!queen || !king) {
    console.log = realLog;
    console.error('FAIL: no local Queen + same-animal King — match did not start as expected.');
    process.exit(2);
  }

  // Rally the Queen's spawns to follow the King, and select the King. A reinforcement
  // spawned now follows the King; because the King is selected, the derivation must
  // fold the newborn into the selection.
  dispatchCommand({ type: 'setQueenRally', payload: { queenId: queen.id, target: { mode: 'follow', monarchId: king.id } } });
  ui().selectUnits([king.id]);
  syncLocalSelectionMirror(); // establish the previous-frame baseline with only the King selected

  // Force the Queen to spawn on the very next tick by back-dating her last-spawn clock
  // past the spawn interval, instead of waiting the full ~5s of ticks.
  useGameStore.setState({
    lastSpawnAtMsByQueenId: { ...g().lastSpawnAtMsByQueenId, [queen.id]: -g().config.spawnIntervalMs },
  });

  const unitCountBefore = g().units.length;
  tick(); // the spawn tick — followers appear, then the derivation runs

  const newFollowers = g().units.filter(
    (u) => u.ownerId === ROLE && u.kind === 'Unit' && u.followMonarchId === king.id
  );
  check('a reinforcement actually spawned this tick', g().units.length > unitCountBefore && newFollowers.length > 0);

  // 1) Spawn auto-select: every newborn following the selected King is now selected.
  const selectedAfterSpawn = new Set(ui().selectedUnitIds);
  check('king stays selected', selectedAfterSpawn.has(king.id));
  check('new followers folded into selection', newFollowers.every((u) => selectedAfterSpawn.has(u.id)));

  // 2) Only ADDS: a hand-deselect sticks. Drop the followers back to just the King; a
  //    further frame with no NEW spawn must not re-add the units the player deselected.
  ui().selectUnits([king.id]);
  tick(); // no forced spawn this tick
  check('hand-deselected followers are not re-added', ui().selectedUnitIds.length === 1 && ui().selectedUnitIds[0] === king.id);

  // 3) Not-selected monarch: a newborn does NOT join the selection when its monarch
  //    isn't selected. Select an unrelated unit (or nothing-relevant), force another
  //    spawn, and confirm the new follower is absent from the selection.
  const bystander = g().units.find((u) => u.ownerId === ROLE && u.kind === 'Unit' && u.followMonarchId !== king.id);
  ui().selectUnits(bystander ? [bystander.id] : []);
  syncLocalSelectionMirror(); // re-baseline with the King deselected
  useGameStore.setState({
    lastSpawnAtMsByQueenId: { ...g().lastSpawnAtMsByQueenId, [queen.id]: -g().config.spawnIntervalMs },
  });
  const idsBeforeUnselectedSpawn = new Set(g().units.map((u) => u.id));
  tick();
  const spawnedWhileUnselected = g().units.filter(
    (u) => !idsBeforeUnselectedSpawn.has(u.id) && u.ownerId === ROLE && u.followMonarchId === king.id
  );
  const selectionNow = new Set(ui().selectedUnitIds);
  check('spawn while monarch unselected does not auto-select', spawnedWhileUnselected.every((u) => !selectionNow.has(u.id)));

  // 4) Placement clear on death-release: while piloting the King with an active
  //    placement teardrop, killing the King (sim death-release) must clear the local
  //    placement mirror + drive intent via the pilot-mirror sync.
  dispatchCommand({ type: 'setPilot', payload: { unitId: king.id } });
  syncLocalPilotMirror();
  ui().setUnitPlacementCount(5);
  ui().setUnitPlacementCursor({ x: 1, y: 0, z: 1 });
  check('piloting the King is derived', g().pilotedUnitId === king.id);

  const livingKing = g().units.find((u) => u.id === king.id);
  livingKing.hp = 0;
  g().deadUnitsToRemove.push(king.id);
  tick(); // death pass clears *ByOwner; the sync derives null + clears placement

  console.log = realLog;

  check('pilot cleared on King death', g().pilotedUnitId === null);
  check('placement count cleared on death-release', ui().unitPlacementCount === 0);
  check('placement cursor cleared on death-release', ui().unitPlacementCursor === null);

  if (failures.length === 0) {
    console.log('PASS: selection + placement mirrors are correctly derived main-thread (spawn auto-select, add-only, monarch-gated, death-release placement clear).');
    process.exit(0);
  }
  console.error('FAIL: selection/placement derivation broke these invariants:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

main().catch((error) => {
  console.error('FAIL: harness threw', error);
  process.exit(3);
});
