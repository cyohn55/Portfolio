import { Suspense, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

/**
 * TitleScreenBackground
 * ---------------------
 * Renders Title_Screen.glb as a static 3D backdrop behind the main menu
 * (Quick Play / Leader Board buttons). Kept intentionally self-contained:
 *
 *  - Its own React Three Fiber Canvas (separate WebGL context from the game's
 *    main Canvas). The two never coexist — App.tsx only mounts the menu OR the
 *    game Canvas at a time, so we don't risk hitting the browser's WebGL
 *    context cap.
 *  - Auto-fits the camera to the model's bounding sphere so the GLB looks the
 *    same regardless of how the artist scaled it in Blender.
 *  - DPR capped at 2 and antialias enabled only on wider viewports, matching
 *    the perf posture used by the main game Canvas in App.tsx.
 *
 * The CSS gradient on `.main-menu` stays in place as a fallback color so the
 * user never sees a flash of black while the ~15 MB GLB streams in.
 */

const TITLE_MODEL_URL = `${import.meta.env.BASE_URL}models/Title_Screen.glb`;

// Distance multiplier applied to the model's bounding-sphere radius when
// placing the camera. Lower = camera sits closer, model appears larger.
// Was 2.2 (model framed with padding); 0.55 = 1/4 of that distance, which
// makes the model fill the frame roughly 4× larger on-screen.
const CAMERA_DISTANCE_FACTOR = 0.55;

// Static yaw applied to the model around the world Y axis. 0 = present the
// model in its native exported orientation (the artist's pose, set via the
// model's origin in Blender). Adjust if the menu needs a stylized angle.
// NOTE: the auto-fit camera sits off-axis at (+X, +Y, +Z) looking at the
// origin, so positive/negative rotation.y does NOT cleanly map to "viewer's
// right/left" — pick the sign empirically.
const TITLE_YAW_RADIANS = (5 * Math.PI) / 18; // +50°

function TitleModel() {
  const { scene } = useGLTF(TITLE_MODEL_URL);

  // Center the model at the origin and capture its size so the parent camera
  // can frame it. We mutate a clone of the loaded scene so re-mounting the
  // menu (e.g. after exiting a match) doesn't accumulate offsets on the cached
  // GLTF scene that useGLTF returns by reference.
  const { centered, radius } = useMemo(() => {
    const root = scene.clone(true);
    const box = new THREE.Box3().setFromObject(root);
    const center = new THREE.Vector3();
    const sphere = new THREE.Sphere();
    box.getCenter(center);
    box.getBoundingSphere(sphere);

    // Translate so the model sits centered on (0, 0, 0).
    root.position.sub(center);

    return { centered: root, radius: sphere.radius || 1 };
  }, [scene]);

  // Expose the computed radius via userData on the group so AutoFitCamera can
  // read it off the mounted scene. Cheaper than threading callbacks through props.
  return (
    <group userData={{ radius }} rotation={[0, TITLE_YAW_RADIANS, 0]}>
      <primitive object={centered} />
    </group>
  );
}

/**
 * Camera placed at a distance proportional to the loaded model's bounding
 * sphere. We can't read that radius until after Suspense resolves, so this
 * sits inside the same Suspense boundary as TitleModel and reads it off the
 * mounted group's userData on the first useFrame.
 */
function AutoFitCamera() {
  const fittedRef = useRef(false);

  useFrame(({ camera, scene }) => {
    if (fittedRef.current) return;
    const target = scene.getObjectByProperty('type', 'Group') as THREE.Group | undefined;
    const radius = (target?.userData?.radius as number | undefined) ?? 0;
    if (!radius) return;

    const distance = radius * CAMERA_DISTANCE_FACTOR;
    camera.position.set(distance * 0.4, distance * 0.35, distance);
    camera.lookAt(0, 0, 0);
    camera.near = Math.max(0.1, distance / 1000);
    camera.far = distance * 10;
    camera.updateProjectionMatrix();
    fittedRef.current = true;
  });

  return null;
}

export function TitleScreenBackground() {
  const antialias = typeof window !== 'undefined' && window.innerWidth > 768;

  return (
    <Canvas
      // Transparent so the .main-menu CSS gradient shows through before the
      // GLB resolves, and at any pixels the model doesn't cover.
      gl={{ antialias, alpha: true, powerPreference: 'high-performance' }}
      dpr={[1, 2]}
      camera={{ fov: 45, position: [0, 0, 50] }}
      // pointerEvents:none so the canvas never swallows clicks meant for the
      // Quick Play / Leader Board buttons sitting at higher z-index in the DOM.
      style={{ width: '100%', height: '100%', display: 'block', pointerEvents: 'none' }}
    >
      {/* Soft three-point-ish lighting; the GLB carries baked materials so we
          only need enough light to reveal them without blowing out highlights. */}
      <ambientLight intensity={0.9} />
      <directionalLight position={[10, 12, 8]} intensity={1.1} />
      <directionalLight position={[-8, 4, -6]} intensity={0.4} />

      <Suspense fallback={null}>
        <TitleModel />
        <AutoFitCamera />
      </Suspense>
    </Canvas>
  );
}

// Preload so the GLB starts downloading the moment the menu module is imported,
// not when the component mounts. Same pattern used in HexGrid.tsx for the
// Battle_Map model.
useGLTF.preload(TITLE_MODEL_URL);
