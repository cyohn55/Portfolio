import { useEffect, useMemo, useRef, useState } from 'react';
import { useGameStore } from '../../game/state';
import {
  type ControlActionId,
  type ControlCategory,
  type InputDevice,
  CONTROL_ACTIONS,
  UNBOUND_TOKEN,
  findConflict,
  formatToken,
  keyboardEventToToken,
  mouseButtonToToken,
  scanGamepadToken,
  wheelDeltaToToken,
} from './controlBindings';

/**
 * ControlBindingsPanel renders the Settings → Controls body: a Keyboard & Mouse
 * and a Controller sub-tab, each listing every bindable action with its current
 * mapping and a click-to-rebind button, plus a Reset to Defaults action.
 *
 * Rebinds persist immediately through the store (which writes localStorage),
 * matching how the rest of Settings (shadows, health bars, music) commit on
 * change. Each device keeps its own independent layout.
 */

const CATEGORY_ORDER: readonly ControlCategory[] = ['Camera', 'Selection', 'Commands', 'Pilot', 'System'];

const CATEGORY_ICONS: Record<ControlCategory, string> = {
  Camera: '🎥',
  Selection: '🎯',
  Commands: '⚔️',
  Pilot: '👑',
  System: '⚙️',
};

const SUB_TABS: readonly { device: InputDevice; label: string }[] = [
  { device: 'keyboard', label: 'Keyboard & Mouse' },
  { device: 'controller', label: 'Controller' },
];

