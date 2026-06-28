// Pre-match setup for the Conquest game mode.
//
// Single responsibility: collect the match configuration (seed, AI opponent
// count, and the single animal the human's army is made of), then generate the
// world and route into the Conquest screen. In Conquest a player commands one
// animal — additional armies are won by conquest, not chosen here — so the lobby
// picks exactly one of the shared RTS animals.

import { useState } from 'react';
import { useUiStore } from '../../../game/uiStore';
import type { AnimalId } from '../../../game/types';
import {
  useConquestStore,
  MAX_CONQUEST_PLAYERS,
} from './conquestState';
import type { WorldArchetype } from './conquestBiomes';
import './ConquestLobby.css';

const ALL_ANIMALS: AnimalId[] = [
  'Bee', 'Bear', 'Bunny', 'Chicken', 'Cat', 'Dolphin',
  'Fox', 'Frog', 'Owl', 'Pig', 'Turtle', 'Yetti',
];

const ANIMAL_DISPLAY_NAME: Partial<Record<AnimalId, string>> = { Yetti: 'Yeti' };
const MAX_AI = MAX_CONQUEST_PLAYERS - 1; // one slot is the human player

function animalDisplayName(animal: AnimalId): string {
  return ANIMAL_DISPLAY_NAME[animal] ?? animal;
}

/** Map-size choices → Goldberg subdivision level (tiles = 10·4^level + 2). */
interface MapSizeOption {
  label: string;
  subdivisions: number;
}
const MAP_SIZES: MapSizeOption[] = [
  { label: 'Small', subdivisions: 2 },
  { label: 'Medium', subdivisions: 3 },
  { label: 'Large', subdivisions: 4 },
];

/**
 * World-type choices. `archetype: null` is the balanced, fully seed-derived world;
 * the named archetypes bias the seed roll toward a recognizable flavor.
 */
interface WorldTypeOption {
  label: string;
  archetype: WorldArchetype | null;
}
const WORLD_TYPES: WorldTypeOption[] = [
  { label: 'Balanced', archetype: null },
  { label: 'Continents', archetype: 'continents' },
  { label: 'Islands', archetype: 'islands' },
  { label: 'Pangaea', archetype: 'pangaea' },
  { label: 'Frozen', archetype: 'frozen' },
  { label: 'Arid', archetype: 'arid' },
];

/** A fresh 32-bit seed for the "randomize" button (worldgen itself is seeded). */
function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

export function ConquestLobby() {
  const transitionToScreen = useUiStore((s) => s.transitionToScreen);
  const generate = useConquestStore((s) => s.generate);

  const [seedText, setSeedText] = useState<string>(() => String(randomSeed()));
  const [aiCount, setAiCount] = useState<number>(3);
  const [selectedAnimal, setSelectedAnimal] = useState<AnimalId | null>(null);
  const [subdivisions, setSubdivisions] = useState<number>(MAP_SIZES[1].subdivisions);
  const [archetype, setArchetype] = useState<WorldArchetype | null>(null);

  const parsedSeed = Number.parseInt(seedText, 10);
  const seedIsValid = Number.isFinite(parsedSeed);
  const rosterIsComplete = selectedAnimal !== null;
  const canStart = seedIsValid && rosterIsComplete;

  const handleStart = () => {
    if (!canStart || selectedAnimal === null) return;
    generate({
      seed: parsedSeed >>> 0,
      subdivisions,
      humanAnimal: selectedAnimal,
      aiCount,
      archetype: archetype ?? undefined,
    });
    transitionToScreen('conquest');
  };

  return (
    <div className="conquest-lobby">
      <div className="conquest-lobby-header">
        <button className="conquest-back-button" data-gamepad-back onClick={() => transitionToScreen('menu')}>
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

          <label className="conquest-field-label">Map Size</label>
          <div className="conquest-animal-grid">
            {MAP_SIZES.map((option) => (
              <button
                key={option.label}
                type="button"
                className={`conquest-animal-chip ${subdivisions === option.subdivisions ? 'selected' : ''}`}
                onClick={() => setSubdivisions(option.subdivisions)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <label className="conquest-field-label">World Type</label>
          <div className="conquest-animal-grid">
            {WORLD_TYPES.map((option) => (
              <button
                key={option.label}
                type="button"
                className={`conquest-animal-chip ${archetype === option.archetype ? 'selected' : ''}`}
                onClick={() => setArchetype(option.archetype)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>

        <section className="conquest-config-panel">
          <h2 className="conquest-section-title">
            Your Army <span className="conquest-roster-count">{selectedAnimal ? animalDisplayName(selectedAnimal) : '—'}</span>
          </h2>

          <div className="conquest-animal-grid">
            {ALL_ANIMALS.map((animal) => {
              const isSelected = selectedAnimal === animal;
              return (
                <button
                  key={animal}
                  type="button"
                  className={`conquest-animal-chip ${isSelected ? 'selected' : ''}`}
                  onClick={() => setSelectedAnimal(animal)}
                >
                  {animalDisplayName(animal)}
                </button>
              );
            })}
          </div>
          {!rosterIsComplete ? (
            <p className="conquest-hint">
              Pick the one animal your army marches as. Defeat a rival army and its
              king or queen — and all its units — join your command.
            </p>
          ) : (
            <p className="conquest-hint">
              Capture rival monarchs to grow your command across the planet.
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
