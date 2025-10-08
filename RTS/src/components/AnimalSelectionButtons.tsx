import { useMemo, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { useLoader } from '@react-three/fiber';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { useGameStore } from '../game/state';
import type { AnimalId } from '../game/types';
import * as THREE from 'three';

// Model file mapping
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

// Simple color scheme for each animal type
const ANIMAL_COLORS: Record<AnimalId, string> = {
  Bee: '#FFD700',      // Gold
  Bear: '#8B4513',     // Saddle brown
  Bunny: '#F5F5DC',    // Beige
  Chicken: '#FFA500',  // Orange
  Cat: '#FF69B4',      // Hot pink
  Dolphin: '#1E90FF',  // Dodger blue
  Fox: '#FF4500',      // Orange red
  Frog: '#32CD32',     // Lime green
  Owl: '#9370DB',      // Medium purple
  Pig: '#FFB6C1',      // Light pink
  Turtle: '#2E8B57',   // Sea green
  Yetti: '#87CEEB',    // Sky blue
};

function getModelPath(animal: AnimalId) {
  return `/models/${ANIMAL_FILE_MAP[animal]}`;
}

// 3D Model component for buttons
function AnimalModel({ animal }: { animal: AnimalId }) {
  const path = getModelPath(animal);
  const gltf = useLoader(GLTFLoader, path, (loader: GLTFLoader) => {
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
    loader.setDRACOLoader(draco);
  });

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

    // Scale and center the model for button display
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = 3.5 / maxDim;
    scene.scale.setScalar(scale);

    const center = new THREE.Vector3();
    box.getCenter(center);
    scene.position.set(-center.x * scale, -(box.min.y) * scale - 1.5, -center.z * scale);

    // Flip Bunny and Yetti models 180 degrees around Y-axis
    if (animal === 'Bunny' || animal === 'Yetti') {
      scene.rotation.y = Math.PI;
    }

    return scene;
  }, [gltf]);

  if (!preparedScene) {
    return (
      <mesh position={[0, -1.5, 0]}>
        <sphereGeometry args={[1.5, 16, 16]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>
    );
  }

  return <primitive object={preparedScene} />;
}

interface AnimalButtonProps {
  animal: AnimalId;
  selectedCount: number;
  totalCount: number;
  onClick: () => void;
}

