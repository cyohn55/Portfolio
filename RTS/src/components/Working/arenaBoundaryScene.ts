import * as THREE from 'three';
import type { ArenaBoundary } from './arenaBoundary';

/**
 * Derive the Arena slab's oriented XZ footprint from its scene-graph object.
 *
 * The slab ("Arena" node) is a square rotated ~45° about Y, so an axis-aligned box would leak
 * units into the corner void between the rotated edges and the bounding box. We instead build
 * an oriented box: a center, the world directions the slab's local X/Z axes point in, and a
 * half-extent along each. Because the Arena node is a multi-primitive mesh, the GLTF loader
 * represents it as a Group of child meshes, so we union every descendant's geometry box in the
 * Arena's own local frame and then map that into world space — this handles both a single Mesh
 * and a Group transparently.
 *
 * @param arena  The "Arena" scene object (Mesh or Group). Caller is responsible for resolving
 *               it by name; this function reads its (already-updated) world matrix.
 * @param inset  World distance to pull each edge inward, so a unit body of that radius rests on
 *               the slab instead of hanging over the rim.
 * @returns The oriented boundary, or null if the object carries no mesh geometry.
 */
export function computeArenaBoundary(arena: THREE.Object3D, inset: number): ArenaBoundary | null {
  arena.updateWorldMatrix(true, true);

  const inverseArenaMatrix = arena.matrixWorld.clone().invert();
  const localBox = new THREE.Box3();
  const childBox = new THREE.Box3();
  const meshToArena = new THREE.Matrix4();

  arena.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox) return;
    meshToArena.multiplyMatrices(inverseArenaMatrix, mesh.matrixWorld);
    childBox.copy(mesh.geometry.boundingBox).applyMatrix4(meshToArena);
    localBox.union(childBox);
  });

  if (localBox.isEmpty()) return null;

  // World-space center of the slab, and the world directions its local X/Z axes point in.
  const localCenter = localBox.getCenter(new THREE.Vector3());
  const center = localCenter.clone().applyMatrix4(arena.matrixWorld);
  const axisU = localCenter.clone().add(new THREE.Vector3(1, 0, 0)).applyMatrix4(arena.matrixWorld).sub(center);
  const axisV = localCenter.clone().add(new THREE.Vector3(0, 0, 1)).applyMatrix4(arena.matrixWorld).sub(center);
  const scaleU = axisU.length();
  const scaleV = axisV.length();
  axisU.normalize();
  axisV.normalize();

  const halfU = Math.max(0, (localBox.max.x - localBox.min.x) * 0.5 * scaleU - inset);
  const halfV = Math.max(0, (localBox.max.z - localBox.min.z) * 0.5 * scaleV - inset);

  // The raw slab has no corner cut or side wall; confineBoundaryToPoints and the caller add those
  // when sizing to the play area.
  return {
    centerX: center.x,
    centerZ: center.z,
    axisUx: axisU.x,
    axisUz: axisU.z,
    axisVx: axisV.x,
    axisVz: axisV.z,
    halfU,
    halfV,
    diagLimit: Infinity,
    minX: -Infinity,
    maxX: Infinity,
  };
}
