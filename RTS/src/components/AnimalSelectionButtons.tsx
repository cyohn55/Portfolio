import { useMemo, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { useLoader } from '@react-three/fiber';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { useGameStore } from '../game/state';
import type { AnimalId, Unit } from '../game/types';
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
  return `${import.meta.env.BASE_URL}models/${ANIMAL_FILE_MAP[animal]}`;
}

// The crown / tiara shown on the King / Queen selection buttons is the 3D prop
// baked into the Bee model. The local player is the Blue ("own") team, so the
// buttons use the blue-team accessory nodes (mirrors royalAccessoryNodeFor in
// ModelPreloader). A King wears the crown; a Queen wears the tiara.
const MONARCH_MODEL_PATH = `${import.meta.env.BASE_URL}models/Bee.glb`;
const MONARCH_ACCESSORY_NODE: Record<'King' | 'Queen', string> = {
  King: 'Blue_Crown',
  Queen: 'Blue_Tiara',
};

// Pose-frame animals pack several pose objects (e.g. Fox_F0..Fox_F2) into one
// glb. A button should show a single representative pose, so map each such
// animal to the one pose node to keep; every other pose object is stripped from
// the button's scene (otherwise all poses render overlapping).
const BUTTON_POSE_NODE: Partial<Record<AnimalId, string>> = {
  Fox: 'Fox_F2',
  Turtle: 'Turtle_F1',
  Yetti: 'Yeti_F0',
  Cat: 'Kitty_F0',
  Bee: 'Bee_F0',
  Frog: 'Frog_F0',
  Chicken: 'Chicken_F0',
};

// Royal head accessories baked into several models for the in-game King/Queen
// units. The button shows a plain animal, so these are always stripped (mirrors
// ROYAL_ACCESSORY_NODE_NAMES in ModelPreloader).
const ROYAL_ACCESSORY_NODE_NAMES = ['Blue_Crown', 'Blue_Tiara', 'Red_Crown', 'Red_Tiara'] as const;

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

    // Strip royal crowns/tiaras so the button shows the bare animal (the
    // pose-frame strip below already removes them for pose animals, but
    // base-variant animals like Bear/Bunny/Owl/Pig need this explicit removal).
    ROYAL_ACCESSORY_NODE_NAMES.forEach((name) => {
      scene.getObjectByName(name)?.removeFromParent();
    });

    // For pose-frame animals, keep only the chosen pose object and drop every
    // other top-level node so the button shows a single pose instead of all of
    // them overlapping. For most animals the only top-level nodes are pose
    // frames; the Frog additionally ships a separate `Tongue` node, which this
    // also drops so the button matches the single Frog_F0 pose seen in-game.
    const keepPoseName = BUTTON_POSE_NODE[animal];
    if (keepPoseName) {
      [...scene.children].forEach((child) => {
        if (child.name !== keepPoseName) child.removeFromParent();
      });
    }

    // Scale and center the model for button display (bounds reflect only the
    // pose objects that remain).
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
  }, [gltf, animal]);

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

// Renders just the Bear model's crown or tiara prop, isolated and recentered so
// it fills a monarch button (the King button shows the crown, the Queen the
// tiara). Every other node in the Bear scene is stripped so only the accessory
// is drawn.
function MonarchAccessoryModel({ kind }: { kind: 'King' | 'Queen' }) {
  const gltf = useLoader(GLTFLoader, MONARCH_MODEL_PATH, (loader: GLTFLoader) => {
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
    loader.setDRACOLoader(draco);
  });

  const accessoryScene = useMemo(() => {
    if (!gltf?.scene) return null;
    const accessory = gltf.scene.getObjectByName(MONARCH_ACCESSORY_NODE[kind]);
    if (!accessory) return null;

    const model = accessory.clone(true);
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      }
    });

    // The accessory node carries its own baked transform that places it on the
    // animal's head, so it cannot be measured-then-overwritten in place. Wrap it
    // in a group and scale/recenter the GROUP, leaving the node's own transform
    // intact, so the prop fills the button centered vertically and horizontally.
    const wrapper = new THREE.Group();
    wrapper.add(model);
    wrapper.updateWorldMatrix(true, true);

    const box = new THREE.Box3().setFromObject(wrapper);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    // The crown reads slightly large next to the tiara, so the King fits a touch
    // smaller than the Queen.
    const fitSize = kind === 'King' ? 3.25 : 3.75;
    const scale = fitSize / maxDim;

    // Recenter the node so the geometry's bounding-box center sits at the wrapper
    // origin, then scale the whole wrapper to fit the button.
    const center = new THREE.Vector3();
    box.getCenter(center);
    model.position.sub(center);
    wrapper.scale.setScalar(scale);

    return wrapper;
  }, [gltf, kind]);

  if (!accessoryScene) {
    return (
      <mesh>
        <sphereGeometry args={[1.0, 12, 12]} />
        <meshStandardMaterial color={kind === 'King' ? '#FFD700' : '#E6C9F0'} />
      </mesh>
    );
  }

  return <primitive object={accessoryScene} />;
}

