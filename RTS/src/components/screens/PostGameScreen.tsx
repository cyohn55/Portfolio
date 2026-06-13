import { useEffect, useState } from 'react';
import { useGameStore } from '../../game/state';
import {
  computeScore,
  getLeaderboard,
  NAME_MAX_LENGTH,
  validateName,
  type LeaderboardEntry,
} from '../Working/leaderboard';
import { fetchLeaderboard, submitScore, type LeaderboardSource } from '../Working/leaderboardRemote';
import { ERUPTION_REVEAL_DELAY_MS } from '../Working/lavaEruptionSim';
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
  const unpauseGame = useGameStore((s) => s.unpauseGame);

  // Local UI state for leaderboard submission. Kept inside the component because
  // it has no meaning outside the postgame screen and shouldn't survive a
  // transition back to the menu.
  const [nameInput, setNameInput] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedEntryKey, setSubmittedEntryKey] = useState<string | null>(null);
  // Seed from the local cache so the table paints immediately, then refresh
  // from the global board. `source` flags when we're showing a cached copy
  // because the backend was unreachable; `submitting` gates the form while a
  // score write is in flight.
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>(() => getLeaderboard());
  const [source, setSource] = useState<LeaderboardSource>('cache');
  const [submitting, setSubmitting] = useState(false);

  // Hold the Winner screen back until the on-map victory eruption has played, so
  // the player sees the lava burst before the overlay covers the field. Resets
  // when the match ends (rematch / menu) so the next win delays again.
  const [eruptionRevealed, setEruptionRevealed] = useState(false);
  useEffect(() => {
    if (!gameOver || !winner) {
      setEruptionRevealed(false);
      return;
    }
    const revealTimer = setTimeout(() => setEruptionRevealed(true), ERUPTION_REVEAL_DELAY_MS);
    return () => clearTimeout(revealTimer);
  }, [gameOver, winner]);

  // Pull the live global board once the match has actually ended. Gated on
  // gameOver/winner because this component is mounted (rendering null) during
  // gameplay, and we don't want a network read until there's a result to show.
  useEffect(() => {
    if (!gameOver || !winner) return;
    let active = true;
    fetchLeaderboard().then((result) => {
      if (!active) return;
      setLeaderboard(result.entries);
      setSource(result.source);
    });
    return () => {
      active = false;
    };
  }, [gameOver, winner]);

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
    // Slot the AI's bridge time into the legacy fields that computeScore
    // already reads, so the same formula applies to both sides.
    rightBridgeDownMs:   matchStats.enemyRightBridgeDownMs,
    leftBridgeDownMs:    matchStats.enemyLeftBridgeDownMs,
    // Re-pass the local-side fields so the shape matches MatchStats; they're
    // unused by computeScore but required by the type.
    aiUnitsGenerated:      matchStats.unitsGenerated,
    playerUnitsKilled:     matchStats.enemyUnitsKilled,
    playerBasesDestroyed:  matchStats.enemyBasesDestroyed,
    playerKingsKilled:     matchStats.enemyKingsKilled,
    playerQueensKilled:    matchStats.enemyQueensKilled,
    enemyRightBridgeDownMs: matchStats.rightBridgeDownMs,
    enemyLeftBridgeDownMs:  matchStats.leftBridgeDownMs,
    matchDurationMs:        matchStats.matchDurationMs,
  });

  // Only render when game is actually over, we have a winner, AND the victory
  // eruption has finished playing (see eruptionRevealed above).
  if (!gameOver || !winner || !eruptionRevealed) return null;

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

  // Per-side bridge-down seconds. Each side accumulates time independently
  // while it holds a King/Queen on the trigger; when both sides are
  // contesting the same bridge, both accrue time. The Forces card shows
  // the side's own contribution, and the corresponding raw ms are fed into
  // computeScore so each Total reflects only that side's effort.
  const playerBridgeSeconds = Math.floor(
    (matchStats.rightBridgeDownMs + matchStats.leftBridgeDownMs) / 1000,
  );
  const enemyBridgeSeconds = Math.floor(
    (matchStats.enemyRightBridgeDownMs + matchStats.enemyLeftBridgeDownMs) / 1000,
  );

  // Wall-clock match duration is shared (both cards show the same value).
  // matchTimeDisplay is a human-readable "M:SS" string; matchTimeMs is the raw
  // value persisted on leaderboard entries for tie-break sorting.
  const matchTimeMs = matchStats.matchDurationMs;
  const matchTimeDisplay = formatMatchTime(matchTimeMs);

  const handlePlayAgain = () => {
    // Replay with the same local animal pool. Capture it before initializeGame()
    // resets state, then re-apply it so startMatch() spawns the same lineup.
    const previousAnimalPool = selectedAnimalPool;
    initializeGame();
    chooseAnimalsForLocal(previousAnimalPool);
    startMatch(true);
    // startMatch() leaves the match paused so the lobby→play flow can gate it
    // behind the InstructionsPopup. On Play Again we never leave the 'playing'
    // screen, so that popup (and the unpauseGame() it would trigger on close)
    // never fires — without this the replayed match stays frozen: no timer,
    // no scoring, no spawns. Unpause directly since the player has already
    // seen the instructions this session.
    unpauseGame();
    transitionToScreen('playing');
  };

  const handleBackToMenu = () => {
    transitionToScreen('menu');
  };

  const handleSubmitScore = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submittedEntryKey || submitting) return; // already submitted / in flight

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
      // Persist the match duration so equal scores break by faster-win-first.
      matchTimeMs,
    };

    setSubmitError(null);
    setSubmitting(true);
    // submitScore never rejects: it writes to the global board and falls back
    // to the local cache if the backend is unreachable, so the entry always
    // lands and the player always gets an updated list.
    const result = await submitScore(entry);
    setLeaderboard(result.entries);
    setSource(result.source);
    setSubmitting(false);
    // Build a stable key that uniquely identifies this submission so we can
    // highlight the player's own row even when other names share the score.
    setSubmittedEntryKey(`${entry.name}|${entry.score}|${entry.dateMs}`);
  };

  const submitDisabled = submittedEntryKey !== null || submitting;

  return (
    <div className="postgame-overlay" data-gamepad-modal>
      <div className="postgame-container">
        {/* Victory/Defeat Banner. Icons flank the text on the left and right
            (vertically centered) rather than stacking above it — keeps the
            banner shorter so more of the Battle Summary is visible without
            scrolling. */}
        <div className={`postgame-banner ${isLocalWinner ? 'victory' : 'defeat'}`}>
          <span className="banner-icon-side" aria-hidden="true">
            {isLocalWinner ? '🏆' : '⚔️'}
          </span>
          <div className="banner-text">
            {isLocalWinner ? (
              <>
                <h1>VICTORY!</h1>
                <p>You have defeated {winnerPlayer?.name === 'You' ? 'the AI' : winnerPlayer?.name}!</p>
              </>
            ) : (
              <>
                <h1>DEFEAT</h1>
                <p>{winnerPlayer?.name} has won the battle</p>
              </>
            )}
          </div>
          <span className="banner-icon-side" aria-hidden="true">
            {isLocalWinner ? '🏆' : '⚔️'}
          </span>
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
              bridgeSeconds={playerBridgeSeconds}
              matchTimeDisplay={matchTimeDisplay}
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
              bridgeSeconds={enemyBridgeSeconds}
              matchTimeDisplay={matchTimeDisplay}
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
                {submitting ? 'Submitting…' : submittedEntryKey ? 'Submitted' : 'Submit'}
              </button>
            </div>
            {submitError && <p className="leaderboard-error">{submitError}</p>}
            {/* Honest signal: the score saved locally but the global board was
                unreachable. Only shown once a submission has completed. */}
            {submittedEntryKey && source === 'cache' && (
              <p className="leaderboard-error">
                Saved locally — couldn’t reach the global leaderboard. It’ll sync next time you’re online.
              </p>
            )}
          </form>

          <ol className="leaderboard-list">
            {/* Column header. Sits inside the same scroll container as the
                rows so it shares column widths exactly; styled as a header
                row via leaderboard-row-header (no border-bottom, dimmer
                text, won't be highlighted as the player's own row). */}
            <li className="leaderboard-row leaderboard-row-header" aria-hidden="true">
              <span className="leaderboard-rank">#</span>
              <span className="leaderboard-name">Name</span>
              <span className="leaderboard-result">W/L</span>
              <span className="leaderboard-score">Score</span>
              <span className="leaderboard-time">Time</span>
            </li>
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
                    <span className="leaderboard-time">{formatMatchTime(entry.matchTimeMs)}</span>
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
          <button className="postgame-button secondary" data-gamepad-back onClick={handleBackToMenu}>
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
  // on a comparable totals strip. `bridgeSeconds` is this side's bridge-down
  // time (see PostGameScreen for the per-side accounting); `matchTimeDisplay`
  // is the wall-clock match length, identical for both cards; `total` is
  // the score computed with this side's counters via computeScore.
  bridgeSeconds: number;
  matchTimeDisplay: string;
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
    bridgeSeconds, matchTimeDisplay, total,
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
        <span className="stat-label">Units Generated:</span>
        <span className="stat-value">{unitsGenerated}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Units Eliminated:</span>
        <span className="stat-value">{unitsKilled}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Bases Destroyed:</span>
        <span className="stat-value">{basesDestroyed}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Kings Eliminated:</span>
        <span className="stat-value">{kingsKilled}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Queens Eliminated:</span>
        <span className="stat-value">{queensKilled}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Bridge Capture Time:</span>
        <span className="stat-value">{bridgeSeconds}s</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Match Time:</span>
        <span className="stat-value">{matchTimeDisplay}</span>
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

/**
 * Format a millisecond duration as M:SS (or H:MM:SS once a match runs past an
 * hour — defensive, but the RTS isn't designed for hour-long matches). Pads
 * the seconds field so "1:05" doesn't show as "1:5". Returns "—" when no
 * value is present so legacy leaderboard entries persisted before match
 * time existed still render a stable, non-empty cell.
 */
function formatMatchTime(matchTimeMs: number | undefined): string {
  if (matchTimeMs === undefined || !Number.isFinite(matchTimeMs) || matchTimeMs < 0) {
    return '—';
  }
  const totalSeconds = Math.floor(matchTimeMs / 1000);
  const hours   = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = seconds.toString().padStart(2, '0');
  if (hours > 0) {
    const mm = minutes.toString().padStart(2, '0');
    return `${hours}:${mm}:${ss}`;
  }
  return `${minutes}:${ss}`;
}
