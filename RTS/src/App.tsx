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
          antialias: true, // Re-enable anti-aliasing for better quality
          powerPreference: "high-performance",
          precision: "highp"
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


