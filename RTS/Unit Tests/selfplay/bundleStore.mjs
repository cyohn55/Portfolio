// Bundles the real game simulation for headless Node execution.
//
// Single responsibility: produce an importable ES module that exposes the live
// `state.ts` simulation surface (store + lockstep glue + ANIMALS roster) AND the
// deterministic SeededRng, so the self-play engine can drive the exact code that
// ships in the browser. Training against any other simulation would not transfer.
//
// This reuses the determinism-harness bundling approach: esbuild inlines the
// TypeScript, the Firebase/leaderboard modules are stubbed out (they pull in
// @grpc, whose dynamic require() breaks under ESM and never touches the tick
// path anyway), and DEV is defined false so dev-only branches compile out.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, '../../src');
const STATE_ENTRY = resolve(SRC_ROOT, 'game/state.ts');
const PRNG_ENTRY = resolve(SRC_ROOT, 'components/Working/net/prng.ts');

// Replace the Firebase-backed leaderboard modules with an inert stub: importing
// them pulls in @grpc, which uses dynamic require() and breaks under ESM in Node.
// None of them are ever on the per-tick simulation path.
const stubLeaderboard = {
  name: 'stub-leaderboard',
  setup(builder) {
    builder.onResolve({ filter: /(leaderboard|leaderboardRemote|firebaseClient)$/ }, (args) => ({
      path: args.path,
      namespace: 'stub-leaderboard',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'stub-leaderboard' }, () => ({
      contents: 'export default {}; export const getDb = () => null;',
      loader: 'js',
    }));
  },
};

// The combined entry re-exports both modules so one import yields the store glue,
// the ANIMALS roster, and SeededRng — no second bundle, no path juggling.
const COMBINED_ENTRY = `
  export * from ${JSON.stringify(STATE_ENTRY)};
  export { SeededRng } from ${JSON.stringify(PRNG_ENTRY)};
`;

/**
 * Bundle the simulation to a file and return its absolute path WITHOUT importing
 * it. Split out so the work can be built once in a parent process and the path
 * handed to many worker threads, each of which imports it to get its OWN isolated
 * sim instance (separate module registry per worker → independent singletons that
 * can run matches in parallel). The esbuild step (~0.5s) then happens once, not
 * once per worker.
 *
 * @returns {Promise<string>} absolute path to the bundled `sim.mjs`.
 */
export async function buildSimulationBundle() {
  const outfile = resolve(mkdtempSync(resolve(tmpdir(), 'selfplay-')), 'sim.mjs');
  await build({
    stdin: { contents: COMBINED_ENTRY, resolveDir: SRC_ROOT, loader: 'ts' },
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

/**
 * Bundle the simulation and import it once. Returns the module namespace
 * (`useGameStore`, `applyNetCommand`, `ANIMALS`, `SeededRng`, …).
 *
 * One instance serves every match in a process: the simulation fully resets its
 * per-match state on each startMatch, so matches are independent and a shared
 * instance is both reproducible and fast. Re-importing per match was rejected — it
 * re-parses the whole bundle (~0.5s) and leaks module instances across thousands
 * of matches. (For cross-process parallelism, see `buildSimulationBundle`.)
 */
export async function loadSimulationApi() {
  return import(await buildSimulationBundle());
}
