import React, { useState, useEffect } from 'react';
import './InstructionsPopup.css';

interface InstructionsPopupProps {
  onClose: () => void;
}

export const InstructionsPopup: React.FC<InstructionsPopupProps> = ({ onClose }) => {
  const [isMobile, setIsMobile] = useState(false);

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
            <ul className="controls-list">
              <li><span className="control-key">Drag</span> Move the camera</li>
              <li><span className="control-key">Pinch</span> Zoom in/out</li>
              <li><span className="control-key">Tap</span> Select an animal</li>
              <li><span className="control-key">Tap & Hold</span> Move/Attack</li>
            </ul>
          ) : (
            <ul className="controls-list">
              <li><span className="control-key">W A S D</span> Move the camera</li>
              <li><span className="control-key">Scroll</span> Zoom in/out</li>
              <li><span className="control-key">Left-Click</span> Select an animal</li>
              <li><span className="control-key">Click & Drag</span> Select multiple animals</li>
              <li><span className="control-key">Spacebar</span> Select all animals</li>
              <li><span className="control-key">Right-Click</span> Move/Attack</li>
            </ul>
          )}
        </div>

        <button className="start-battle-btn" onClick={onClose}>
          Begin Battle!
        </button>
      </div>
    </div>
  );
};
