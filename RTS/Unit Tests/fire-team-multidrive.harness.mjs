/**
 * FIRE-TEAM MULTI-DRIVE harness (headless Node, no browser).
 *
 * Guards the new keyboard "Fire Team Overlay" capability: confirming the overlay with
 * SEVERAL fire teams selected hands the player drive control over all of them at once
 * (setPilotFireTeam with multiple teamIds), and the Move keys then steer every selected
 * team together. Before this change pilotedFireTeamByOwner held a single team id, so
 * only one team could ever be driven.
 *
 * It drives the SIMULATION path directly — the exact commands the overlay issues
 * (setPilotFireTeam with two teamIds + per-tick pilotMove) — and asserts BOTH teams
 * advance along the +x drive direction. It then replays the identical seed + command
 * script a SECOND time and asserts byte-identical per-tick checksums, proving the
 * multi-team drive set is deterministic (the prerequisite for lockstep multiplayer).
 *
 * Run from the RTS project root:
 *   node "Unit Tests/fire-team-multidrive.harness.mjs"
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_ENTRY = resolve(HERE, '../src/game/state.ts');

const SEED = 0x5eed1234;
const DT = 1 / 60;
const DRIVE_TICKS = 90;
const LINEUPS = { p0: ['Bear', 'Fox', 'Bee'], p1: ['Cat', 'Owl', 'Frog'] };
const TEAM_IDS = ['FT-1', 'FT-2'];
// Same "is it steerable" floor as the single-team drive harness.
const MIN_DRIVE_DISPLACEMENT = 5;

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
  const outfile = resolve(mkdtempSync(resolve(tmpdir(), 'fire-team-multidrive-')), 'store.mjs');
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

// Synthesize two fire teams (3 members each) for an owner from its King template,
// stamping each with a distinct fireTeamId. Returns { teamId -> memberIds }.
function formTwoFireTeams(useGameStore, ownerId) {
  const state = useGameStore.getState();
  const template = state.units.find((u) => u.ownerId === ownerId && u.kind === 'King');
  if (!template) return null;
  const newUnits = [];
  const byTeam = {};
  TEAM_IDS.forEach((teamId, team) => {
    const ids = [0, 1, 2].map((i) => `${ownerId}-${teamId}-${i}`);
    byTeam[teamId] = ids;
    ids.forEach((id, i) => {
      newUnits.push({
        ...template,
        id,
        kind: 'Unit',
        fireTeamId: teamId,
        followMonarchId: undefined,
        // Park each team on its own row so the two never overlap.
        position: { x: template.position.x + i * 4, y: 0, z: template.position.z + 20 + team * 12 },
        anchor: { x: template.position.x + i * 4, y: 0, z: template.position.z + 20 + team * 12 },
      });
    });
  });
  useGameStore.setState({ units: [...state.units, ...newUnits] });
  return byTeam;
}

// Drive BOTH of an owner's teams with one multi-team setPilotFireTeam + a +x pilotMove
// each tick. Returns { meanDriveX per team, checksums per tick }.
function runMultiDrive(api, ownerId) {
  const { useGameStore, applyNetCommand, setCommandRouter, computeStateChecksum } = api;

  setCommandRouter(() => {});
  useGameStore.getState().startMultiplayerMatch({ localRole: ownerId, seed: SEED, lineups: LINEUPS });

  const byTeam = formTwoFireTeams(useGameStore, ownerId);
  if (!byTeam) throw new Error(`no ${ownerId} King to template fire teams from`);
  const allMemberIds = TEAM_IDS.flatMap((teamId) => byTeam[teamId]);

  const startX = new Map(
    useGameStore.getState().units.filter((u) => allMemberIds.includes(u.id)).map((u) => [u.id, u.position.x])
  );

  // The overlay confirm hands BOTH teams over at once (sorted, canonical order).
  applyNetCommand(ownerId, { type: 'setPilotFireTeam', payload: { teamIds: [...TEAM_IDS].sort() } });

  const checksums = [];
  for (let tick = 1; tick <= DRIVE_TICKS; tick++) {
    applyNetCommand(ownerId, { type: 'pilotMove', payload: { x: 1, z: 0 } });
    useGameStore.getState().tick(DT, Date.now());
    checksums.push(computeStateChecksum());
  }

  const meanByTeam = {};
  for (const teamId of TEAM_IDS) {
    const ids = byTeam[teamId];
    let sum = 0;
    for (const u of useGameStore.getState().units) {
      if (!ids.includes(u.id)) continue;
      sum += u.position.x - startX.get(u.id);
    }
    meanByTeam[teamId] = sum / ids.length;
  }
  setCommandRouter(null);
  return { meanByTeam, checksums };
}

async function main() {
  const realLog = console.log;
  console.log = () => {};
  const api = await import(await bundleStore());

  // Two identical runs (same seed, same synthetic teams, same command script); a
  // deterministic sim must produce byte-identical per-tick checksums across them.
  const runA = runMultiDrive(api, 'p0');
  const runB = runMultiDrive(api, 'p0');
  console.log = realLog;

  let allPass = true;

  // 1) Both teams actually advanced along the drive direction.
  for (const teamId of TEAM_IDS) {
    const mean = runA.meanByTeam[teamId];
    const ok = mean >= MIN_DRIVE_DISPLACEMENT;
    allPass = allPass && ok;
    console.log(`${ok ? 'PASS' : 'FAIL'}  driven together: ${teamId.padEnd(8)} mean +x drive = ${mean.toFixed(3)}`);
  }

  // 2) Determinism: the two identical runs produced identical per-tick checksums.
  const checksumsMatch =
    runA.checksums.length === runB.checksums.length &&
    runA.checksums.every((value, index) => value === runB.checksums[index]);
  allPass = allPass && checksumsMatch;
  console.log(`${checksumsMatch ? 'PASS' : 'FAIL'}  identical-run checksums match for all ${runA.checksums.length} ticks`);

  if (!allPass) {
    console.error('\nFAIL: multi-team drive did not steer both teams or was not deterministic.');
    process.exit(1);
  }
  console.log('\nPASS: a multi-team drive steers every selected team together and stays lockstep-deterministic.');
  process.exit(0);
}

main().catch((error) => {
  console.error('FAIL: harness threw', error);
  process.exit(3);
});
