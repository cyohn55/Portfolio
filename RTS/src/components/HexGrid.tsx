import { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { useGameStore, computeBridgeOccupancy } from '../game/state';
import { getActiveNetEngine } from './Working/net/netMatch';
import { runAiCommanders } from './Working/ai/aiCommander';
import { replayRecorderTick } from './Working/ai/replayRecorder';
import { registerArenaBoundary, confineBoundaryToPoints } from './Working/arenaBoundary';
import { computeArenaBoundary } from './Working/arenaBoundaryScene';
import { UnitsLayer } from './UnitsLayer';
import { MapInteraction } from './HexInteraction';
import { Skybox } from './Working/Skybox';
import { LavaEruption } from './Working/LavaEruption';
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

// Bridge capture flags. When a King/Queen holds a bridge trigger, that side's flag rises to
// the top of its pole (this many world units) and takes the holder's team color; when the
// trigger empties it eases back down to its neutral resting state.
const FLAG_RAISE_UNITS = 4.5;
// Exponential approach rate (per second) for both the rise/fall and the color fade. ~1.2 gives
// a deliberately slow ease that settles over a couple of seconds, in step with the bridge anim.
const FLAG_EASE_RATE = 1.2;

// Flag team colors, taken straight from the Battle_Map's materials as linear baseColorFactors
// (the space GLTFLoader assigns to material.color), so a recolored flag matches those materials
// exactly: neutral = Material.014, own/blue = Material.22015, enemy/red = Material.22027.
const FLAG_COLOR_NEUTRAL = new THREE.Color().setRGB(0.9093, 1.0, 0.9484, THREE.LinearSRGBColorSpace);
const FLAG_COLOR_FRIENDLY = new THREE.Color().setRGB(0.0694, 0.1358, 0.4076, THREE.LinearSRGBColorSpace);
const FLAG_COLOR_ENEMY = new THREE.Color().setRGB(0.5583, 0.011, 0.0144, THREE.LinearSRGBColorSpace);

// Distance the playable boundary is pulled in from the Arena slab's true edge, so a unit's
// body (collision radius 2.5) rests fully on the slab instead of hanging over the rim.
const ARENA_EDGE_INSET = 2.5;

// How far past the outermost base the playable boundary sits. The Arena slab is much larger than
// the field the bases bracket, so the boundary is tightened to the base positions plus these
// margins ("just past the bases"): along each rotated axis, and on the diagonal corner cut that
// trims the empty diamond tips units used to flank out onto.
const ARENA_BASE_AXIS_MARGIN = 25;
const ARENA_BASE_CORNER_MARGIN = 25;

// Straight left/right walls in world x. The slab is rotated 45°, so the octagon's sides come out
// as wide as its front/back (~±270); these cap the lateral extent independently. Left and right are
// set separately so the field can be trimmed asymmetrically. -117 .. +98 -> 215 units wide.
const ARENA_WALL_LEFT_X = -117;
const ARENA_WALL_RIGHT_X = 98;

// Resolve the named "Arena" node from the raw (pre-merge) gltf scene — the merge pass folds the
// slab into the static map, so its name survives only here — and register the movement boundary,
// tightened from the oversized slab down to just past the base line.
function registerArenaBoundaryFromScene(scene: THREE.Object3D): void {
  const arena = scene.getObjectByName('Arena');
  if (!arena) {
    console.warn('⚠️ Arena node not found in battle map; off-map boundary clamp is disabled');
    registerArenaBoundary(null);
    return;
  }

  const slab = computeArenaBoundary(arena, ARENA_EDGE_INSET);
  if (!slab) {
    console.warn('⚠️ Arena node has no mesh geometry; off-map boundary clamp is disabled');
    registerArenaBoundary(null);
    return;
  }

  // Tighten to the play area bracketed by the bases. Bases exist by the time the map mounts
  // (startMatch runs before the screen transition); if none are present yet, fall back to the
  // full slab so the boundary is never larger than intended.
  const basePositions = useGameStore
    .getState()
    .units.filter((unit) => unit.kind === 'Base')
    .map((unit) => unit.position);
  const confined =
    basePositions.length > 0
      ? confineBoundaryToPoints(slab, basePositions, ARENA_BASE_AXIS_MARGIN, ARENA_BASE_CORNER_MARGIN)
      : slab;
  const boundary = { ...confined, minX: ARENA_WALL_LEFT_X, maxX: ARENA_WALL_RIGHT_X };

  registerArenaBoundary(boundary);
  console.log(
    `🧱 Arena boundary registered: center (${boundary.centerX.toFixed(1)}, ${boundary.centerZ.toFixed(1)}), ` +
    `half-extents ${boundary.halfU.toFixed(1)} x ${boundary.halfV.toFixed(1)}, ` +
    `corner cut ${Number.isFinite(boundary.diagLimit) ? boundary.diagLimit.toFixed(1) : '∞'}, ` +
    `left/right walls x [${boundary.minX}, ${boundary.maxX}] (from ${basePositions.length} bases)`
  );
}

// Named empty locator nodes in the Battle_Map marking the volcano vents the
// victory lava eruption bursts from. They carry no mesh, so their names survive
// only in the raw (pre-merge) gltf scene.
const ERUPTION_VENT_NODE_NAMES = ['Center_Eruption', 'Left_Eruption', 'Right_Eruption'];

// Scenery hidden in multiplayer: the three volcanoes and their eruption locators.
// The victory lava finale is single-player only, so multiplayer drops both the
// volcano meshes (from the merged map) and the eruption effect.
const MULTIPLAYER_HIDDEN_NODE_NAMES = [
  'Center_Mountain',
  'Left_Mountain',
  'Right_Mountain',
  ...ERUPTION_VENT_NODE_NAMES,
];

// Resolve the eruption vent world positions from the raw (pre-merge) gltf scene.
// The merge pass drops these mesh-less locators, so this is the only place their
// transforms are available.
function resolveEruptionVents(scene: THREE.Object3D): THREE.Vector3[] {
  const vents: THREE.Vector3[] = [];
  for (const name of ERUPTION_VENT_NODE_NAMES) {
    const node = scene.getObjectByName(name);
    if (!node) continue;
    node.updateWorldMatrix(true, false);
    vents.push(new THREE.Vector3().setFromMatrixPosition(node.matrixWorld));
  }
  return vents;
}

export function BattleMap() {
  const tick = useGameStore((s) => s.tick);
  const bridgeState = useGameStore((s) => s.bridgeState);
  // The win that triggers the eruption.
  const gameOver = useGameStore((s) => s.gameOver);
  // Multiplayer hides the volcanoes and skips the victory lava finale.
  const isMultiplayer = useGameStore((s) => s.netMode !== 'single');
  const { scene } = useGLTF(`${import.meta.env.BASE_URL}models/Battle_Map_compressed.glb?v=7`);

  // Vent world positions for the victory eruption, resolved once per loaded map.
  // Multiplayer hides the volcanoes, so the eruption has no vents and never plays.
  const eruptionVents = useMemo(
    () => (scene && !isMultiplayer ? resolveEruptionVents(scene) : []),
    [scene, isMultiplayer],
  );

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

  // Bridge capture flags + their neutral resting Y (the height to ease back down to).
  const rightFlagRef = useRef<THREE.Object3D | null>(null);
  const leftFlagRef = useRef<THREE.Object3D | null>(null);
  const flagBaseY = useRef<{ right: number; left: number }>({ right: 0, left: 0 });

  // Process the battle map: merge its ~3250 solid-color meshes by material into a
  // handful of draw calls (see buildOptimizedBattleMap). Bridge frame meshes are
  // kept separate so their raise/lower visibility animation still works, and water
  // remains its own merged mesh so TerrainValidator can still detect it by color.
  const battleMapScene = useMemo(() => {
    if (!scene) {
      console.log('❌ Battle map scene not loaded yet');
      return null;
    }

    const optimized = buildOptimizedBattleMap(
      scene,
      isMultiplayer ? MULTIPLAYER_HIDDEN_NODE_NAMES : [],
    );

    // Wire the preserved bridge frame meshes to the refs the animation uses.
    rightBridgeRefs.current = optimized.rightBridge;
    leftBridgeRefs.current = optimized.leftBridge;

    // Wire the capture flags and record their resting heights for the raise/lower ease.
    rightFlagRef.current = optimized.rightFlag;
    leftFlagRef.current = optimized.leftFlag;
    flagBaseY.current = {
      right: optimized.rightFlag?.position.y ?? 0,
      left: optimized.leftFlag?.position.y ?? 0,
    };

    console.log(
      `🗺️ Battle map optimized: ${optimized.stats.sourceMeshes} source meshes -> ` +
      `${optimized.stats.mergedDrawCalls} merged draw calls ` +
      `(+${optimized.stats.preservedMeshes} preserved bridge meshes)`
    );

    return optimized.root;
  }, [scene, isMultiplayer]);

  // Initialize terrain validator when battle map scene is ready
  useEffect(() => {
    if (battleMapScene) {
      console.log('🗺️ Initializing terrain validator with battle map scene');
      terrainValidator.initialize(battleMapScene);

      // Confine movable units (Units, Queens, Kings) to the Arena slab so they cannot walk
      // off the outermost edge of the map. Derived from the raw scene's "Arena" node, whose
      // name survives only pre-merge.
      if (scene) registerArenaBoundaryFromScene(scene);

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
  }, [battleMapScene, scene]);

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
    //
    // In multiplayer the lockstep engine — not this free-running accumulator —
    // owns tick advancement: it only steps the simulation once both peers' inputs
    // for a tick have arrived, so we hand it the elapsed wall time and let it
    // decide how many ticks to run (it calls store.tick internally). The local
    // accumulator is drained so a later return to single-player starts clean.
    const netEngine = useGameStore.getState().netMode === 'single' ? null : getActiveNetEngine();
    if (netEngine) {
      netEngine.update(frameTime);
      accumulator.current = 0;
    } else {
      // Drive the opt-in replay recorder (begins/ends capture on match lifecycle).
      // No-op unless recording is armed; never mutates the sim.
      replayRecorderTick();
      while (accumulator.current >= FIXED_TIMESTEP) {
        // Drive the AI opponent's commander for the tick about to run, applying its
        // orders through the deterministic command bus BEFORE the tick — the same
        // ordering the self-play harness trained against. No-ops outside
        // single-player (lockstep has no AI).
        runAiCommanders();
        tick(FIXED_TIMESTEP / 1000, now);
        accumulator.current -= FIXED_TIMESTEP;
      }
    }


    // Update bridge visibility based on game state
    updateBridgeVisibility();

    // Ease the capture flags toward their team color + raised/lowered height.
    updateFlagVisuals(delta);

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

  // Ease each capture flag toward the team color of whoever holds its bridge trigger
  // (own = blue, enemy = red, nobody = neutral) and raise it up the pole while held.
  // Occupancy is recomputed locally from live unit positions, so it stays out of the
  // deterministic sim state (friend/foe is viewer-relative in multiplayer).
  const updateFlagVisuals = (delta: number) => {
    const right = rightFlagRef.current;
    const left = leftFlagRef.current;
    if (!right && !left) return;

    const { units, localPlayerId } = useGameStore.getState();
    const occupancy = computeBridgeOccupancy(units, localPlayerId);
    const ease = Math.min(1, delta * FLAG_EASE_RATE);

    const applyFlag = (
      flag: THREE.Object3D | null,
      baseY: number,
      hasFriendly: boolean,
      hasEnemy: boolean,
    ) => {
      if (!flag) return;
      const isHeld = hasFriendly || hasEnemy;
      // Friendly wins a contested trigger (both teams' K/Qs present) so the local
      // player always sees their own color when they're contributing.
      const targetColor = hasFriendly
        ? FLAG_COLOR_FRIENDLY
        : hasEnemy
        ? FLAG_COLOR_ENEMY
        : FLAG_COLOR_NEUTRAL;
      const targetY = baseY + (isHeld ? FLAG_RAISE_UNITS : 0);

      flag.position.y += (targetY - flag.position.y) * ease;
      flag.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          const colored = material as THREE.MeshStandardMaterial;
          if (colored.color) colored.color.lerp(targetColor, ease);
        }
      });
    };

    applyFlag(right, flagBaseY.current.right, occupancy.rightFriendly, occupancy.rightEnemy);
    applyFlag(left, flagBaseY.current.left, occupancy.leftFriendly, occupancy.leftEnemy);
  };

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

      {/* Victory lava eruption — bursts from the map's volcano vents on a win,
          before the post-game screen is revealed. */}
      {eruptionVents.length > 0 && <LavaEruption origins={eruptionVents} active={gameOver} />}
    </group>
  );
}

// Preload the model
useGLTF.preload(`${import.meta.env.BASE_URL}models/Battle_Map_compressed.glb?v=7`);


