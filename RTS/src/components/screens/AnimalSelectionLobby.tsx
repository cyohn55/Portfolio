import { useState, useMemo } from 'react';
import { useGameStore } from '../../game/state';
import type { AnimalId } from '../../game/types';
import { AnimalModelPreview } from '../../../Working/AnimalModelPreview';
import './AnimalSelectionLobby.css';

const ALL_ANIMALS: AnimalId[] = ['Bee', 'Bear', 'Bunny', 'Chicken', 'Cat', 'Dolphin', 'Fox', 'Frog', 'Owl', 'Pig', 'Turtle', 'Yetti'];

// Animal stats and descriptions. These mirror the gameplay ANIMALS table in
// game/state.ts. Damage is per hit; how often a hit lands is set by
// attackCooldownMs, so the player-facing damage bar shows DPS (see animalDps),
// which is what actually matters in a fight.
const ANIMAL_STATS: Record<AnimalId, {
  baseHp: number;
  dmg: number;
  speed: number;
  range: number;
  attackCooldownMs: number;
  role: string;
  description: string;
  strengths: string[];
  weaknesses: string[];
}> = {
  Bee: {
    baseHp: 40, dmg: 11, speed: 20.4, range: 9, attackCooldownMs: 800, role: 'Fast',
    description: 'Fastest unit: a flying ranged kiter with rapid stings',
    strengths: ['Fastest unit', 'Attacks from range', 'Flies over water'],
    weaknesses: ['Lowest HP', 'Dies instantly if cornered', 'Low per-hit damage']
  },
  Bear: {
    baseHp: 95, dmg: 36, speed: 8.16, range: 4, attackCooldownMs: 2050, role: 'DPS',
    description: 'Slow melee slammer with the biggest single hit in the game',
    strengths: ['Highest per-hit damage', 'Punishing burst', 'Solid HP'],
    weaknesses: ['Very slow', 'Slowest attack', 'Easily kited by ranged units']
  },
  Bunny: {
    baseHp: 80, dmg: 14, speed: 18.36, range: 4, attackCooldownMs: 1000, role: 'Fast',
    description: 'Fast evasive melee skirmisher that is hard to pin down',
    strengths: ['Very fast', 'Quick attacks', 'Good mobility'],
    weaknesses: ['Low per-hit damage', 'Melee only', 'Loses prolonged duels']
  },
  Chicken: {
    baseHp: 70, dmg: 14, speed: 19.04, range: 4, attackCooldownMs: 900, role: 'Fast',
    description: 'Nimble melee harasser with fast pecks for hit-and-run',
    strengths: ['Very fast', 'Fast attack rate', 'Great for harassment'],
    weaknesses: ['Low HP', 'Melee only', 'Weak head-on against tanks']
  },
  Cat: {
    baseHp: 65, dmg: 20, speed: 16.32, range: 4, attackCooldownMs: 1100, role: 'DPS',
    description: 'Agile melee duelist with the highest sustained DPS',
    strengths: ['Highest DPS', 'Good speed', 'Strong 1v1'],
    weaknesses: ['Low HP', 'Melee only', 'Fragile under focus fire']
  },
  Dolphin: {
    baseHp: 105, dmg: 19, speed: 13.6, range: 4, attackCooldownMs: 1500, role: 'Balanced',
    description: 'Tanky aquatic all-rounder that crosses water freely',
    strengths: ['Good HP pool', 'Swims across water', 'Reliable frontline'],
    weaknesses: ['Average everything else', 'Melee only', 'Moderate speed']
  },
  Fox: {
    baseHp: 90, dmg: 19, speed: 14.28, range: 4, attackCooldownMs: 1300, role: 'Balanced',
    description: 'Well-rounded melee bruiser with no glaring weakness',
    strengths: ['Balanced HP and DPS', 'Strong in skirmishes', 'Flexible'],
    weaknesses: ['Out-tanked by true tanks', 'Out-ranged by fliers', 'Melee only']
  },
  Frog: {
    baseHp: 60, dmg: 14, speed: 17.68, range: 8, attackCooldownMs: 1300, role: 'Fast',
    description: 'Fast amphibious skirmisher with a long tongue lash',
    strengths: ['Attacks from range', 'Crosses water', 'Kites slow melee'],
    weaknesses: ['Low HP', 'Slow attack', 'Fragile if caught']
  },
  Owl: {
    baseHp: 45, dmg: 15, speed: 14.96, range: 11, attackCooldownMs: 1400, role: 'Balanced',
    description: 'Longest-range flying sniper that picks targets apart',
    strengths: ['Longest range', 'Flies over water', 'Excellent kiter'],
    weaknesses: ['Very fragile', 'Slow attack', 'Falls fast if caught']
  },
  Pig: {
    baseHp: 120, dmg: 20, speed: 12.24, range: 4, attackCooldownMs: 1700, role: 'Tank',
    description: 'Sturdy slow tank that hits hard and holds the line',
    strengths: ['High HP', 'Heavy hits', 'Hard to kill'],
    weaknesses: ['Slow movement', 'Slow attack', 'Easily kited']
  },
  Turtle: {
    baseHp: 155, dmg: 23, speed: 6.8, range: 4, attackCooldownMs: 2000, role: 'Tank',
    description: 'Immovable HP wall that absorbs enormous punishment',
    strengths: ['Highest HP', 'Outlasts almost anything', 'Anchors a push'],
    weaknesses: ['Slowest unit', 'Slow attack', 'Very easily kited']
  },
  Yetti: {
    baseHp: 120, dmg: 27, speed: 7.48, range: 4, attackCooldownMs: 1900, role: 'Tank',
    description: 'Slow juggernaut combining a big health pool with heavy damage',
    strengths: ['High HP', 'Heavy hits', 'Dominant in a grind'],
    weaknesses: ['Very slow', 'Slow attack', 'Easily kited']
  },
};

// Damage per second: the meaningful combat output once attack speed is folded in.
function animalDps(dmg: number, attackCooldownMs: number): number {
  return dmg / (attackCooldownMs / 1000);
}

// Normalize stats for progress bars (0-100 scale). Maxes track the current
// roster leaders so the fullest bar always maps to 100%.
function normalizeHp(hp: number): number {
  const maxHp = 155; // Turtle
  return (hp / maxHp) * 100;
}

function normalizeDps(dps: number): number {
  const maxDps = 18.2; // Cat (20 dmg / 1.1s)
  return Math.min(100, (dps / maxDps) * 100);
}

function normalizeRange(range: number): number {
  const maxRange = 11; // Owl
  return (range / maxRange) * 100;
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
                <div className="animal-model-preview">
                  <AnimalModelPreview animal={animal} />
                </div>
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
                    <span className="stat-label">DPS</span>
                    <div className="stat-bar">
                      <div
                        className="stat-fill dps"
                        style={{ width: `${normalizeDps(animalDps(stats.dmg, stats.attackCooldownMs))}%` }}
                      />
                    </div>
                    <span className="stat-value">{animalDps(stats.dmg, stats.attackCooldownMs).toFixed(1)}</span>
                  </div>

                  <div className="stat-row">
                    <span className="stat-label">RNG</span>
                    <div className="stat-bar">
                      <div
                        className="stat-fill rng"
                        style={{ width: `${normalizeRange(stats.range)}%` }}
                      />
                    </div>
                    <span className="stat-value">{stats.range}</span>
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
                    <div>DPS: {animalDps(stats.dmg, stats.attackCooldownMs).toFixed(1)}</div>
                    <div>RNG: {stats.range}</div>
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
