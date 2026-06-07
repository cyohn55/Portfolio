import { Canvas } from '@react-three/fiber';
import { Suspense, useEffect, useState } from 'react';
import * as THREE from 'three';
import './App.css';
import { BattleMap } from './components/HexGrid';
import { CameraController } from './components/CameraController';
import { GamepadController } from './components/Working/GamepadController';
import { UnitPlacementIndicator } from './components/Working/UnitPlacementIndicator';
import { EdgePanChevrons } from './components/Working/EdgePanChevrons';
import { BehaviorRadial } from './components/Working/BehaviorRadial';
import { HUD } from './components/HUD';
import { KeyboardShortcuts } from './components/KeyboardShortcuts';
import { ModelPreloader } from './utils/ModelPreloader';
import { PerformanceOptimizer } from './components/PerformanceOptimizer';
import { DayNightCycle } from './components/DayNightCycle';
import { SceneLighting } from './components/SceneLighting';
import { useGameStore } from './game/state';
import { MainMenu } from './components/screens/MainMenu';
import { AnimalSelectionLobby } from './components/screens/AnimalSelectionLobby';
import { MultiplayerScreen } from './components/Working/MultiplayerScreen';
import { useMultiplayerSession, setPendingJoinCode } from './components/Working/net/multiplayerSession';
import { readRoomCodeFromUrl } from './components/Working/roomInvite';
import { PostGameScreen } from './components/screens/PostGameScreen';
import { LeaderboardScreen } from './components/Working/LeaderboardScreen';
import { useParentScrollBridge } from './components/Working/parentScrollBridge';
import { BackgroundMusic } from './components/BackgroundMusic';
import { InstructionsPopup } from './components/screens/InstructionsPopup';