interface MonarchButtonProps {
  kind: 'King' | 'Queen';
  monarch?: Unit;
  isSelected: boolean;
  onClick: () => void;
}

// One of the two small (quarter-size) monarch selection buttons that sit above
// an animal button: the left selects that animal's King, the right its Queen.
// Disabled (dimmed) when the monarch is no longer alive.
function MonarchButton({ kind, monarch, isSelected, onClick }: MonarchButtonProps) {
  const exists = Boolean(monarch);
  const accentColor = kind === 'King' ? '#FFD700' : '#E6A8E6';

  return (
    <button
      onClick={exists ? onClick : undefined}
      disabled={!exists}
      title={`Select ${kind} (${kind === 'King' ? 'Crown' : 'Tiara'})`}
      style={{
        position: 'relative',
        flex: 1,
        height: '38px',
        backgroundColor: '#4169E1',
        border: isSelected ? `2px solid ${accentColor}` : '1px solid rgba(255, 255, 255, 0.35)',
        borderRadius: '8px',
        cursor: exists ? 'pointer' : 'default',
        opacity: exists ? 1 : 0.4,
        padding: 0,
        overflow: 'hidden',
        transition: 'all 0.2s ease',
        boxShadow: isSelected ? `0 0 12px ${accentColor}` : '0 2px 4px rgba(0, 0, 0, 0.3)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
        }}
      >
        <Canvas
          camera={{ fov: 45, position: [0, 0, 5] }}
          style={{ width: '100%', height: '100%', background: 'transparent' }}
          gl={{ alpha: true, antialias: false, powerPreference: 'high-performance' }}
        >
          <ambientLight intensity={1.2} />
          <directionalLight position={[2, 3, 3]} intensity={1.5} />
          <directionalLight position={[-2, 2, 2]} intensity={0.8} />
          <pointLight position={[0, 0, 4]} intensity={1.0} color="#ffffff" />
          <Suspense fallback={null}>
            <MonarchAccessoryModel kind={kind} />
          </Suspense>
        </Canvas>
      </div>
    </button>
  );
}

interface CommandToggleButtonProps {
  enabled: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  title: string;
}

