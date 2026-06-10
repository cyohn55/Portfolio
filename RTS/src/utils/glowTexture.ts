import * as THREE from 'three';

// A soft, white radial-gradient sprite used as the alpha mask for the team-colored
// unit aura outline. It is bright through the inner body and fades to fully
// transparent at the rim, so when the texture is drawn on a camera-facing quad
// behind a unit (additively, with depth-test on) the opaque model occludes the
// center and only a soft colored halo bleeds out around the silhouette — exactly
// the "stand out against the background" glow the aura is meant to give.
//
// The gradient is rendered to an offscreen canvas once and cached: the texture is
// color-agnostic (tinted per team via each material's `color`), so a single shared
// instance serves every unit in both game modes (Quick Play and Conquest).
let cachedGlowTexture: THREE.Texture | null = null;

const GLOW_TEXTURE_SIZE = 128;

function renderRadialGlowTexture(): THREE.Texture {
  // Guard for non-DOM environments (e.g. the headless determinism harness). The
  // aura is purely visual and never runs in those builds, but a 1x1 fallback keeps
  // an accidental import from throwing.
  if (typeof document === 'undefined') {
    return new THREE.Texture();
  }

  const canvas = document.createElement('canvas');
  canvas.width = GLOW_TEXTURE_SIZE;
  canvas.height = GLOW_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  if (!context) return new THREE.Texture();

  const center = GLOW_TEXTURE_SIZE / 2;
  const gradient = context.createRadialGradient(center, center, 0, center, center, center);
  // White core (the material tints it) fading out toward the rim. The mid-radius
  // stays near-opaque so the halo that escapes around the unit silhouette reads
  // strongly, then it tapers smoothly to zero so the outline has no hard edge.
  gradient.addColorStop(0.0, 'rgba(255,255,255,0.55)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.85)');
  gradient.addColorStop(0.78, 'rgba(255,255,255,0.30)');
  gradient.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, GLOW_TEXTURE_SIZE, GLOW_TEXTURE_SIZE);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Return the shared radial-glow alpha texture for the team-colored unit aura,
 * creating it on first use. Safe to reuse across many materials and both game
 * modes, since the texture is immutable and tinted per material.
 */
export function getRadialGlowTexture(): THREE.Texture {
  if (!cachedGlowTexture) {
    cachedGlowTexture = renderRadialGlowTexture();
  }
  return cachedGlowTexture;
}
