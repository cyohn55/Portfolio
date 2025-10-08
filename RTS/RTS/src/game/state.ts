import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { produce } from 'immer';
import { SpatialGrid } from '../utils/SpatialGrid';
import type { Position3D, AnimalId, CommandMoveUnits, CommandSetPatrol, GameConfig, GameState, Player, Unit, PatrolRoute } from './types';

const ANIMALS: Record<AnimalId, { baseHp: number; dmg: number; speed: number }> = {
  Bee: { baseHp: 60, dmg: 10, speed: 12.0 },
  Bear: { baseHp: 220, dmg: 40, speed: 4.8 },
  Chicken: { baseHp: 70, dmg: 8, speed: 11.2 },
  Cat: { baseHp: 90, dmg: 12, speed: 9.6 },
  Dolphin: { baseHp: 110, dmg: 18, speed: 8.0 },
  Fox: { baseHp: 140, dmg: 20, speed: 8.4 },
  Frog: { baseHp: 80, dmg: 10, speed: 10.4 },
  Owl: { baseHp: 100, dmg: 16, speed: 8.8 },
  Pig: { baseHp: 160, dmg: 18, speed: 7.2 },
  Turtle: { baseHp: 240, dmg: 24, speed: 4.0 },
  Yetti: { baseHp: 260, dmg: 30, speed: 4.4 },
};

const defaultConfig: GameConfig = {
  mapSize: 50,
  spawnIntervalMs: 10_000,
  regenPerSecondNearQueen: 5,
  regenRadius: 8,
};

type Store = GameState & {
  initializeGame: () => void;
  chooseAnimalsForLocal: (animals: AnimalId[]) => void;
  startMatch: (withAI?: boolean) => void;
  tick: (dtSec: number, nowMs: number) => void;
  moveCommand: (cmd: CommandMoveUnits) => void;
  setPatrol: (cmd: CommandSetPatrol) => void;
  selectUnits: (unitIds: string[]) => void;
  addToSelection: (unitIds: string[]) => void;
  clearSelection: () => void;
};

