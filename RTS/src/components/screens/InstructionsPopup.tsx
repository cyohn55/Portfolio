import React, { useState, useEffect } from 'react';
import './InstructionsPopup.css';

interface InstructionsPopupProps {
  onClose: () => void;
}

/** A single "input → what it does" row inside a control group. */
interface ControlEntry {
  input: string;
  action: string;
}

/** A titled cluster of related control rows (Camera, Selection, …). */
interface ControlGroup {
  label: string;
  entries: ControlEntry[];
}

// Keep these tables in sync with the bindable actions and their runtime handlers:
// DEFAULT_KEYBOARD_BINDINGS / DEFAULT_CONTROLLER_BINDINGS in controlBindings.ts,
// consumed by CameraController, KeyboardShortcuts, HexInteraction (mouse gestures
// + Queen patrol/rally), and GamepadController. The Settings → Controls screen
// shows the live, remappable bindings; this popup teaches the shipped defaults.
const KEYBOARD_MOUSE_GROUPS: readonly ControlGroup[] = [
  {
    label: 'Camera',
    entries: [
      { input: 'Mouse to Edge', action: 'Pan the camera' },
      { input: 'Middle-Drag', action: 'Grab & slide the map' },
      { input: 'Scroll', action: 'Zoom in / out' },
    ],
  },
  {
    label: 'Selection',
    entries: [
      { input: 'Left-Click', action: 'Select an animal' },
      { input: 'Shift + Left-Click', action: 'Add an animal to the selection' },
      { input: 'Click & Drag', action: 'Box-select multiple animals' },
      { input: 'Shift + A / S / D', action: 'Select your 1st / 2nd / 3rd animal' },
      { input: 'Double-Tap Space', action: 'Select all your animals' },
      { input: 'Esc', action: 'Deselect all' },
    ],
  },
  {
    label: 'Commands',
    entries: [
      { input: 'Right-Click', action: 'Move / Attack' },
      { input: 'Left + Right Click', action: "Use the selected animal's special ability" },
      { input: 'Right-Hold on Queen', action: 'Draw a patrol route' },
      { input: 'R, then R', action: "Set a lone Queen's spawn rally point" },
    ],
  },
  {
    label: 'Pilot a Monarch',
    entries: [
      { input: 'A', action: 'Pilot / cycle your Kings' },
      { input: 'G', action: 'Toggle the King / Queen' },
      { input: 'E S D F', action: 'Drive the piloted monarch' },
      { input: 'Tap Space', action: 'Rally that army to follow' },
      { input: 'Hold Space', action: 'Deploy units at the monarch' },
    ],
  },
  {
    label: 'System',
    entries: [{ input: 'P', action: 'Pause the game' }],
  },
];

const CONTROLLER_GROUPS: readonly ControlGroup[] = [
  {
    label: 'Camera & Reticle',
    entries: [
      { input: 'Left Stick', action: 'Pan camera (or drive a piloted monarch)' },
      { input: 'Right Stick', action: 'Move the targeting reticle' },
      { input: 'LT / RT', action: 'Zoom out / in' },
    ],
  },
  {
    label: 'Selection',
    entries: [
      { input: 'A', action: 'Select the animal under the reticle' },
      { input: 'LB + A / B / Y', action: 'Select your 1st / 2nd / 3rd animal' },
      { input: 'X', action: 'Select all your animals' },
      { input: 'Y', action: 'Deselect all' },
    ],
  },
  {
    label: 'Commands',
    entries: [
      { input: 'B', action: 'Move / Attack at the reticle' },
      { input: 'RB', action: "Use the selected animal's special ability" },
    ],
  },
  {
    label: 'Pilot a Monarch',
    entries: [
      { input: 'D-Pad ↑ / ← / →', action: 'Pilot your 1st / 2nd / 3rd King' },
      { input: 'D-Pad ↓', action: 'Toggle the King / Queen' },
      { input: 'X (while piloting)', action: 'Rally that army to follow' },
    ],
  },
  {
    label: 'System',
    entries: [{ input: 'Start', action: 'Pause the game' }],
  },
];

const TOUCH_GROUPS: readonly ControlGroup[] = [
  {
    label: 'Controls',
    entries: [
      { input: 'Drag', action: 'Move the camera' },
      { input: 'Pinch', action: 'Zoom in / out' },
      { input: 'Tap', action: 'Select an animal' },
      { input: 'Tap & Hold', action: 'Move / Attack' },
    ],
  },
];

const ControlGroupList: React.FC<{ groups: readonly ControlGroup[] }> = ({ groups }) => (
  <>
    {groups.map((group) => (
      <div key={group.label} className="controls-group">
        <h4 className="controls-group-label">{group.label}</h4>
        <ul className="controls-list">
          {group.entries.map((entry) => (
            <li key={entry.input}>
              <span className="control-key">{entry.input}</span>
              {entry.action}
            </li>
          ))}
        </ul>
      </div>
    ))}
  </>
);

type InputView = 'keyboard' | 'controller';

export const InstructionsPopup: React.FC<InstructionsPopupProps> = ({ onClose }) => {
  const [isMobile, setIsMobile] = useState(false);
  const [inputView, setInputView] = useState<InputView>('keyboard');

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 768 || 'ontouchstart' in window);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  return (
    <div className="instructions-overlay">
      <div className="instructions-popup">
        <h2>Battle Instructions</h2>

        <div className="instructions-section">
          <h3>Objective</h3>
          <p>Eliminate the enemy army or destroy all three enemy bases to win!</p>
        </div>

        <div className="instructions-section">
          <h3>Controls</h3>

          {isMobile ? (
            <ControlGroupList groups={TOUCH_GROUPS} />
          ) : (
            <>
              <div className="controls-tabs">
                <button
                  className={`controls-tab ${inputView === 'keyboard' ? 'active' : ''}`}
                  onClick={() => setInputView('keyboard')}
                >
                  ⌨️ Keyboard &amp; Mouse
                </button>
                <button
                  className={`controls-tab ${inputView === 'controller' ? 'active' : ''}`}
                  onClick={() => setInputView('controller')}
                >
                  🎮 Controller
                </button>
              </div>

              <ControlGroupList
                groups={inputView === 'keyboard' ? KEYBOARD_MOUSE_GROUPS : CONTROLLER_GROUPS}
              />

              <p className="controls-note">
                Rebind any of these in Settings → Controls.
              </p>
            </>
          )}
        </div>

        <button className="start-battle-btn" onClick={onClose}>
          Begin Battle!
        </button>
      </div>
    </div>
  );
};
