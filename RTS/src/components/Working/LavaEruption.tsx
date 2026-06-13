import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  createEruptionParticles,
  resetEruptionParticles,
  updateEruptionParticles,
  EMISSION_DURATION_S,
  ERUPTION_TOTAL_DURATION_S,
  PARTICLES_PER_VENT,
  type EruptionParticles,
  type Vec3Tuple,
} from './lavaEruptionSim';

/**
 * Victory lava eruption.
 *
 * Renders a single additive point cloud whose particles burst upward out of the
 * Battle_Map's Center/Left/Right eruption vents the moment the match is won, then
 * arc back down and fade — the dramatic finale shown before the post-game screen
 * is revealed. All physics and the lava look come from the pure `lavaEruptionSim`
 * module; this component only owns the Three.js buffers, the glow shader, and the
 * arm/disarm lifecycle keyed off the `active` flag.
 */
interface LavaEruptionProps {
  /** World positions of the eruption vents (the GLB's *_Eruption locator nodes). */
  origins: THREE.Vector3[];
  /** True once the match is won; its rising edge ignites a fresh eruption. */
  active: boolean;
}

// Round, soft-edged glowing embers sized by perspective. Color/opacity arrive
// per-particle from the simulation so the shader stays a thin presentation layer.
const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aAlpha;
  uniform float uSizeScale;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float pointSize = aSize * uSizeScale / max(-mvPosition.z, 1.0);
    gl_PointSize = clamp(pointSize, 0.0, 80.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 fromCenter = gl_PointCoord - vec2(0.5);
    float dist = length(fromCenter);
    if (dist > 0.5) discard;
    // Bright core falling off to a soft edge.
    float falloff = smoothstep(0.5, 0.05, dist);
    gl_FragColor = vec4(vColor, vAlpha * falloff);
  }
`;

// Maps the simulation's world-space blob radius to screen pixels (with the
// 1/depth perspective term applied in the vertex shader).
const SIZE_SCALE = 2500;

export function LavaEruption({ origins, active }: LavaEruptionProps) {
  // Stable plain-number origins so the sim/geometry only rebuild when the vents
  // actually change (e.g. the map reloads), not on every render.
  const originTuples = useMemo<Vec3Tuple[]>(
    () => origins.map((o) => [o.x, o.y, o.z] as Vec3Tuple),
    [origins],
  );

  const sim = useMemo<EruptionParticles>(
    () => createEruptionParticles(originTuples.length, PARTICLES_PER_VENT, originTuples),
    [originTuples],
  );

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(sim.position, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(sim.color, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sim.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(sim.alpha, 1));
    return geo;
  }, [sim]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uSizeScale: { value: SIZE_SCALE } },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );

  const pointsRef = useRef<THREE.Points>(null);
  const wasActive = useRef(false);
  const elapsedS = useRef(0);
  const erupting = useRef(false);

  useFrame((_, delta) => {
    const points = pointsRef.current;
    if (!points) return;

    // Rising edge of `active` (the win) re-arms a fresh eruption from t=0.
    if (active && !wasActive.current) {
      resetEruptionParticles(sim, originTuples);
      elapsedS.current = 0;
      erupting.current = true;
      points.visible = true;
    }
    // Falling edge (rematch / leaving the match) stops and hides immediately.
    if (!active && wasActive.current) {
      erupting.current = false;
      points.visible = false;
    }
    wasActive.current = active;

    if (!erupting.current) return;

    // Cap dt so a stutter or tab-out can't teleport particles across the arc.
    const dt = Math.min(delta, 0.05);
    elapsedS.current += dt;
    const emitting = elapsedS.current < EMISSION_DURATION_S;
    updateEruptionParticles(sim, originTuples, dt, emitting);

    geometry.getAttribute('position').needsUpdate = true;
    geometry.getAttribute('aColor').needsUpdate = true;
    geometry.getAttribute('aSize').needsUpdate = true;
    geometry.getAttribute('aAlpha').needsUpdate = true;

    // Emission has ended and the last particle has surely died — retire the effect.
    if (elapsedS.current >= ERUPTION_TOTAL_DURATION_S) {
      erupting.current = false;
      points.visible = false;
    }
  });

  if (originTuples.length === 0) return null;

  return (
    <points
      ref={pointsRef}
      geometry={geometry}
      material={material}
      visible={false}
      frustumCulled={false}
    />
  );
}