// A square trigger button to the right of the animal buttons. It reveals/hides one
// of the selection command radials (combat posture, formation) via that radial's
// shared toggle event; disabled when the selection has no commandable units.
function CommandToggleButton({ enabled, onClick, icon, label, title }: CommandToggleButtonProps) {
  return (
    <button
      onClick={enabled ? onClick : undefined}
      disabled={!enabled}
      title={title}
      style={{
        position: 'relative',
        width: '80px',
        height: '80px',
        backgroundColor: 'rgba(28, 38, 64, 0.9)',
        border: '2px solid rgba(129, 160, 255, 0.7)',
        borderRadius: '12px',
        cursor: enabled ? 'pointer' : 'default',
        opacity: enabled ? 1 : 0.5,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        transition: 'all 0.2s ease',
        boxShadow: '0 4px 8px rgba(0, 0, 0, 0.3)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
      onMouseEnter={(e) => {
        if (!enabled) return;
        e.currentTarget.style.borderColor = 'rgba(129, 160, 255, 0.95)';
        e.currentTarget.style.boxShadow = '0 0 18px rgba(129, 160, 255, 0.6), 0 6px 16px rgba(0, 0, 0, 0.4)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'rgba(129, 160, 255, 0.7)';
        e.currentTarget.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.3)';
      }}
    >
      <span style={{ fontSize: '30px', lineHeight: 1 }}>{icon}</span>
      <span style={{ fontSize: '11px', fontWeight: 600, color: '#e2e8f0', whiteSpace: 'nowrap' }}>
        {label}
      </span>
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
  const pilotMonarchById = useGameStore((s) => s.pilotMonarchById);

  // Get player's units
  const playerUnits = useMemo(() => {
    return units.filter(u => u.ownerId === localPlayerId && u.kind === 'Unit');
  }, [units, localPlayerId]);

  // The player's living monarchs keyed by animal, so each animal button can show
  // its King and Queen selection buttons (absent => that monarch is dead).
  const monarchsByAnimal = useMemo(() => {
    const map = {} as Record<AnimalId, { King?: Unit; Queen?: Unit }>;
    for (const animal of selectedAnimalPool) map[animal] = {};
    for (const unit of units) {
      if (unit.ownerId !== localPlayerId) continue;
      if (unit.kind !== 'King' && unit.kind !== 'Queen') continue;
      const entry = map[unit.animal];
      if (entry) entry[unit.kind] = unit;
    }
    return map;
  }, [units, localPlayerId, selectedAnimalPool]);

  // Whether the current selection holds any commandable own unit (non-Base), used
  // to enable the combat-posture toggle just like the radial's own gating.
  const hasCommandableSelection = useMemo(() => {
    return units.some(
      (u) => selectedUnitIds.includes(u.id) && u.ownerId === localPlayerId && u.kind !== 'Base',
    );
  }, [units, selectedUnitIds, localPlayerId]);

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

  // Selecting a King/Queen button immediately hands the player pilot control of
  // that monarch (the gold ring + drive controls), not just a selection.
  const handleMonarchButtonClick = (monarch?: Unit) => {
    if (monarch) pilotMonarchById(monarch.id);
  };

  // Toggle the combat-posture radial via the shared event the BehaviorRadial (and
  // controller/keyboard bindings) already listen for, so this button is just
  // another trigger for the same UI.
  const handleStanceToggle = () => {
    window.dispatchEvent(new CustomEvent('rts:toggle-stance-radial'));
  };

  // Same pattern for the three formation wheels — each is another trigger for the
  // shared toggle event its radial (and the keyboard/controller bindings) listen for.
  const handleFormationToggle = () => {
    window.dispatchEvent(new CustomEvent('rts:toggle-formation-radial'));
  };
  const handleAudibleToggle = () => {
    window.dispatchEvent(new CustomEvent('rts:toggle-audible-radial'));
  };
  const handlePlaybookToggle = () => {
    window.dispatchEvent(new CustomEvent('rts:toggle-playbook-radial'));
  };

  if (!matchStarted || selectedAnimalPool.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '35px',
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'flex-end',
        gap: '16px',
        zIndex: 1000,
        pointerEvents: 'auto',
      }}
    >
      {selectedAnimalPool.map((animal) => {
        const monarchs = monarchsByAnimal[animal] ?? {};
        return (
          <div
            key={animal}
            style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '80px' }}
          >
            {/* Two quarter-size monarch buttons above the animal button: King
                (crown) on the left, Queen (tiara) on the right. */}
            <div style={{ display: 'flex', gap: '4px', width: '80px' }}>
              <MonarchButton
                kind="King"
                monarch={monarchs.King}
                isSelected={monarchs.King ? selectedUnitIds.includes(monarchs.King.id) : false}
                onClick={() => handleMonarchButtonClick(monarchs.King)}
              />
              <MonarchButton
                kind="Queen"
                monarch={monarchs.Queen}
                isSelected={monarchs.Queen ? selectedUnitIds.includes(monarchs.Queen.id) : false}
                onClick={() => handleMonarchButtonClick(monarchs.Queen)}
              />
            </div>

            <AnimalButton
              animal={animal}
              selectedCount={animalData[animal]?.selected || 0}
              totalCount={animalData[animal]?.total || 0}
              onClick={() => handleAnimalButtonClick(animal)}
            />
          </div>
        );
      })}

      {/* Command radials for the selection: combat posture, then the formation wheel. */}
      <CommandToggleButton
        enabled={hasCommandableSelection}
        onClick={handleStanceToggle}
        icon="⚔️"
        label="Posture"
        title="Show/hide combat posture for the selection"
      />
      <CommandToggleButton
        enabled={hasCommandableSelection}
        onClick={handleFormationToggle}
        icon="🎖️"
        label="Formation"
        title="Show/hide the formation shape wheel for the selection"
      />
      <CommandToggleButton
        enabled={hasCommandableSelection}
        onClick={handleAudibleToggle}
        icon="🎚️"
        label="Audible"
        title="Show/hide the formation audible wheel (rotate / spread / disband)"
      />
      <CommandToggleButton
        enabled={hasCommandableSelection}
        onClick={handlePlaybookToggle}
        icon="📋"
        label="Playbook"
        title="Show/hide the playbook wheel (re-shape all teams by role)"
      />
    </div>
  );
}
