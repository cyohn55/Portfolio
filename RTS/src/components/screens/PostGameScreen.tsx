import { useGameStore } from '../../game/state';
import './PostGameScreen.css';

export function PostGameScreen() {
  const gameOver = useGameStore((s) => s.gameOver);
  const winner = useGameStore((s) => s.winner);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const players = useGameStore((s) => s.players);
  const units = useGameStore((s) => s.units);
  const transitionToScreen = useGameStore((s) => s.transitionToScreen);
  const selectedAnimalPool = useGameStore((s) => s.selectedAnimalPool);
  const initializeGame = useGameStore((s) => s.initializeGame);
  const chooseAnimalsForLocal = useGameStore((s) => s.chooseAnimalsForLocal);
  const startMatch = useGameStore((s) => s.startMatch);

  // Only render when game is actually over AND we have a winner
  if (!gameOver || !winner) return null;

  const winnerPlayer = players.find(p => p.id === winner);
  const isLocalWinner = winner === localPlayerId;

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
