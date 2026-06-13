import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Battle_Map optimization.
 *
 * The exported Battle_Map model is a low-poly scene of ~3250 separate solid-color
 * meshes (4130 primitives / 3395 materials) — but those materials collapse to only
 * ~157 distinct looks. Rendered as individual meshes that's ~6300 draw calls, which
 * alone prevents 60fps on low-end GPUs regardless of unit count.
 *
 * This merges every static mesh that shares an equivalent material into a single
 * geometry (one draw call per distinct material), cutting the map to ~150 draw
 * calls with identical appearance. Two things are deliberately kept separate:
 *
 *  - Bridge frames: 8 named meshes whose visibility is toggled at runtime for the
 *    raise/lower animation. Merging would make them un-toggleable, and TerrainValidator
 *    detects the bridge decks by color, so they must stay as distinct colored meshes.
 *  - Water: it has its own color, so it naturally becomes its own merged mesh whose
 *    material color still matches — TerrainValidator.findTerrainMeshes keeps working.
 *
 * Geometry counts are unchanged (no triangles added/removed); only the number of
 * draw calls drops.
 */

export type BridgeFrameName = 'Fully_Up' | 'Almost_Up' | 'Almost_Down' | 'Fully_Down';

export type BridgeFrameMeshes = Record<BridgeFrameName, THREE.Object3D | null>;

export interface OptimizedBattleMap {
  root: THREE.Group;
  rightBridge: BridgeFrameMeshes;
  leftBridge: BridgeFrameMeshes;
  /** Bridge capture flags, kept separate so the renderer can recolor + raise them. */
  rightFlag: THREE.Object3D | null;
  leftFlag: THREE.Object3D | null;
  stats: {
    sourceMeshes: number;
    mergedDrawCalls: number;
    preservedMeshes: number;
  };
}

const BRIDGE_FRAME_NAMES: BridgeFrameName[] = ['Fully_Up', 'Almost_Up', 'Almost_Down', 'Fully_Down'];

function emptyBridgeFrames(): BridgeFrameMeshes {
  return { Fully_Up: null, Almost_Up: null, Almost_Down: null, Fully_Down: null };
}

// A stable key describing a material's appearance. Meshes whose materials share a
// key render identically and can be merged into one draw call.
function materialSignature(material: THREE.Material): string {
  const m = material as THREE.MeshStandardMaterial;
  const color = m.color ? m.color.getHexString() : 'none';
  const emissive = m.emissive ? m.emissive.getHexString() : 'none';
  const mapId = (m.map as THREE.Texture | null)?.uuid ?? 'none';
  const metalness = (m as any).metalness ?? 'na';
  const roughness = (m as any).roughness ?? 'na';
  const transparent = m.transparent ? `t${m.opacity}` : 'o';
  const side = m.side;
  const vertexColors = m.vertexColors ? 'vc' : 'nc';
  return `${color}|${emissive}|${mapId}|${metalness}|${roughness}|${transparent}|${side}|${vertexColors}`;
}

// Reduce a world-baked geometry to the common attribute set (position, normal, uv)
// so geometries with and without original UVs can be merged together.
function normalizeAttributes(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const normalized = new THREE.BufferGeometry();

  const position = geometry.getAttribute('position');
  normalized.setAttribute('position', position);

  let normal = geometry.getAttribute('normal');
  if (!normal) {
    geometry.computeVertexNormals();
    normal = geometry.getAttribute('normal');
  }
  normalized.setAttribute('normal', normal);

  let uv = geometry.getAttribute('uv');
  if (!uv) {
    uv = new THREE.BufferAttribute(new Float32Array(position.count * 2), 2);
  }
  normalized.setAttribute('uv', uv);

  if (geometry.index) {
    normalized.setIndex(geometry.index);
  }
  return normalized;
}

function isBridgeName(name: string): boolean {
  return /bridge/i.test(name);
}

// Bridge decks must be hit by TerrainValidator's straight-down traversability ray
// cast from above. A raycast only registers a hit on a face the material actually
// renders, so a single-sided (THREE.FrontSide) deck whose winding points away from
// the ray is culled and never hit. The Center_Bridge ships with a net-negative node
// scale (which flips its winding) AND a single-sided material, so the downward ray
// passed straight through it and ground units saw only water there. Forcing deck
// materials to render both sides makes the deck both visible from below and
// raycast-hittable regardless of the source model's winding. Materials are cloned
// first so unrelated meshes that share the same material instance keep their look.
function makeDeckDoubleSided(object: THREE.Object3D): void {
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((material) => toDoubleSided(material))
      : toDoubleSided(mesh.material);
  });
}

function toDoubleSided(material: THREE.Material): THREE.Material {
  if (material.side === THREE.DoubleSide) return material;
  const clone = material.clone();
  clone.side = THREE.DoubleSide;
  return clone;
}

function isHiddenName(name: string): boolean {
  return /sketchfab/i.test(name);
}

// Walk up the ancestor chain testing each node's name.
function ancestorNameMatches(object: THREE.Object3D, test: (name: string) => boolean): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.name && test(current.name)) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Build a draw-call-optimized version of the Battle_Map scene.
 */
