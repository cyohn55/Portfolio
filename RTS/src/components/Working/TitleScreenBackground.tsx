import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { TitleChaseChoreographer } from './titleScreenChoreography';
import { Skybox } from './Skybox';

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
 *  - If the GLB ships with its own camera node (authored in Blender), that
 *    camera is promoted to the active render camera so the menu shows the
 *    exact framing the artist set up. Otherwise we fall back to auto-fitting
 *    a camera around the model's bounding sphere.
 *  - DPR capped at 2 and antialias enabled only on wider viewports, matching
 *    the perf posture used by the main game Canvas in App.tsx.
 *
 * The CSS gradient on `.main-menu` stays in place as a fallback color so the
 * user never sees a flash of black while the ~15 MB GLB streams in.
 */

const TITLE_MODEL_URL = `${import.meta.env.BASE_URL}models/Title_Screen.glb`;

// Distance multiplier applied to the model's bounding-sphere radius when the
// fallback auto-fit camera has to frame the model itself (i.e. the GLB does
// not carry a camera node). Lower = camera sits closer, model appears larger.
const CAMERA_DISTANCE_FACTOR = 0.55;

// Far-clip distance for whichever camera ends up active on the menu. The nebula
// Skybox is a single enormous sphere (~55,842-unit radius at its game scale)
// centered near the origin, so the camera sits deep inside it. The active
// camera's far plane must comfortably exceed that radius or the skybox is
// clipped away entirely. Matches the game Canvas's far plane (App.tsx).
const SKYBOX_SAFE_FAR = 200000;

/**
 * Walks the cloned scene graph and returns the first perspective camera node
 * found. Authored cameras come through gltf nodes with isPerspectiveCamera
 * set; orthographic cameras are intentionally ignored because the rest of the
 * pipeline (FOV-based culling, post fx if any) assumes a perspective camera.
 */
function findEmbeddedCamera(root: THREE.Object3D): THREE.PerspectiveCamera | undefined {
  let found: THREE.PerspectiveCamera | undefined;
  root.traverse((obj) => {
    if (found) return;
    const cam = obj as THREE.PerspectiveCamera;
    if (cam.isCamera && cam.isPerspectiveCamera) found = cam;
  });
  return found;
}

function TitleModel() {
  const { scene } = useGLTF(TITLE_MODEL_URL);
  const setDefaults = useThree((s) => s.set);
  const size = useThree((s) => s.size);

  // Clone so re-mounting the menu (e.g. after exiting a match) doesn't
  // accumulate mutations on the cached GLTF scene that useGLTF returns by
  // reference. We also branch here on whether the GLB carries its own camera:
  // if it does, we present the model in its native pose so the authored camera
  // transform frames it correctly; if not, we recenter the model and emit a
  // bounding-sphere radius for AutoFitCamera to consume.
  const { sceneClone, embeddedCamera, fallbackRadius } = useMemo(() => {
    const root = scene.clone(true);
    const camera = findEmbeddedCamera(root);

    if (camera) {
      return { sceneClone: root, embeddedCamera: camera, fallbackRadius: 0 };
    }

    const box = new THREE.Box3().setFromObject(root);
    const center = new THREE.Vector3();
    const sphere = new THREE.Sphere();
    box.getCenter(center);
    box.getBoundingSphere(sphere);
    root.position.sub(center);

    return { sceneClone: root, embeddedCamera: undefined, fallbackRadius: sphere.radius || 1 };
  }, [scene]);

  // Build the chase choreographer once the scene clone exists. Construction
  // locates each animal group by name and re-parents the animals to the scene
  // root. If the GLB carries no named animal groups, no pairs resolve and the
  // title screen simply renders statically.
  const choreographer = useMemo(() => new TitleChaseChoreographer(sceneClone), [sceneClone]);

  // Advance the chase every frame off the shared render clock. The camera lets
  // the active pair retire once it has walked out of view.
  useFrame(({ clock, camera }) => {
    choreographer.update(clock.elapsedTime, camera);
  });

  // Dev-only handle so the title-screen chase test can read live placements
  // (mirrors the __rtsStore / __rtsAnimals handles used by the gameplay tests).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __rtsTitleChoreographer?: TitleChaseChoreographer }).__rtsTitleChoreographer =
      choreographer;
    return () => {
      delete (window as unknown as { __rtsTitleChoreographer?: TitleChaseChoreographer }).__rtsTitleChoreographer;
    };
  }, [choreographer]);

  // Promote the authored camera to the active render camera. Re-applying on
  // size changes keeps the projection matrix in sync when the window resizes
  // (the GLB stores a fixed aspect from Blender that won't match the canvas).
  useEffect(() => {
    if (!embeddedCamera) return;
    embeddedCamera.updateMatrixWorld(true);
    embeddedCamera.aspect = size.width / Math.max(size.height, 1);
    // Push the far plane out so the surrounding Skybox sphere is inside the
    // view frustum; the authored Blender far plane is sized for the model only.
    embeddedCamera.far = Math.max(embeddedCamera.far, SKYBOX_SAFE_FAR);
    embeddedCamera.updateProjectionMatrix();
    setDefaults({ camera: embeddedCamera });
  }, [embeddedCamera, size.width, size.height, setDefaults]);

  // userData.radius is read by AutoFitCamera only in the fallback path; when
  // an embedded camera is present we set it to 0 so AutoFitCamera bails out.
  return (
    <group userData={{ radius: fallbackRadius }}>
      <primitive object={sceneClone} />
    </group>
  );
}

/**
 * Fallback framing for GLBs that do NOT ship a camera. Places a camera at a
 * distance proportional to the loaded model's bounding sphere. We can't read
 * that radius until after Suspense resolves, so this sits inside the same
 * Suspense boundary as TitleModel and reads it off the mounted group's
 * userData on the first useFrame.
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
    // Reach past the model's own framing distance so the Skybox sphere remains
    // inside the frustum (see SKYBOX_SAFE_FAR).
    camera.far = Math.max(distance * 10, SKYBOX_SAFE_FAR);
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
      camera={{ fov: 45, position: [0, 0, 50], far: SKYBOX_SAFE_FAR }}
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
        {/* Same rotating nebula Skybox the in-game scene renders (HexGrid.tsx).
            It draws with renderOrder -1000 and depthWrite off, so it always sits
            behind the title model and animals regardless of mount order. */}
        <Skybox />
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
