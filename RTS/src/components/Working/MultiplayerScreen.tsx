import { useState } from 'react';
import type { AnimalId } from '../../game/types';
import { useGameStore } from '../../game/state';
import { useMultiplayerSession } from './net/multiplayerSession';
import './MultiplayerScreen.css';

// The selectable roster, mirroring AnimalSelectionLobby's list so both screens
// offer the same animals. Kept local rather than imported to avoid coupling the
// multiplayer screen to the single-player lobby's internals.
const ALL_ANIMALS: AnimalId[] = [
  'Bee', 'Bear', 'Bunny', 'Chicken', 'Cat', 'Dolphin',
  'Fox', 'Frog', 'Owl', 'Pig', 'Turtle', 'Yetti',
];

const ANIMAL_DISPLAY_NAME: Partial<Record<AnimalId, string>> = { Yetti: 'Yeti' };
const displayName = (animal: AnimalId): string => ANIMAL_DISPLAY_NAME[animal] ?? animal;

const MAX_PICKS = 3;

/**
 * The multiplayer flow: matchmaking (host a room / join by code) followed by a
 * shared ready-up lobby where both players pick three animals and ready up. All
 * state lives in useMultiplayerSession; this component only renders it and calls
 * its actions. The actual match runs on the 'playing' screen once both ready.
 */
