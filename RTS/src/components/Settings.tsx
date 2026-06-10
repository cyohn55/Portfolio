import { useState, useEffect, useRef } from 'react';
import { useGameStore } from '../game/state';
import { ControlBindingsPanel } from './Working/ControlBindingsPanel';

interface SettingsProps {
  onBack: () => void;
}

export function Settings({ onBack }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<'video' | 'audio' | 'controls'>('video');

  const lightingSettings = useGameStore((s) => s.lightingSettings);
  const updateLightingSettings = useGameStore((s) => s.updateLightingSettings);
  const shadowsEnabled = useGameStore((s) => s.shadowsEnabled);
  const setShadowsEnabled = useGameStore((s) => s.setShadowsEnabled);
  const healthBarsEnabled = useGameStore((s) => s.healthBarsEnabled);
  const setHealthBarsEnabled = useGameStore((s) => s.setHealthBarsEnabled);

  // Local state for settings (synced with store)
  const [sunBrightness, setSunBrightness] = useState(lightingSettings.sunBrightness);
  const [moonBrightness, setMoonBrightness] = useState(lightingSettings.moonBrightness);
  const [ambientLight, setAmbientLight] = useState(lightingSettings.ambientLight);
  const [dayNightSpeed, setDayNightSpeed] = useState(lightingSettings.dayNightSpeed);
  const [exposure, setExposure] = useState(lightingSettings.exposure);
  const [environmentIntensity, setEnvironmentIntensity] = useState(lightingSettings.environmentIntensity);
  const [saturation, setSaturation] = useState(lightingSettings.saturation);
  const [contrast, setContrast] = useState(lightingSettings.contrast);
  const [brightness, setBrightness] = useState(lightingSettings.brightness);
  const [hue, setHue] = useState(lightingSettings.hue);

  // Sync with store when settings change externally
  useEffect(() => {
    setSunBrightness(lightingSettings.sunBrightness);
    setMoonBrightness(lightingSettings.moonBrightness);
    setAmbientLight(lightingSettings.ambientLight);
    setDayNightSpeed(lightingSettings.dayNightSpeed);
    setExposure(lightingSettings.exposure);
    setEnvironmentIntensity(lightingSettings.environmentIntensity);
    setSaturation(lightingSettings.saturation);
    setContrast(lightingSettings.contrast);
    setBrightness(lightingSettings.brightness);
    setHue(lightingSettings.hue);
  }, [lightingSettings]);

  // The visual-look knobs (exposure, IBL, and the color grade) update the live scene as the
  // slider moves so the player can dial against the 3D behind this panel; they are committed to
  // localStorage on Save like the rest. Each preview helper updates its local state AND the
  // store in one place so the two never drift.
  const preview = (key: keyof typeof lightingSettings, setLocal: (v: number) => void) =>
    (value: number) => {
      setLocal(value);
      updateLightingSettings({ [key]: value } as Partial<typeof lightingSettings>);
    };
  const previewExposure = preview('exposure', setExposure);
  const previewEnvironmentIntensity = preview('environmentIntensity', setEnvironmentIntensity);
  const previewSaturation = preview('saturation', setSaturation);
  const previewContrast = preview('contrast', setContrast);
  const previewBrightness = preview('brightness', setBrightness);
  const previewHue = preview('hue', setHue);

  // The live-preview values that were active when the panel opened, so "Back" (cancel) can
  // discard any dialing and restore the scene to where it was. Captured once on mount.
  const openingPreviewRef = useRef({
    exposure: lightingSettings.exposure,
    environmentIntensity: lightingSettings.environmentIntensity,
    saturation: lightingSettings.saturation,
    contrast: lightingSettings.contrast,
    brightness: lightingSettings.brightness,
    hue: lightingSettings.hue,
  });
  const handleBack = () => {
    updateLightingSettings({ ...openingPreviewRef.current });
    onBack();
  };

  const handleSave = () => {
    const next = {
      sunBrightness,
      moonBrightness,
      ambientLight,
      dayNightSpeed,
      exposure,
      environmentIntensity,
      saturation,
      contrast,
      brightness,
      hue,
    };
    // Save to game store
    updateLightingSettings(next);
    // Also persist to localStorage
    localStorage.setItem('lightingSettings', JSON.stringify(next));

    onBack();
  };

  return (
    <div data-gamepad-modal style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      // Light, un-blurred scrim so the 3D scene stays visible behind the panel — the lighting/
      // color sliders preview live, which is only useful if you can actually see the battlefield.
      // The panel is pushed to the right so the centre/left of the map shows while you dial.
      backgroundColor: 'rgba(0, 0, 0, 0.2)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-end',
      paddingRight: '40px',
      zIndex: 9999
    }}>
      <div style={{
        background: 'linear-gradient(180deg, rgba(17,23,38,0.95) 0%, rgba(12,17,29,0.95) 100%)',
        border: '2px solid rgba(88,120,255,0.5)',
        borderRadius: '16px',
        padding: '40px',
        minWidth: '600px',
        maxWidth: '800px',
        maxHeight: '90vh',
        overflowY: 'auto',
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
            {/* Shadow quality toggle */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '16px',
              padding: '16px 20px',
              background: 'rgba(88,120,255,0.08)',
              border: '1px solid rgba(88,120,255,0.25)',
              borderRadius: '8px'
            }}>
              <div>
                <div style={{ color: '#fff', fontSize: '16px', fontWeight: 600 }}>
                  Shadows
                </div>
                <div style={{ color: '#64748b', fontSize: '12px', marginTop: '2px' }}>
                  May lower FPS on low-end devices
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={shadowsEnabled}
                aria-label="Toggle shadows"
                onClick={() => setShadowsEnabled(!shadowsEnabled)}
                style={{
                  position: 'relative',
                  flexShrink: 0,
                  width: '52px',
                  height: '28px',
                  borderRadius: '14px',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  background: shadowsEnabled
                    ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
                    : 'rgba(148,163,184,0.3)',
                  transition: 'background 0.3s ease'
                }}
              >
                <span style={{
                  position: 'absolute',
                  top: '3px',
                  left: shadowsEnabled ? '27px' : '3px',
                  width: '22px',
                  height: '22px',
                  borderRadius: '50%',
                  background: '#fff',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                  transition: 'left 0.3s ease'
                }} />
              </button>
            </div>

            {/* Health bars toggle */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '16px',
              padding: '16px 20px',
              background: 'rgba(88,120,255,0.08)',
              border: '1px solid rgba(88,120,255,0.25)',
              borderRadius: '8px'
            }}>
              <div>
                <div style={{ color: '#fff', fontSize: '16px', fontWeight: 600 }}>
                  Health Bars
                </div>
                <div style={{ color: '#64748b', fontSize: '12px', marginTop: '2px' }}>
                  Show health bars above units that are below full health
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={healthBarsEnabled}
                aria-label="Toggle health bars"
                onClick={() => setHealthBarsEnabled(!healthBarsEnabled)}
                style={{
                  position: 'relative',
                  flexShrink: 0,
                  width: '52px',
                  height: '28px',
                  borderRadius: '14px',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  background: healthBarsEnabled
                    ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
                    : 'rgba(148,163,184,0.3)',
                  transition: 'background 0.3s ease'
                }}
              >
                <span style={{
                  position: 'absolute',
                  top: '3px',
                  left: healthBarsEnabled ? '27px' : '3px',
                  width: '22px',
                  height: '22px',
                  borderRadius: '50%',
                  background: '#fff',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                  transition: 'left 0.3s ease'
                }} />
              </button>
            </div>

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
                Exposure (Current: {exposure.toFixed(2)})
              </label>
              <input
                type="range"
                min="0.4"
                max="2"
                step="0.05"
                value={exposure}
                onChange={(e) => previewExposure(parseFloat(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                Overall brightness (AgX tone mapping). Lower to recover washed-out highlights, raise to lift a dark scene.
              </div>
            </div>

            <div>
              <label style={{ color: '#94a3b8', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
                Environment Light / IBL (Current: {environmentIntensity.toFixed(1)})
              </label>
              <input
                type="range"
                min="0"
                max="3"
                step="0.1"
                value={environmentIntensity}
                onChange={(e) => previewEnvironmentIntensity(parseFloat(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                Soft studio fill on the models' shadow side. Higher = richer, more "rendered" look; 0 = lit by the sun/moon only.
              </div>
            </div>

            <div>
              <label style={{ color: '#94a3b8', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
                Saturation (Current: {saturation.toFixed(2)})
              </label>
              <input
                type="range"
                min="0"
                max="2"
                step="0.05"
                value={saturation}
                onChange={(e) => previewSaturation(parseFloat(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                Color vividness. 1.0 = unchanged, higher = punchier "Pixar" color, 0 = greyscale.
              </div>
            </div>

            <div>
              <label style={{ color: '#94a3b8', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
                Contrast (Current: {contrast.toFixed(2)})
              </label>
              <input
                type="range"
                min="0.5"
                max="1.5"
                step="0.05"
                value={contrast}
                onChange={(e) => previewContrast(parseFloat(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                Separation between lights and darks. 1.0 = unchanged.
              </div>
            </div>

            <div>
              <label style={{ color: '#94a3b8', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
                Brightness (Current: {brightness.toFixed(2)})
              </label>
              <input
                type="range"
                min="0.5"
                max="1.5"
                step="0.05"
                value={brightness}
                onChange={(e) => previewBrightness(parseFloat(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                Post-grade lift of the final image (distinct from Exposure, which is the lighting).
              </div>
            </div>

            <div>
              <label style={{ color: '#94a3b8', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
                Hue Shift (Current: {hue.toFixed(0)}°)
              </label>
              <input
                type="range"
                min="-180"
                max="180"
                step="1"
                value={hue}
                onChange={(e) => previewHue(parseFloat(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ color: '#64748b', fontSize: '12px', marginTop: '4px' }}>
                Rotates all colors around the wheel. 0° = unchanged (use sparingly for a stylized tint).
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
          <ControlBindingsPanel />
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
            onClick={handleBack}
            data-gamepad-back
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
