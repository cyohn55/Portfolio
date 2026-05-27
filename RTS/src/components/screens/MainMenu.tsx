import { useEffect } from 'react';
import { useGameStore } from '../../game/state';
import './MainMenu.css';

export function MainMenu() {
  const transitionToScreen = useGameStore((s) => s.transitionToScreen);
  const musicEnabled = useGameStore((s) => s.musicEnabled);
  const setMusicEnabled = useGameStore((s) => s.setMusicEnabled);

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

  const handleLeaderboard = () => {
    transitionToScreen('leaderboard');
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
            onClick={handleLeaderboard}
          >
            LEADER BOARD
          </button>
        </div>

        <div className="version-info">
          <p>v1.0.0 - Alpha</p>
        </div>
      </div>

      {/* Bottom-left background-music toggle. Mirrors the in-game toggle in
          HUD.tsx so the title screen exposes the same mute affordance. The
          state is shared via the store (musicEnabled / setMusicEnabled, see
          MUSIC_STORAGE_KEY in state.ts), so toggling here persists across
          reloads and carries straight into the lobby and match. */}
      <button
        type="button"
        role="switch"
        aria-checked={musicEnabled}
        aria-label={musicEnabled ? 'Mute title screen music' : 'Unmute title screen music'}
        onClick={() => setMusicEnabled(!musicEnabled)}
        style={{
          position: 'fixed',
          bottom: '20px',
          left: '20px',
          width: '48px',
          height: '48px',
          borderRadius: '50%',
          background: musicEnabled
            ? 'linear-gradient(135deg, rgba(88,120,255,0.9) 0%, rgba(118,75,162,0.9) 100%)'
            : 'rgba(60,68,90,0.85)',
          border: '2px solid rgba(255,255,255,0.3)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'transform 0.3s ease, box-shadow 0.3s ease, background 0.3s ease',
          boxShadow: musicEnabled
            ? '0 4px 15px rgba(88,120,255,0.4)'
            : '0 4px 15px rgba(0,0,0,0.4)',
          backdropFilter: 'blur(10px)',
          fontSize: '22px',
          lineHeight: 1,
          padding: 0,
          zIndex: 10,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'scale(1.1)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'scale(1)';
        }}
      >
        <span role="img" aria-hidden="true">{musicEnabled ? '🔊' : '🔇'}</span>
      </button>

      {/* Animated background */}
      <div className="menu-background">
        <div className="background-gradient"></div>
      </div>
    </div>
  );
}
