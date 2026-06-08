// Pre-match setup for the Conquest game mode.
//
// Single responsibility: collect the match configuration (seed, AI opponent
// count, the human player's 3-animal roster), then generate the world and route
// into the Conquest screen. It reuses the RTS animal roster so Conquest armies
// are the same units the player already knows.

import { useState } from 'react';
import { useGameStore } from '../../../game/state';
import type { AnimalId } from '../../../game/types';
import {
  useConquestStore,
  MAX_CONQUEST_PLAYERS,
  DEFAULT_CONQUEST_SUBDIVISIONS,
} from './conquestState';
import './ConquestLobby.css';

const ALL_ANIMALS: AnimalId[] = [
  'Bee', 'Bear', 'Bunny', 'Chicken', 'Cat', 'Dolphin',
  'Fox', 'Frog', 'Owl', 'Pig', 'Turtle', 'Yetti',
];

const ANIMAL_DISPLAY_NAME: Partial<Record<AnimalId, string>> = { Yetti: 'Yeti' };
const REQUIRED_ANIMALS = 3;
const MAX_AI = MAX_CONQUEST_PLAYERS - 1; // one slot is the human player

function animalDisplayName(animal: AnimalId): string {
  return ANIMAL_DISPLAY_NAME[animal] ?? animal;
}

/** A fresh 32-bit seed for the "randomize" button (worldgen itself is seeded). */
function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

export function ConquestLobby() {
  const transitionToScreen = useGameStore((s) => s.transitionToScreen);
  const generate = useConquestStore((s) => s.generate);

  const [seedText, setSeedText] = useState<string>(() => String(randomSeed()));
  const [aiCount, setAiCount] = useState<number>(3);
  const [selectedAnimals, setSelectedAnimals] = useState<AnimalId[]>([]);

  const parsedSeed = Number.parseInt(seedText, 10);
  const seedIsValid = Number.isFinite(parsedSeed);
  const rosterIsComplete = selectedAnimals.length === REQUIRED_ANIMALS;
  const canStart = seedIsValid && rosterIsComplete;

  const toggleAnimal = (animal: AnimalId) => {
    setSelectedAnimals((previous) => {
      if (previous.includes(animal)) return previous.filter((a) => a !== animal);
      if (previous.length >= REQUIRED_ANIMALS) return previous;
      return [...previous, animal];
    });
  };

  const handleStart = () => {
    if (!canStart) return;
    generate({
      seed: parsedSeed >>> 0,
      subdivisions: DEFAULT_CONQUEST_SUBDIVISIONS,
      humanAnimals: selectedAnimals,
      aiCount,
    });
    transitionToScreen('conquest');
  };

  return (
    <div className="conquest-lobby">
      <div className="conquest-lobby-header">
        <button className="conquest-back-button" onClick={() => transitionToScreen('menu')}>
          ← BACK
        </button>
        <h1 className="conquest-lobby-title">Conquest</h1>
        <div className="conquest-player-count">{aiCount + 1}/{MAX_CONQUEST_PLAYERS} Players</div>
      </div>

      <div className="conquest-lobby-body">
        <section className="conquest-config-panel">
          <h2 className="conquest-section-title">World</h2>

          <label className="conquest-field-label" htmlFor="conquest-seed">World Seed</label>
          <div className="conquest-seed-row">
            <input
              id="conquest-seed"
              className="conquest-seed-input"
              type="text"
              inputMode="numeric"
              value={seedText}
              onChange={(event) => setSeedText(event.target.value.replace(/[^0-9]/g, ''))}
            />
            <button
              className="conquest-randomize-button"
              type="button"
              onClick={() => setSeedText(String(randomSeed()))}
            >
              🎲 Randomize
            </button>
          </div>
          {!seedIsValid && <p className="conquest-warning">Enter a numeric seed.</p>}

          <label className="conquest-field-label" htmlFor="conquest-ai">
            AI Opponents: <strong>{aiCount}</strong>
          </label>
          <input
            id="conquest-ai"
            className="conquest-slider"
            type="range"
            min={1}
            max={MAX_AI}
            value={aiCount}
            onChange={(event) => setAiCount(Number(event.target.value))}
          />
          <p className="conquest-hint">
            Up to 12 players spawn on the planet's twelve pentagon nodes.
          </p>
        </section>

        <section className="conquest-config-panel">
          <h2 className="conquest-section-title">
            Your Team <span className="conquest-roster-count">{selectedAnimals.length}/{REQUIRED_ANIMALS}</span>
          </h2>

          <div className="conquest-animal-grid">
            {ALL_ANIMALS.map((animal) => {
              const isSelected = selectedAnimals.includes(animal);
              return (
                <button
                  key={animal}
                  type="button"
                  className={`conquest-animal-chip ${isSelected ? 'selected' : ''}`}
                  onClick={() => toggleAnimal(animal)}
                >
                  {animalDisplayName(animal)}
                </button>
              );
            })}
          </div>
          {!rosterIsComplete && (
            <p className="conquest-hint">
              Pick {REQUIRED_ANIMALS - selectedAnimals.length} more animal
              {REQUIRED_ANIMALS - selectedAnimals.length === 1 ? '' : 's'} to march.
            </p>
          )}
        </section>
      </div>

      <button className="conquest-start-button" disabled={!canStart} onClick={handleStart}>
        {canStart ? 'GENERATE PLANET' : 'CONFIGURE YOUR MATCH'}
      </button>
    </div>
  );
}
