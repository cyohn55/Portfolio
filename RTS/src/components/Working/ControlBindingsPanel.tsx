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
import { getBridgedGamepads } from './gamepadSource';
import {
  type ActivationMode,
  ACTIVATION_MODES,
  ACTIVATION_MODE_HINTS,
  ACTIVATION_MODE_LABELS,
} from './gestureModes';

/** Mouse `buttons` bitmask (1=left, 2=right, 4=middle) → the held atom tokens. */
function mouseChordAtoms(buttons: number): string[] {
  const atoms: string[] = [];
  if (buttons & 1) atoms.push('mouse:left');
  if (buttons & 2) atoms.push('mouse:right');
  if (buttons & 4) atoms.push('mouse:middle');
  return atoms;
}

/** Indices of the gamepad buttons currently pressed (for capturing a chord). */
function pressedGamepadButtons(pad: Gamepad): number[] {
  const out: number[] = [];
  pad.buttons.forEach((button, index) => {
    if (button.pressed || button.value > 0.5) out.push(index);
  });
  return out;
}

/** The four-way Tap / Double-Tap / Hold / Chord radio for one action's binding. */
function ModeRadial({
  selected,
  onSelect,
}: {
  selected: ActivationMode;
  onSelect: (mode: ActivationMode) => void;
}) {
  return (
    <div role="radiogroup" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      {ACTIVATION_MODES.map((mode) => {
        const isSelected = selected === mode;
        return (
          <button
            key={mode}
            role="radio"
            aria-checked={isSelected}
            title={ACTIVATION_MODE_HINTS[mode]}
            onClick={() => onSelect(mode)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '5px 10px',
              fontSize: '12px',
              fontWeight: 600,
              color: isSelected ? '#0b1020' : '#cbd5e1',
              background: isSelected
                ? 'linear-gradient(135deg, #ffd34d 0%, #f59e0b 100%)'
                : 'rgba(148,163,184,0.08)',
              border: isSelected ? '1px solid #f59e0b' : '1px solid rgba(148,163,184,0.2)',
              borderRadius: '999px',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                border: isSelected ? '3px solid #0b1020' : '2px solid #94a3b8',
                display: 'inline-block',
              }}
            />
            {ACTIVATION_MODE_LABELS[mode]}
          </button>
        );
      })}
    </div>
  );
}

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

// Speed sliders run as a multiplier on the tuned default (1.0×). The bounds let a player
// slow inputs to a quarter or speed them up to triple without ever hitting zero (which
// would freeze the input) or a runaway rate that overshoots the map every frame.
const SPEED_MIN = 0.25;
const SPEED_MAX = 3;
const SPEED_STEP = 0.05;

/** One labelled speed slider showing its current value as a "1.0×" multiplier. */
function SpeedSlider({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label style={{ color: '#cbd5e1', fontSize: '14px', fontWeight: 600, display: 'block', marginBottom: '6px' }}>
        {label} <span style={{ color: '#94a3b8', fontWeight: 400 }}>({value.toFixed(2)}×)</span>
      </label>
      <input
        type="range"
        min={SPEED_MIN}
        max={SPEED_MAX}
        step={SPEED_STEP}
        value={value}
        onChange={(event) => onChange(parseFloat(event.target.value))}
        style={{ width: '100%' }}
      />
      <div style={{ color: '#8b97a8', fontSize: '11px', marginTop: '4px', lineHeight: 1.3 }}>
        {description}
      </div>
    </div>
  );
}