function AnimalButton({ animal, selectedCount, totalCount, onClick }: AnimalButtonProps) {
  const backgroundColor = ANIMAL_COLORS[animal];
  const isSelected = selectedCount > 0;

  return (
    <button
      onClick={onClick}
      style={{
        position: 'relative',
        width: '80px',
        height: '80px',
        backgroundColor,
        border: isSelected ? '3px solid #FFFFFF' : '2px solid rgba(255, 255, 255, 0.5)',
        borderRadius: '12px',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px',
        transition: 'all 0.2s ease',
        transform: isSelected ? 'scale(1.05)' : 'scale(1)',
        boxShadow: isSelected
          ? '0 0 20px rgba(255, 255, 255, 0.8), 0 4px 12px rgba(0, 0, 0, 0.3)'
          : '0 4px 8px rgba(0, 0, 0, 0.3)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        overflow: 'hidden',
        padding: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = isSelected ? 'scale(1.1)' : 'scale(1.05)';
        e.currentTarget.style.boxShadow = '0 0 25px rgba(255, 255, 255, 0.9), 0 6px 16px rgba(0, 0, 0, 0.4)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = isSelected ? 'scale(1.05)' : 'scale(1)';
        e.currentTarget.style.boxShadow = isSelected
          ? '0 0 20px rgba(255, 255, 255, 0.8), 0 4px 12px rgba(0, 0, 0, 0.3)'
          : '0 4px 8px rgba(0, 0, 0, 0.3)';
      }}
    >
      {/* 3D Model Canvas - centered in button */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '70px',
          height: '70px',
          pointerEvents: 'none',
        }}
      >
        <Canvas
          camera={{ fov: 45, position: [0, 0, 5] }}
          style={{
            width: '100%',
            height: '100%',
            background: 'transparent',
          }}
          gl={{
            alpha: true,
            antialias: false,
            powerPreference: 'high-performance',
          }}
        >
          {/* Strong ambient light for overall visibility */}
          <ambientLight intensity={1.2} />
          {/* Key light from front-top */}
          <directionalLight position={[2, 3, 3]} intensity={1.5} />
          {/* Fill light from opposite side */}
          <directionalLight position={[-2, 2, 2]} intensity={0.8} />
          {/* Front point light for pop */}
          <pointLight position={[0, 0, 4]} intensity={1.0} color="#ffffff" />
          <Suspense fallback={null}>
            <AnimalModel animal={animal} />
          </Suspense>
        </Canvas>
      </div>

      {/* Unit count badge - bottom right */}
      <div
        style={{
          position: 'absolute',
          bottom: '4px',
          right: '4px',
          fontSize: '14px',
          fontWeight: '900',
          color: '#FFFFFF',
          textShadow: '0 1px 3px rgba(0, 0, 0, 0.8)',
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          borderRadius: '4px',
          padding: '2px 6px',
          pointerEvents: 'none',
        }}
      >
        {totalCount}
      </div>

      {/* Selection indicator badge - top right */}
      {isSelected && (
        <div
          style={{
            position: 'absolute',
            top: '-6px',
            right: '-6px',
            width: '24px',
            height: '24px',
            backgroundColor: '#00FF00',
            border: '2px solid #FFFFFF',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '12px',
            fontWeight: '700',
            color: '#000000',
            boxShadow: '0 2px 6px rgba(0, 0, 0, 0.4)',
          }}
        >
          {selectedCount}
        </div>
      )}

      {/* Animal name label - bottom center */}
      <div
        style={{
          position: 'absolute',
          bottom: '-22px',
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: '11px',
          fontWeight: '600',
          color: '#FFFFFF',
          textShadow: '0 1px 3px rgba(0, 0, 0, 0.8)',
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }}
      >
        {animal}
      </div>
    </button>
  );
}

export function AnimalSelectionButtons() {
  const matchStarted = useGameStore((s) => s.matchStarted);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const selectedAnimalPool = useGameStore((s) => s.selectedAnimalPool);
  const units = useGameStore((s) => s.units);
  const selectedUnitIds = useGameStore((s) => s.selectedUnitIds);
  const selectUnits = useGameStore((s) => s.selectUnits);

  // Get player's units
  const playerUnits = useMemo(() => {
    return units.filter(u => u.ownerId === localPlayerId && u.kind === 'Unit');
  }, [units, localPlayerId]);

  // Calculate counts and selections per animal
  const animalData = useMemo(() => {
    const data: Record<AnimalId, { total: number; selected: number }> = {} as any;

    for (const animal of selectedAnimalPool) {
      const unitsOfThisAnimal = playerUnits.filter(u => u.animal === animal);
      const selectedOfThisAnimal = unitsOfThisAnimal.filter(u => selectedUnitIds.includes(u.id));

      data[animal] = {
        total: unitsOfThisAnimal.length,
        selected: selectedOfThisAnimal.length,
      };
    }

    return data;
  }, [selectedAnimalPool, playerUnits, selectedUnitIds]);

  const handleAnimalButtonClick = (animal: AnimalId) => {
    // Select all units of this animal type
    const allUnitsOfThisAnimal = playerUnits.filter(u => u.animal === animal);
    const unitIds = allUnitsOfThisAnimal.map(u => u.id);
    selectUnits(unitIds);
  };

  if (!matchStarted || selectedAnimalPool.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '30px',
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: '16px',
        zIndex: 1000,
        pointerEvents: 'auto',
      }}
    >
      {selectedAnimalPool.map((animal) => (
        <AnimalButton
          key={animal}
          animal={animal}
          selectedCount={animalData[animal]?.selected || 0}
          totalCount={animalData[animal]?.total || 0}
          onClick={() => handleAnimalButtonClick(animal)}
        />
      ))}
    </div>
  );
}
