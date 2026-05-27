import { useMemo } from 'react';
import { useGameStore } from '../../game/state';
import { getLeaderboard, type LeaderboardEntry } from './leaderboard';
// Reuse the existing leaderboard list/row styling from the post-game screen.
// CSS classes in this project are loaded globally (Vite concatenates), so
// importing the stylesheet anywhere is enough to make .leaderboard-row,
// .leaderboard-list, etc. available — see the rts-css-class-collision-trap
// memory for why we're explicit about that.
import '../screens/PostGameScreen.css';
import './LeaderboardScreen.css';

/**
 * Standalone leaderboard view reachable from the title screen. Mirrors the
 * post-game leaderboard list but drops the score-submission form (there's no
 * match in flight to submit) and adds a BACK button that returns to the main
 * menu.
 *
 * The leaderboard data itself is pulled from the same persisted source the
 * post-game screen uses (getLeaderboard in ./leaderboard), so a single
 * top-10 list is shared between both entry points.
 */
export function LeaderboardScreen() {
  const transitionToScreen = useGameStore((s) => s.transitionToScreen);

  // Read once per mount — the list only changes via addLeaderboardEntry in
  // the post-game flow, and that flow can only fire after this screen
  // unmounts (transition → playing → postgame). Recomputing on every render
  // would just thrash localStorage for no reader benefit.
  const leaderboard = useMemo<LeaderboardEntry[]>(() => getLeaderboard(), []);

  const handleBack = () => {
    transitionToScreen('menu');
  };

  return (
    <div className="leaderboard-screen">
      <div className="leaderboard-screen-content">
        <h1 className="leaderboard-screen-title">Leaderboard</h1>

        <ol className="leaderboard-list leaderboard-screen-list">
          {/* Column header row — same shape as the data rows so columns line
              up. Marked aria-hidden because screen readers can announce the
              data rows directly. */}
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
              return (
                <li key={key} className="leaderboard-row">
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

        <div className="leaderboard-screen-actions">
          <button className="menu-button primary" onClick={handleBack}>
            BACK
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Format a millisecond duration as M:SS (or H:MM:SS for the defensive case
 * of an hour-long match). Mirrors the helper in PostGameScreen so the Time
 * column renders identically across both views.
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
