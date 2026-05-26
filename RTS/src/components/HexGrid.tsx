import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { useGameStore } from '../game/state';
import { UnitsLayer } from './UnitsLayer';
import { MapInteraction } from './HexInteraction';
import { Skybox } from './Working/Skybox';
import { buildOptimizedBattleMap } from './Working/mergeBattleMap';
import { bridgeNavigator } from './Working/bridgeNavigator';
import { pathfinder } from './Working/pathfinder';
import { performanceMonitor } from '../utils/PerformanceMonitor';
import { terrainValidator } from '../utils/TerrainValidator';
import * as THREE from 'three';

// Land margin (world units) added around the bridge footprint when sizing the
// navigation grid, so the grid covers the moat plus the shoreline units approach from.
const NAV_GRID_MARGIN = 60;
const NAV_GRID_STEP = 2; // grid cell size; ~half a unit body, fine enough to find bridge mouths

// A* pathfinding grid spans the whole playable map (units and targets sit anywhere on it,
// not just near the moat). Margin pads past the outermost spawn so edge positions stay
// in-grid. The Battle_Map GLB carries far-flung decorative geometry, so the raw scene
// bounding box is many times the playable area; clamp to the region units actually
// occupy (spawns sit at |x| < 80, |z| ~ 252) to keep the grid compact and A* cheap.
const PATH_GRID_MARGIN = 20;
// Cell size must be fine enough to resolve thin shoreline water (e.g. the slivers beside a
// bridge mouth); a coarser grid routes units straight through water the fine collision then
// blocks, deadlocking them. 2 matches the bridge grid's proven moat resolution.
const PATH_GRID_STEP = 2;
const PATH_PLAY_HALF_X = 180;
const PATH_PLAY_HALF_Z = 290;

export function BattleMap() {
  const tick = useGameStore((s) => s.tick);
  const bridgeState = useGameStore((s) => s.bridgeState);
  const { scene } = useGLTF(`${import.meta.env.BASE_URL}models/Battle_Map_compressed.glb?v=5`);

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

      // Build the region+portal navigation grid so ground units funnel onto bridges
      // instead of stalling at the shore. Sized to the bridge footprint plus a land
      // margin (the moat and the approaches around it).
      const bridgeBounds = terrainValidator.getBridgeBounds();
      if (bridgeBounds) {
        bridgeNavigator.build(
          terrainValidator,
          {
            minX: bridgeBounds.minX - NAV_GRID_MARGIN,
            minZ: bridgeBounds.minZ - NAV_GRID_MARGIN,
            maxX: bridgeBounds.maxX + NAV_GRID_MARGIN,
            maxZ: bridgeBounds.maxZ + NAV_GRID_MARGIN,
          },
          NAV_GRID_STEP,
        );
      }

      // Build the full-map A* pathfinding grid so ground units route around the moat to
      // any destination, not just funnel onto the nearest bridge. Sized to the whole map
      // (the merged scene's xz bounding box) plus a margin, since units and their targets
      // can be anywhere — well beyond the moat the bridge grid covers.
      const mapBox = new THREE.Box3().setFromObject(battleMapScene);
      pathfinder.build(
        terrainValidator,
        {
          minX: Math.max(mapBox.min.x - PATH_GRID_MARGIN, -PATH_PLAY_HALF_X),
          minZ: Math.max(mapBox.min.z - PATH_GRID_MARGIN, -PATH_PLAY_HALF_Z),
          maxX: Math.min(mapBox.max.x + PATH_GRID_MARGIN, PATH_PLAY_HALF_X),
          maxZ: Math.min(mapBox.max.z + PATH_GRID_MARGIN, PATH_PLAY_HALF_Z),
        },
        PATH_GRID_STEP,
      );

      // Dev-only handle for verifying water/bridge terrain queries after merge.
      if (import.meta.env.DEV) {
        (window as any).__rtsTerrain = terrainValidator;
        (window as any).__rtsMap = battleMapScene;
        (window as any).__rtsNav = bridgeNavigator;
        (window as any).__rtsPath = pathfinder;
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

    // Re-open/-close navigation portals to match (cheap; only recomputes when a
    // raise/lower bridge actually changes crossability).
    if (bridgeNavigator.isReady()) {
      bridgeNavigator.refreshPortals();
    }
    // Invalidate cached A* paths that assumed the old bridge openness.
    if (pathfinder.isReady()) {
      pathfinder.refresh();
    }
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
useGLTF.preload(`${import.meta.env.BASE_URL}models/Battle_Map_compressed.glb?v=5`);