export const useGameStore = create<Store>((set, get) => ({
  config: defaultConfig,
  players: [],
  units: [],
  lastSpawnAtMsByQueenId: {},
  lastRegenAtMsByUnitId: {},
  selectedAnimalPool: ['Bee', 'Bear', 'Fox'],
  localPlayerId: null,
  matchStarted: false,
  gameOver: false,
  winner: null,
  selectedUnitIds: [],
  unitOrders: {},
  queenPatrols: {},

  initializeGame: () => {
    // Prepare a local player and an AI opponent with placeholder base hexes
    const localId = nanoid();
    const aiId = nanoid();
    const players: Player[] = [
      {
        id: localId,
        name: 'You',
        isAI: false,
        animals: ['Bee', 'Bear', 'Fox'],
        basePositions: [{ x: 73.5, y: 0.25, z: 252 }, { x: -2, y: 0.25, z: 252 }, { x: -77, y: 0.25, z: 252 }],
      },
      {
        id: aiId,
        name: 'AI',
        isAI: true,
        animals: ['Owl', 'Pig', 'Turtle'],
        basePositions: [{ x: 76.5, y: 0.25, z: -248 }, { x: 1, y: 0.25, z: -248 }, { x: -74, y: 0.25, z: -248 }],
      },
    ];

    set({ players, localPlayerId: localId, units: [], matchStarted: false, gameOver: false, winner: null, selectedUnitIds: [], unitOrders: {}, lastSpawnAtMsByQueenId: {}, lastRegenAtMsByUnitId: {}, queenPatrols: {} });
  },

  chooseAnimalsForLocal: (animals) => set({ selectedAnimalPool: animals.slice(0, 3) }),

  startMatch: (withAI = true) => {
    const state = get();
    const units: Unit[] = [];

    for (const player of state.players) {
      const chosenAnimals = player.isAI ? player.animals : state.selectedAnimalPool;
      for (let i = 0; i < 3; i++) {
        const animal = chosenAnimals[i];
        const basePos = player.basePositions[i];

        // Base entity (high HP, stationary)
        const base = createBase(player.id, animal, basePos);
        units.push(base);
        // Queen spawns units; place nearby
        const queenPos = { x: basePos.x + 3, y: basePos.y, z: basePos.z };
        units.push(createQueen(player.id, animal, queenPos));
        // King on another nearby position
        const kingPos = { x: basePos.x, y: basePos.y, z: basePos.z + 3 };
        units.push(createKing(player.id, animal, kingPos));
      }
    }

    set({ units, matchStarted: true, gameOver: false, winner: null, selectedUnitIds: [], unitOrders: {}, lastSpawnAtMsByQueenId: {} });
  },

  tick: (dtSec, nowMs) => set((prev) =>
    produce(prev, (draft) => {
      if (!draft.matchStarted) return;

      // Create spatial grid for efficient collision detection
      const spatialGrid = new SpatialGrid(1000, 50);
      spatialGrid.buildFromUnits(draft.units);

      // Pre-filter units by type to avoid repeated filtering (performance optimization)
      const queens = [];
      const unitsNeedingHealing = [];
      const movableUnits = [];

      for (const unit of draft.units) {
        if (unit.kind === 'Queen') queens.push(unit);
        if (unit.hp < unit.maxHp) unitsNeedingHealing.push(unit);
        if (unit.kind !== 'Base') movableUnits.push(unit);
      }

      // Discrete health regeneration: 1 HP every 3 seconds when near queens
      const REGEN_INTERVAL_MS = 3000; // 3 seconds
      const REGEN_AMOUNT = 1;

      for (const unit of unitsNeedingHealing) {
        const lastRegenTime = draft.lastRegenAtMsByUnitId[unit.id] ?? 0;
        if (nowMs - lastRegenTime < REGEN_INTERVAL_MS) continue;

        // Use spatial grid to find nearby queens (much faster than checking all queens)
        const nearbyQueens = spatialGrid.findNearbyQueens(unit, draft.config.regenRadius);
        if (nearbyQueens.length > 0) {
          unit.hp = Math.min(unit.maxHp, unit.hp + REGEN_AMOUNT);
          draft.lastRegenAtMsByUnitId[unit.id] = nowMs;
        }
      }

      // Spawning system: maintain 33 units per animal type (99 total per player)
      for (const q of queens) {
        const last = draft.lastSpawnAtMsByQueenId[q.id] ?? 0;
        if (nowMs - last >= draft.config.spawnIntervalMs) {
          // Count existing units of this queen's animal type for this player
          const existingUnitsOfType = draft.units.filter(u =>
            u.ownerId === q.ownerId &&
            u.animal === q.animal &&
            u.kind === 'Unit' // Only count regular units, not Queens/Kings/Bases
          );

          // Only spawn if we have less than 33 units of this animal type
          if (existingUnitsOfType.length < 33) {
            // Spawn at random position near queen
            const angle = Math.random() * Math.PI * 2;
            const distance = 2 + Math.random() * 2; // 2-4 units away
            const spawnPos = {
              x: q.position.x + Math.cos(angle) * distance,
              y: 0,
              z: q.position.z + Math.sin(angle) * distance
            };
            draft.units.push(createUnit(q.ownerId, q.animal, spawnPos));
          }

          draft.lastSpawnAtMsByQueenId[q.id] = nowMs;
        }
      }

      // Execute movement orders and combat (using pre-filtered movable units)
      for (const unit of movableUnits) {

        const order = draft.unitOrders[unit.id];
        const patrol = draft.queenPatrols[unit.id];
        let target: Unit | null = null;

        if (order && distance3D(unit.position, order) > 1) {
          // Move toward ordered position
          const direction = normalize3D(subtract3D(order, unit.position));
          const moveDistance = unit.moveSpeed * dtSec;
          unit.position = {
            x: unit.position.x + direction.x * moveDistance,
            y: unit.position.y,
            z: unit.position.z + direction.z * moveDistance
          };

          // Clear order if reached destination
          if (distance3D(unit.position, order) <= 1) {
            delete draft.unitOrders[unit.id];
          }
        } else if (patrol && unit.kind === 'Queen') {
          // Queen patrol behavior
          const targetPos = patrol.currentTarget === 'end' ? patrol.endPosition : patrol.startPosition;
          const dist = distance3D(unit.position, targetPos);

          if (dist > 1) {
            // Move toward patrol target
            const direction = normalize3D(subtract3D(targetPos, unit.position));
            const moveDistance = unit.moveSpeed * dtSec;
            unit.position = {
              x: unit.position.x + direction.x * moveDistance,
              y: unit.position.y,
              z: unit.position.z + direction.z * moveDistance
            };
          } else {
            // Reached patrol point, switch to other end
            draft.queenPatrols[unit.id].currentTarget = patrol.currentTarget === 'end' ? 'start' : 'end';
          }
        } else {
          // No orders - behavior depends on whether this is a player or AI unit
          const ownerPlayer = draft.players.find(p => p.id === unit.ownerId);
          const isPlayerUnit = ownerPlayer && !ownerPlayer.isAI;

          // Try spatial grid first, fallback to full search if no enemies found
          target = spatialGrid.findClosestEnemy(unit, 100); // Increased search radius
          if (!target) {
            // Fallback: search all units if spatial grid fails
            target = findClosestEnemy(unit, draft.units);
          }

          if (target) {
            const dist = distance3D(unit.position, target.position);
            if (dist <= 2) { // Attack range
              if (nowMs - unit.lastAttackAtMs >= unit.attackCooldownMs) {
                target.hp -= unit.attackDamage;
                unit.lastAttackAtMs = nowMs;
              }
            } else {
              // Movement logic differs for player vs AI units
              if (isPlayerUnit) {
                // Player units only move to defend if enemy is very close (within 8 units)
                if (dist <= 8) {
                  const direction = normalize3D(subtract3D(target.position, unit.position));
                  const moveDistance = unit.moveSpeed * dtSec;
                  unit.position = {
                    x: unit.position.x + direction.x * moveDistance,
                    y: unit.position.y,
                    z: unit.position.z + direction.z * moveDistance
                  };
                }
                // Otherwise, player units stay put until given explicit orders
              } else {
                // AI units always pursue enemies aggressively
                const direction = normalize3D(subtract3D(target.position, unit.position));
                const moveDistance = unit.moveSpeed * dtSec;
                unit.position = {
                  x: unit.position.x + direction.x * moveDistance,
                  y: unit.position.y,
                  z: unit.position.z + direction.z * moveDistance
                };
              }
            }
          }
        }
      }

      // Remove dead units
      draft.units = draft.units.filter((u) => u.hp > 0);

      // Check win conditions
      if (!draft.gameOver) {
        checkWinConditions(draft);
      }
    })
  ),

  moveCommand: (cmd) => set((prev) =>
    produce(prev, (draft) => {
      for (const id of cmd.unitIds) {
        const u = draft.units.find((x) => x.id === id);
        if (!u || u.ownerId !== draft.localPlayerId) continue; // Only allow moving own units
        draft.unitOrders[id] = cmd.target;
      }
    })
  ),

  setPatrol: (cmd) => set((prev) =>
    produce(prev, (draft) => {
      const queen = draft.units.find(u => u.id === cmd.queenId);
      if (!queen || queen.ownerId !== draft.localPlayerId || queen.kind !== 'Queen') return;

      // Set patrol route for the queen
      draft.queenPatrols[cmd.queenId] = {
        startPosition: cmd.startPosition,
        endPosition: cmd.endPosition,
        currentTarget: 'end' // Start by moving toward end position
      };

      // Clear any existing unit orders for this queen
      delete draft.unitOrders[cmd.queenId];

    })
  ),

  selectUnits: (unitIds) => set({ selectedUnitIds: unitIds }),
  
  addToSelection: (unitIds) => set((prev) => ({ 
    selectedUnitIds: [...new Set([...prev.selectedUnitIds, ...unitIds])]
  })),
  
  clearSelection: () => set({ selectedUnitIds: [] }),
}));

