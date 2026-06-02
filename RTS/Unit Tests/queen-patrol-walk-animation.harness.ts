/**
 * Regression harness: a patrolling Queen must drive her per-animal walk cycle,
 * not slide on a single frozen pose.
 *
 * Background: the renderer (`UnitsLayer.variantKeyForUnit`) picks a hopping
 * Frog/Bunny's frame from `unit.hopPhase`, and `verticalOffset` only applies the
 * hop bob while `unit.isHopping` is true. The normal move-order mover and the
 * monarch-piloting mover both advance those flags every moving tick. The Queen
 * patrol branch in `tick()` originally advanced only the Owl's wing phase, so a
 * Frog/Bunny Queen on patrol kept `hopPhase` frozen and `isHopping` false — the
 * renderer held Frog_F0 and she appeared to slide across the ground.
 *
 * This asserts the live tick output (no hard-coded expectations about exact
 * positions): over a patrol leg the Queen's `hopPhase` must take on multiple
 * distinct values and `isHopping` must become true at least once.
 *
 * Run: `npx vite-node "Unit Tests/queen-patrol-walk-animation.harness.ts"`
 */
import { useGameStore } from '../src/game/state';

const store = useGameStore;

const PATROL_START = { x: 100, y: 0.25, z: 100 };
const PATROL_END = { x: 140, y: 0, z: 100 };
const FRAME_DT_MS = 1000 / 60;
const LEG_TICKS = 120; // long enough to cover several hops without reaching the far end

function makeQueen(animal: string) {
  return {
    id: 'Q', ownerId: 'P1', animal, kind: 'Queen',
    position: { ...PATROL_START },
    hp: 200, maxHp: 200, attackDamage: 10, moveSpeed: 18,
    attackRange: 4, attackCooldownMs: 1000, lastAttackAtMs: 0, rotation: 0,
  } as any;
}

const friendlyBase = {
  id: 'PB', ownerId: 'P1', animal: 'Bear', kind: 'Base',
  position: { x: 130, y: 0, z: 130 }, hp: 10000, maxHp: 10000,
  attackDamage: 0, moveSpeed: 0, attackRange: 4, attackCooldownMs: 1000, lastAttackAtMs: 0, rotation: 0,
} as any;
const enemyBase = {
  id: 'EB', ownerId: 'P2', animal: 'Bear', kind: 'Base',
  position: { x: -130, y: 0, z: -130 }, hp: 10000, maxHp: 10000,
  attackDamage: 0, moveSpeed: 0, attackRange: 4, attackCooldownMs: 1000, lastAttackAtMs: 0, rotation: 0,
} as any;

function runPatrolLeg(animal: string) {
  store.setState({
    players: [
      { id: 'P1', name: 'P1', isAI: false, animals: [animal as any, 'Cat', 'Bear'], basePositions: [] },
      { id: 'P2', name: 'P2', isAI: true, animals: ['Bear', 'Cat', 'Bunny'], basePositions: [] },
    ] as any,
    localPlayerId: 'P1', matchStarted: true, isPaused: false, gameOver: false, winner: null,
    units: [makeQueen(animal), friendlyBase, enemyBase],
    unitOrders: {}, queenPatrols: {}, selectedUnitIds: ['Q'],
    deadUnitsToRemove: [], targetCache: {}, aiThinkingOffset: {}, spatialGrid: null,
  } as any);

  store.getState().setPatrol({ queenId: 'Q', startPosition: PATROL_START, endPosition: PATROL_END });

  const hopPhases = new Set<string>();
  let everHopping = false;
  let now = 1_000_000;
  for (let tick = 0; tick < LEG_TICKS; tick++) {
    now += FRAME_DT_MS;
    store.getState().tick(FRAME_DT_MS / 1000, now);
    const queen = store.getState().units.find((u: any) => u.id === 'Q');
    if (queen.isHopping) everHopping = true;
    if (typeof queen.hopPhase === 'number') hopPhases.add(queen.hopPhase.toFixed(3));
  }
  return { distinctHopPhases: hopPhases.size, everHopping };
}

let failures = 0;
for (const animal of ['Frog', 'Bunny']) {
  const { distinctHopPhases, everHopping } = runPatrolLeg(animal);
  const animating = distinctHopPhases > 1 && everHopping;
  console.log(
    `${animal} Queen patrol: distinctHopPhases=${distinctHopPhases}, isHopping seen=${everHopping} -> ${animating ? 'PASS' : 'FAIL'}`
  );
  if (!animating) failures++;
}

if (failures > 0) {
  console.error(`\n${failures} animation check(s) FAILED — patrolling Queen is sliding, not walking.`);
  process.exit(1);
}
console.log('\nAll patrol walk-animation checks passed.');
