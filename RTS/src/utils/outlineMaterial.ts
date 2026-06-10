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

// Bright, slightly glowing team colors (tone mapping is left off so they stay
// saturated against the scene rather than being crushed by the AgX grade).
export const OUTLINE_OWN_COLOR = 0x3b9dff;   // player / friendly = blue
export const OUTLINE_ENEMY_COLOR = 0xff3b46; // enemy = red

/**
 * Build a MeshBasicMaterial that renders an inverted-hull outline. Reuse a single
 * instance across many meshes: pass `color: 0xffffff` and drive per-instance color
 * through an InstancedMesh's instance color, or bake a fixed team color in for
 * non-instanced meshes. The same material works in both cases because the normal
 * push is injected through three's standard vertex pipeline (so instancing,
 * instance color, and morph/skin all keep working).
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
    shader.vertexShader =
      'uniform float uOutlineThickness;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  transformed += normalize( objectNormal ) * uOutlineThickness;',
      );
  };

  return material;
}
