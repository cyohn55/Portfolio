import { useGameStore } from './src/game/state';

const store = useGameStore;

const Q = {
  id: 'Q', ownerId: 'P1', animal: 'Bear', kind: 'Queen',
  position: { x: 100, y: 0.25, z: 100 },
  hp: 200, maxHp: 200, attackDamage: 10, moveSpeed: 18,
  attackRange: 4, attackCooldownMs: 1000, lastAttackAtMs: 0, rotation: 0,
} as any;
const pBase = {
  id: 'PB', ownerId: 'P1', animal: 'Bear', kind: 'Base',
  position: { x: 130, y: 0, z: 130 }, hp: 10000, maxHp: 10000,
  attackDamage: 0, moveSpeed: 0, attackRange: 4, attackCooldownMs: 1000, lastAttackAtMs: 0, rotation: 0,
} as any;
const eBase = {
  id: 'EB', ownerId: 'P2', animal: 'Bear', kind: 'Base',
  position: { x: -130, y: 0, z: -130 }, hp: 10000, maxHp: 10000,
  attackDamage: 0, moveSpeed: 0, attackRange: 4, attackCooldownMs: 1000, lastAttackAtMs: 0, rotation: 0,
} as any;

store.setState({
  players: [
    { id: 'P1', name: 'P1', isAI: false, animals: ['Bear', 'Bunny', 'Cat'], basePositions: [] },
    { id: 'P2', name: 'P2', isAI: true, animals: ['Bear', 'Bunny', 'Cat'], basePositions: [] },
  ] as any,
  localPlayerId: 'P1',
  matchStarted: true,
  isPaused: false,
  gameOver: false,
  winner: null,
  units: [Q, pBase, eBase],
  unitOrders: {},
  queenPatrols: {},
  selectedUnitIds: ['Q'],
  deadUnitsToRemove: [],
  targetCache: {},
  aiThinkingOffset: {},
  spatialGrid: null,
} as any);

const start = { x: 100, y: 0.25, z: 100 };
const end = { x: 140, y: 0, z: 100 };

store.getState().setPatrol({ queenId: 'Q', startPosition: start, endPosition: end });

const afterSet = store.getState();
console.log('patrol set?', JSON.stringify(afterSet.queenPatrols['Q']));
console.log('order after setPatrol?', JSON.stringify(afterSet.unitOrders['Q']));

let now = 1_000_000;
const dt = 1000 / 60;
const q0 = store.getState().units.find((u: any) => u.id === 'Q');
console.log('queen start pos', JSON.stringify(q0.position));

// --- Movement hold (secondary-button patrol-draw) check ---------------------
store.getState().setMovementHold('Q');
const heldStartPos = { ...store.getState().units.find((u: any) => u.id === 'Q').position };
for (let i = 0; i < 60; i++) {
  now += dt;
  store.getState().tick(dt / 1000, now);
}
const heldEndPos = store.getState().units.find((u: any) => u.id === 'Q').position;
const heldDrift = Math.hypot(heldEndPos.x - heldStartPos.x, heldEndPos.z - heldStartPos.z);
console.log(`HOLD: queen drift over 60 frozen ticks = ${heldDrift.toFixed(4)} (expect ~0)`);
store.getState().setMovementHold(null);

let prevTarget = store.getState().queenPatrols['Q'].currentTarget;
let flips = 0;
for (let i = 0; i < 600; i++) {
  now += dt;
  store.getState().tick(dt / 1000, now);
  const patrol = store.getState().queenPatrols['Q'];
  if (patrol.currentTarget !== prevTarget) {
    const q = store.getState().units.find((u: any) => u.id === 'Q');
    flips++;
    console.log(`tick ${i + 1}: TURNAROUND #${flips} now heading to '${patrol.currentTarget}' at pos=${JSON.stringify(q?.position)}`);
    prevTarget = patrol.currentTarget;
  }
}
console.log(`total turnarounds over 600 ticks: ${flips} (expect >=2 => back-and-forth)`);

// --- Move order cancels the patrol -----------------------------------------
const moveDest = { x: 120, y: 0, z: 120 };
store.getState().moveCommand({ unitIds: ['Q'], target: moveDest });
console.log(`after moveCommand: patrol = ${JSON.stringify(store.getState().queenPatrols['Q'])} (expect undefined)`);
for (let i = 0; i < 300; i++) {
  now += dt;
  store.getState().tick(dt / 1000, now);
}
const qAfterMove = store.getState().units.find((u: any) => u.id === 'Q').position;
const restDrift = (() => {
  // Run another 120 ticks and measure movement — should be ~0 (parked at dest, no patrol).
  const before = { ...qAfterMove };
  for (let i = 0; i < 120; i++) { now += dt; store.getState().tick(dt / 1000, now); }
  const after = store.getState().units.find((u: any) => u.id === 'Q').position;
  return Math.hypot(after.x - before.x, after.z - before.z);
})();
const distToDest = Math.hypot(qAfterMove.x - moveDest.x, qAfterMove.z - moveDest.z);
console.log(`after move+park: at dest? distToDest=${distToDest.toFixed(2)} (expect ~0), idle drift=${restDrift.toFixed(4)} (expect ~0 => no patrol resume)`);

// --- Patrol drawn on a PILOTED queen (A -> G case) --------------------------
// Reproduces the reported bug: selecting a King (A) then toggling to the Queen
// (G) leaves the Queen as the piloted unit. Drawing a patrol must stop piloting
// her, otherwise the pilot tick block holds her in place and she never walks the
// route until a separate move order releases piloting. setPatrol now releases it.
const pilotedQueenPos = store.getState().units.find((u: any) => u.id === 'Q').position;
store.setState({ pilotedUnitId: 'Q' } as any);
const patrolStart = { ...pilotedQueenPos };
const patrolEnd = { x: pilotedQueenPos.x + 40, y: 0, z: pilotedQueenPos.z };
store.getState().setPatrol({ queenId: 'Q', startPosition: patrolStart, endPosition: patrolEnd });
console.log(`after setPatrol on piloted queen: pilotedUnitId = ${JSON.stringify(store.getState().pilotedUnitId)} (expect null => piloting released)`);

const beforePilotPatrol = { ...store.getState().units.find((u: any) => u.id === 'Q').position };
for (let i = 0; i < 120; i++) {
  now += dt;
  store.getState().tick(dt / 1000, now);
}
const afterPilotPatrol = store.getState().units.find((u: any) => u.id === 'Q').position;
const pilotPatrolDrift = Math.hypot(afterPilotPatrol.x - beforePilotPatrol.x, afterPilotPatrol.z - beforePilotPatrol.z);
console.log(`piloted-queen patrol: drift over 120 ticks = ${pilotPatrolDrift.toFixed(2)} (expect > 0 => she walks the route without a move order first)`);
