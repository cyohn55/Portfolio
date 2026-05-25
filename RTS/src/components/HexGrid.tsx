import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { useGameStore } from '../game/state';
import { UnitsLayer } from './UnitsLayer';
import { MapInteraction } from './HexInteraction';
import { Skybox } from './Working/Skybox';
import { buildOptimizedBattleMap } from './Working/mergeBattleMap';
import { performanceMonitor } from '../utils/PerformanceMonitor';
import { terrainValidator } from '../utils/TerrainValidator';
import * as THREE from 'three';

export function BattleMap() {
  const tick = useGameStore((s) => s.tick);
  const bridgeState = useGameStore((s) => s.bridgeState);
  const { scene } = useGLTF(`${import.meta.env.BASE_URL}models/Battle_Map_compressed.glb?v=4`);

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

  // Process the battle map: merge its ~3250 solid-color meshes by material into a
  // handful of draw calls (see buildOptimizedBattleMap). Bridge frame meshes are
  // kept separate so their raise/lower visibility animation still works, and water
  // remains its own merged mesh so TerrainValidator can still detect it by color.
  const battleMapScene = useMemo(() => {
    if (!scene) {
      console.log('❌ Battle map scene not loaded yet');
      return null;
    }

    const optimized = buildOptimizedBattleMap(scene);

    // Wire the preserved bridge frame meshes to the refs the animation uses.
    rightBridgeRefs.current = optimized.rightBridge;
    leftBridgeRefs.current = optimized.leftBridge;

    console.log(
      `🗺️ Battle map optimized: ${optimized.stats.sourceMeshes} source meshes -> ` +
      `${optimized.stats.mergedDrawCalls} merged draw calls ` +
      `(+${optimized.stats.preservedMeshes} preserved bridge meshes)`
    );

    return optimized.root;
  }, [scene]);

  // Initialize terrain validator when battle map scene is ready
  useEffect(() => {
    if (battleMapScene) {
      console.log('🗺️ Initializing terrain validator with battle map scene');
      terrainValidator.initialize(battleMapScene);
      // Dev-only handle for verifying water/bridge terrain queries after merge.
      if (import.meta.env.DEV) {
        (window as any).__rtsTerrain = terrainValidator;
        (window as any).__rtsMap = battleMapScene;
      }
    }
  }, [battleMapScene]);

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

    // SYNCHRONIZED: Game logic at 60 FPS matching rendering frequency.
    // Units render directly from store positions (logic already runs at 60 FPS),
    // so no separate interpolation buffer is needed.
    while (accumulator.current >= FIXED_TIMESTEP) {
      tick(FIXED_TIMESTEP / 1000, now);
      accumulator.current -= FIXED_TIMESTEP;
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

    // Update terrain validator with current bridge state
    terrainValidator.updateBridgeState({
      right: rightFrame as 'Fully_Up' | 'Almost_Up' | 'Almost_Down' | 'Fully_Down',
      left: leftFrame as 'Fully_Up' | 'Almost_Up' | 'Almost_Down' | 'Fully_Down',
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
useGLTF.preload(`${import.meta.env.BASE_URL}models/Battle_Map_compressed.glb?v=4`);


