/**
 * Snapshot codec roundtrip harness (headless Node) — worker-offload P1-4.
 *
 * The per-frame units snapshot is encoded structure-of-arrays before crossing the worker
 * boundary: hot numeric columns (x,y,z,rotation,hp) in a TRANSFERABLE Float32Array + a lean
 * cold object that drops the sim-internal A* path cache. This harness pins that codec in
 * isolation: encode → structuredClone (simulating postMessage's serialize) → decode, then
 * assert the decoded units are field-for-field identical to the source for every render/UI
 * field, the path cache is gone, and the hot columns are a correctly-sized transferable buffer.
 *
 * Fidelity here is what lets ingest stay semantically identical to a plain clone — P1-4 is a
 * transport optimization, not a behaviour change.
 *
 * Run from the RTS project root:
 *   node "Unit Tests/snapshot-codec-roundtrip.harness.mjs"
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODEC_ENTRY = resolve(HERE, '../src/components/Working/sim/snapshotCodec.ts');

async function bundleCodec() {
  const outfile = resolve(mkdtempSync(resolve(tmpdir(), 'snapshot-codec-')), 'codec.mjs');
  await build({ entryPoints: [CODEC_ENTRY], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
  return outfile;
}

let failures = 0;
const assert = (label, cond) => { if (cond) { console.log(`  ✓ ${label}`); } else { failures++; console.error(`  ✗ ${label}`); } };

// A few synthetic units carrying hot fields, warm/cold fields, AND the sim-internal A* path
// cache that must be stripped. Shapes mirror the real Unit (nested position, nested objects).
function makeUnits() {
  return [
    {
      id: 'U-1', ownerId: 'p0', animal: 'Bear', kind: 'Unit',
      position: { x: 1.5, y: 0.25, z: -3.5 }, rotation: 0.75, hp: 42, maxHp: 100,
      unitState: 'pursuing_enemy', isHopping: false, behavior: { stance: 'aggressive' },
      anchor: { x: 0, y: 0, z: 0 }, currentAttackers: ['U-9', 'U-7'],
      // path cache — must be dropped
      pathWaypoints: [{ x: 1, y: 0, z: 1 }, { x: 2, y: 0, z: 2 }], pathIndex: 1,
      pathDestX: 5, pathDestZ: 6, pathVersion: 3, pathStall: 0, pathStuckTicks: 0,
    },
    {
      id: 'Q-2', ownerId: 'p1', animal: 'Owl', kind: 'Queen',
      position: { x: -10, y: 2, z: 8 }, rotation: -1.25, hp: 200, maxHp: 200,
      unitState: 'idle', isFlying: true, wingPhase: 0.3, auraActive: true,
      pathLastX: -10, pathLastZ: 8,
    },
  ];
}

async function main() {
  const { encodeUnits, decodeUnits } = await import(await bundleCodec());
  const source = makeUnits();

  const encoded = encodeUnits(source);

  console.log('Encoding shape:');
  assert('hot buffer is an ArrayBuffer', encoded.hot.buffer instanceof ArrayBuffer);
  assert('hot buffer is packed count*stride*8 bytes (f64)', encoded.hot.buffer.byteLength === source.length * encoded.hot.stride * 8);
  assert('cold has one entry per unit', encoded.cold.length === source.length);
  assert('cold drops the path cache', encoded.cold.every((c) =>
    !('pathWaypoints' in c) && !('pathIndex' in c) && !('pathDestX' in c) &&
    !('pathVersion' in c) && !('pathStall' in c) && !('pathStuckTicks' in c) &&
    !('pathLastX' in c) && !('pathLastZ' in c)));
  assert('cold drops the hot numeric fields', encoded.cold.every((c) =>
    !('position' in c) && !('rotation' in c) && !('hp' in c)));

  console.log('\nRoundtrip through structuredClone (simulates postMessage):');
  const wire = structuredClone(encoded);
  const decoded = decodeUnits(wire.hot, wire.cold);

  assert('decodes every unit', decoded.length === source.length);
  const hotExact = decoded.every((u, i) =>
    u.position.x === source[i].position.x &&
    u.position.y === source[i].position.y &&
    u.position.z === source[i].position.z &&
    u.rotation === source[i].rotation &&
    u.hp === source[i].hp);
  assert('hot fields exact (x,y,z,rotation,hp)', hotExact);

  const coldPreserved = decoded.every((u, i) =>
    u.id === source[i].id && u.ownerId === source[i].ownerId && u.animal === source[i].animal &&
    u.kind === source[i].kind && u.maxHp === source[i].maxHp && u.unitState === source[i].unitState);
  assert('cold scalar fields preserved (id/owner/animal/kind/maxHp/unitState)', coldPreserved);
  assert('nested cold object preserved (behavior)', decoded[0].behavior?.stance === 'aggressive');
  assert('nested cold array preserved (currentAttackers)', JSON.stringify(decoded[0].currentAttackers) === JSON.stringify(['U-9', 'U-7']));
  assert('decoded units carry no path cache', decoded.every((u) => u.pathWaypoints === undefined && u.pathIndex === undefined));

  console.log('');
  if (failures > 0) {
    console.error(`✗ snapshot-codec-roundtrip FAILED (${failures} assertion(s))`);
    process.exit(1);
  }
  console.log('✓ snapshot-codec-roundtrip PASSED');
}

main().catch((err) => { console.error(err); process.exit(1); });
