import { useState, useEffect } from 'react';
import { useGameStore } from '../game/state';
import { Settings } from './Settings';

interface PauseMenuProps {
  onClose: () => void;
}

export function PauseMenu({ onClose }: PauseMenuProps) {
  const [showSettings, setShowSettings] = useState(false);
  const transitionToScreen = useGameStore((s) => s.transitionToScreen);

  // Set pause state when menu opens
  useEffect(() => {
    useGameStore.setState({ isPaused: true });
    return () => {
      useGameStore.setState({ isPaused: false });
    };
  }, []);

  const handleResume = () => {
    onClose();
  };

  const handleRestart = () => {
    transitionToScreen('menu');
    onClose();
  };

  const handleSettings = () => {
    setShowSettings(true);
  };

  if (showSettings) {
    return <Settings onBack={() => setShowSettings(false)} />;
  }

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999,
      backdropFilter: 'blur(5px)'
    }}>
      <div style={{
        background: 'linear-gradient(180deg, rgba(17,23,38,0.95) 0%, rgba(12,17,29,0.95) 100%)',
        border: '2px solid rgba(88,120,255,0.5)',
        borderRadius: '16px',
        padding: '40px',
        minWidth: '400px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)'
      }}>
        <h2 style={{
          color: '#fff',
          fontSize: '32px',
          fontWeight: '700',
          marginBottom: '32px',
          textAlign: 'center',
          textShadow: '0 2px 10px rgba(88,120,255,0.3)'
        }}>
          Game Paused
        </h2>

        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '16px'
        }}>
          <button
            onClick={handleResume}
            style={{
              padding: '16px 32px',
              fontSize: '18px',
              fontWeight: '600',
              color: '#fff',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              transition: 'all 0.3s ease',
              boxShadow: '0 4px 15px rgba(102,126,234,0.4)'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = '0 6px 20px rgba(102,126,234,0.6)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 4px 15px rgba(102,126,234,0.4)';
            }}
          >
            Resume
          </button>

          <button
            onClick={handleSettings}
            style={{
              padding: '16px 32px',
              fontSize: '18px',
              fontWeight: '600',
              color: '#fff',
              background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              transition: 'all 0.3s ease',
              boxShadow: '0 4px 15px rgba(240,147,251,0.4)'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = '0 6px 20px rgba(240,147,251,0.6)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 4px 15px rgba(240,147,251,0.4)';
            }}
          >
            Settings
          </button>

          <button
            onClick={handleRestart}
            style={{
              padding: '16px 32px',
              fontSize: '18px',
              fontWeight: '600',
              color: '#fff',
              background: 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              transition: 'all 0.3s ease',
              boxShadow: '0 4px 15px rgba(250,112,154,0.4)'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)';
              e.currentTarget.style.boxShadow = '0 6px 20px rgba(250,112,154,0.6)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 4px 15px rgba(250,112,154,0.4)';
            }}
          >
            Main Menu
          </button>
        </div>
      </div>
    </div>
  );
}
