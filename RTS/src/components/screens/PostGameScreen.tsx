import { useState } from 'react';
import { useGameStore } from '../../game/state';
import {
  addLeaderboardEntry,
  computeScore,
  getLeaderboard,
  NAME_MAX_LENGTH,
  validateName,
  type LeaderboardEntry,
} from '../Working/leaderboard';
import './PostGameScreen.css';

export function PostGameScreen() {
  const gameOver = useGameStore((s) => s.gameOver);
  const winner = useGameStore((s) => s.winner);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const players = useGameStore((s) => s.players);
  const units = useGameStore((s) => s.units);
  const matchStats = useGameStore((s) => s.matchStats);
  const transitionToScreen = useGameStore((s) => s.transitionToScreen);
  const selectedAnimalPool = useGameStore((s) => s.selectedAnimalPool);
  const initializeGame = useGameStore((s) => s.initializeGame);
  const chooseAnimalsForLocal = useGameStore((s) => s.chooseAnimalsForLocal);
  const startMatch = useGameStore((s) => s.startMatch);

  // Local UI state for leaderboard submission. Kept inside the component because
  // it has no meaning outside the postgame screen and shouldn't survive a
  // transition back to the menu.
  const [nameInput, setNameInput] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedEntryKey, setSubmittedEntryKey] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>(() => getLeaderboard());

  // The breakdown is a pure function of matchStats. We deliberately recompute
  // it on every render rather than caching by `[matchStats]` reference: the
  // game's tick loop mutates the same matchStats object in place for perf
  // (see state.ts `tick()`), so a ref-keyed useMemo would lock in the zeros
  // from the first render (which happens during gameplay, while this screen
  // is mounted but returning null) and never update once the game ends.
  // computeScore is a handful of multiplies — recomputing on a name keystroke
  // is free.
  const score = computeScore(matchStats);

  // Only render when game is actually over AND we have a winner
  if (!gameOver || !winner) return null;

  const winnerPlayer = players.find(p => p.id === winner);
  const isLocalWinner = winner === localPlayerId;
  const matchResult: 'victory' | 'defeat' = isLocalWinner ? 'victory' : 'defeat';

  // Calculate stats
  const playerUnits = units.filter(u => u.ownerId === localPlayerId);
  const enemyUnits = units.filter(u => u.ownerId !== localPlayerId);

  // Count remaining units by type
  const playerBases = playerUnits.filter(u => u.kind === 'Base').length;
  const playerQueens = playerUnits.filter(u => u.kind === 'Queen').length;
  const playerKings = playerUnits.filter(u => u.kind === 'King').length;
  const playerRegular = playerUnits.filter(u => u.kind === 'Unit').length;

  const enemyBases = enemyUnits.filter(u => u.kind === 'Base').length;
  const enemyQueens = enemyUnits.filter(u => u.kind === 'Queen').length;
  const enemyKings = enemyUnits.filter(u => u.kind === 'King').length;
  const enemyRegular = enemyUnits.filter(u => u.kind === 'Unit').length;

  const handlePlayAgain = () => {
    // Replay with same animals
    initializeGame();
    chooseAnimalsForLocal(selectedAnimalPool);
    startMatch(true);
    transitionToScreen('playing');
  };

  const handleBackToMenu = () => {
    transitionToScreen('menu');
  };

  const handleSubmitScore = (event: React.FormEvent) => {
    event.preventDefault();
    if (submittedEntryKey) return; // already submitted this match

    const validation = validateName(nameInput);
    if (!validation.ok) {
      setSubmitError(validation.reason ?? 'Invalid name.');
      return;
    }

    const entry: LeaderboardEntry = {
      name: nameInput.trim(),
      score: score.total,
      dateMs: Date.now(),
      result: matchResult,
    };
    const next = addLeaderboardEntry(entry);
    setLeaderboard(next);
    setSubmitError(null);
    // Build a stable key that uniquely identifies this submission so we can
    // highlight the player's own row even when other names share the score.
    setSubmittedEntryKey(`${entry.name}|${entry.score}|${entry.dateMs}`);
  };

  const submitDisabled = submittedEntryKey !== null;

  return (
    <div className="postgame-overlay">
      <div className="postgame-container">
        {/* Victory/Defeat Banner */}
        <div className={`postgame-banner ${isLocalWinner ? 'victory' : 'defeat'}`}>
          {isLocalWinner ? (
            <>
              <div className="banner-icon">🏆</div>
              <h1>VICTORY!</h1>
              <p>You have defeated {winnerPlayer?.name === 'You' ? 'the AI' : winnerPlayer?.name}!</p>
            </>
          ) : (
            <>
              <div className="banner-icon">⚔️</div>
              <h1>DEFEAT</h1>
              <p>{winnerPlayer?.name} has won the battle</p>
            </>
          )}
        </div>

        {/* Battle Statistics */}
        <div className="postgame-stats">
          <h2>Battle Summary</h2>

          <div className="stats-grid">
            {/* Player Stats */}
            <div className="stats-column player">
              <h3>Your Forces</h3>
              <div className="stat-row">
                <span className="stat-label">Team:</span>
                <span className="stat-value">{selectedAnimalPool.join(', ')}</span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Bases:</span>
                <span className={`stat-value ${playerBases > 0 ? 'alive' : 'destroyed'}`}>
                  {playerBases}/3
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Queens:</span>
                <span className={`stat-value ${playerQueens > 0 ? 'alive' : 'destroyed'}`}>
                  {playerQueens}/3
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Kings:</span>
                <span className={`stat-value ${playerKings > 0 ? 'alive' : 'destroyed'}`}>
                  {playerKings}/3
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Units:</span>
                <span className="stat-value">{playerRegular}</span>
              </div>
            </div>

            {/* Enemy Stats */}
            <div className="stats-column enemy">
              <h3>Enemy Forces</h3>
              <div className="stat-row">
                <span className="stat-label">Team:</span>
                <span className="stat-value">
                  {players.find(p => p.id !== localPlayerId)?.animals.join(', ')}
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Bases:</span>
                <span className={`stat-value ${enemyBases > 0 ? 'alive' : 'destroyed'}`}>
                  {enemyBases}/3
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Queens:</span>
                <span className={`stat-value ${enemyQueens > 0 ? 'alive' : 'destroyed'}`}>
                  {enemyQueens}/3
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Kings:</span>
                <span className={`stat-value ${enemyKings > 0 ? 'alive' : 'destroyed'}`}>
                  {enemyKings}/3
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Units:</span>
                <span className="stat-value">{enemyRegular}</span>
              </div>
            </div>
          </div>

          {/* Victory Condition Met */}
          <div className="victory-condition">
            <p>
              {isLocalWinner
                ? '✓ All enemy Bases, Queens, and Kings have been eliminated!'
                : '✗ Your Bases, Queens, and Kings have been eliminated'}
            </p>
          </div>
        </div>

        {/* Score Breakdown */}
        <div className="postgame-score">
          <h2>Your Score</h2>
          <div className="score-breakdown">
            <ScoreRow label="Units generated"     count={matchStats.unitsGenerated}      points={score.unitsGeneratedPoints} />
            <ScoreRow label="Enemy units killed"  count={matchStats.enemyUnitsKilled}    points={score.enemyUnitsKilledPoints} />
            <ScoreRow label="Enemy bases destroyed" count={matchStats.enemyBasesDestroyed} points={score.enemyBasesDestroyedPoints} />
            <ScoreRow label="Enemy kings killed"  count={matchStats.enemyKingsKilled}    points={score.enemyKingsKilledPoints} />
            <ScoreRow label="Enemy queens killed" count={matchStats.enemyQueensKilled}   points={score.enemyQueensKilledPoints} />
            <ScoreRow
              label="Bridges held down (per 5s)"
              count={Math.floor(matchStats.rightBridgeDownMs / 5000) + Math.floor(matchStats.leftBridgeDownMs / 5000)}
              points={score.bridgeHeldPoints}
            />
            <div className="score-row score-total">
              <span className="score-label">Total</span>
              <span className="score-points">{score.total}</span>
            </div>
          </div>
        </div>

        {/* Leaderboard (sits directly above PLAY AGAIN / MAIN MENU per design) */}
        <div className="postgame-leaderboard">
          <h2>Leaderboard</h2>

          <form className="leaderboard-form" onSubmit={handleSubmitScore}>
            <label className="leaderboard-form-label" htmlFor="leaderboard-name">
              Add your name (optional):
            </label>
            <div className="leaderboard-form-row">
              <input
                id="leaderboard-name"
                className="leaderboard-input"
                type="text"
                value={nameInput}
                maxLength={NAME_MAX_LENGTH}
                placeholder="Your name"
                disabled={submitDisabled}
                onChange={(e) => {
                  setNameInput(e.target.value);
                  if (submitError) setSubmitError(null);
                }}
              />
              <button
                type="submit"
                className="leaderboard-submit"
                disabled={submitDisabled || nameInput.trim().length === 0}
              >
                {submitDisabled ? 'Submitted' : 'Submit'}
              </button>
            </div>
            {submitError && <p className="leaderboard-error">{submitError}</p>}
          </form>

          <ol className="leaderboard-list">
            {leaderboard.length === 0 ? (
              <li className="leaderboard-empty">No scores yet — be the first!</li>
            ) : (
              leaderboard.map((entry, index) => {
                const key = `${entry.name}|${entry.score}|${entry.dateMs}`;
                const isMine = key === submittedEntryKey;
                return (
                  <li
                    key={key}
                    className={`leaderboard-row${isMine ? ' leaderboard-row-mine' : ''}`}
                  >
                    <span className="leaderboard-rank">#{index + 1}</span>
                    <span className="leaderboard-name">{entry.name}</span>
                    <span className={`leaderboard-result leaderboard-result-${entry.result}`}>
                      {entry.result === 'victory' ? 'W' : 'L'}
                    </span>
                    <span className="leaderboard-score">{entry.score}</span>
                  </li>
                );
              })
            )}
          </ol>
        </div>

        {/* Action Buttons */}
        <div className="postgame-actions">
          <button className="postgame-button primary" onClick={handlePlayAgain}>
            PLAY AGAIN
          </button>
          <button className="postgame-button secondary" onClick={handleBackToMenu}>
            MAIN MENU
          </button>
        </div>
      </div>
    </div>
  );
}

interface ScoreRowProps {
  label: string;
  count: number;
  points: number;
}

/** Single row in the score breakdown table: "Units generated   12 × 5 = 60". */
function ScoreRow({ label, count, points }: ScoreRowProps) {
  return (
    <div className="score-row">
      <span className="score-label">{label}</span>
      <span className="score-count">{count}</span>
      <span className="score-points">{points}</span>
    </div>
  );
}
