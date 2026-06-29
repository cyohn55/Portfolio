/**
 * WORKER multiplayer determinism harness (headless Node, no browser) — worker-offload P1-3.
 *
 * The multiplayer flip moves the lockstep ENGINE into the worker (alongside the sim) and
 * proxies the WebRTC transport across the boundary. This harness proves that path end to end:
 * it stands up TWO independent worker hosts (two separately-bundled module instances, each
 * with its own sim + in-worker engine + proxy transport), cross-wires each host's outbound
 * `netSend` into the other's `netRecv` — a loopback for the real lockstep exchange — and drives
 * both with `netUpdate` frames + a scripted command on each side. It then asserts the two peers
 * produce byte-identical per-tick checksums and that neither engine reported a desync.
 *
 * This is the worker-path counterpart to lockstep-two-peer-determinism: that one drives the
 * sim directly (role symmetry); this one drives it THROUGH the worker message protocol and the
 * WorkerTransport proxy, so it fails loudly if the boundary plumbing perturbs the lockstep.
 *
 * Terrain-free (no oracle) like the other sim harnesses — the sim degrades to permissive
 * terrain, which is deterministic and identical on both peers.
 *
 * Run from the RTS project root:
 *   node "Unit Tests/lockstep-worker-determinism.harness.mjs"
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_ENTRY = resolve(HERE, '../src/components/Working/sim/simWorkerHost.ts');

const SEED = 0x1234abcd;
const FRAMES = 360;
const DT_MS = 1000 / 60;
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

// Bundle the host to a UNIQUE outfile each call so importing twice yields two independent
// module graphs (separate useGameStore singletons + engines), simulating two peers in-process.
async function bundleHost(tag) {
  const outfile = resolve(mkdtempSync(resolve(tmpdir(), `lockstep-worker-${tag}-`)), 'host.mjs');
  await build({
    entryPoints: [HOST_ENTRY],
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

const ownedNonBase = (host, role) =>
  host.useGameStore.getState().units.filter((u) => u.ownerId === role && u.kind !== 'Base').map((u) => u.id);

const failures = [];
const check = (label, cond) => { if (!cond) failures.push(label); };

async function main() {
  const realLog = console.log;
  console.log = () => {};

  const peerA = await import(await bundleHost('a')); // host (p0)
  const peerB = await import(await bundleHost('b')); // guest (p1)

  let desync = false;
  // Cross-wire the proxy transports: a frame one peer's engine sends is delivered to the other
  // peer's engine as a received message — the loopback that makes lockstep advance. receive()
  // only records frames (never sends), so this is not re-entrant.
  //
  // Frames sent during start() are BUFFERED until both engines exist, then flushed. In
  // production the single ordered WebRTC channel guarantees each peer processes the 'start'
  // handshake (constructing its engine) before the opening input frames arrive; this models
  // that ordering, which the synchronous in-process loopback would otherwise violate.
  let ready = false;
  const buffered = [];
  const route = (target) => (message) => {
    if (!message) return;
    if (message.kind === 'netCallback') {
      if (message.event === 'desync') desync = true;
      return;
    }
    if (message.kind !== 'netSend') return;
    if (ready) target.processSimRequest({ kind: 'netRecv', message: message.message });
    else buffered.push({ target, message: message.message });
  };
  peerA.setSimOutbound(route(peerB));
  peerB.setSimOutbound(route(peerA));

  // Build the identical seeded match + stand up the in-worker engine on each peer.
  peerA.processSimRequest({ kind: 'startNetMatch', localRole: 'p0', seed: SEED, lineups: LINEUPS });
  peerB.processSimRequest({ kind: 'startNetMatch', localRole: 'p1', seed: SEED, lineups: LINEUPS });

  // Both engines now exist; flush the opening frames and switch to live delivery.
  ready = true;
  for (const { target, message } of buffered) target.processSimRequest({ kind: 'netRecv', message });

  const p0Units = ownedNonBase(peerA, 'p0');
  const p1Units = ownedNonBase(peerB, 'p1');

  const perTickA = [];
  const perTickB = [];
  for (let frame = 1; frame <= FRAMES; frame++) {
    // Scripted commands, injected through the worker command path (→ in-worker engine, shipped
    // to the peer in the next input frame). Each peer issues only its own units' orders.
    if (frame === 60) {
      peerA.processSimRequest({ kind: 'command', command: { type: 'moveUnits', payload: { unitIds: p0Units, target: { x: 0, y: 0.25, z: 0 } } } });
    }
    if (frame === 120) {
      peerB.processSimRequest({ kind: 'command', command: { type: 'moveUnits', payload: { unitIds: p1Units, target: { x: 0, y: 0.25, z: 5 } } } });
    }
    peerA.processSimRequest({ kind: 'netUpdate', dtMs: DT_MS, pilot: { x: 0, z: 0 } });
    peerB.processSimRequest({ kind: 'netUpdate', dtMs: DT_MS, pilot: { x: 0, z: 0 } });

    perTickA.push(peerA.buildSimSnapshot());
    perTickB.push(peerB.buildSimSnapshot());
  }
  console.log = realLog;

  const finalTickA = perTickA[perTickA.length - 1].tickCounter;
  const finalTickB = perTickB[perTickB.length - 1].tickCounter;

  check('both peers advanced past the input-delay opening', finalTickA > 10 && finalTickB > 10);
  check('peers stayed tick-aligned', finalTickA === finalTickB);
  check('no engine reported a desync', desync === false);

  // Compare checksums at matching tick counts (lockstep advances both identically).
  let firstDivergence = -1;
  for (let i = 0; i < perTickA.length; i++) {
    if (perTickA[i].tickCounter !== perTickB[i].tickCounter || perTickA[i].checksum !== perTickB[i].checksum) {
      firstDivergence = i;
      break;
    }
  }
  check('host (p0) and guest (p1) produced byte-identical per-frame checksums', firstDivergence === -1);

  if (failures.length === 0) {
    console.log(`PASS: worker multiplayer reproduces byte-identical peers across ${FRAMES} frames (tick ${finalTickA}) over the proxied lockstep exchange.`);
    process.exit(0);
  }
  console.error('FAIL: worker multiplayer path broke these invariants:');
  for (const f of failures) console.error(`  - ${f}`);
  if (firstDivergence >= 0) {
    console.error(`  first checksum divergence at frame ${firstDivergence + 1}:`);
    console.error(`    host : ${perTickA[firstDivergence].checksum}`);
    console.error(`    guest: ${perTickB[firstDivergence].checksum}`);
  }
  process.exit(1);
}

main().catch((error) => {
  console.error('FAIL: harness threw', error);
  process.exit(3);
});
