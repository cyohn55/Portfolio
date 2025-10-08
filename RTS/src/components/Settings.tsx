import { useState, useEffect } from 'react';
import { useGameStore } from '../game/state';

interface SettingsProps {
  onBack: () => void;
}

export function Settings({ onBack }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<'video' | 'audio' | 'controls'>('video');

  const lightingSettings = useGameStore((s) => s.lightingSettings);
  const updateLightingSettings = useGameStore((s) => s.updateLightingSettings);

  // Local state for settings (synced with store)
  const [sunBrightness, setSunBrightness] = useState(lightingSettings.sunBrightness);
  const [moonBrightness, setMoonBrightness] = useState(lightingSettings.moonBrightness);
  const [ambientLight, setAmbientLight] = useState(lightingSettings.ambientLight);
  const [dayNightSpeed, setDayNightSpeed] = useState(lightingSettings.dayNightSpeed);

  // Sync with store when settings change externally
  useEffect(() => {
    setSunBrightness(lightingSettings.sunBrightness);
    setMoonBrightness(lightingSettings.moonBrightness);
    setAmbientLight(lightingSettings.ambientLight);
    setDayNightSpeed(lightingSettings.dayNightSpeed);
  }, [lightingSettings]);

  const handleSave = () => {
    // Save to game store
    updateLightingSettings({
      sunBrightness,
      moonBrightness,
      ambientLight,
      dayNightSpeed
    });

    // Also persist to localStorage
    localStorage.setItem('lightingSettings', JSON.stringify({
      sunBrightness,
      moonBrightness,
      ambientLight,
      dayNightSpeed
    }));

    onBack();
  };

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
        minWidth: '600px',
        maxWidth: '800px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)'
      }}>
        <h2 style={{
          color: '#fff',
          fontSize: '32px',
          fontWeight: '700',
          marginBottom: '24px',
          textAlign: 'center'
        }}>
          Settings
        </h2>

        {/* Tabs */}
        <div style={{
          display: 'flex',
          gap: '8px',
          marginBottom: '32px',
          borderBottom: '2px solid rgba(88,120,255,0.3)',
          paddingBottom: '8px'
        }}>
          {(['video', 'audio', 'controls'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '12px 24px',
                fontSize: '16px',
                fontWeight: '600',
                color: activeTab === tab ? '#fff' : '#94a3b8',
                background: activeTab === tab ? 'rgba(88,120,255,0.3)' : 'transparent',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
                textTransform: 'capitalize'
              }}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Video Tab */}
        {activeTab === 'video' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div>
              <label style={{ color: '#94a3b8', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
                Sun Brightness (Current: {sunBrightness.toFixed(1)})
              </label>
              <input
                type="range"
                min="1"
                max="10"
                step="0.5"
                value={sunBrightness}
                onChange={(e) => setSunBrightness(parseFloat(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                Range: 1.0 (dim) to 10.0 (very bright)
              </div>
            </div>

            <div>
              <label style={{ color: '#94a3b8', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
                Moon Brightness (Current: {moonBrightness.toFixed(1)})
              </label>
              <input
                type="range"
                min="1"
                max="15"
                step="0.5"
                value={moonBrightness}
                onChange={(e) => setMoonBrightness(parseFloat(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                Range: 1.0 (dim) to 15.0 (very bright)
              </div>
            </div>

            <div>
              <label style={{ color: '#94a3b8', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
                Ambient Light (Current: {ambientLight.toFixed(1)})
              </label>
              <input
                type="range"
                min="0.5"
                max="5"
                step="0.1"
                value={ambientLight}
                onChange={(e) => setAmbientLight(parseFloat(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                Base ambient lighting - prevents complete darkness
              </div>
            </div>

            <div>
              <label style={{ color: '#94a3b8', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
                Day/Night Cycle Speed (Current: {dayNightSpeed}s)
              </label>
              <input
                type="range"
                min="30"
                max="300"
                step="10"
                value={dayNightSpeed}
                onChange={(e) => setDayNightSpeed(parseInt(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                Time for full day/night cycle (30s = fast, 300s = slow)
              </div>
            </div>
          </div>
        )}

        {/* Audio Tab */}
        {activeTab === 'audio' && (
          <div style={{ color: '#94a3b8', textAlign: 'center', padding: '40px' }}>
            Audio settings coming soon...
          </div>
        )}

        {/* Controls Tab */}
        {activeTab === 'controls' && (
          <div style={{ color: '#94a3b8', textAlign: 'center', padding: '40px' }}>
            Controller settings coming soon...
          </div>
        )}

        {/* Action Buttons */}
        <div style={{
          display: 'flex',
          gap: '16px',
          marginTop: '32px',
          paddingTop: '24px',
          borderTop: '2px solid rgba(88,120,255,0.3)'
        }}>
          <button
            onClick={onBack}
            style={{
              flex: 1,
              padding: '14px 28px',
              fontSize: '16px',
              fontWeight: '600',
              color: '#94a3b8',
              background: 'rgba(148,163,184,0.1)',
              border: '1px solid rgba(148,163,184,0.3)',
              borderRadius: '8px',
              cursor: 'pointer',
              transition: 'all 0.3s ease'
            }}
          >
            Back
          </button>
          <button
            onClick={handleSave}
            style={{
              flex: 1,
              padding: '14px 28px',
              fontSize: '16px',
              fontWeight: '600',
              color: '#fff',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              transition: 'all 0.3s ease',
              boxShadow: '0 4px 15px rgba(102,126,234,0.4)'
            }}
          >
            Save & Close
          </button>
        </div>
      </div>
    </div>
  );
}