export function MultiplayerScreen() {
  const transitionToScreen = useGameStore((s) => s.transitionToScreen);
  const phase = useMultiplayerSession((s) => s.phase);
  const roomCode = useMultiplayerSession((s) => s.roomCode);
  const error = useMultiplayerSession((s) => s.error);
  const localAnimals = useMultiplayerSession((s) => s.localAnimals);
  const localReady = useMultiplayerSession((s) => s.localReady);
  const remoteAnimals = useMultiplayerSession((s) => s.remoteAnimals);
  const remoteReady = useMultiplayerSession((s) => s.remoteReady);
  const isQuickMatch = useMultiplayerSession((s) => s.isQuickMatch);
  const hostRoom = useMultiplayerSession((s) => s.hostRoom);
  const joinByCode = useMultiplayerSession((s) => s.joinByCode);
  const startQuickMatch = useMultiplayerSession((s) => s.startQuickMatch);
  const setLocalAnimals = useMultiplayerSession((s) => s.setLocalAnimals);
  const setReady = useMultiplayerSession((s) => s.setReady);
  const leave = useMultiplayerSession((s) => s.leave);

  const [joinCode, setJoinCode] = useState('');

  const backToMenu = () => {
    leave();
    transitionToScreen('menu');
  };

  const toggleAnimal = (animal: AnimalId) => {
    if (localReady) return; // locked in once ready
    const next = localAnimals.includes(animal)
      ? localAnimals.filter((a) => a !== animal)
      : localAnimals.length < MAX_PICKS
        ? [...localAnimals, animal]
        : localAnimals;
    setLocalAnimals(next);
  };

  // --- matchmaking (idle / error) ---
  if (phase === 'idle' || phase === 'error') {
    return (
      <div className="mp-screen">
        <div className="mp-panel">
          <h1 className="mp-title">Multiplayer</h1>
          <p className="mp-subtitle">Play a 1v1 battle against another commander.</p>

          {error && <div className="mp-error">{error}</div>}

          <button className="mp-button primary" onClick={startQuickMatch}>
            QUICK MATCH
          </button>

          <div className="mp-divider"><span>or play a friend</span></div>

          <button className="mp-button" onClick={hostRoom}>
            CREATE ROOM
          </button>

          <div className="mp-divider"><span>or</span></div>

          <div className="mp-join-row">
            <input
              className="mp-code-input"
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={6}
              placeholder="ENTER CODE"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && joinCode.trim()) joinByCode(joinCode.trim());
              }}
            />
            <button
              className="mp-button"
              disabled={!joinCode.trim()}
              onClick={() => joinByCode(joinCode.trim())}
            >
              JOIN
            </button>
          </div>

          <button className="mp-back" onClick={backToMenu}>← Back</button>
        </div>
      </div>
    );
  }

  // --- connecting (waiting for the peer) ---
  if (phase === 'connecting') {
    return (
      <div className="mp-screen">
        <div className="mp-panel">
          <h1 className="mp-title">
            {isQuickMatch ? 'Quick Match' : roomCode ? 'Room Created' : 'Joining…'}
          </h1>
          {isQuickMatch ? (
            <p className="mp-waiting">Searching for an opponent…</p>
          ) : roomCode ? (
            <>
              <p className="mp-subtitle">Share this code with your opponent:</p>
              <div className="mp-room-code">{roomCode}</div>
              <p className="mp-waiting">Waiting for an opponent to join…</p>
            </>
          ) : (
            <p className="mp-waiting">Connecting to the room…</p>
          )}
          <div className="mp-spinner" aria-hidden="true" />
          <button className="mp-back" onClick={backToMenu}>Cancel</button>
        </div>
      </div>
    );
  }

  // --- shared ready-up lobby (lobby / starting) ---
  const canReady = localAnimals.length === MAX_PICKS;
  return (
    <div className="mp-screen">
      <div className="mp-lobby">
        <h1 className="mp-title">Battle Lobby</h1>
        <p className="mp-subtitle">
          Pick {MAX_PICKS} animals, then ready up. The match begins when both players are ready.
        </p>

        <div className="mp-players">
          <PlayerCard
            label="You"
            animals={localAnimals}
            ready={localReady}
            highlight
          />
          <span className="mp-vs">VS</span>
          <PlayerCard
            label="Opponent"
            animals={remoteAnimals}
            ready={remoteReady}
            placeholder={remoteAnimals.length === 0 ? 'Choosing…' : undefined}
          />
        </div>

        <div className="mp-roster">
          {ALL_ANIMALS.map((animal) => {
            const selected = localAnimals.includes(animal);
            return (
              <button
                key={animal}
                className={`mp-animal ${selected ? 'selected' : ''}`}
                disabled={localReady || (!selected && localAnimals.length >= MAX_PICKS)}
                onClick={() => toggleAnimal(animal)}
              >
                {displayName(animal)}
              </button>
            );
          })}
        </div>

        <div className="mp-lobby-actions">
          <button
            className={`mp-button primary ${localReady ? 'ready' : ''}`}
            disabled={!canReady || phase === 'starting'}
            onClick={() => setReady(!localReady)}
          >
            {phase === 'starting'
              ? 'STARTING…'
              : localReady
                ? 'READY ✓ (tap to unready)'
                : canReady
                  ? 'READY UP'
                  : `PICK ${MAX_PICKS - localAnimals.length} MORE`}
          </button>
          <button className="mp-back" onClick={backToMenu}>Leave</button>
        </div>
      </div>
    </div>
  );
}

/** A compact summary of one player's lineup + ready state in the lobby. */
function PlayerCard(props: {
  label: string;
  animals: AnimalId[];
  ready: boolean;
  highlight?: boolean;
  placeholder?: string;
}) {
  return (
    <div className={`mp-player-card ${props.highlight ? 'me' : ''} ${props.ready ? 'is-ready' : ''}`}>
      <div className="mp-player-label">{props.label}</div>
      <div className="mp-player-animals">
        {props.placeholder
          ? <span className="mp-player-placeholder">{props.placeholder}</span>
          : props.animals.length === 0
            ? <span className="mp-player-placeholder">No picks yet</span>
            : props.animals.map((a) => (
                <span key={a} className="mp-player-chip">{displayName(a)}</span>
              ))}
      </div>
      <div className={`mp-player-status ${props.ready ? 'ready' : ''}`}>
        {props.ready ? 'READY' : 'Not ready'}
      </div>
    </div>
  );
}
