import { useState, useMemo } from 'react';
import { useGameStore } from '../../game/state';
import type { AnimalId } from '../../game/types';
import './AnimalSelectionLobby.css';

const ALL_ANIMALS: AnimalId[] = ['Bee', 'Bear', 'Bunny', 'Chicken', 'Cat', 'Dolphin', 'Fox', 'Frog', 'Owl', 'Pig', 'Turtle', 'Yetti'];

// Animal stats and descriptions
const ANIMAL_STATS: Record<AnimalId, {
  baseHp: number;
  dmg: number;
  speed: number;
  role: string;
  description: string;
  strengths: string[];
  weaknesses: string[];
}> = {
  Bee: {
    baseHp: 60, dmg: 10, speed: 20.4, role: 'Fast',
    description: 'Lightning fast scout with swarm tactics',
    strengths: ['Fastest unit', 'Great for flanking', 'Hard to catch'],
    weaknesses: ['Low HP', 'Weak damage', 'Fragile in direct combat']
  },
  Bear: {
    baseHp: 220, dmg: 40, speed: 8.16, role: 'Tank',
    description: 'Devastating bruiser with massive damage',
    strengths: ['Highest damage', 'High HP', 'Excellent frontline'],
    weaknesses: ['Very slow', 'Easy to kite', 'Poor mobility']
  },
  Bunny: {
    baseHp: 75, dmg: 9, speed: 18.36, role: 'Fast',
    description: 'Agile hopper with quick strikes',
    strengths: ['Very fast', 'Good mobility', 'Hard to pin down'],
    weaknesses: ['Low HP', 'Weak damage', 'Fragile in combat']
  },
  Chicken: {
    baseHp: 70, dmg: 8, speed: 19.04, role: 'Fast',
    description: 'Nimble striker with hit-and-run potential',
    strengths: ['Very fast', 'Good for harassment', 'Evasive'],
    weaknesses: ['Low HP', 'Weak damage', 'Dies quickly']
  },
  Cat: {
    baseHp: 90, dmg: 12, speed: 16.32, role: 'Balanced',
    description: 'Versatile fighter with balanced stats',
    strengths: ['No major weaknesses', 'Reliable', 'Adaptable'],
    weaknesses: ['No major strengths', 'Average at everything']
  },
  Dolphin: {
    baseHp: 110, dmg: 18, speed: 13.6, role: 'Balanced',
    description: 'Solid all-rounder with good survivability',
    strengths: ['Balanced stats', 'Good HP pool', 'Decent damage'],
    weaknesses: ['Not exceptional at anything', 'Moderate speed']
  },
  Fox: {
    baseHp: 140, dmg: 20, speed: 14.28, role: 'DPS',
    description: 'High damage dealer with decent mobility',
    strengths: ['High damage', 'Good HP', 'Strong in skirmishes'],
    weaknesses: ['Not as tanky as bears', 'Moderate speed']
  },
  Frog: {
    baseHp: 80, dmg: 10, speed: 17.68, role: 'Fast',
    description: 'Quick hopper excellent for scouting',
    strengths: ['Fast movement', 'Good mobility', 'Hard to pin down'],
    weaknesses: ['Low HP', 'Weak damage', 'Poor in sustained fights']
  },
  Owl: {
    baseHp: 100, dmg: 16, speed: 14.96, role: 'Balanced',
    description: 'Well-rounded unit with consistent performance',
    strengths: ['Balanced stats', 'Reliable', 'Versatile'],
    weaknesses: ['Not specialized', 'Average speed']
  },
  Pig: {
    baseHp: 160, dmg: 18, speed: 12.24, role: 'Tank',
    description: 'Durable tank with good staying power',
    strengths: ['High HP', 'Good damage', 'Hard to kill'],
    weaknesses: ['Slow movement', 'Easy to kite']
  },
  Turtle: {
    baseHp: 240, dmg: 24, speed: 6.8, role: 'Tank',
    description: 'Ultimate tank with massive health pool',
    strengths: ['Highest HP', 'Great damage', 'Excellent survivability'],
    weaknesses: ['Slowest unit', 'Very easy to kite']
  },
  Yetti: {
    baseHp: 260, dmg: 30, speed: 7.48, role: 'Tank',
    description: 'Legendary powerhouse combining HP and damage',
    strengths: ['Highest HP', 'Second highest damage', 'Dominant in melee'],
    weaknesses: ['Very slow', 'Poor chase potential']
  },
};

// Normalize stats for progress bars (0-100 scale)
function normalizeHp(hp: number): number {
  const maxHp = 260; // Yetti
  return (hp / maxHp) * 100;
}

function normalizeDmg(dmg: number): number {
  const maxDmg = 40; // Bear
  return (dmg / maxDmg) * 100;
}

function normalizeSpeed(speed: number): number {
  const maxSpeed = 20.4; // Bee
  return (speed / maxSpeed) * 100;
}