function baseStats(animal: AnimalId) {
  return ANIMALS[animal];
}

function createBase(ownerId: string, animal: AnimalId, position: Position3D): Unit {
  const stats = baseStats(animal);
  return {
    id: nanoid(),
    ownerId,
    animal,
    kind: 'Base',
    position,
    hp: stats.baseHp * 8,
    maxHp: stats.baseHp * 8,
    attackDamage: 0,
    moveSpeed: 0,
    attackCooldownMs: 1000,
    lastAttackAtMs: 0,
  };
}

function createQueen(ownerId: string, animal: AnimalId, position: Position3D): Unit {
  const stats = baseStats(animal);
  return {
    id: nanoid(),
    ownerId,
    animal,
    kind: 'Queen',
    position,
    hp: stats.baseHp * 2,
    maxHp: stats.baseHp * 2,
    attackDamage: stats.dmg,
    moveSpeed: stats.speed * 0.9,
    attackCooldownMs: 900,
    lastAttackAtMs: 0,
  };
}

function createKing(ownerId: string, animal: AnimalId, position: Position3D): Unit {
  const stats = baseStats(animal);
  return {
    id: nanoid(),
    ownerId,
    animal,
    kind: 'King',
    position,
    hp: stats.baseHp * 3,
    maxHp: stats.baseHp * 3,
    attackDamage: stats.dmg * 3, // one-shot most standard units
    moveSpeed: stats.speed * 0.5,
    attackCooldownMs: 800,
    lastAttackAtMs: 0,
  };
}