export function buildOptimizedBattleMap(gltfScene: THREE.Object3D): OptimizedBattleMap {
  const source = gltfScene.clone(true);
  source.updateMatrixWorld(true);

  const root = new THREE.Group();
  root.name = 'BattleMap_Optimized';

  const rightBridge = emptyBridgeFrames();
  const leftBridge = emptyBridgeFrames();

  // Geometries to merge, grouped by material signature, plus a representative
  // material per group. Bridges and hidden meshes are preserved verbatim.
  const geometriesBySignature = new Map<string, THREE.BufferGeometry[]>();
  const materialBySignature = new Map<string, THREE.Material>();
  const disposable: THREE.BufferGeometry[] = [];

  let sourceMeshes = 0;
  let preservedMeshes = 0;

  // 1) Extract each bridge frame as a whole subtree, re-parented under the
  //    optimized root with its world transform baked in so it keeps its position
  //    while becoming independently toggleable. Each frame node is a Group whose
  //    child meshes have generic names, so it must be preserved as a unit.
  const extractFrame = (side: 'Right' | 'Left', frame: BridgeFrameName): THREE.Object3D | null => {
    const node = source.getObjectByName(`${side}_Bridge_${frame}`);
    if (!node) return null;
    node.matrixWorld.decompose(node.position, node.quaternion, node.scale);
    node.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true; // casts + receives, like the rest of the static map
        m.receiveShadow = true;
        preservedMeshes++;
      }
    });
    makeDeckDoubleSided(node); // keep the deck raycast-hittable regardless of winding
    root.add(node); // re-parents out of `source`, so the merge pass below skips it
    return node;
  };
  for (const frame of BRIDGE_FRAME_NAMES) {
    rightBridge[frame] = extractFrame('Right', frame);
    leftBridge[frame] = extractFrame('Left', frame);
  }

  // 1b) Extract the two bridge capture flags the same way. They aren't bridge-named,
  //     so the merge pass below would otherwise fold them into the static map and the
  //     renderer could neither recolor (team capture) nor raise them. Their materials
  //     are cloned so recoloring one flag never bleeds into the other or the map.
  const extractFlag = (name: string): THREE.Object3D | null => {
    const node = source.getObjectByName(name);
    if (!node) return null;
    node.matrixWorld.decompose(node.position, node.quaternion, node.scale);
    node.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((material) => material.clone())
        : mesh.material.clone();
      preservedMeshes++;
    });
    root.add(node); // re-parents out of `source`, so the merge pass below skips it
    return node;
  };
  const rightFlag = extractFlag('Right_Flag');
  const leftFlag = extractFlag('Left_Flag');

  // 2) Merge everything that remains (bridges already removed) by material.
  source.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    sourceMeshes++;

    // Sketchfab helper geometry was hidden in the original — drop it.
    if (ancestorNameMatches(mesh, isHiddenName)) return;

    // Any stray bridge-related mesh that isn't one of the 8 toggled frames stays
    // separate (always visible, as before) rather than being merged away.
    if (ancestorNameMatches(mesh, isBridgeName)) {
      const preserved = new THREE.Mesh(mesh.geometry, mesh.material);
      mesh.matrixWorld.decompose(preserved.position, preserved.quaternion, preserved.scale);
      preserved.name = mesh.name;
      preserved.visible = mesh.visible;
      preserved.castShadow = true; // casts + receives, like the rest of the static map
      preserved.receiveShadow = true;
      makeDeckDoubleSided(preserved); // keep the deck raycast-hittable regardless of winding
      root.add(preserved);
      preservedMeshes++;
      return;
    }

    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!material) return;

    // Bake the world transform into a cloned geometry, then normalize attributes.
    const baked = mesh.geometry.clone();
    baked.applyMatrix4(mesh.matrixWorld);
    const normalized = normalizeAttributes(baked);
    disposable.push(baked);

    const signature = materialSignature(material);
    if (!geometriesBySignature.has(signature)) {
      geometriesBySignature.set(signature, []);
      materialBySignature.set(signature, material);
    }
    geometriesBySignature.get(signature)!.push(normalized);
  });

  // One merged mesh per material signature.
  let mergedDrawCalls = 0;
  for (const [signature, geometries] of geometriesBySignature) {
    const material = materialBySignature.get(signature)!;
    const merged = mergeGeometries(geometries, false);

    // Static map geometry both casts and receives shadows so props (trees, rocks,
    // structures) ground themselves in the world. Because the map is merged BY MATERIAL,
    // the large flat ground is part of these casters and will self-shadow; the resulting
    // acne/shimmer is held off by the sun light's shadow-bias / normalBias (see
    // DayNightCycle), not by disabling casting.
    if (merged) {
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `Merged_${signature}`;
      root.add(mesh);
      mergedDrawCalls++;
    } else {
      // Fallback: if a group can't merge, add its parts individually so nothing
      // is lost (should not happen given attributes are normalized).
      for (const geometry of geometries) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        root.add(mesh);
        mergedDrawCalls++;
      }
    }
  }

  // Free the per-mesh baked clones; merged geometries own copies of the data.
  for (const geometry of disposable) geometry.dispose();

  return {
    root,
    rightBridge,
    leftBridge,
    rightFlag,
    leftFlag,
    stats: { sourceMeshes, mergedDrawCalls, preservedMeshes },
  };
}