export function AnimalSelectionLobby() {
  const transitionToScreen = useGameStore((s) => s.transitionToScreen);
  const chooseAnimalsForLocal = useGameStore((s) => s.chooseAnimalsForLocal);
  const initializeGame = useGameStore((s) => s.initializeGame);
  const startMatch = useGameStore((s) => s.startMatch);

  const [selectedAnimals, setSelectedAnimals] = useState<AnimalId[]>([]);
  const [hoveredAnimal, setHoveredAnimal] = useState<AnimalId | null>(null);

  const handleAnimalClick = (animal: AnimalId) => {
    setSelectedAnimals((prev) => {
      if (prev.includes(animal)) {
        return prev.filter((a) => a !== animal);
      }
      if (prev.length >= 3) {
        return prev;
      }
      return [...prev, animal];
    });
  };

  const handleStartGame = () => {
    if (selectedAnimals.length === 3) {
      chooseAnimalsForLocal(selectedAnimals);
      initializeGame();
      startMatch(true);
      transitionToScreen('playing');
    }
  };

  const teamAnalysis = useMemo(() => {
    if (selectedAnimals.length === 0) return null;

    const roles = selectedAnimals.map(a => ANIMAL_STATS[a].role);
    const hasTank = roles.includes('Tank');
    const hasDPS = roles.includes('DPS');
    const hasFast = roles.includes('Fast');

    if (hasTank && hasDPS && hasFast) {
      return { type: '⭐ Excellent Balance', color: '#4ade80' };
    } else if (hasTank && (hasDPS || hasFast)) {
      return { type: '✓ Good Mix', color: '#60a5fa' };
    } else if (selectedAnimals.length === 3) {
      return { type: '⚠ Unbalanced', color: '#fbbf24' };
    }
    return null;
  }, [selectedAnimals]);

  return (
    <div className="animal-lobby">
      <div className="lobby-header">
        <button className="back-button" onClick={() => transitionToScreen('menu')}>
          ← BACK
        </button>
        <h1>Choose Your Team</h1>
        <div className="selection-count">
          {selectedAnimals.length}/3 Selected
        </div>
      </div>

      <div className="lobby-content">
        {/* Animal Grid */}
        <div className="animal-grid">
          {ALL_ANIMALS.map((animal) => {
            const stats = ANIMAL_STATS[animal];
            const isSelected = selectedAnimals.includes(animal);

            return (
              <div
                key={animal}
                className={`animal-card ${isSelected ? 'selected' : ''}`}
                onClick={() => handleAnimalClick(animal)}
                onMouseEnter={() => setHoveredAnimal(animal)}
                onMouseLeave={() => setHoveredAnimal(null)}
              >
                <div className="animal-name">{animal}</div>
                <div className="animal-role">{stats.role}</div>
                <div className="animal-description">{stats.description}</div>

                <div className="stat-bars">
                  <div className="stat-row">
                    <span className="stat-label">HP</span>
                    <div className="stat-bar">
                      <div
                        className="stat-fill hp"
                        style={{ width: `${normalizeHp(stats.baseHp)}%` }}
                      />
                    </div>
                    <span className="stat-value">{stats.baseHp}</span>
                  </div>

                  <div className="stat-row">
                    <span className="stat-label">DMG</span>
                    <div className="stat-bar">
                      <div
                        className="stat-fill dmg"
                        style={{ width: `${normalizeDmg(stats.dmg)}%` }}
                      />
                    </div>
                    <span className="stat-value">{stats.dmg}</span>
                  </div>

                  <div className="stat-row">
                    <span className="stat-label">SPD</span>
                    <div className="stat-bar">
                      <div
                        className="stat-fill spd"
                        style={{ width: `${normalizeSpeed(stats.speed)}%` }}
                      />
                    </div>
                    <span className="stat-value">{stats.speed.toFixed(1)}</span>
                  </div>
                </div>

                {isSelected && (
                  <div className="selected-badge">
                    ✓
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Selected Team Panel */}
        <div className="selected-team-panel">
          <h2>Your Team</h2>

          <div className="selected-animals">
            {selectedAnimals.length === 0 && (
              <div className="empty-selection">
                <p>Select 3 animals to start</p>
              </div>
            )}

            {selectedAnimals.map((animal, index) => {
              const stats = ANIMAL_STATS[animal];
              return (
                <div key={animal} className="selected-animal">
                  <div className="selected-animal-header">
                    <span className="animal-name">{animal}</span>
                    <button
                      className="remove-button"
                      onClick={() => setSelectedAnimals(prev => prev.filter(a => a !== animal))}
                    >
                      ×
                    </button>
                  </div>
                  <div className="role-tag">{stats.role}</div>
                  <div className="mini-stats">
                    <div>HP: {stats.baseHp}</div>
                    <div>DMG: {stats.dmg}</div>
                    <div>SPD: {stats.speed.toFixed(1)}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {teamAnalysis && (
            <div className="team-analysis" style={{ borderColor: teamAnalysis.color }}>
              <div className="analysis-title" style={{ color: teamAnalysis.color }}>
                {teamAnalysis.type}
              </div>
              <p className="analysis-text">
                {selectedAnimals.length === 3
                  ? 'Your team is ready for battle!'
                  : `Select ${3 - selectedAnimals.length} more animal${3 - selectedAnimals.length > 1 ? 's' : ''}`
                }
              </p>
            </div>
          )}

          <button
            className="start-game-button"
            disabled={selectedAnimals.length !== 3}
            onClick={handleStartGame}
          >
            {selectedAnimals.length === 3 ? 'START BATTLE' : `SELECT ${3 - selectedAnimals.length} MORE`}
          </button>

          {/* Detailed Animal Info (shown on hover) */}
          {hoveredAnimal && (
            <div className="animal-details-panel">
              <h4>{hoveredAnimal}</h4>
              <div className="details-section">
                <div className="details-strengths">
                  <h5>✓ Strengths</h5>
                  <ul>
                    {ANIMAL_STATS[hoveredAnimal].strengths.map((strength, idx) => (
                      <li key={idx}>{strength}</li>
                    ))}
                  </ul>
                </div>
                <div className="details-weaknesses">
                  <h5>✗ Weaknesses</h5>
                  <ul>
                    {ANIMAL_STATS[hoveredAnimal].weaknesses.map((weakness, idx) => (
                      <li key={idx}>{weakness}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