export default function App() {
  const initialize = useGameStore((s) => s.initializeGame);
  const currentScreen = useGameStore((s) => s.currentScreen);
  const transitionToScreen = useGameStore((s) => s.transitionToScreen);
  const unpauseGame = useGameStore((s) => s.unpauseGame);
  const [showInstructions, setShowInstructions] = useState(true);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    initialize();

    // A join link (…?room=CODE) drops the recipient straight into multiplayer
    // with the code pre-filled — no typing. Capture it for the multiplayer
    // screen, strip the param so a refresh or Back doesn't re-trigger a join,
    // then route there. The param is read once at boot.
    const joinCode = readRoomCodeFromUrl(window.location.search);
    if (joinCode) {
      setPendingJoinCode(joinCode);
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      transitionToScreen('multiplayer');
    }
    // initialize/transitionToScreen are stable store actions; run this once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialize]);

  // When embedded in the portfolio page, broadcast screen transitions to the
  // host so it can scroll the iframe into view and lock the page's wheel
  // scroll while the player is in-game. See parentScrollBridge.ts and the
  // `rts:screen` listener in Portfolio/script.js for the contract.
  useParentScrollBridge();

  // Detect mobile device
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 768 || 'ontouchstart' in window);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Prevent scrolling on mobile when playing
  useEffect(() => {
    if (currentScreen === 'playing' && !showInstructions && isMobile) {
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed';
      document.body.style.width = '100%';
      document.body.style.height = '100%';
      document.documentElement.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.width = '';
      document.body.style.height = '';
      document.documentElement.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.width = '';
      document.body.style.height = '';
      document.documentElement.style.overflow = '';
    };
  }, [currentScreen, showInstructions, isMobile]);

  // Reset instructions popup when going back to lobby
  useEffect(() => {
    if (currentScreen === 'lobby') {
      setShowInstructions(true);
    }
  }, [currentScreen]);

  // Tear down any multiplayer session when returning to the main menu (e.g. from
  // Post-Game "Back to Menu" or after a desync/disconnect). leave() stops the
  // lockstep engine, closes the peer connection, and restores single-player mode
  // so a subsequent solo match runs cleanly. No-op when no session is active.
  useEffect(() => {
    if (currentScreen === 'menu') {
      useMultiplayerSession.getState().leave();
    }
  }, [currentScreen]);

  const handleCloseInstructions = () => {
    setShowInstructions(false);
    unpauseGame();
  };

  const handleExitGame = () => {
    transitionToScreen('lobby');
  };

  // Render different screens based on state
  if (currentScreen === 'menu') {
    return (
      <>
        <BackgroundMusic />
        <MainMenu />
      </>
    );
  }

  if (currentScreen === 'lobby') {
    return (
      <>
        <BackgroundMusic />
        <AnimalSelectionLobby />
      </>
    );
  }

  if (currentScreen === 'multiplayer') {
    return (
      <>
        <BackgroundMusic />
        <MultiplayerScreen />
      </>
    );
  }

  if (currentScreen === 'leaderboard') {
    return (
      <>
        <BackgroundMusic />
        <LeaderboardScreen />
      </>
    );
  }

  // Playing screen (original game view)
  return (
    <>
      <BackgroundMusic />
      {showInstructions && <InstructionsPopup onClose={handleCloseInstructions} />}
      {isMobile && !showInstructions && (
        <button className="mobile-exit-button" onClick={handleExitGame}>
          Exit
        </button>
      )}
      <PostGameScreen />
      <KeyboardShortcuts />
      <div className="hud">
        <HUD />
      </div>
      {/* Selection radial for the combat-posture system (stance / fire / priority). */}
      <BehaviorRadial />
      {/* Yellow edge-scroll chevrons, lit only while the cursor is in a pan-trigger band. */}
      <EdgePanChevrons />
      <Canvas
        camera={{ fov: 45, far: 200000 }}
        shadows
        onContextMenu={(e) => e.preventDefault()}
        gl={{
          antialias: window.innerWidth > 768, // Only enable anti-aliasing on desktop for performance
          powerPreference: "high-performance",
          precision: "highp",
          preserveDrawingBuffer: false,  // Disable to save memory (was causing issues)
          failIfMajorPerformanceCaveat: false,  // Allow fallback
          alpha: false,  // Disable alpha channel to save memory
          stencil: false,  // Disable stencil buffer if not needed
          depth: true  // Keep depth buffer for 3D rendering
        }}
        onCreated={({ gl, scene, camera }) => {
          // Dev-only handles for performance testing (renderer stats + camera).
          if (import.meta.env.DEV) {
            (window as any).__rtsGL = gl;
            (window as any).__rtsCamera = camera;
          }
          console.log('🎮 RTS Game: WebGL context created successfully');

          // Access the WebGL context correctly from the renderer
          const glContext = gl.getContext();
          console.log('WebGL Version:', glContext.getParameter(glContext.VERSION));
          console.log('WebGL Vendor:', glContext.getParameter(glContext.VENDOR));
          console.log('Max Textures:', glContext.getParameter(glContext.MAX_TEXTURE_IMAGE_UNITS));
          console.log('Renderer info:', glContext.getParameter(glContext.RENDERER));

          // Set initial background color in case models take time to load
          scene.background = new THREE.Color(0x1a1f35);
          console.log('✅ Initial background set');

          // Handle context loss with recovery.
          // NOTE: When the user navigates back to the menu/lobby, React unmounts the
          // <Canvas> and R3F intentionally drops the WebGL context as part of disposal —
          // that fires `webglcontextlost` even though nothing is wrong. We treat it as
          // a real failure only when we're still on the playing screen.
          gl.domElement.addEventListener('webglcontextlost', (e) => {
            const screen = useGameStore.getState().currentScreen;
            if (screen !== 'playing') {
              console.log('🧹 WebGL context released during screen transition (expected)');
              return;
            }

            console.error('❌❌❌ CRITICAL: WebGL context lost!', e);
            console.error('This usually happens when too many WebGL contexts are created');
            e.preventDefault(); // Prevent default to allow recovery

            // Show error message to user
            const errorMsg = document.createElement('div');
            errorMsg.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(255,0,0,0.9); color: white; padding: 20px; border-radius: 10px; z-index: 10000; font-size: 16px; text-align: center;';
            errorMsg.innerHTML = '⚠️ WebGL Context Lost<br><small>Too many 3D models active. Reloading...</small>';
            document.body.appendChild(errorMsg);

            // Attempt to recover by reloading after 2 seconds
            setTimeout(() => {
              window.location.reload();
            }, 2000);
          });

          gl.domElement.addEventListener('webglcontextrestored', () => {
            console.log('✅ WebGL context restored successfully');
          });

          // Log available extensions for debugging
          const extensions = glContext.getSupportedExtensions();
          console.log('Available WebGL Extensions:', extensions?.length || 0);
        }}
      >
        {/* Soft IBL fill + AgX tone mapping + exposure (player-tunable). Wraps the models in
            stylized studio light so they stay vivid and readable at every point in the cycle. */}
        <Suspense fallback={null}>
          <SceneLighting />
        </Suspense>
        {/* Day/Night Cycle with Sun and Moon - handles background color dynamically */}
        <DayNightCycle cycleDurationSeconds={120} />
        <ModelPreloader />
        {/* Performance monitoring */}
        <PerformanceOptimizer />
        <Suspense fallback={null}>
          <BattleMap />
        </Suspense>
        <CameraController
          moveSpeed={1.5}
          zoomSpeed={5}
          minDistance={75}
          maxDistance={200}
        />
        <GamepadController />
        {/* Blue teardrop above a piloted monarch while holding the rally key to place units. */}
        <UnitPlacementIndicator />
      </Canvas>
    </>
  );
}


