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

  // The AI's "score" reuses the same scoring formula, fed the mirror counters
  // recorded for the AI side. This keeps a single source of truth for point
  // values (SCORE_POINTS in leaderboard.ts) instead of duplicating the math.
  // Bridge time is shared map state, so both sides receive the same bridge
  // contribution. Only the local player's score feeds the leaderboard
  // submission — this is purely for the side-by-side comparison.
  const aiScore = computeScore({
    unitsGenerated:      matchStats.aiUnitsGenerated,
    enemyUnitsKilled:    matchStats.playerUnitsKilled,
    enemyBasesDestroyed: matchStats.playerBasesDestroyed,
    enemyKingsKilled:    matchStats.playerKingsKilled,
    enemyQueensKilled:   matchStats.playerQueensKilled,
    rightBridgeDownMs:   matchStats.rightBridgeDownMs,
    leftBridgeDownMs:    matchStats.leftBridgeDownMs,
    // Re-pass the local-side fields so the shape matches MatchStats; they're
    // unused by computeScore but required by the type.
    aiUnitsGenerated:     matchStats.unitsGenerated,
    playerUnitsKilled:    matchStats.enemyUnitsKilled,
    playerBasesDestroyed: matchStats.enemyBasesDestroyed,
    playerKingsKilled:    matchStats.enemyKingsKilled,
    playerQueensKilled:   matchStats.enemyQueensKilled,
  });

  // Only render when game is actually over AND we have a winner
  if (!gameOver || !winner) return null;

  const winnerPlayer = players.find(p => p.id === winner);
  const isLocalWinner = winner === localPlayerId;
  const matchResult: 'victory' | 'defeat' = isLocalWinner ? 'victory' : 'defeat';

  // Calculate stats
  const playerUnits = units.filter(u => u.ownerId === localPlayerId);
  const enemyUnits = units.filter(u => u.ownerId !== localPlayerId);

  // Count remaining units by type. Used for the "X/3" survival rows in each
  // Forces card.
  const playerBases = playerUnits.filter(u => u.kind === 'Base').length;
  const playerQueens = playerUnits.filter(u => u.kind === 'Queen').length;
  const playerKings = playerUnits.filter(u => u.kind === 'King').length;

  const enemyBases = enemyUnits.filter(u => u.kind === 'Base').length;
  const enemyQueens = enemyUnits.filter(u => u.kind === 'Queen').length;
  const enemyKings = enemyUnits.filter(u => u.kind === 'King').length;

  // Total bridge-down seconds (shared map state — not per-side). Displayed in
  // its own row below the cards because it doesn't attribute to either team.
  const bridgeDownSeconds = Math.floor(
    (matchStats.rightBridgeDownMs + matchStats.leftBridgeDownMs) / 1000,
  );

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

        {/* Battle Statistics — symmetric per-side cards so the player can
            directly compare what they accomplished vs the AI. Both cards
            render the same row shape via ForcesCard, including the final
            Total computed via computeScore so the comparison ends on a
            single headline number per side. */}
        <div className="postgame-stats">
          <h2>Battle Summary</h2>

          <div className="stats-grid">
            <ForcesCard
              variant="player"
              heading="Your Forces"
              team={selectedAnimalPool.join(', ')}
              basesRemaining={playerBases}
              queensRemaining={playerQueens}
              kingsRemaining={playerKings}
              unitsGenerated={matchStats.unitsGenerated}
              unitsKilled={matchStats.enemyUnitsKilled}
              basesDestroyed={matchStats.enemyBasesDestroyed}
              kingsKilled={matchStats.enemyKingsKilled}
              queensKilled={matchStats.enemyQueensKilled}
              bridgeSeconds={bridgeDownSeconds}
              total={score.total}
            />
            <ForcesCard
              variant="enemy"
              heading="Enemy Forces"
              team={players.find(p => p.id !== localPlayerId)?.animals.join(', ') ?? ''}
              basesRemaining={enemyBases}
              queensRemaining={enemyQueens}
              kingsRemaining={enemyKings}
              unitsGenerated={matchStats.aiUnitsGenerated}
              unitsKilled={matchStats.playerUnitsKilled}
              basesDestroyed={matchStats.playerBasesDestroyed}
              kingsKilled={matchStats.playerKingsKilled}
              queensKilled={matchStats.playerQueensKilled}
              bridgeSeconds={bridgeDownSeconds}
              total={aiScore.total}
            />
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

interface ForcesCardProps {
  variant: 'player' | 'enemy';
  heading: string;
  team: string;
  basesRemaining: number;
  queensRemaining: number;
  kingsRemaining: number;
  unitsGenerated: number;
  // Counts of the *other* side's assets this side took out. Labels are kept
  // ambiguous on purpose ("Units killed", "Bases destroyed") so the same
  // component renders correctly under either heading — context comes from the
  // surrounding card title.
  unitsKilled: number;
  basesDestroyed: number;
  kingsKilled: number;
  queensKilled: number;
  // Shared/derived stats shown at the bottom of each card so both sides end
  // on a comparable totals strip. `bridgeSeconds` is shared map state (the
  // same value for both cards); `total` is the score computed with this
  // side's counters via computeScore.
  bridgeSeconds: number;
  total: number;
}

/**
 * One side of the Battle Summary. Renders the same row shape for both player
 * and AI so the two cards are visually comparable; the only variant-specific
 * styling is the accent border color, applied via `variant` on the outer
 * stats-column class.
 *
 * The Team row uses a stacked label/value layout (`stat-row-stacked`) so the
 * full animal list ("Bear, Bunny, Frog") can wrap to a second line instead of
 * getting ellipsis-truncated to "Be..." like it did when it shared the
 * inline-row layout with the short numeric stats.
 */
function ForcesCard(props: ForcesCardProps) {
  const {
    variant, heading, team,
    basesRemaining, queensRemaining, kingsRemaining,
    unitsGenerated, unitsKilled, basesDestroyed, kingsKilled, queensKilled,
    bridgeSeconds, total,
  } = props;
  return (
    <div className={`stats-column ${variant}`}>
      <h3>{heading}</h3>
      <div className="stat-row stat-row-stacked">
        <span className="stat-label">Team:</span>
        <span className="stat-value stat-value-team">{team}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Bases:</span>
        <span className={`stat-value ${basesRemaining > 0 ? 'alive' : 'destroyed'}`}>
          {basesRemaining}/3
        </span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Queens:</span>
        <span className={`stat-value ${queensRemaining > 0 ? 'alive' : 'destroyed'}`}>
          {queensRemaining}/3
        </span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Kings:</span>
        <span className={`stat-value ${kingsRemaining > 0 ? 'alive' : 'destroyed'}`}>
          {kingsRemaining}/3
        </span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Units:</span>
        <span className="stat-value">{unitsGenerated}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Units killed:</span>
        <span className="stat-value">{unitsKilled}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Bases destroyed:</span>
        <span className="stat-value">{basesDestroyed}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Kings killed:</span>
        <span className="stat-value">{kingsKilled}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Queens killed:</span>
        <span className="stat-value">{queensKilled}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Bridges held down:</span>
        <span className="stat-value">{bridgeSeconds}s</span>
      </div>
      {/* Final Total row — visually weighted (separator above, gold accent)
          so it reads as the headline number, not just another stat. */}
      <div className="stat-row stat-row-total">
        <span className="stat-label">Total</span>
        <span className="stat-value stat-value-total">{total}</span>
      </div>
    </div>
  );
}