function createUnit(ownerId: string, animal: AnimalId, position: Position3D): Unit {
  const stats = baseStats(animal);
  return {
    id: nanoid(),
    ownerId,
    animal,
    kind: 'Unit',
    position,
    hp: stats.baseHp,
    maxHp: stats.baseHp,
    attackDamage: stats.dmg,
    moveSpeed: stats.speed,
    attackCooldownMs: 1000,
    lastAttackAtMs: 0,
  };
}

function findClosestEnemy(unit: Unit, all: Unit[]): Unit | null {
  let best: Unit | null = null;
  let bestDistSq = Infinity;
  for (const other of all) {
    if (other.ownerId === unit.ownerId) continue;
    const dSq = distanceSquared3D(unit.position, other.position);
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      best = other;
    }
  }
  return best;
}

function checkWinConditions(draft: GameState): void {
  const playerIds = draft.players.map(p => p.id);

  for (const playerId of playerIds) {
    const enemyIds = playerIds.filter(id => id !== playerId);

    // Check if all enemies are eliminated
    let allEnemiesDefeated = true;

    for (const enemyId of enemyIds) {
      // Count enemy's remaining bases, kings, and queens
      const enemyBases = draft.units.filter(u => u.ownerId === enemyId && u.kind === 'Base');
      const enemyKings = draft.units.filter(u => u.ownerId === enemyId && u.kind === 'King');
      const enemyQueens = draft.units.filter(u => u.ownerId === enemyId && u.kind === 'Queen');

      // Enemy must lose all 3 bases AND all 6 king/queens (3 kings + 3 queens)
      if (enemyBases.length > 0 || enemyKings.length > 0 || enemyQueens.length > 0) {
        allEnemiesDefeated = false;
        break;
      }
    }

    if (allEnemiesDefeated) {
      draft.gameOver = true;
      draft.winner = playerId;
      break;
    }
  }
}

// 3D utility functions
function distance3D(a: Position3D, b: Position3D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Faster squared distance - avoids expensive sqrt calculation when comparing distances
function distanceSquared3D(a: Position3D, b: Position3D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function subtract3D(a: Position3D, b: Position3D): Position3D {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z
  };
}

function normalize3D(vec: Position3D): Position3D {
  const length = Math.sqrt(vec.x * vec.x + vec.y * vec.y + vec.z * vec.z);
  if (length === 0) return { x: 0, y: 0, z: 0 };
  return {
    x: vec.x / length,
    y: vec.y / length,
    z: vec.z / length
  };
}


