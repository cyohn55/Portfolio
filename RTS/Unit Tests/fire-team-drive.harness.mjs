/**
 * FIRE-TEAM DRIVE harness (headless Node, no browser).
 *
 * Reproduces the player report: "I can't pilot the fire teams/formations after
 * pressing the T key to select them." T runs cycleFireTeam, which selects a team
 * and dispatches setPilotFireTeam; the drive keys then feed a per-owner pilotMove
 * vector that the tick is supposed to translate into squad movement.
 *
 * It drives the SIMULATION path directly (setPilotFireTeam + per-tick pilotMove via
 * applyNetCommand, the same commands the input layer issues) across the four states
 * a grabbed team can be in — {unshaped, shaped} x {loose, rallied-to-King} — and
 * asserts each one actually advances ALONG the drive direction (not just "moves",
 * which a team chasing its parked monarch would also do).
 *
 * The shaped + rallied-to-King case is the regression guard for the reported bug:
 * shaping a RALLIED army leaves followMonarchId set on the members (only the Deploy
 * path clears it), and the monarch-rally chase used to overwrite each member's
 * formation-slot order with the parked monarch's position — yanking the formation
 * back and making it unsteerable (mean +x went NEGATIVE before the fix).
 *
 * Run from the RTS project root:
 *   node "Unit Tests/fire-team-drive.harness.mjs"
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
const TEAM_ID = 'FT-1';

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
  const outfile = resolve(mkdtempSync(resolve(tmpdir(), 'fire-team-drive-')), 'store.mjs');
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

// The smallest mean +x displacement (along the drive direction) that proves the
// team was actually steered there. Members that chase a parked monarch instead of
// following the drive move a lot in OTHER directions but barely advance along +x —
// so this floor is the "is it steerable" line.
const MIN_DRIVE_DISPLACEMENT = 5;

// The four scenarios a fire team can be in when the player grabs and drives it.
// `shaped` => formed into a formation (FireTeamState entry); `rallied` => members
// still carry followMonarchId, which is exactly what shaping a RALLIED army leaves
// behind (only the Deploy path clears it). The shaped+rallied combo is the reported
// "can't pilot the formations" bug: the monarch-rally chase used to overwrite each
// member's formation-slot order with the parked monarch's position.
const SCENARIOS = [
  { name: 'unshaped squad', shaped: false, rallied: false },
  { name: 'shaped formation', shaped: true, rallied: false },
  { name: 'unshaped squad, rallied-to-King', shaped: false, rallied: true },
  { name: 'shaped formation, rallied-to-King', shaped: true, rallied: true },
];

// Synthesize three p0 Units from a King template (a real match has no regular Units
// at kickoff) and stamp them with one fire-team id near p0's King.
function formFireTeam(useGameStore, rallied) {
  const state = useGameStore.getState();
  const template = state.units.find((u) => u.ownerId === 'p0' && u.kind === 'King');
  if (!template) return [];
  const members = [0, 1, 2].map((i) => ({
    ...template,
    id: `ft-member-${i}`,
    kind: 'Unit',
    fireTeamId: TEAM_ID,
    followMonarchId: rallied ? template.id : undefined,
    position: { x: template.position.x + i * 4, y: 0, z: template.position.z + 20 },
    anchor: { x: template.position.x + i * 4, y: 0, z: template.position.z + 20 },
  }));
  const memberIds = members.map((u) => u.id);
  useGameStore.setState({ units: [...state.units, ...members] });
  return memberIds;
}

// Drive one scenario end to end on a fresh match and return the mean displacement
// of the team's members along the +x drive direction.
function runScenario(api, scenario) {
  const { useGameStore, applyNetCommand, setCommandRouter } = api;

  // Lockstep path so applyNetCommand fills pilotMoveByOwner directly (the
  // single-player path reads pilotInput, a UI singleton not reachable here).
  setCommandRouter(() => {});
  useGameStore.getState().startMultiplayerMatch({ localRole: 'p0', seed: SEED, lineups: LINEUPS });

  const memberIds = formFireTeam(useGameStore, scenario.rallied);
  if (memberIds.length === 0) throw new Error('no p0 King to template a fire team from');

  if (scenario.shaped) {
    applyNetCommand('p0', {
      type: 'setFormation',
      payload: { unitIds: memberIds, shape: 'line', facing: 0 },
    });
  }

  // T -> cycleFireTeam dispatches this exact command to grab the team.
  applyNetCommand('p0', { type: 'setPilotFireTeam', payload: { teamIds: [TEAM_ID] } });

  const startX = new Map(
    useGameStore.getState().units.filter((u) => memberIds.includes(u.id)).map((u) => [u.id, u.position.x])
  );

  // Drive straight along +x every tick, exactly as the drive keys would.
  for (let tick = 1; tick <= DRIVE_TICKS; tick++) {
    applyNetCommand('p0', { type: 'pilotMove', payload: { x: 1, z: 0 } });
    useGameStore.getState().tick(DT, Date.now());
  }

  let sumDriveX = 0;
  let count = 0;
  for (const u of useGameStore.getState().units) {
    if (!startX.has(u.id)) continue;
    sumDriveX += u.position.x - startX.get(u.id);
    count++;
  }
  setCommandRouter(null);
  return count > 0 ? sumDriveX / count : 0;
}

async function main() {
  const realLog = console.log;
  console.log = () => {};
  const api = await import(await bundleStore());

  const results = SCENARIOS.map((scenario) => ({
    scenario,
    meanDriveX: runScenario(api, scenario),
  }));
  console.log = realLog;

  let allPass = true;
  for (const { scenario, meanDriveX } of results) {
    const ok = meanDriveX >= MIN_DRIVE_DISPLACEMENT;
    allPass = allPass && ok;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${scenario.name.padEnd(36)} mean +x drive = ${meanDriveX.toFixed(3)}`
    );
  }

  if (!allPass) {
    console.error('\nFAIL: a grabbed fire team was not steerable along the drive direction.');
    process.exit(1);
  }
  console.log('\nPASS: every grabbed fire team — including a formation shaped from a rallied army — is steerable.');
  process.exit(0);
}

main().catch((error) => {
  console.error('FAIL: harness threw', error);
  process.exit(3);
});
