import { useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import * as THREE from 'three';
import { useGameStore } from '../game/state';

/**
 * Production lighting layer that gives the battlefield models the bright, vivid,
 * stylized ("Pixar"-leaning) look the team-select preview has, while keeping the
 * day/night cycle. It does three things, all driven by the player-tunable
 * lightingSettings (Settings → Video):
 *
 *   B (IBL)            — a soft studio environment, baked locally from Lightformers
 *                        (no external HDRI download), supplies the wrap-around fill
 *                        that lifts each model's shadow side instead of letting it
 *                        crush to black. Its strength is the `environmentIntensity`
 *                        knob, applied as `material.envMapIntensity` across the scene
 *                        (three r160 has no global `scene.environmentIntensity`).
 *   C (tamed rig)      — handled in DayNightCycle: the day/night lights were lowered
 *                        so they no longer blow out surfaces, now that IBL fills shadows.
 *   D (tone mapping)   — AgX tone mapping preserves hue and saturation under bright
 *                        light (unlike ACES, which desaturates highlights toward grey),
 *                        keeping colors vivid. `exposure` is the overall brightness knob.
 */

// How often (in frames at ~60fps) to re-apply envMapIntensity. Materials stream in as
// models finish loading, so a periodic sweep catches late arrivals; ~0.5s is invisible
// to the player and cheap (a handful of shared materials, not per-instance work).
const ENV_INTENSITY_REFRESH_INTERVAL = 30;

export function SceneLighting() {
  const exposure = useGameStore((s) => s.lightingSettings.exposure);
  const environmentIntensity = useGameStore((s) => s.lightingSettings.environmentIntensity);

  const { gl, scene } = useThree();
  const frameCounter = useRef(0);

  // Tone mapping: switch from R3F's default ACES (which greys out vivid highlights) to
  // AgX, which holds saturation. Exposure is the master brightness control.
  useEffect(() => {
    gl.toneMapping = THREE.AgXToneMapping;
    gl.toneMappingExposure = exposure;
  }, [gl, exposure]);

  // Push the IBL strength onto every lit material. Only MeshStandard/Physical materials
  // sample the environment map (basic/emissive UI materials ignore it), so we guard on the
  // property's presence. Runs immediately when the knob changes and then on a slow sweep so
  // models that load after the change still receive the current value.
  const applyEnvironmentIntensity = (value: number) => {
    scene.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      if (!material) return;
      const materials = Array.isArray(material) ? material : [material];
      for (const entry of materials) {
        if ('envMapIntensity' in entry) {
          (entry as THREE.MeshStandardMaterial).envMapIntensity = value;
        }
      }
    });
  };

  useEffect(() => {
    applyEnvironmentIntensity(environmentIntensity);
    // applyEnvironmentIntensity reads only its argument; scene is stable for the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentIntensity]);

  useFrame(() => {
    frameCounter.current += 1;
    if (frameCounter.current >= ENV_INTENSITY_REFRESH_INTERVAL) {
      frameCounter.current = 0;
      applyEnvironmentIntensity(environmentIntensity);
    }
  });

  // Baked-once stylized studio environment. `frames={1}` renders the virtual scene a single
  // time into the env map (it never changes), and `background={false}` keeps the day/night
  // sky as the visible backdrop — this only feeds reflections/ambient. The Lightformers form
  // a soft three-point-ish dome: a broad cool sky overhead, a warm key from the front, and a
  // cool fill from behind, so models read as softly lit from all sides.
  return (
    <Environment resolution={256} frames={1} background={false}>
      <color attach="background" args={['#2a3550']} />
      {/* Broad overhead sky fill — the dominant soft ambient. */}
      <Lightformer
        intensity={1.6}
        color="#bcd4ff"
        position={[0, 6, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        scale={[12, 12, 1]}
        form="circle"
      />
      {/* Warm key from the front-upper, gives shape and a sunlit warmth. */}
      <Lightformer
        intensity={2.2}
        color="#fff1d6"
        position={[4, 4, 6]}
        scale={[6, 6, 1]}
        form="rect"
      />
      {/* Cool fill from behind/left to keep the shadow side colored, not black. */}
      <Lightformer
        intensity={1.0}
        color="#9fb8ff"
        position={[-6, 2, -5]}
        scale={[6, 6, 1]}
        form="rect"
      />
    </Environment>
  );
}
