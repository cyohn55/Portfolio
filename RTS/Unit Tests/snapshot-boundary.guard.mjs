// Phase-0 (worker-offload) T6 — structural guard for the sim read/write boundary.
//
// The sim is reachable for READS only through `getSimSnapshot()` and for WRITES
// only through `dispatchCommand()` / local-UI store setters (see
// Working/worker-offload-phase0.md). This guard keeps that boundary from rotting
// back before the worker switch flips in Phase 1. It is the ESLint rule the plan
// calls for, implemented as a Node structural check because the project ships no
// ESLint toolchain (matching the T1/T3/T4 "structural gate" precedent).
//
// Run: node "Unit Tests/snapshot-boundary.guard.mjs"  (exit 0 = boundary intact)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

// The one file that is allowed to reach the store directly — it DEFINES the
// boundary (the store, `getSimSnapshot`, `dispatchCommand`, the snapshot ingest).
const BOUNDARY_FILE = join('src', 'game', 'state.ts');

// Read-side allowlist: files that still hold a direct `useGameStore.getState()`
// because they own work deferred past T5. Each entry must name the blocking task
// so the list visibly shrinks to empty as that work lands. A direct store read in
// ANY file not listed here is a NEW boundary leak and fails the guard.
const DEFERRED_DIRECT_READS = new Map([
  // (T2-A done: currentScreen moved to useUiStore, so App.tsx and parentScrollBridge
  //  no longer read the sim store — removed from this list.)
  // Mixed read+action surfaces (selection / pilot / unit-placement) — these read
  // sim data AND call deferred Bucket-C/pilot/placement actions through the same
  // object; they get restructured in T2/Tier-3, not split mid-flight in T5.
  [join('src', 'components', 'KeyboardShortcuts.tsx'), 'T2/Tier-3: selection/pilot/placement surface'],
  [join('src', 'components', 'Working', 'GamepadController.tsx'), 'T2/Tier-3: fireAction + deploy lifecycle'],
  // Tier-3 net/harness — these run alongside the tick and move INTO the worker in
  // Phase 1, so they keep talking to the store directly (no main-thread mirror).
  [join('src', 'components', 'Working', 'net', 'netMatch.ts'), 'Tier-3: drives the tick; into worker P1'],
  [join('src', 'components', 'Working', 'net', 'multiplayerSession.ts'), 'Tier-3: match lifecycle; into worker P1'],
  [join('src', 'components', 'Working', 'ai', 'aiCommander.ts'), 'Tier-3: runs with the tick; into worker P1'],
  [join('src', 'components', 'Working', 'ai', 'replayRecorder.ts'), 'Tier-3: runs with the tick; into worker P1'],
]);

const DIRECT_READ = /useGameStore\s*\.\s*getState\s*\(\s*\)/;
// A mutation THROUGH the read-only snapshot: assignment to, or an in-place array
// mutator on, a `getSimSnapshot()` member. (`=` excludes ==, ===, =>, <=, >=, !=.)
const SNAPSHOT_WRITE = /getSimSnapshot\s*\(\s*\)\s*\.\s*[A-Za-z0-9_]+\s*(?:=(?![=>])|\.\s*(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)\s*\()/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk(SRC_ROOT);
const leaks = [];          // direct store reads outside the boundary + allowlist
const writes = [];         // mutations through the snapshot
const staleAllowlist = []; // allowlisted files that no longer read the store

const seenDirectReadFiles = new Set();

for (const file of files) {
  const rel = relative(REPO_ROOT, file).split(sep).join(sep);
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');

  const hasDirectRead = DIRECT_READ.test(source);
  if (hasDirectRead) seenDirectReadFiles.add(rel);

  const isBoundary = rel === BOUNDARY_FILE;
  const isDeferred = DEFERRED_DIRECT_READS.has(rel);

  lines.forEach((line, i) => {
    // Read boundary: direct store reads only in the boundary file or an
    // allowlisted (deferred) file.
    if (DIRECT_READ.test(line) && !isBoundary && !isDeferred) {
      leaks.push(`${rel}:${i + 1}  ${line.trim()}`);
    }
    // Write boundary: never mutate through the read-only snapshot, anywhere.
    if (SNAPSHOT_WRITE.test(line)) {
      writes.push(`${rel}:${i + 1}  ${line.trim()}`);
    }
  });
}

// Keep the allowlist honest: an entry that no longer reads the store is dead and
// should be deleted (its deferred work has landed).
for (const rel of DEFERRED_DIRECT_READS.keys()) {
  if (!seenDirectReadFiles.has(rel)) staleAllowlist.push(rel);
}

const problems = [];
if (leaks.length) {
  problems.push(
    `Direct \`useGameStore.getState()\` outside the boundary (read sim state via ` +
    `getSimSnapshot() instead, or add the file to DEFERRED_DIRECT_READS with its ` +
    `blocking task):\n  ${leaks.join('\n  ')}`
  );
}
if (writes.length) {
  problems.push(
    `Mutation through the read-only snapshot (writes must go through ` +
    `dispatchCommand / a UI-store setter):\n  ${writes.join('\n  ')}`
  );
}
if (staleAllowlist.length) {
  problems.push(
    `DEFERRED_DIRECT_READS lists files that no longer read the store directly — ` +
    `remove them:\n  ${staleAllowlist.join('\n  ')}`
  );
}

if (problems.length) {
  console.error('FAIL: sim read/write boundary violations\n\n' + problems.join('\n\n'));
  process.exit(1);
}

console.log(
  `PASS: sim boundary intact — ${files.length} files scanned; direct store reads ` +
  `confined to state.ts + ${DEFERRED_DIRECT_READS.size} allowlisted deferred files; ` +
  `no mutation through getSimSnapshot().`
);
