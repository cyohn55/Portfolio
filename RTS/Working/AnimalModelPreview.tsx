import { Suspense, useMemo, useRef } from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import * as THREE from 'three';
import type { AnimalId } from '../src/game/types';

// File mapping mirrors AnimalSelectionButtons / ModelPreloader so we share
// the same on-disk assets (and their already-warm GLTF caches).
const ANIMAL_FILE_MAP: Record<AnimalId, string> = {
  Bee: 'Bee.glb',
  Bear: 'Bear.glb',
  Bunny: 'Bunny.glb',
  Chicken: 'Chicken.glb',
  Cat: 'cat.glb',
  Dolphin: 'dolphin.glb',
  Fox: 'Fox.glb',
  Frog: 'Frog.glb',
  Owl: 'Owl.glb',
  Pig: 'Pig.glb',
  Turtle: 'Turtle.glb',
  Yetti: 'Yeti.glb',
};

// Some source models face away from the camera; flip them so the front of the
// animal is shown in the card.
const ROTATED_180: ReadonlySet<AnimalId> = new Set<AnimalId>(['Bunny', 'Yetti']);

// Pose-frame animals pack several pose objects (e.g. Fox_F0..Fox_F2) into one
// glb. A card should show a single representative pose, so map each such animal
// to the one pose node to keep; every other pose object is stripped from the
// card's scene (otherwise all poses render overlapping).
const CARD_POSE_NODE: Partial<Record<AnimalId, string>> = {
  Fox: 'Fox_F2',
  Turtle: 'Turtle_F1',
  Yetti: 'Yeti_F0',
  Cat: 'Kitty_F0',
  Bee: 'Bee_F0',
};

// Pose-root objects are named "<Prefix>_F<number>" (Fox_F0, Turtle_F3, …).
const POSE_ROOT_NAME = /_F\d+$/;

const TARGET_DISPLAY_SIZE = 3.0;     // Three.js units the model should fit within
const VERTICAL_OFFSET = -1.4;        // pull the model down so it sits in the frame
const AUTO_ROTATE_RAD_PER_SEC = 0.6; // slow lazy-susan rotation

function modelUrl(animal: AnimalId): string {
  return `${import.meta.env.BASE_URL}models/${ANIMAL_FILE_MAP[animal]}`;
}

function AnimalModel({ animal }: { animal: AnimalId }) {
  const groupRef = useRef<THREE.Group>(null);
  const gltf = useLoader(GLTFLoader, modelUrl(animal), (loader: GLTFLoader) => {
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
    loader.setDRACOLoader(draco);
  });

  // Clone-and-normalize so each card gets its own transform without mutating
  // the cached scene graph shared with the rest of the app.
  const preparedScene = useMemo(() => {
    if (!gltf?.scene) return null;

    const scene = gltf.scene.clone(true);
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      }
    });

    // For pose-frame animals, keep only the chosen pose object and drop the rest
    // so the card shows a single pose instead of every pose at once.
    const keepPoseName = CARD_POSE_NODE[animal];
    if (keepPoseName) {
      const posesToRemove: THREE.Object3D[] = [];
      scene.traverse((obj) => {
        if (POSE_ROOT_NAME.test(obj.name) && obj.name !== keepPoseName) {
          posesToRemove.push(obj);
        }
      });
      posesToRemove.forEach((obj) => obj.removeFromParent());
    }

    // Bounds reflect only the pose objects that remain.
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = TARGET_DISPLAY_SIZE / maxDim;
    scene.scale.setScalar(scale);

    const center = new THREE.Vector3();
    box.getCenter(center);
    // Re-center on X/Z, drop to floor on Y, then nudge down by VERTICAL_OFFSET.
    scene.position.set(
      -center.x * scale,
      -box.min.y * scale + VERTICAL_OFFSET,
      -center.z * scale,
    );

    if (ROTATED_180.has(animal)) {
      scene.rotation.y = Math.PI;
    }

    return scene;
  }, [gltf, animal]);

  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += AUTO_ROTATE_RAD_PER_SEC * delta;
    }
  });

  if (!preparedScene) {
    return null;
  }

  return (
    <group ref={groupRef}>
      <primitive object={preparedScene} />
    </group>
  );
}

interface AnimalModelPreviewProps {
  animal: AnimalId;
}

/**
 * Small 3D preview of an animal, intended to sit at the top of a card in the
 * "Choose Your Team" lobby. The host element controls width/height via CSS;
 * this component fills it.
 */
export function AnimalModelPreview({ animal }: AnimalModelPreviewProps) {
  return (
    <Canvas
      camera={{ fov: 40, position: [0, 0.5, 5.5] }}
      style={{ width: '100%', height: '100%', background: 'transparent' }}
      gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
      dpr={[1, 1.5]}
    >
      <ambientLight intensity={1.1} />
      <directionalLight position={[2, 3, 3]} intensity={1.4} />
      <directionalLight position={[-2, 2, 2]} intensity={0.7} />
      <pointLight position={[0, 0, 4]} intensity={0.8} color="#ffffff" />
      <Suspense fallback={null}>
        <AnimalModel animal={animal} />
      </Suspense>
    </Canvas>
  );
}
