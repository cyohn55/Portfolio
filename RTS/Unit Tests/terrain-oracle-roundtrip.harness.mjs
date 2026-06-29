/**
 * Terrain-oracle roundtrip harness (headless Node) — worker-offload P1-2.
 *
 * The worker sim queries terrain through a grid-backed TerrainOracle rebuilt from a
 * serialized TerrainSnapshot (no THREE). This harness proves the oracle answers the sim's
 * terrain surface correctly from plain data, that side-bridge raise/lower is honoured live
 * (updateBridgeState), and that the snapshot survives structuredClone with identical answers
 * — i.e. it crosses a postMessage losslessly.
 *
 * It does NOT exercise serializeTerrain (that needs THREE + a built pathfinder, main-thread
 * only); the in-thread === worker fidelity of the SIM itself is covered by
 * sim-worker-determinism.harness.mjs. This pins the oracle's query logic in isolation.
 *
 * Run from the RTS project root:
 *   node "Unit Tests/terrain-oracle-roundtrip.harness.mjs"
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORACLE_ENTRY = resolve(HERE, '../src/components/Working/sim/terrainOracle.ts');

// state.ts (pulled in transitively) imports the leaderboard modules; stub them so the bundle
// has no Firebase/network dependency, exactly as the other sim harnesses do.
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

async function bundleOracle() {
  const outfile = resolve(mkdtempSync(resolve(tmpdir(), 'terrain-oracle-')), 'oracle.mjs');
  await build({
    entryPoints: [ORACLE_ENTRY],
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

let failures = 0;
function assert(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

// --- a small synthetic map -----------------------------------------------------------
// 5×5 grid, 2-unit cells, origin (0,0): cell (cx,cz) centre = (cx*2, cz*2), index = cx*5+cz.
// Column cx=2 (x=4) is a water moat, crossed by a CENTER deck at cz=1 and a RIGHT-side deck
// at cz=3; everywhere else is land. Deck cells sit over water (so the only way across is the
// bridge), matching how the real classifier marks them.
const STEP = 2;
const COLS = 5;
const ROWS = 5;
const SIDE_NONE = 0, SIDE_RIGHT = 1, SIDE_CENTER = 3;

function buildSnapshot() {
  const count = COLS * ROWS;
  const water = new Uint8Array(count);
  const bridgeSide = new Uint8Array(count);
  const deckSide = new Uint8Array(count);
  for (let cz = 0; cz < ROWS; cz++) {
    const index = 2 * ROWS + cz; // cx = 2 (the moat column)
    water[index] = 1;
    if (cz === 1) { bridgeSide[index] = SIDE_CENTER; deckSide[index] = SIDE_CENTER; }
    else if (cz === 3) { bridgeSide[index] = SIDE_RIGHT; deckSide[index] = SIDE_RIGHT; }
  }
  return {
    grid: {
      minX: 0, minZ: 0, step: STEP, cols: COLS, rows: ROWS,
      cellType: new Int8Array(count), // unused by the oracle's query path; present for clone fidelity
      cellSide: new Int8Array(count),
    },
    water,
    bridgeSide,
    deckSide,
    deckSurfaceY: { right: 5, left: null, center: 7 },
  };
}

// Cell-centre world positions used by the assertions.
const at = (cx, cz) => ({ x: cx * STEP, y: 0, z: cz * STEP });
const LAND = at(0, 0);
const OPEN_WATER = at(2, 0);
const CENTER_DECK = at(2, 1);
const RIGHT_DECK = at(2, 3);

async function main() {
  console.log('Bundling terrainOracle for Node…');
  const oracleModule = await bundleOracle();
  const { TerrainOracle } = await import(oracleModule);

  const snapshot = buildSnapshot();
  const oracle = new TerrainOracle(snapshot);

  console.log('\nTerrainQuery + SimTerrain answers (bridges default Fully_Down):');
  assert('isInitialized() is true', oracle.isInitialized() === true);
  assert('ground animal walks on land', oracle.canAnimalMoveTo('Bear', LAND) === true);
  assert('ground animal blocked by open water', oracle.canAnimalMoveTo('Bear', OPEN_WATER) === false);
  assert('air animal crosses open water', oracle.canAnimalMoveTo('Bee', OPEN_WATER) === true);
  assert('water animal crosses open water', oracle.canAnimalMoveTo('Frog', OPEN_WATER) === true);
  assert('ground animal crosses center deck', oracle.canAnimalMoveTo('Bear', CENTER_DECK) === true);
  assert('ground animal crosses lowered right deck', oracle.canAnimalMoveTo('Bear', RIGHT_DECK) === true);

  assert('bridgeAt(right deck) = right', oracle.bridgeAt(RIGHT_DECK).side === 'right' && oracle.bridgeAt(RIGHT_DECK).onBridge);
  assert('bridgeAt(land) = none', oracle.bridgeAt(LAND).onBridge === false);
  assert('isSideOpen(center) always true', oracle.isSideOpen('center') === true);
  assert('isSideOpen(right) true when down', oracle.isSideOpen('right') === true);

  assert('surfaceY(center deck) = 7', oracle.getBridgeSurfaceY(CENTER_DECK) === 7);
  assert('surfaceY(lowered right deck) = 5', oracle.getBridgeSurfaceY(RIGHT_DECK) === 5);
  assert('surfaceY(land) = null', oracle.getBridgeSurfaceY(LAND) === null);
  assert('isPositionOverWater(open water) true', oracle.isPositionOverWater(OPEN_WATER) === true);
  assert('isPositionOverWater(land) false', oracle.isPositionOverWater(LAND) === false);

  console.log('\nLive raise/lower (updateBridgeState):');
  oracle.updateBridgeState({ right: 'Fully_Up', left: 'Fully_Down' });
  assert('raised right deck blocks ground', oracle.canAnimalMoveTo('Bear', RIGHT_DECK) === false);
  assert('raised right deck has no surfaceY', oracle.getBridgeSurfaceY(RIGHT_DECK) === null);
  assert('isSideOpen(right) false when raised', oracle.isSideOpen('right') === false);
  assert('center deck unaffected by right raise', oracle.canAnimalMoveTo('Bear', CENTER_DECK) === true);
  oracle.updateBridgeState({ right: 'Fully_Down', left: 'Fully_Down' });

  console.log('\nnearestTraversable rescue:');
  const rescued = oracle.nearestTraversable('Bear', OPEN_WATER, 5);
  assert('stranded ground unit rescued to land', rescued !== null && oracle.canAnimalMoveTo('Bear', rescued) === true);
  const airSelf = oracle.nearestTraversable('Bee', OPEN_WATER, 5);
  assert('air animal never stranded (returns its own pos)', airSelf !== null && airSelf.x === OPEN_WATER.x && airSelf.z === OPEN_WATER.z);

  console.log('\nstructuredClone fidelity (crosses the wire losslessly):');
  const cloned = structuredClone(snapshot);
  const clonedOracle = new TerrainOracle(cloned);
  const sweep = [LAND, OPEN_WATER, CENTER_DECK, RIGHT_DECK, at(1, 1), at(3, 3), at(4, 4)];
  const animals = ['Bear', 'Bee', 'Frog'];
  let sweepMatches = true;
  for (const a of animals) {
    for (const p of sweep) {
      if (oracle.canAnimalMoveTo(a, p) !== clonedOracle.canAnimalMoveTo(a, p)) sweepMatches = false;
      if (oracle.getBridgeSurfaceY(p) !== clonedOracle.getBridgeSurfaceY(p)) sweepMatches = false;
    }
  }
  assert('cloned snapshot yields identical answers across the sweep', sweepMatches);

  console.log('');
  if (failures > 0) {
    console.error(`✗ terrain-oracle-roundtrip FAILED (${failures} assertion(s))`);
    process.exit(1);
  }
  console.log('✓ terrain-oracle-roundtrip PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
