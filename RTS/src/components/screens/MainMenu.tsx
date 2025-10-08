import { useGameStore } from '../../game/state';
import './MainMenu.css';

export function MainMenu() {
  const transitionToScreen = useGameStore((s) => s.transitionToScreen);

  return (
    <div className="main-menu">
      <div className="main-menu-content">
        <h1 className="game-title">Tails We Herd</h1>
        <p className="game-subtitle">In A Dog Eat Dog World... Bring Bears</p>

        <div className="menu-buttons">
          <button
            className="menu-button primary"
            onClick={() => transitionToScreen('lobby')}
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
