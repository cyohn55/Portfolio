import { Canvas } from '@react-three/fiber';
import { Suspense, useEffect } from 'react';
import './App.css';
import { BattleMap } from './components/HexGrid';
import { CameraController } from './components/CameraController';
import { HUD } from './components/HUD';
import { KeyboardShortcuts } from './components/KeyboardShortcuts';
import { ModelPreloader } from './utils/ModelPreloader';
import { PerformanceOptimizer } from './components/PerformanceOptimizer';
import { DayNightCycle } from './components/DayNightCycle';
import { useGameStore } from './game/state';
import { MainMenu } from './components/screens/MainMenu';
import { AnimalSelectionLobby } from './components/screens/AnimalSelectionLobby';
import { PostGameScreen } from './components/screens/PostGameScreen';
import { BackgroundMusic } from './components/BackgroundMusic';

export default function App() {
  const initialize = useGameStore((s) => s.initializeGame);
  const currentScreen = useGameStore((s) => s.currentScreen);

  useEffect(() => {
    initialize();
  }, [initialize]);

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

  // Playing screen (original game view)
  return (
    <>
      <BackgroundMusic />
      <PostGameScreen />
      <KeyboardShortcuts />
      <div className="hud">
        <HUD />
      </div>
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
        onCreated={({ gl }) => {
          console.log('🎮 RTS Game: WebGL context created successfully');
          console.log('WebGL Version:', gl.getParameter(gl.VERSION));
          console.log('WebGL Vendor:', gl.getParameter(gl.VENDOR));
          console.log('Max Textures:', gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS));

          // Handle context loss with recovery
          gl.domElement.addEventListener('webglcontextlost', (e) => {
            console.error('❌ WebGL context lost!', e);
            e.preventDefault(); // Prevent default to allow recovery

            // Show error message to user
            const errorMsg = document.createElement('div');
            errorMsg.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(255,0,0,0.9); color: white; padding: 20px; border-radius: 10px; z-index: 10000; font-size: 16px; text-align: center;';
            errorMsg.innerHTML = '⚠️ WebGL Context Lost<br><small>Reloading game...</small>';
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
          const extensions = gl.getSupportedExtensions();
          console.log('Available WebGL Extensions:', extensions?.length || 0);
        }}
      >
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
      </Canvas>
    </>
  );
}


