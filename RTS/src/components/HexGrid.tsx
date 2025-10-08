import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { useGameStore } from '../game/state';
import { UnitsLayer } from './UnitsLayer';
import { MapInteraction } from './HexInteraction';
import { Skybox } from './Working/Skybox';
import { performanceMonitor } from '../utils/PerformanceMonitor';
import { interpolationHelper } from '../utils/InterpolationHelper';
import * as THREE from 'three';

export function BattleMap() {
  const tick = useGameStore((s) => s.tick);
  const bridgeState = useGameStore((s) => s.bridgeState);
  const { scene } = useGLTF('/models/Battle_Map_compressed.glb');

  // Bridge refs for storing references to bridge objects
  const rightBridgeRefs = useRef<Record<string, THREE.Object3D | null>>({
    Fully_Up: null,
    Almost_Up: null,
    Almost_Down: null,
    Fully_Down: null
  });
  const leftBridgeRefs = useRef<Record<string, THREE.Object3D | null>>({
    Fully_Up: null,
    Almost_Up: null,
    Almost_Down: null,
    Fully_Down: null
  });

  // Process the battle map without centering
  const battleMapScene = useMemo(() => {
    if (!scene) {
      console.log('❌ Battle map scene not loaded yet');
      return null;
    }

    console.log('✅ Battle map scene loaded, processing...');
    // Clone the entire scene to avoid modifying the original
    const clonedScene = scene.clone();

    clonedScene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.receiveShadow = true;
        child.castShadow = true;
      }

      // Check for bridge objects by name
      if (child.name) {
        // Hide Sketchfab model objects
        if (child.name.toLowerCase().includes('sketchfab')) {
          child.visible = false;
          console.log('🙈 Hidden Sketchfab object:', child.name);
        }

        // Look for bridge objects by name
        if (child.name.toLowerCase().includes('bridge')) {
          console.log('Found bridge-related object:', child.name, 'Type:', child.type);
        }

        // Right bridge objects
        if (child.name === 'Right_Bridge_Fully_Up') {
          rightBridgeRefs.current.Fully_Up = child;
          console.log('✓ Found Right_Bridge_Fully_Up');
        } else if (child.name === 'Right_Bridge_Almost_Up') {
          rightBridgeRefs.current.Almost_Up = child;
          console.log('✓ Found Right_Bridge_Almost_Up');
        } else if (child.name === 'Right_Bridge_Almost_Down') {
          rightBridgeRefs.current.Almost_Down = child;
          console.log('✓ Found Right_Bridge_Almost_Down');
        } else if (child.name === 'Right_Bridge_Fully_Down') {
          rightBridgeRefs.current.Fully_Down = child;
          console.log('✓ Found Right_Bridge_Fully_Down');
        }
        // Left bridge objects
        else if (child.name === 'Left_Bridge_Fully_Up') {
          leftBridgeRefs.current.Fully_Up = child;
          console.log('✓ Found Left_Bridge_Fully_Up');
        } else if (child.name === 'Left_Bridge_Almost_Up') {
          leftBridgeRefs.current.Almost_Up = child;
          console.log('✓ Found Left_Bridge_Almost_Up');
        } else if (child.name === 'Left_Bridge_Almost_Down') {
          leftBridgeRefs.current.Almost_Down = child;
          console.log('✓ Found Left_Bridge_Almost_Down');
        } else if (child.name === 'Left_Bridge_Fully_Down') {
          leftBridgeRefs.current.Fully_Down = child;
          console.log('✓ Found Left_Bridge_Fully_Down');
        }
      }
    });

    // Keep the battle map at its original position - don't center it
    // This ensures base coordinates align with terrain features

    return clonedScene;
  }, [scene]);

  const last = useRef(performance.now());
  const accumulator = useRef(0);
  const GAME_LOGIC_FPS = 60; // Full 60 FPS game logic for maximum smoothness
  const FIXED_TIMESTEP = 1000 / GAME_LOGIC_FPS;

  useFrame((state, delta) => {
    const frameStart = performance.now();
    const now = frameStart;
    const frameTime = Math.min(now - last.current, 250); // Cap at 250ms to prevent spiral of death
    last.current = now;
    accumulator.current += frameTime;

    // Measure game logic performance
    const gameLogicStart = performance.now();

    // SYNCHRONIZED: Game logic at 60 FPS matching rendering frequency
    let logicUpdated = false;
    while (accumulator.current >= FIXED_TIMESTEP) {
      tick(FIXED_TIMESTEP / 1000, now);
      accumulator.current -= FIXED_TIMESTEP;
      logicUpdated = true;
    }

    // Update interpolation positions when game logic runs
    if (logicUpdated) {
      const units = useGameStore.getState().units;
      const positions: Record<string, any> = {};
      units.forEach(unit => {
        positions[unit.id] = unit.position;
      });
      interpolationHelper.updatePositions(positions);
    }


    // Update bridge visibility based on game state
    updateBridgeVisibility();

    // Rendering can now exceed game logic frequency for smoother visuals

    const gameLogicTime = performance.now() - gameLogicStart;
    const renderTime = performance.now() - frameStart - gameLogicTime;

    // Update FPS monitoring
    const currentFPS = performanceMonitor.updateFPS();

    // Log performance every 2 seconds
    if (Math.floor(now / 2000) !== Math.floor((now - frameTime) / 2000)) {
      console.log(`Performance Report:
      Current FPS: ${currentFPS.toFixed(1)}
      Average FPS: ${performanceMonitor.getAverageFPS().toFixed(1)}
      Min FPS: ${performanceMonitor.getMinFPS().toFixed(1)}
      Max FPS: ${performanceMonitor.getMaxFPS().toFixed(1)}
      Game Logic: ${gameLogicTime.toFixed(2)}ms
      Render Time: ${renderTime.toFixed(2)}ms`);
    }
  });

  // Function to update bridge visibility based on game state
  const updateBridgeVisibility = () => {
    // Update right bridge visibility
    const rightFrame = bridgeState.rightBridge.currentFrame;
    Object.entries(rightBridgeRefs.current).forEach(([frameName, bridgeObj]) => {
      if (bridgeObj) {
        const shouldBeVisible = frameName === rightFrame;
        if (bridgeObj.visible !== shouldBeVisible) {
          bridgeObj.visible = shouldBeVisible;
          if (shouldBeVisible) {
            console.log(`Right bridge: Showing ${frameName}`);
          }
        }
      }
    });

    // Update left bridge visibility
    const leftFrame = bridgeState.leftBridge.currentFrame;
    Object.entries(leftBridgeRefs.current).forEach(([frameName, bridgeObj]) => {
      if (bridgeObj) {
        const shouldBeVisible = frameName === leftFrame;
        if (bridgeObj.visible !== shouldBeVisible) {
          bridgeObj.visible = shouldBeVisible;
          if (shouldBeVisible) {
            console.log(`Left bridge: Showing ${frameName}`);
          }
        }
      }
    });
  };


  return (
    <group>
      {/* Battle Map 3D Model */}
      {battleMapScene && <primitive object={battleMapScene} />}

      {/* Units Layer with Instanced Rendering and LOD */}
      <UnitsLayer />

      {/* Interaction Layer - Re-enabled with context menu fix */}
      <MapInteraction />

      {/* Nebula Skybox - GLTF model */}
      <Skybox />
    </group>
  );
}

// Preload the model
useGLTF.preload('/models/Battle_Map_compressed.glb');


