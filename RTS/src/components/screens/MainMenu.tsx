import { useEffect } from 'react';
import { useGameStore } from '../../game/state';
import './MainMenu.css';

export function MainMenu() {
  const transitionToScreen = useGameStore((s) => s.transitionToScreen);

  useEffect(() => {
    console.log('🎮 MainMenu component mounted and rendering');
    console.log('📱 Window dimensions:', window.innerWidth, 'x', window.innerHeight);
    console.log('📄 Document body:', document.body);
    return () => {
      console.log('🎮 MainMenu component unmounting');
    };
  }, []);

  const handleQuickPlay = () => {
    console.log('Quick Play clicked - transitioning to lobby');

    // Try to request fullscreen for the entire document
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(err => {
        console.log('Fullscreen request failed (user may need to interact first):', err);
      });
    }

    // Transition to lobby
    transitionToScreen('lobby');
  };

  return (
    <div className="main-menu">
      <div className="main-menu-content">
        <h1 className="game-title">Tails We Herd</h1>
        <p className="game-subtitle">In A Dog Eat Dog World... Bring Bears</p>

        <div className="menu-buttons">
          <button
            className="menu-button primary"
            onClick={handleQuickPlay}
          >
            QUICK PLAY
          </button>

          <button
            className="menu-button"
            onClick={() => alert('Settings coming soon!')}
          >
            SETTINGS
          </button>

          <button
            className="menu-button"
            onClick={() => alert('Help & Tutorial coming soon!')}
          >
            HELP
          </button>
        </div>

        <div className="version-info">
          <p>v1.0.0 - Alpha</p>
        </div>
      </div>

      {/* Animated background */}
      <div className="menu-background">
        <div className="background-gradient"></div>
      </div>
    </div>
  );
}