export function ControlBindingsPanel() {
  const keyboardBindings = useGameStore((s) => s.keyboardBindings);
  const controllerBindings = useGameStore((s) => s.controllerBindings);
  const keyboardBindingModes = useGameStore((s) => s.keyboardBindingModes);
  const controllerBindingModes = useGameStore((s) => s.controllerBindingModes);
  const setBinding = useGameStore((s) => s.setBinding);
  const setBindingMode = useGameStore((s) => s.setBindingMode);
  const resetBindings = useGameStore((s) => s.resetBindings);
  const controlSpeeds = useGameStore((s) => s.controlSpeeds);
  const updateControlSpeeds = useGameStore((s) => s.updateControlSpeeds);

  const [device, setDevice] = useState<InputDevice>('keyboard');
  const [listeningFor, setListeningFor] = useState<ControlActionId | null>(null);

  const bindings = device === 'keyboard' ? keyboardBindings : controllerBindings;
  const modes = device === 'keyboard' ? keyboardBindingModes : controllerBindingModes;

  // Keep capture handlers reading the latest values without re-subscribing. The
  // mode of the action being rebound decides single-input vs. two-input (chord)
  // capture, so it is mirrored into a ref the capture effects read.
  const deviceRef = useRef(device);
  const listeningRef = useRef(listeningFor);
  const listeningModeRef = useRef<ActivationMode>('tap');
  deviceRef.current = device;
  listeningRef.current = listeningFor;
  listeningModeRef.current = listeningFor ? modes[listeningFor] : 'tap';

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
      // Chord mode captures two buttons held at once (e.g. Left + Right); wait
      // until a second button joins before committing the combined token.
      if (listeningModeRef.current === 'chord') {
        const atoms = mouseChordAtoms(event.buttons);
        if (atoms.length >= 2) commit(atoms.slice(0, 2).join('+'));
        return;
      }
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

    let rafId = 0;
    let armed = false;
    const poll = () => {
      // Bridged read so rebinding works in the portfolio embed too (gamepadSource.ts).
      const pad = getBridgedGamepads().find((p) => p && p.connected);
      if (pad) {
        if (listeningModeRef.current === 'chord') {
          // Capture two buttons held simultaneously, e.g. LB + A.
          const pressed = pressedGamepadButtons(pad as Gamepad);
          if (!armed) {
            if (pressed.length === 0) armed = true;
          } else if (pressed.length >= 2) {
            commit(`button:${pressed[0]}+button:${pressed[1]}`);
            return;
          }
        } else {
          const token = scanGamepadToken(pad as any);
          if (!armed) {
            if (token === null) armed = true; // wait for release first
          } else if (token !== null) {
            commit(token);
            return;
          }
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
          Click a binding, then press the key, mouse button, or scroll to rebind. Under each action, pick how its input fires: Tap, Double-Tap, Hold, or Chord (two inputs at once — e.g. Left + Right Click for an ability). One input can drive several actions when their modes differ. Pan the camera with the screen edges or a middle-mouse drag; the Move keys drive a piloted King/Queen.
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
          Connect a controller and press a button to rebind. Under each action, pick how its button fires: Tap, Double-Tap, Hold, or Chord (two buttons at once, e.g. LB + A). One button can drive several actions when their modes differ. The left stick pans the camera (or drives a piloted King/Queen); the right stick moves the on-screen reticle. Standard (Xbox) layout shown.
        </div>
      )}

      {/* Speed sliders. Scroll speed scales the camera zoom + pan rate; cursor speed
          scales the controller reticle (and, on keyboard & mouse, the screen-edge scroll,
          since the OS owns the actual mouse pointer). Changes apply live and persist. */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        marginBottom: '20px',
        padding: '14px 16px',
        background: 'rgba(88,120,255,0.06)',
        border: '1px solid rgba(88,120,255,0.15)',
        borderRadius: '8px',
      }}>
        <SpeedSlider
          label="Scroll Speed"
          description={device === 'keyboard'
            ? 'How fast the mouse wheel zooms and a middle-mouse drag pans the map.'
            : 'How fast the triggers zoom and the left stick pans the camera.'}
          value={device === 'keyboard' ? controlSpeeds.keyboardScroll : controlSpeeds.controllerScroll}
          onChange={(value) => updateControlSpeeds(
            device === 'keyboard' ? { keyboardScroll: value } : { controllerScroll: value }
          )}
        />
        <SpeedSlider
          label="Cursor Speed"
          description={device === 'keyboard'
            ? 'How fast the camera scrolls when the cursor pushes against a screen edge.'
            : 'How fast the right stick moves the on-screen targeting reticle.'}
          value={device === 'keyboard' ? controlSpeeds.keyboardCursor : controlSpeeds.controllerCursor}
          onChange={(value) => updateControlSpeeds(
            device === 'keyboard' ? { keyboardCursor: value } : { controllerCursor: value }
          )}
        />
      </div>

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
                const mode = modes[action.id];
                const conflict = token !== UNBOUND_TOKEN
                  ? findConflict(bindings, modes, token, mode, action.id)
                  : null;
                return (
                  <div
                    key={action.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      padding: '10px 12px',
                      background: 'rgba(88,120,255,0.06)',
                      border: '1px solid rgba(88,120,255,0.15)',
                      borderRadius: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
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
                    <ModeRadial
                      selected={mode}
                      onSelect={(nextMode) => setBindingMode(device, action.id, nextMode)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
        <button
          onClick={() => {
            setListeningFor(null);
            resetBindings(device);
            // Also restore this device's speed sliders to the 1.0× default so "Reset to
            // Defaults" returns the whole tab to its out-of-box feel, not just the keys.
            updateControlSpeeds(device === 'keyboard'
              ? { keyboardScroll: 1, keyboardCursor: 1 }
              : { controllerScroll: 1, controllerCursor: 1 });
          }}
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
