import * as THREE from 'three';

// Team-colored silhouette outline for unit models, drawn with the classic
// "inverted hull" technique: the unit's own geometry is rendered a second time
// with only its BACK faces, each vertex pushed a hair outward along its normal.
// The expanded back-face shell pokes out just past the real model, so all that
// shows is a thin rim hugging the silhouette — the opaque body covers the rest.
// Blue for the player's units, red for the enemy, with a small unlit glow.
//
// The push is applied in OBJECT space, before the per-instance/world scale, so a
// fixed thickness here yields an outline whose width tracks each model's on-field
// size (a big Yetti and a small Bee both read as equally thin). The models bake to
// a longest edge of ~1 unit, so this is roughly the rim width as a fraction of the
// model — ~6% reads as a thin-but-clearly-visible edge at gameplay camera distance
// (1-2% was invisibly thin). Tune via thickness.
const DEFAULT_OUTLINE_THICKNESS = 0.06;

// Name of the welded smooth-normal vertex attribute the outline shader extrudes
// along. See ensureSmoothOutlineNormals for why the model's own normals can't be
// used directly.
const SMOOTH_NORMAL_ATTRIBUTE = 'aSmoothNormal';

// Bright, slightly glowing team colors (tone mapping is left off so they stay
// saturated against the scene rather than being crushed by the AgX grade).
export const OUTLINE_OWN_COLOR = 0x3b9dff;   // player / friendly = blue
export const OUTLINE_ENEMY_COLOR = 0xff3b46; // enemy = red

/**
 * Add a welded smooth-normal attribute (`aSmoothNormal`) to a geometry so the
 * inverted-hull outline shell stays continuous.
 *
 * The models bake with HARD normals: at every hard edge / UV seam the same point
 * in space carries several vertices, each with a different face normal. Extruding
 * along those raw, split normals tears the shell apart — neighbouring faces push
 * in different directions and separate, so the rim reads as disconnected facets
 * (a "segmented" outline) and the diverging faces can fold in FRONT of the body,
 * painting the outline onto the animal instead of around it.
 *
 * The fix is to extrude every coincident vertex along ONE shared direction: the
 * average of all face normals meeting at that point. That keeps the expanded
 * shell welded — a single smooth envelope that hugs the true silhouette — so the
 * rim is continuous and stays behind the body except at the silhouette edge.
 *
 * Idempotent and cheap: the attribute is computed once per geometry and cached on
 * it. Safe to call on geometry shared with the lit body mesh — the body's shader
 * never references this extra attribute.
 */
export function ensureSmoothOutlineNormals(geometry: THREE.BufferGeometry): void {
  if (geometry.getAttribute(SMOOTH_NORMAL_ATTRIBUTE)) return;

  if (!geometry.getAttribute('normal')) {
    geometry.computeVertexNormals();
  }
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const vertexCount = position.count;

  // Accumulate every vertex's normal into a bucket keyed by its (quantized)
  // position, so all coincident-but-split vertices share one summed direction.
  const summedNormalByPosition = new Map<string, THREE.Vector3>();
  const positionKey = (index: number): string => {
    // Round to ~0.1mm on the ~1-unit-tall baked models: tight enough to keep
    // genuinely distinct vertices apart, loose enough to weld the float-identical
    // duplicates the exporter emits at hard edges.
    const x = Math.round(position.getX(index) * 1e4);
    const y = Math.round(position.getY(index) * 1e4);
    const z = Math.round(position.getZ(index) * 1e4);
    return `${x},${y},${z}`;
  };

  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex++) {
    const key = positionKey(vertexIndex);
    let summed = summedNormalByPosition.get(key);
    if (!summed) {
      summed = new THREE.Vector3();
      summedNormalByPosition.set(key, summed);
    }
    summed.x += normal.getX(vertexIndex);
    summed.y += normal.getY(vertexIndex);
    summed.z += normal.getZ(vertexIndex);
  }

  const smoothNormals = new Float32Array(vertexCount * 3);
  const welded = new THREE.Vector3();
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex++) {
    welded.copy(summedNormalByPosition.get(positionKey(vertexIndex))!);
    if (welded.lengthSq() === 0) {
      // Opposing normals cancelled out (a paper-thin shell): fall back to this
      // vertex's own normal so the push still has a direction.
      welded.set(normal.getX(vertexIndex), normal.getY(vertexIndex), normal.getZ(vertexIndex));
    }
    welded.normalize();
    smoothNormals[vertexIndex * 3] = welded.x;
    smoothNormals[vertexIndex * 3 + 1] = welded.y;
    smoothNormals[vertexIndex * 3 + 2] = welded.z;
  }

  geometry.setAttribute(SMOOTH_NORMAL_ATTRIBUTE, new THREE.BufferAttribute(smoothNormals, 3));
}

/**
 * Build a MeshBasicMaterial that renders an inverted-hull outline. Reuse a single
 * instance across many meshes: pass `color: 0xffffff` and drive per-instance color
 * through an InstancedMesh's instance color, or bake a fixed team color in for
 * non-instanced meshes. The same material works in both cases because the normal
 * push is injected through three's standard vertex pipeline (so instancing,
 * instance color, and morph/skin all keep working).
 *
 * Every geometry drawn with this material MUST first be passed through
 * {@link ensureSmoothOutlineNormals}; the shader extrudes along that welded
 * attribute, not the model's own normals.
 */
export function createOutlineMaterial(options?: {
  color?: THREE.ColorRepresentation;
  thickness?: number;
}): THREE.MeshBasicMaterial {
  const thickness = options?.thickness ?? DEFAULT_OUTLINE_THICKNESS;
  const material = new THREE.MeshBasicMaterial({
    color: options?.color ?? 0xffffff,
    side: THREE.BackSide,
    toneMapped: false,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uOutlineThickness = { value: thickness };
    // Extrude along the welded smooth normal (ensureSmoothOutlineNormals), NOT the
    // model's split face normals: a fixed thickness along one shared direction per
    // point keeps the back-face shell continuous, so the rim reads as a single
    // glowing edge instead of separated facets.
    shader.vertexShader =
      'uniform float uOutlineThickness;\n' +
      `attribute vec3 ${SMOOTH_NORMAL_ATTRIBUTE};\n` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n' +
          `  transformed += normalize( ${SMOOTH_NORMAL_ATTRIBUTE} ) * uOutlineThickness;`,
      );
  };

  return material;
}