export function ControlBindingsPanel() {
  const keyboardBindings = useGameStore((s) => s.keyboardBindings);
  const controllerBindings = useGameStore((s) => s.controllerBindings);
  const setBinding = useGameStore((s) => s.setBinding);
  const resetBindings = useGameStore((s) => s.resetBindings);

  const [device, setDevice] = useState<InputDevice>('keyboard');
  const [listeningFor, setListeningFor] = useState<ControlActionId | null>(null);

  const bindings = device === 'keyboard' ? keyboardBindings : controllerBindings;

  // Keep capture handlers reading the latest values without re-subscribing.
  const deviceRef = useRef(device);
  const listeningRef = useRef(listeningFor);
  deviceRef.current = device;
  listeningRef.current = listeningFor;

  const commit = (token: string) => {
    const actionId = listeningRef.current;
    if (actionId) setBinding(deviceRef.current, actionId, token);
    setListeningFor(null);
  };

  // Switching device cancels any in-progress capture.
  useEffect(() => {
    setListeningFor(null);
  }, [device]);

  // Keyboard / mouse capture: listen in the capture phase and swallow the event
  // so an in-game shortcut (which listens while a match is running) never also
  // fires from the key the player is binding.
  useEffect(() => {
    if (listeningFor === null || device !== 'keyboard') return;

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const token = keyboardEventToToken(event);
      if (token !== UNBOUND_TOKEN) commit(token);
    };
    const onMouseDown = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      commit(mouseButtonToToken(event.button));
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      commit(wheelDeltaToToken(event.deltaY));
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('mousedown', onMouseDown, { capture: true });
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('mousedown', onMouseDown, { capture: true });
      window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
    };
    // commit/listeningFor are intentionally captured fresh on each (re)bind start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listeningFor, device]);

  // Controller capture: poll the gamepad. Require the pad to read "neutral" once
  // before capturing, so a button still held from navigating the menu doesn't
  // immediately bind itself.
  useEffect(() => {
    if (listeningFor === null || device !== 'controller') return;
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;

    let rafId = 0;
    let armed = false;
    const poll = () => {
      const pad = Array.from(navigator.getGamepads()).find((p) => p && p.connected);
      if (pad) {
        const token = scanGamepadToken(pad as any);
        if (!armed) {
          if (token === null) armed = true; // wait for release first
        } else if (token !== null) {
          commit(token);
          return;
        }
      }
      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listeningFor, device]);

  const grouped = useMemo(() => {
    return CATEGORY_ORDER.map((category) => ({
      category,
      actions: CONTROL_ACTIONS.filter((action) => action.category === category),
    })).filter((group) => group.actions.length > 0);
  }, []);

  return (
    <div style={{ color: '#e2e8f0', fontSize: '14px' }}>
      {/* Device sub-tabs */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px' }}>
        {SUB_TABS.map((tab) => (
          <button
            key={tab.device}
            onClick={() => setDevice(tab.device)}
            style={{
              flex: 1,
              padding: '10px 16px',
              fontSize: '15px',
              fontWeight: 600,
              color: device === tab.device ? '#fff' : '#94a3b8',
              background: device === tab.device ? 'rgba(88,120,255,0.25)' : 'rgba(148,163,184,0.08)',
              border: device === tab.device ? '1px solid rgba(88,120,255,0.6)' : '1px solid rgba(148,163,184,0.2)',
              borderRadius: '8px',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            {tab.device === 'keyboard' ? '⌨️ ' : '🎮 '}{tab.label}
          </button>
        ))}
      </div>

      {device === 'keyboard' && (
        <div style={{
          color: '#94a3b8',
          fontSize: '12px',
          marginBottom: '16px',
          padding: '10px 14px',
          background: 'rgba(88,120,255,0.08)',
          border: '1px solid rgba(88,120,255,0.2)',
          borderRadius: '8px',
        }}>
          Click a binding, then press the key, mouse button, or scroll to rebind. Pan the camera with the screen edges or a middle-mouse drag; the Move keys drive a piloted King/Queen.
        </div>
      )}

      {device === 'controller' && (
        <div style={{
          color: '#94a3b8',
          fontSize: '12px',
          marginBottom: '16px',
          padding: '10px 14px',
          background: 'rgba(88,120,255,0.08)',
          border: '1px solid rgba(88,120,255,0.2)',
          borderRadius: '8px',
        }}>
          Connect a controller and press a button to rebind. The left stick pans the camera (or drives a piloted King/Queen); the right stick moves the on-screen reticle. Standard (Xbox) layout shown.
        </div>
      )}

      <div style={{ maxHeight: '46vh', overflowY: 'auto', paddingRight: '6px' }}>
        {grouped.map((group) => (
          <div key={group.category} style={{ marginBottom: '20px' }}>
            <h3 style={{ color: '#fff', fontSize: '16px', margin: '0 0 10px 0', fontWeight: 600 }}>
              {CATEGORY_ICONS[group.category]} {group.category}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {group.actions.map((action) => {
                const token = bindings[action.id];
                const isListening = listeningFor === action.id;
                const conflict = token !== UNBOUND_TOKEN
                  ? findConflict(bindings, token, action.id)
                  : null;
                return (
                  <div
                    key={action.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '12px',
                      padding: '8px 12px',
                      background: 'rgba(88,120,255,0.06)',
                      border: '1px solid rgba(88,120,255,0.15)',
                      borderRadius: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
                      <span style={{ color: '#cbd5e1' }} title={action.description}>{action.label}</span>
                      {action.gestureHint && (
                        <span style={{ color: '#8b97a8', fontSize: '11px', lineHeight: 1.2 }}>
                          {action.gestureHint}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                      {conflict && (
                        <span title="This input is shared with another action" style={{ color: '#fbbf24', fontSize: '12px' }}>
                          ⚠ conflict
                        </span>
                      )}
                      <button
                        onClick={() => setListeningFor(isListening ? null : action.id)}
                        style={{
                          minWidth: '130px',
                          padding: '8px 14px',
                          fontSize: '13px',
                          fontWeight: 600,
                          color: isListening ? '#0b1020' : '#fff',
                          background: isListening
                            ? 'linear-gradient(135deg, #ffd34d 0%, #f59e0b 100%)'
                            : 'rgba(102,126,234,0.25)',
                          border: '1px solid rgba(102,126,234,0.5)',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          transition: 'all 0.2s ease',
                        }}
                      >
                        {isListening ? 'Press input…' : formatToken(device, token)}
                      </button>
                      <button
                        onClick={() => setBinding(device, action.id, UNBOUND_TOKEN)}
                        title="Unbind"
                        aria-label={`Unbind ${action.label}`}
                        style={{
                          width: '28px',
                          height: '28px',
                          color: '#94a3b8',
                          background: 'rgba(148,163,184,0.1)',
                          border: '1px solid rgba(148,163,184,0.25)',
                          borderRadius: '6px',
                          cursor: 'pointer',
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
        <button
          onClick={() => { setListeningFor(null); resetBindings(device); }}
          style={{
            padding: '10px 18px',
            fontSize: '13px',
            fontWeight: 600,
            color: '#94a3b8',
            background: 'rgba(148,163,184,0.1)',
            border: '1px solid rgba(148,163,184,0.3)',
            borderRadius: '8px',
            cursor: 'pointer',
          }}
        >
          Reset {device === 'keyboard' ? 'Keyboard & Mouse' : 'Controller'} to Defaults
        </button>
      </div>
    </div>
  );
}
