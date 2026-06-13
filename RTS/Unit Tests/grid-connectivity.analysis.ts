/**
 * One-off diagnostic (not a CI test): load the REAL Battle_Map, build the actual
 * TerrainValidator + GridPathfinder the game uses, and flood-fill the navigation grid to
 * report its connected components. If the two shores of the moat (and the center island)
 * land in DIFFERENT components, ground units can never be routed across, the pathfinder
 * falls back to a straight line into the water, and units freeze at the bank — the reported
 * symptom. Prints the grid classification counts and the size/extent of each component.
 *
 * Run: npx tsx "Unit Tests/grid-connectivity.analysis.ts"
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { TerrainValidator } from '../src/utils/TerrainValidator';
import { GridPathfinder } from '../src/components/Working/pathfinder';

const here = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(here, '../public/models/Battle_Map.glb');

// Mirror HexGrid.tsx's pathfinder grid sizing.
const PATH_GRID_MARGIN = 20;
const PATH_GRID_STEP = 2;
const PATH_PLAY_HALF_X = 180;
const PATH_PLAY_HALF_Z = 290;

// Strip textures/images from a GLB's JSON chunk so GLTFLoader.parse never tries to decode
// images (which needs a browser). Geometry, node names, and material baseColorFactor — all
// this analysis needs — are preserved. Re-packs the container with correct chunk padding.
function stripTextures(buffer: Buffer): ArrayBuffer {
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const jsonLen = dv.getUint32(12, true); // header is 12 bytes, then chunk0 length@12 type@16
  const jsonStart = 20;
  const jsonText = buffer.toString('utf8', jsonStart, jsonStart + jsonLen);
  const binStart = jsonStart + jsonLen; // [len][type][data] for BIN chunk follows
  const binChunkLen = dv.getUint32(binStart, true);
  const binData = buffer.subarray(binStart + 8, binStart + 8 + binChunkLen);

  const json: any = JSON.parse(jsonText);
  delete json.images;
  delete json.textures;
  delete json.samplers;
  const textureKeys = ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'occlusionTexture', 'emissiveTexture'];
  for (const mat of json.materials ?? []) {
    if (mat.pbrMetallicRoughness) {
      for (const k of textureKeys) delete mat.pbrMetallicRoughness[k];
    }
    for (const k of textureKeys) delete mat[k];
    delete mat.extensions; // KHR_texture_transform etc. reference textures
  }
  if (Array.isArray(json.extensionsUsed)) {
    json.extensionsUsed = json.extensionsUsed.filter((e: string) => !/texture/i.test(e));
  }

  // Re-pack: header(12) + jsonChunk(8 + padded) + binChunk(8 + binData).
  const newJson = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (newJson.length % 4)) % 4;
  const jsonPadded = Buffer.concat([newJson, Buffer.alloc(jsonPad, 0x20)]);
  const total = 12 + 8 + jsonPadded.length + 8 + binData.length;
  const out = Buffer.alloc(total);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, 0x46546c67, true); // 'glTF'
  odv.setUint32(4, 2, true);
  odv.setUint32(8, total, true);
  odv.setUint32(12, jsonPadded.length, true);
  odv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  jsonPadded.copy(out, 20);
  let p = 20 + jsonPadded.length;
  odv.setUint32(p, binData.length, true);
  odv.setUint32(p + 4, 0x004e4942, true); // 'BIN\0'
  binData.copy(out, p + 8);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

function loadScene(): Promise<THREE.Object3D> {
  (globalThis as any).self = globalThis;
  const buffer = readFileSync(MODEL);
  const arrayBuffer = stripTextures(buffer);
  const loader = new GLTFLoader();
  return new Promise((res, rej) => {
    loader.parse(arrayBuffer, '', (gltf) => res(gltf.scene), rej);
  });
}

async function main() {
  const scene = await loadScene();
  scene.updateMatrixWorld(true);

  const terrain = new TerrainValidator();
  terrain.initialize(scene);

  const box = new THREE.Box3().setFromObject(scene);
  const bounds = {
    minX: Math.max(box.min.x - PATH_GRID_MARGIN, -PATH_PLAY_HALF_X),
    minZ: Math.max(box.min.z - PATH_GRID_MARGIN, -PATH_PLAY_HALF_Z),
    maxX: Math.min(box.max.x + PATH_GRID_MARGIN, PATH_PLAY_HALF_X),
    maxZ: Math.min(box.max.z + PATH_GRID_MARGIN, PATH_PLAY_HALF_Z),
  };
  console.log('map box:', box.min.toArray().map(n => n.toFixed(1)), box.max.toArray().map(n => n.toFixed(1)));
  console.log('grid bounds:', bounds);

  const pf = new GridPathfinder();
  pf.build(terrain, bounds, PATH_GRID_STEP);

  // Reach into the built grid via the same public surface the game uses. We re-derive
  // passability by probing nearestPassable indirectly; instead, reconstruct the grid here
  // using the validator the same way classifyCells does, so the analysis is self-contained
  // and does not depend on private fields.
  const cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / PATH_GRID_STEP) + 1);
  const rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / PATH_GRID_STEP) + 1);
  const half = PATH_GRID_STEP / 2;
  const WATER = 0, LAND = 1, DECK = 2;
  const cell = new Int8Array(cols * rows);
  let counts = [0, 0, 0];

  for (let cx = 0; cx < cols; cx++) {
    for (let cz = 0; cz < rows; cz++) {
      const x = bounds.minX + cx * PATH_GRID_STEP;
      const z = bounds.minZ + cz * PATH_GRID_STEP;
      const probes = [
        { x, y: 0, z },
        { x: x - half, y: 0, z }, { x: x + half, y: 0, z },
        { x, y: 0, z: z - half }, { x, y: 0, z: z + half },
      ];
      let anyWater = false;
      let deck = false;
      for (const p of probes) {
        if (!terrain.isPositionOverWater(p)) continue;
        const d = terrain.deckAt(p);
        if (d.onDeck && d.side) deck = true;
        else { anyWater = true; break; }
      }
      const t = anyWater ? WATER : deck ? DECK : LAND;
      cell[cx * rows + cz] = t;
      counts[t]++;
    }
  }
  console.log(`cells: ${cols}x${rows}=${cols * rows}  WATER=${counts[0]} LAND=${counts[1]} DECK=${counts[2]}`);

  // Flood-fill connected components over passable (LAND or DECK; side bridges assumed down).
  const comp = new Int32Array(cols * rows).fill(-1);
  const passable = (i: number) => cell[i] !== WATER;
  let nextComp = 0;
  const components: { id: number; size: number; minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < cell.length; start++) {
    if (!passable(start) || comp[start] !== -1) continue;
    const id = nextComp++;
    let size = 0;
    let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;
    stack.push(start);
    comp[start] = id;
    while (stack.length) {
      const cur = stack.pop()!;
      size++;
      const cxx = Math.floor(cur / rows), czz = cur % rows;
      const wx = bounds.minX + cxx * PATH_GRID_STEP, wz = bounds.minZ + czz * PATH_GRID_STEP;
      mnX = Math.min(mnX, wx); mxX = Math.max(mxX, wx);
      mnZ = Math.min(mnZ, wz); mxZ = Math.max(mxZ, wz);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cxx + dx, nz = czz + dz;
        if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
        const ni = nx * rows + nz;
        if (!passable(ni) || comp[ni] !== -1) continue;
        // mirror A* corner rule: no diagonal through water
        if (dx !== 0 && dz !== 0) {
          if (!passable(cxx * rows + nz) || !passable(nx * rows + czz)) continue;
        }
        comp[ni] = id;
        stack.push(ni);
      }
    }
    components.push({ id, size, minX: mnX, maxX: mxX, minZ: mnZ, maxZ: mxZ });
  }

  components.sort((a, b) => b.size - a.size);
  console.log(`\nconnected components: ${components.length}`);
  for (const c of components.slice(0, 12)) {
    console.log(
      `  #${c.id}: ${c.size} cells  x[${c.minX.toFixed(0)}, ${c.maxX.toFixed(0)}] z[${c.minZ.toFixed(0)}, ${c.maxZ.toFixed(0)}]`
    );
  }

  // Which component contains some representative spots? Spawn-ish points on each side.
  const probeSpots: [string, number, number][] = [
    ['north (-z) midfield', 0, bounds.minZ + 60],
    ['south (+z) midfield', 0, bounds.maxZ - 60],
    ['map center (island?)', 0, 0],
    ['east side', bounds.maxX - 40, 0],
    ['west side', bounds.minX + 40, 0],
  ];
  console.log('\nrepresentative spots -> component:');
  for (const [name, x, z] of probeSpots) {
    const cx = Math.min(cols - 1, Math.max(0, Math.round((x - bounds.minX) / PATH_GRID_STEP)));
    const cz = Math.min(rows - 1, Math.max(0, Math.round((z - bounds.minZ) / PATH_GRID_STEP)));
    const i = cx * rows + cz;
    console.log(`  ${name} (${x.toFixed(0)},${z.toFixed(0)}): cellType=${cell[i]} component=${comp[i]}`);
  }

  // Geometry around the island: water mesh bounds + center bridge bounds, and an ASCII
  // map (. land, ~ water, # deck) of the island + its surrounding moat / center bridge.
  console.log('\ncenter bridge / deck surface:');
  console.log('  centerDeckSurfaceY=', (terrain as any).centerDeckSurfaceY,
    ' centerDeckMeshes=', (terrain as any).centerDeckMeshes?.length,
    ' centerBridgeMeshes=', (terrain as any).centerBridgeMeshes?.length);
  for (const m of ((terrain as any).centerBridgeMeshes ?? []) as THREE.Mesh[]) {
    const b = new THREE.Box3().setFromObject(m);
    console.log(`  centerBridge "${m.name}" x[${b.min.x.toFixed(0)},${b.max.x.toFixed(0)}] y[${b.min.y.toFixed(1)},${b.max.y.toFixed(1)}] z[${b.min.z.toFixed(0)},${b.max.z.toFixed(0)}]`);
  }
  for (const m of ((terrain as any).waterMeshes ?? []) as THREE.Mesh[]) {
    const b = new THREE.Box3().setFromObject(m);
    console.log(`  water "${m.name}" x[${b.min.x.toFixed(0)},${b.max.x.toFixed(0)}] y[${b.min.y.toFixed(1)},${b.max.y.toFixed(1)}] z[${b.min.z.toFixed(0)},${b.max.z.toFixed(0)}]`);
  }

  console.log('\nraw raycast against Center_Bridge mesh (from y+100 straight down at x=0,z=-35):');
  {
    const meshes = ((terrain as any).centerBridgeMeshes ?? []) as THREE.Mesh[];
    const rc = new THREE.Raycaster();
    for (const m of meshes) {
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      const geo = m.geometry as THREE.BufferGeometry;
      const pos = geo.getAttribute('position');
      const idx = geo.index;
      // first triangle world-space normal
      const a = new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(0) : 0).applyMatrix4(m.matrixWorld);
      const b = new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(1) : 1).applyMatrix4(m.matrixWorld);
      const c = new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(2) : 2).applyMatrix4(m.matrixWorld);
      const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
      console.log(`  mesh="${m.name}" tris=${(idx ? idx.count : pos.count) / 3} matSide=${(mat as any)?.side} (0=Front,1=Back,2=Double) firstTriNormal=[${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}] visible=${m.visible}`);
      for (const side of [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide]) {
        const saved = (mat as any).side;
        (mat as any).side = side;
        rc.set(new THREE.Vector3(0, 100, -35), new THREE.Vector3(0, -1, 0));
        const hits = rc.intersectObject(m, true);
        (mat as any).side = saved;
        console.log(`    side=${side}: ${hits.length} hit(s)${hits[0] ? ` at y=${hits[0].point.y.toFixed(2)}` : ''}`);
      }
    }
  }

  console.log('\ndirect terrain probes along center-bridge centerline (x=0):');
  for (let z = -46; z <= 46; z += 4) {
    const p = { x: 0, y: 0, z };
    const overWater = terrain.isPositionOverWater(p);
    const deck = terrain.deckAt(p);
    const bridge = terrain.bridgeAt(p);
    const surfaceY = terrain.getBridgeSurfaceY(p);
    console.log(
      `  z=${String(z).padStart(3)}  overWater=${overWater ? 'Y' : 'n'}  deck=${deck.onDeck ? deck.side : '-'}  bridge=${bridge.onBridge ? bridge.side : '-'}  surfaceY=${surfaceY === null ? 'null' : surfaceY.toFixed(2)}  canGroundMove=${terrain.canAnimalMoveTo('Bear', p)}`
    );
  }

  console.log('\nASCII map around island (x −60..60, z −60..60; . land  ~ water  # deck):');
  const sym = ['~', '.', '#'];
  for (let z = -60; z <= 60; z += PATH_GRID_STEP) {
    let line = '';
    for (let x = -60; x <= 60; x += PATH_GRID_STEP) {
      const cx = Math.round((x - bounds.minX) / PATH_GRID_STEP);
      const cz = Math.round((z - bounds.minZ) / PATH_GRID_STEP);
      line += sym[cell[cx * rows + cz]];
    }
    console.log(line);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
