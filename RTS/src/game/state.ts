import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { produce } from 'immer';
import { SpatialGrid } from '../utils/SpatialGrid';
import type { Position3D, AnimalId, CommandMoveUnits, CommandSetPatrol, CommandAttackTarget, GameConfig, GameState, Player, Unit, PatrolRoute } from './types';

type BridgeAnimationState = 'up' | 'lowering' | 'down' | 'raising';
type BridgeFrame = 'Fully_Up' | 'Almost_Up' | 'Almost_Down' | 'Fully_Down';

interface BridgeAnimation {
  currentState: BridgeAnimationState;
  currentFrame: BridgeFrame;
  animationStartMs: number;
  frameStartMs: number;
  triggeredByPlayer: boolean;
}

interface BridgeState {
  rightBridge: BridgeAnimation;
  leftBridge: BridgeAnimation;
}


const ANIMALS: Record<AnimalId, { baseHp: number; dmg: number; speed: number }> = {
  Bee: { baseHp: 60, dmg: 10, speed: 20.4 },     // Reduced 15% from 24.0
  Bear: { baseHp: 220, dmg: 40, speed: 8.16 },   // Reduced 15% from 9.6
  Bunny: { baseHp: 75, dmg: 9, speed: 18.36 },   // Reduced 15% from 21.6
  Chicken: { baseHp: 70, dmg: 8, speed: 19.04 }, // Reduced 15% from 22.4
  Cat: { baseHp: 90, dmg: 12, speed: 16.32 },    // Reduced 15% from 19.2
  Dolphin: { baseHp: 110, dmg: 18, speed: 13.6 }, // Reduced 15% from 16.0
  Fox: { baseHp: 140, dmg: 20, speed: 14.28 },   // Reduced 15% from 16.8
  Frog: { baseHp: 80, dmg: 10, speed: 17.68 },   // Reduced 15% from 20.8
  Owl: { baseHp: 100, dmg: 16, speed: 14.96 },   // Reduced 15% from 17.6
  Pig: { baseHp: 160, dmg: 18, speed: 12.24 },   // Reduced 15% from 14.4
  Turtle: { baseHp: 240, dmg: 24, speed: 6.8 },  // Reduced 15% from 8.0
  Yetti: { baseHp: 260, dmg: 30, speed: 7.48 },  // Reduced 15% from 8.8
};

const defaultConfig: GameConfig = {
  mapSize: 50,
  spawnIntervalMs: 10_000,
  regenPerSecondNearQueen: 5,
  regenRadius: 8,
};

type GameScreen = 'menu' | 'lobby' | 'playing' | 'postgame';

type Store = GameState & {
  // Screen management
  currentScreen: GameScreen;
  transitionToScreen: (screen: GameScreen) => void;

  initializeGame: () => void;
  chooseAnimalsForLocal: (animals: AnimalId[]) => void;
  startMatch: (withAI?: boolean) => void;
  tick: (dtSec: number, nowMs: number) => void;
  moveCommand: (cmd: CommandMoveUnits) => void;
  setPatrol: (cmd: CommandSetPatrol) => void;
  attackTarget: (cmd: CommandAttackTarget) => void;
  selectUnits: (unitIds: string[]) => void;
  addToSelection: (unitIds: string[]) => void;
  clearSelection: () => void;
  toggleOptimization: (key: keyof Store['optimizations']) => void;
  // Bridge animation system
  bridgeState: BridgeState;
  updateBridgeAnimations: (nowMs: number) => void;
  // Performance optimization: cache for unit counts per player/animal
  unitCountCache: Record<string, Record<AnimalId, number>>;
  spatialGrid: SpatialGrid | null;
  // Regeneration throttling
  lastRegenCheckMs: number;
  tickCounter: number;
  debugTickCount?: number;
  // AI thinking throttling
  aiThinkingOffset: Record<string, number>;
  // Movement caching
  movementDirectionCache: Record<string, Position3D>;
  // Target caching for AI units
  targetCache: Record<string, string>;
  // Win condition throttling
  lastWinCheckMs: number;
  // Dead units batch
  deadUnitsToRemove: string[];
  // Ultra-aggressive optimization toggle
  ultraPerformanceMode: boolean;
  // Optimization toggles for testing
  optimizations: {
    aiThrottling: boolean;
    combatBatching: boolean;
    movementCaching: boolean;
    regenThrottling: boolean;
    winCheckThrottling: boolean;
    deadUnitBatching: boolean;
    spawnOptimization: boolean;
  };
  // Game pause state
  isPaused: boolean;
  // Lighting settings
  lightingSettings: {
    sunBrightness: number;
    moonBrightness: number;
    ambientLight: number;
    dayNightSpeed: number;
  };
  updateLightingSettings: (settings: Partial<Store['lightingSettings']>) => void;
};

export const useGameStore = create<Store>((set, get) => ({
  // Screen state
  currentScreen: 'menu',
  transitionToScreen: (screen) => set({ currentScreen: screen }),

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
  unitCountCache: {},
  spatialGrid: null,
  lastRegenCheckMs: 0,
  tickCounter: 0,
  aiThinkingOffset: {},
  movementDirectionCache: {},
  targetCache: {},
  lastWinCheckMs: 0,
  deadUnitsToRemove: [],
  ultraPerformanceMode: true, // Enable ultra mode by default
  optimizations: {
    aiThrottling: true,
    combatBatching: true,
    movementCaching: true,
    regenThrottling: true,
    winCheckThrottling: true,
    deadUnitBatching: true,
    spawnOptimization: true,
  },
  isPaused: false,
  lightingSettings: {
    sunBrightness: 5.0,
    moonBrightness: 5.0,
    ambientLight: 1.6,
    dayNightSpeed: 60,
  },
  updateLightingSettings: (settings) => set((state) => ({
    lightingSettings: { ...state.lightingSettings, ...settings }
  })),
  bridgeState: {
    rightBridge: {
      currentState: 'up',
      currentFrame: 'Fully_Up',
      animationStartMs: 0,
      frameStartMs: 0,
      triggeredByPlayer: false,
    },
    leftBridge: {
      currentState: 'up',
      currentFrame: 'Fully_Up',
      animationStartMs: 0,
      frameStartMs: 0,
      triggeredByPlayer: false,
    },
  },

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

    set({ players, localPlayerId: localId, units: [], matchStarted: false, gameOver: false, winner: null, selectedUnitIds: [], unitOrders: {}, lastSpawnAtMsByQueenId: {}, lastRegenAtMsByUnitId: {}, queenPatrols: {}, unitCountCache: {}, spatialGrid: null, lastRegenCheckMs: 0, tickCounter: 0, aiThinkingOffset: {}, movementDirectionCache: {}, targetCache: {}, lastWinCheckMs: 0, deadUnitsToRemove: [], optimizations: { aiThrottling: true, combatBatching: true, movementCaching: true, regenThrottling: true, winCheckThrottling: true, deadUnitBatching: true, spawnOptimization: true } });
  },

  chooseAnimalsForLocal: (animals) => set({ selectedAnimalPool: animals.slice(0, 3) }),

  startMatch: (withAI = true) => {
    const state = get();
    const units: Unit[] = [];

    console.log('🎮 Starting match with players:', state.players);

    for (const player of state.players) {
      const chosenAnimals = player.isAI ? player.animals : state.selectedAnimalPool;
      const isPlayerUnit = player.id === state.localPlayerId;
      const initialRotation = isPlayerUnit ? Math.PI : 0; // Player units face 180 degrees (toward AI)

      console.log(`👤 Player ${player.name} (${player.isAI ? 'AI' : 'Human'}) animals:`, chosenAnimals);

      for (let i = 0; i < 3; i++) {
        const animal = chosenAnimals[i];
        const basePos = player.basePositions[i];

        console.log(`  Creating ${animal} base at`, basePos);

        // Base entity (high HP, stationary)
        const base = createBase(player.id, animal, basePos, initialRotation);
        units.push(base);
        // Queen spawns units; place nearby
        const queenPos = { x: basePos.x + 3, y: basePos.y, z: basePos.z };
        units.push(createQueen(player.id, animal, queenPos, initialRotation));
        // King on another nearby position
        const kingPos = { x: basePos.x, y: basePos.y, z: basePos.z + 3 };
        units.push(createKing(player.id, animal, kingPos, initialRotation));
      }
    }

    console.log(`✅ Created ${units.length} total units:`, units.map(u => `${u.animal} ${u.kind}`));

    set({
      units,
      matchStarted: true,
      gameOver: false,
      winner: null,
      selectedUnitIds: [],
      unitOrders: {},
      lastSpawnAtMsByQueenId: {},
      unitCountCache: {},
      spatialGrid: null,
      lastRegenCheckMs: 0,
      tickCounter: 0,
      aiThinkingOffset: {},
      movementDirectionCache: {},
      targetCache: {},
      lastWinCheckMs: 0,
      deadUnitsToRemove: [],
      bridgeState: {
        rightBridge: {
          currentState: 'up',
          currentFrame: 'Fully_Up',
          animationStartMs: 0,
          frameStartMs: 0,
          triggeredByPlayer: false,
        },
        leftBridge: {
          currentState: 'up',
          currentFrame: 'Fully_Up',
          animationStartMs: 0,
          frameStartMs: 0,
          triggeredByPlayer: false,
        },
      }
    });
  },

  tick: (dtSec, nowMs) => set((prev) =>
    produce(prev, (draft) => {
      if (!draft.matchStarted || draft.isPaused) return;

      // DEBUG: Initialize tick counter
      if (!draft.debugTickCount) {
        draft.debugTickCount = 0;
        console.log('🎮 GAME LOOP STARTED - Debug logging initialized');
      }
      draft.debugTickCount++;

      draft.tickCounter++;

      // Debug: Log game is running (every 5 seconds)
      if (draft.tickCounter % 300 === 0) {
        console.log(`Game tick ${draft.tickCounter}, units: ${draft.units.length}, started: ${draft.matchStarted}`);
      }

      // Reuse spatial grid instead of rebuilding every tick (major optimization)
      if (!draft.spatialGrid) {
        draft.spatialGrid = new SpatialGrid(1000, 50);
      }
      draft.spatialGrid.buildFromUnits(draft.units);

      // Optimized single-pass unit filtering and caching (major CPU optimization)
      const unitCategories = {
        queens: [] as Unit[],
        unitsNeedingHealing: [] as Unit[],
        movableUnits: [] as Unit[],
        playerUnits: {} as Record<string, Unit[]>,
        aiUnits: {} as Record<string, Unit[]>
      };

      // Single pass through units for all categorization
      const newUnitCountCache: Record<string, Record<AnimalId, number>> = {};

      for (const unit of draft.units) {
        // Type-based categorization
        if (unit.kind === 'Queen') unitCategories.queens.push(unit);
        if (unit.hp < unit.maxHp) unitCategories.unitsNeedingHealing.push(unit);
        if (unit.kind !== 'Base') unitCategories.movableUnits.push(unit);

        // Owner-based categorization for later use
        const ownerPlayer = draft.players.find(p => p.id === unit.ownerId);
        if (ownerPlayer) {
          const category = ownerPlayer.isAI ? 'aiUnits' : 'playerUnits';
          if (!unitCategories[category][unit.ownerId]) {
            unitCategories[category][unit.ownerId] = [];
          }
          unitCategories[category][unit.ownerId].push(unit);
        }

        // Update unit count cache in same pass
        if (unit.kind === 'Unit') {
          if (!newUnitCountCache[unit.ownerId]) {
            newUnitCountCache[unit.ownerId] = {} as Record<AnimalId, number>;
          }
          newUnitCountCache[unit.ownerId][unit.animal] = (newUnitCountCache[unit.ownerId][unit.animal] || 0) + 1;
        }
      }

      draft.unitCountCache = newUnitCountCache;
      const { queens, unitsNeedingHealing, movableUnits } = unitCategories;

      // BALANCED: Moderate health regeneration throttling
      const REGEN_INTERVAL_MS = 3000; // 3 seconds
      const REGEN_AMOUNT = 1;
      const REGEN_CHECK_FREQUENCY = 3; // Restored to 3 ticks

      if (!draft.optimizations.regenThrottling || draft.tickCounter % REGEN_CHECK_FREQUENCY === 0) {
        // Process more healing units for better responsiveness
        const healingUnitsToProcess = unitsNeedingHealing.slice(0, 30); // Increased to 30 units per frame
        for (const unit of healingUnitsToProcess) {
          // Skip dead units - they should not regenerate
          if (unit.hp <= 0) continue;

          const lastRegenTime = draft.lastRegenAtMsByUnitId[unit.id] ?? 0;
          if (nowMs - lastRegenTime < REGEN_INTERVAL_MS) continue;

          // Use spatial grid to find nearby queens (much faster than checking all queens)
          const nearbyQueens = draft.spatialGrid!.findNearbyQueens(unit, draft.config.regenRadius);
          if (nearbyQueens.length > 0) {
            unit.hp = Math.min(unit.maxHp, unit.hp + REGEN_AMOUNT);
            draft.lastRegenAtMsByUnitId[unit.id] = nowMs;
          }
        }
      }

      // AGGRESSIVE: Reduced spawn rate to limit unit count (major performance optimization)
      for (const q of queens) {
        const last = draft.lastSpawnAtMsByQueenId[q.id] ?? 0;
        if (nowMs - last >= draft.config.spawnIntervalMs) {
          // Use cached unit count instead of expensive filtering
          const existingCount = draft.unitCountCache[q.ownerId]?.[q.animal] || 0;

          // Reduced max units from 33 to 20 for better performance
          if (existingCount < 20) {
            // Pre-calculated spawn positions (much faster than random generation)
            const spawnIndex = existingCount % 8; // Cycle through 8 preset positions
            const presetAngles = [0, Math.PI/4, Math.PI/2, 3*Math.PI/4, Math.PI, 5*Math.PI/4, 3*Math.PI/2, 7*Math.PI/4];
            const angle = presetAngles[spawnIndex];
            const distance = 2.5; // Fixed distance for consistency
            const tentativeSpawnPos = {
              x: q.position.x + Math.cos(angle) * distance,
              y: 0,
              z: q.position.z + Math.sin(angle) * distance
            };

            // Create a temporary unit to check collision
            const ownerPlayer = draft.players.find(p => p.id === q.ownerId);
            const isPlayerUnit = q.ownerId === draft.localPlayerId;
            const initialRotation = isPlayerUnit ? Math.PI : 0;
            const tempUnit = createUnit(q.ownerId, q.animal, tentativeSpawnPos, initialRotation);

            // Find a collision-free spawn position
            const finalSpawnPos = checkCollision(tentativeSpawnPos, tempUnit, draft.units, 2.5, draft.selectedUnitIds, draft.localPlayerId, draft.unitOrders);
            tempUnit.position = finalSpawnPos;
            draft.units.push(tempUnit);
          }

          draft.lastSpawnAtMsByQueenId[q.id] = nowMs;
        }
      }

      // Batched combat processing for better performance
      const combatPairs: Array<{attacker: Unit, target: Unit, damage: number}> = [];

      // Track units under attack for immediate response
      const unitsUnderAttack = new Set<string>();

      // FIXED: Process all units but with smart optimizations for AI
      // Execute movement orders and combat (process all units for proper AI)
      for (const unit of movableUnits) {
        // AI thinking throttling - each unit thinks on different frames
        const ownerPlayer = draft.players.find(p => p.id === unit.ownerId);
        const isPlayerUnit = ownerPlayer && !ownerPlayer.isAI;
        const shouldThinkThisTick = isPlayerUnit || !draft.optimizations.aiThrottling || (draft.tickCounter + (draft.aiThinkingOffset[unit.id] || 0)) % 2 === 0; // Reduced to 2 for better AI responsiveness

        // Initialize AI thinking offset for new units
        if (!draft.aiThinkingOffset[unit.id]) {
          draft.aiThinkingOffset[unit.id] = Math.floor(Math.random() * 2); // Match new thinking interval
        }

        const order = draft.unitOrders[unit.id];
        const patrol = draft.queenPatrols[unit.id];
        let target: Unit | null = null;

        // REVISED PLAYER PRIORITY SYSTEM - MOVEMENT ORDERS FIRST
        // Priority 1: Player movement orders (NEVER interrupted by combat)
        // Priority 2: Attack response when idle (defend when under attack)
        // Priority 3: Autonomous enemy detection when idle and not under attack
        if (isPlayerUnit) {
          // Debug: Check player unit detection
          if (unit.id.endsWith('0') && draft.tickCounter % 120 === 0) {
            console.log(`PLAYER unit ${unit.animal} (${unit.id}) - isPlayerUnit: ${isPlayerUnit}, currentAttackers: ${unit.currentAttackers?.length || 0}`);
          }

          // Initialize unit state if not set
          if (!unit.unitState) {
            unit.unitState = 'idle';
          }

          // PRIORITY 1: Execute player movement orders (HIGHEST PRIORITY - never interrupted)
          if (order) {
            unit.unitState = 'moving_to_order';
            const distanceToOrder = distance3D(unit.position, order);

            // Check if movement is paused due to collision attempts
            const isInRecentCombat = unit.lastCombatEngagementMs && nowMs - unit.lastCombatEngagementMs < 2000;
            const isMovementPaused = unit.movementPausedUntilMs && nowMs < unit.movementPausedUntilMs && !isInRecentCombat;

            // BLOCKING DETECTION: Track when unit gets blocked
            const isCurrentlyBlocked = isMovementPaused || (unit.collisionAttempts && unit.collisionAttempts >= 3);

            if (isCurrentlyBlocked) {
              // Start tracking block time if not already tracking
              if (!unit.firstBlockedAtMs) {
                unit.firstBlockedAtMs = nowMs;
              }

              // Check if blocked for more than 2 seconds (reduced from 5)
              const blockedDuration = nowMs - unit.firstBlockedAtMs;
              if (blockedDuration >= 2000) {
                // Unit is stuck - abandon current order and switch to idle
                delete draft.unitOrders[unit.id];
                delete unit.arrivedAtDestinationMs;
                unit.unitState = 'idle';

                // Reset blocking state
                unit.collisionAttempts = 0;
                delete unit.movementPausedUntilMs;
                delete unit.firstBlockedAtMs;

                if (unit.id.endsWith('0')) {
                  console.log(`PLAYER unit ${unit.animal} BLOCKED for ${(blockedDuration/1000).toFixed(1)}s - abandoning order and switching to IDLE state`);
                }
              }
            } else {
              // Unit is not blocked - clear block tracking
              delete unit.firstBlockedAtMs;
            }

            // Check for enemies near movement path (allow combat while moving)
            let nearbyEnemy: Unit | null = null;
            // Use spatial grid for O(1) nearby enemy lookup instead of O(n) filter
            if (draft.spatialGrid) {
              const nearbyEnemies = draft.spatialGrid.findEnemiesInRange(unit, 8);
              if (nearbyEnemies.length > 0) {
                nearbyEnemy = nearbyEnemies.reduce((closest, enemy) => {
                  const distToCurrent = distanceSquared3D(unit.position, closest.position);
                  const distToEnemy = distanceSquared3D(unit.position, enemy.position);
                  return distToEnemy < distToCurrent ? enemy : closest;
                });
              }
            }

            // Owl landing logic - land if within 15 units for more than 5 seconds
            if (unit.animal === 'Owl' && unit.isFlying && distanceToOrder <= 15) {
              if (!unit.nearDestinationSinceMs) {
                unit.nearDestinationSinceMs = nowMs;
              } else if (nowMs - unit.nearDestinationSinceMs >= 5000) {
                // Been near destination for 5+ seconds, land
                unit.isFlying = false;
                delete unit.nearDestinationSinceMs;
                console.log(`Owl ${unit.id} landing after hovering near destination`);
              }
            } else if (unit.animal === 'Owl' && distanceToOrder > 15) {
              // Reset timer if moved away from destination
              delete unit.nearDestinationSinceMs;
            }

            // Move toward ordered position (but allow combat interruption)
            if (distanceToOrder > 0.5 && !isMovementPaused) {
              const direction = normalize3D(subtract3D(order, unit.position));
              const moveDistance = unit.moveSpeed * dtSec;

              // Update rotation to face movement direction (unless in combat)
              if (!nearbyEnemy || distanceSquared3D(unit.position, nearbyEnemy.position) > 900) {
                unit.rotation = Math.atan2(direction.x, direction.z);
              }

              // Frog and Bunny hopping animation
              if (unit.animal === 'Frog' || unit.animal === 'Bunny') {
                unit.isHopping = true;
                // Update hop phase (cycles 0-1, speed based on movement speed)
                const hopSpeed = unit.moveSpeed / 5; // Hop frequency
                unit.hopPhase = ((unit.hopPhase || 0) + (hopSpeed * dtSec)) % 1;
              } else {
                unit.isHopping = false;
              }

              // Owl flying animation
              if (unit.animal === 'Owl') {
                unit.isFlying = true;
                // Update wing phase (cycles 0-1 for wing flapping)
                const flapSpeed = 3; // Flaps per second
                unit.wingPhase = ((unit.wingPhase || 0) + (flapSpeed * dtSec)) % 1;
              } else if (unit.animal !== 'Owl') {
                unit.isFlying = false;
              }

              const newPosition = {
                x: unit.position.x + direction.x * moveDistance,
                y: unit.position.y,
                z: unit.position.z + direction.z * moveDistance
              };

              // Always apply collision detection for player-ordered movement (highest priority)
              unit.position = checkCollision(newPosition, unit, draft.units, 2.5, draft.selectedUnitIds, draft.localPlayerId, draft.unitOrders);

              // Debug: Log movement for player units
              if (unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
                console.log(`PLAYER unit ${unit.animal} executing order: distance ${distanceToOrder.toFixed(1)}`);
              }
            }

            // Set target if enemy nearby (allow combat during movement)
            if (nearbyEnemy && distanceSquared3D(unit.position, nearbyEnemy.position) <= 64) {
              target = nearbyEnemy;
            }

            // Clear order and enter idle state when destination reached
            if (distanceToOrder <= 0.5) {
              delete draft.unitOrders[unit.id];
              delete unit.arrivedAtDestinationMs;
              unit.unitState = 'idle';
              // Owl landed when destination reached
              if (unit.animal === 'Owl') {
                unit.isFlying = false;
              }
              console.log(`PLAYER unit ${unit.animal} reached destination - entering IDLE state`);
            }
          }

          // PRIORITY 2: When idle (no movement orders), check for attack response
          else {
            // Debug: Log when entering Priority 2 (idle state) logic
            if (unit.id.endsWith('0') && draft.tickCounter % 30 === 0) {
              console.log(`📍 PLAYER ${unit.animal} entered IDLE state - no active movement orders`);
            }

            // ATTACK RESPONSE: When idle and under attack, fight back until enemy defeated or new order given
            if (unit.currentAttackers && unit.currentAttackers.length > 0) {
              // Debug: Log when player units are under attack while idle
              if (unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
                console.log(`PLAYER unit ${unit.animal} IDLE but UNDER ATTACK by ${unit.currentAttackers.length} attackers`);
              }

              // Select priority attacker (focus-fire: attack one until dead)
              let priorityAttacker: Unit | null = null;

              // First try to stick with current priority attacker if still attacking
              if (unit.priorityAttacker && unit.currentAttackers.includes(unit.priorityAttacker)) {
                priorityAttacker = draft.units.find(u => u.id === unit.priorityAttacker) || null;
              }

              // If no priority attacker or they're not attacking anymore, find closest attacker
              if (!priorityAttacker) {
                const attackers = unit.currentAttackers
                  .map(id => draft.units.find(u => u.id === id))
                  .filter(u => u && u.hp > 0) as Unit[];

                if (attackers.length > 0) {
                  priorityAttacker = attackers.reduce((closest, attacker) => {
                    const distToCurrent = distanceSquared3D(unit.position, closest.position);
                    const distToAttacker = distanceSquared3D(unit.position, attacker.position);
                    return distToAttacker < distToCurrent ? attacker : closest;
                  });
                  unit.priorityAttacker = priorityAttacker.id;
                }
              }

              if (priorityAttacker) {
                unit.unitState = 'pursuing_enemy';
                target = priorityAttacker;
                console.log(`✅ PLAYER ${unit.animal} IDLE → fighting back against ${target.animal} (focus-fire)`);

                // Debug: Confirm target is set for combat
                if (unit.id.endsWith('0')) {
                  console.log(`PLAYER unit ${unit.animal} combat target: ${target.animal} - will fight until defeated or new order given`);
                }
              }
            }
            // Clear priority attacker if no longer under attack and return to idle
            else if (unit.priorityAttacker) {
              delete unit.priorityAttacker;
              unit.unitState = 'idle';
              console.log(`PLAYER unit ${unit.animal} defeated all attackers → returning to IDLE state`);
            }

            // PRIORITY 3: Autonomous enemy detection when idle (enabled but with limited range)
            // Player units will engage nearby enemies when not under attack and idle
            else if (unit.unitState === 'idle' || unit.unitState === 'pursuing_enemy') {
              // Detect nearby enemies
              let enemyTarget: Unit | null = null;

              // If we have a priority attacker that was just defeated, clear it
              if (unit.priorityAttacker) {
                const priorityAttackerUnit = draft.units.find(u => u.id === unit.priorityAttacker);
                if (!priorityAttackerUnit || priorityAttackerUnit.hp <= 0) {
                  delete unit.priorityAttacker;
                  console.log(`PLAYER unit ${unit.animal} defeated attacker - checking for other enemies`);
                }
              }

              // First try to re-engage recent combat target (unless it was our priority attacker we just defeated)
              if (unit.lastCombatTargetId && unit.lastCombatEngagementMs &&
                  nowMs - unit.lastCombatEngagementMs < 3000 &&
                  unit.lastCombatTargetId !== unit.priorityAttacker) {
                const lastTarget = draft.units.find(u => u.id === unit.lastCombatTargetId);
                if (lastTarget && lastTarget.ownerId !== unit.ownerId && lastTarget.hp > 0) {
                  const distToLastTarget = distanceSquared3D(unit.position, lastTarget.position);
                  if (distToLastTarget <= 100) { // 10 units - closer re-engagement
                    enemyTarget = lastTarget;
                  }
                }
              }

              // If no recent target, find closest enemy within limited detection range
              if (!enemyTarget && draft.spatialGrid) {
                const nearbyEnemies = draft.spatialGrid.findEnemiesInRange(unit, 10);
                if (nearbyEnemies.length > 0) {
                  enemyTarget = nearbyEnemies.reduce((closest, enemy) => {
                    const distToCurrent = distanceSquared3D(unit.position, closest.position);
                    const distToEnemy = distanceSquared3D(unit.position, enemy.position);
                    return distToEnemy < distToCurrent ? enemy : closest;
                  });
                }
              }

              // Pursue enemy if found
              if (enemyTarget) {
                unit.unitState = 'pursuing_enemy';
                target = enemyTarget;

                // Debug: Log enemy engagement
                if (unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
                  const distance = Math.sqrt(distanceSquared3D(unit.position, enemyTarget.position));
                  console.log(`PLAYER unit ${unit.animal} IDLE → pursuing enemy ${enemyTarget.animal}: distance ${distance.toFixed(1)}`);
                }
              } else {
                // No enemies found - stay idle
                unit.unitState = 'idle';
              }
            }
          }
        }

        // AI UNITS: Keep existing behavior for non-player units
        else if (!isPlayerUnit && order) {
          const distanceToOrder = distance3D(unit.position, order);

          // Check if movement is paused due to collision attempts
          const isInRecentCombat = unit.lastCombatEngagementMs && nowMs - unit.lastCombatEngagementMs < 2000;
          const isMovementPaused = unit.movementPausedUntilMs && nowMs < unit.movementPausedUntilMs && !isInRecentCombat;

          // Owl landing logic - land if within 15 units for more than 5 seconds
          if (unit.animal === 'Owl' && unit.isFlying && distanceToOrder <= 15) {
            if (!unit.nearDestinationSinceMs) {
              unit.nearDestinationSinceMs = nowMs;
            } else if (nowMs - unit.nearDestinationSinceMs >= 5000) {
              // Been near destination for 5+ seconds, land
              unit.isFlying = false;
              delete unit.nearDestinationSinceMs;
            }
          } else if (unit.animal === 'Owl' && distanceToOrder > 15) {
            // Reset timer if moved away from destination
            delete unit.nearDestinationSinceMs;
          }

          // Move toward ordered position
          if (distanceToOrder > 0.5 && !isMovementPaused) {
            const direction = normalize3D(subtract3D(order, unit.position));
            const moveDistance = unit.moveSpeed * dtSec;
            unit.rotation = Math.atan2(direction.x, direction.z);

            // Owl flying animation (AI units with orders)
            if (unit.animal === 'Owl') {
              unit.isFlying = true;
              const flapSpeed = 3; // Flaps per second
              unit.wingPhase = ((unit.wingPhase || 0) + (flapSpeed * dtSec)) % 1;
            } else if (unit.animal !== 'Owl') {
              unit.isFlying = false;
            }

            const newPosition = {
              x: unit.position.x + direction.x * moveDistance,
              y: unit.position.y,
              z: unit.position.z + direction.z * moveDistance
            };

            unit.position = checkCollision(newPosition, unit, draft.units, 2.5, draft.selectedUnitIds, draft.localPlayerId, draft.unitOrders);
          } else if (unit.animal === 'Owl') {
            // Owl landed when destination reached
            unit.isFlying = false;
          }

          // Clear order when destination reached
          if (distanceToOrder <= 0.5) {
            delete draft.unitOrders[unit.id];
            delete unit.arrivedAtDestinationMs;
          }
        } else if (patrol && unit.kind === 'Queen') {
          // Queen patrol behavior
          const targetPos = patrol.currentTarget === 'end' ? patrol.endPosition : patrol.startPosition;
          const dist = distance3D(unit.position, targetPos);

          // Owl landing logic - land if within 15 units for more than 5 seconds
          if (unit.animal === 'Owl' && unit.isFlying && dist <= 15) {
            if (!unit.nearDestinationSinceMs) {
              unit.nearDestinationSinceMs = nowMs;
            } else if (nowMs - unit.nearDestinationSinceMs >= 5000) {
              // Been near destination for 5+ seconds, land
              unit.isFlying = false;
              delete unit.nearDestinationSinceMs;
            }
          } else if (unit.animal === 'Owl' && dist > 15) {
            // Reset timer if moved away from destination
            delete unit.nearDestinationSinceMs;
          }

          if (dist > 1) {
            // Move toward patrol target
            const direction = normalize3D(subtract3D(targetPos, unit.position));
            const moveDistance = unit.moveSpeed * dtSec;

            // Update rotation to face movement direction
            unit.rotation = Math.atan2(direction.x, direction.z);

            // Owl flying animation (Queen patrol)
            if (unit.animal === 'Owl') {
              unit.isFlying = true;
              const flapSpeed = 3; // Flaps per second
              unit.wingPhase = ((unit.wingPhase || 0) + (flapSpeed * dtSec)) % 1;
            }

            const newPosition = {
              x: unit.position.x + direction.x * moveDistance,
              y: unit.position.y,
              z: unit.position.z + direction.z * moveDistance
            };

            // Apply collision detection
            unit.position = checkCollision(newPosition, unit, draft.units, 2.5, draft.selectedUnitIds, draft.localPlayerId, draft.unitOrders);
          } else {
            // Reached patrol point, switch to other end
            draft.queenPatrols[unit.id].currentTarget = patrol.currentTarget === 'end' ? 'start' : 'end';
            // Owl landed when patrol point reached
            if (unit.animal === 'Owl') {
              unit.isFlying = false;
            }
          }
        }

        // AI ENEMY DETECTION: Only for AI units when they don't have orders
        else if (!order && !patrol) {
          // PLAYER UNIT FIX: Only search for enemies if they're very close or if AI unit
          if (isPlayerUnit) {
            // COMBAT PERSISTENCE: First try to re-engage last combat target if still valid
            if (unit.lastCombatTargetId && unit.lastCombatEngagementMs &&
                nowMs - unit.lastCombatEngagementMs < 3000) { // 3 second combat persistence
              const lastTarget = draft.units.find(u => u.id === unit.lastCombatTargetId);
              if (lastTarget && lastTarget.ownerId !== unit.ownerId && lastTarget.hp > 0) {
                const distToLastTarget = distanceSquared3D(unit.position, lastTarget.position);
                if (distToLastTarget <= 100) { // 10 units - closer re-engagement range
                  target = lastTarget;
                }
              }
            }

            // If no combat target found, react defensively to very close enemies (within 8 units)
            if (!target && draft.spatialGrid) {
              const nearbyEnemies = draft.spatialGrid.findEnemiesInRange(unit, 8);
              if (nearbyEnemies.length > 0) {
                // Find closest nearby enemy
                target = nearbyEnemies.reduce((closest, enemy) => {
                  const distToCurrent = distanceSquared3D(unit.position, closest.position);
                  const distToEnemy = distanceSquared3D(unit.position, enemy.position);
                  return distToEnemy < distToCurrent ? enemy : closest;
                });
              }
            }
          } else if (shouldThinkThisTick) {
            // AI FOCUS-FIRE: First check if current target is still valid
            let currentTarget: Unit | null = null;

            // Check if we have a current focus target that's still alive and reachable
            if (unit.lastCombatTargetId) {
              const focusTarget = draft.units.find(u => u.id === unit.lastCombatTargetId);
              if (focusTarget && focusTarget.ownerId !== unit.ownerId && focusTarget.hp > 0) {
                const distanceToFocus = Math.sqrt(distanceSquared3D(unit.position, focusTarget.position));
                // Stick with current target if it's within reasonable range (50 units)
                if (distanceToFocus <= 50) {
                  currentTarget = focusTarget;
                  if (unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
                    console.log(`AI unit ${unit.animal} FOCUS-FIRE: sticking with ${focusTarget.animal}, distance: ${distanceToFocus.toFixed(1)}`);
                  }
                }
              }
            }

            // Only find new target if current focus target is dead/invalid
            if (!currentTarget) {
              currentTarget = findClosestEnemy(unit, draft.units);
              if (currentTarget) {
                // Log new target acquisition
                const distance = Math.sqrt(distanceSquared3D(unit.position, currentTarget.position));
                if (unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
                  console.log(`AI unit ${unit.animal} NEW TARGET: ${currentTarget.animal}, distance: ${distance.toFixed(1)} units`);
                }
              } else {
                // Log when no enemies found (should be rare)
                if (unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
                  console.log(`AI unit ${unit.animal} found no enemies on map`);
                }
              }
            }

            target = currentTarget;

            // Cache the target for AI units with extended persistence
            if (target) {
              const cacheKey = `${unit.id}-target`;
              draft.targetCache[cacheKey] = target.id;
              // PERSISTENCE FIX: Cache for longer to prevent target switching during collision
              const persistenceKey = `${unit.id}-target-persistence`;
              draft.targetCache[persistenceKey] = target.id;
            } else {
              // AGGRESSIVE AI FIX: If no target found anywhere on map, log this unusual situation
              console.log(`AI unit ${unit.animal} (${unit.id}) found no enemies anywhere on map`);
            }
          } else if (!isPlayerUnit) {
            // COMBAT PERSISTENCE: First try to re-engage last combat target if still valid
            if (unit.lastCombatTargetId && unit.lastCombatEngagementMs &&
                nowMs - unit.lastCombatEngagementMs < 3000) { // 3 second combat persistence
              const lastTarget = draft.units.find(u => u.id === unit.lastCombatTargetId);
              if (lastTarget && lastTarget.ownerId !== unit.ownerId && lastTarget.hp > 0) {
                const distToLastTarget = distanceSquared3D(unit.position, lastTarget.position);
                if (distToLastTarget <= 100) { // 10 units - closer re-engagement range
                  target = lastTarget;
                }
              }
            }

            // If no combat target found, use cached target for AI units on non-thinking frames
            // FOCUS-FIRE: Prioritize last combat target to maintain focus
            if (!target) {
              // First try to stick with last combat target (focus-fire)
              if (unit.lastCombatTargetId) {
                const focusTarget = draft.units.find(u => u.id === unit.lastCombatTargetId);
                if (focusTarget && focusTarget.ownerId !== unit.ownerId && focusTarget.hp > 0) {
                  const distanceToFocus = Math.sqrt(distanceSquared3D(unit.position, focusTarget.position));
                  // Stick with focus target if within range
                  if (distanceToFocus <= 50) {
                    target = focusTarget;
                  }
                }
              }

              // Fall back to cached target if no focus target
              if (!target) {
                const cacheKey = `${unit.id}-target`;
                const cachedTargetId = draft.targetCache[cacheKey];
                if (cachedTargetId) {
                  target = draft.units.find(u => u.id === cachedTargetId && u.hp > 0) || null;
                  // Clear invalid cached targets
                  if (!target) {
                    delete draft.targetCache[cacheKey];
                  }
                }
              }
            }
          }
        }

        // COMBAT EXECUTION SECTION: Handle all units with targets (both player and AI)
        // This section processes combat for units that have targets from any source:
        // - Player units: targets from attack response (Priority 2)
        // - AI units: targets from enemy detection above
        if (target) {
          // Process combat logic here (moved from below)
          // OPTIMIZED: Reduced distance calculations
          const distSquared = distanceSquared3D(unit.position, target.position);

          // Debug: Log target acquisition and movement (throttled to avoid spam)
          if (unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
            const playerType = isPlayerUnit ? 'PLAYER' : 'AI';
            console.log(`${playerType} ${unit.animal} found target: ${target.animal}, distance: ${Math.sqrt(distSquared).toFixed(1)}`);
          }

          // Always face the enemy when in combat
          const direction = normalize3D(subtract3D(target.position, unit.position));
          unit.rotation = Math.atan2(direction.x, direction.z);

          // Debug: Check if player units are reaching combat logic
          if (isPlayerUnit && unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
            console.log(`PLAYER unit ${unit.animal} has TARGET: ${target.animal}, distance: ${Math.sqrt(distSquared).toFixed(1)}, attack range: 4`);
          }

          if (distSquared <= 16) { // Attack range (4^2 = 16) - Close melee combat
            // Within attack range - attack AND continue moving closer for more aggressive behavior
            if (nowMs - unit.lastAttackAtMs >= unit.attackCooldownMs) {
              // Add to combat batch instead of immediate damage
              combatPairs.push({ attacker: unit, target, damage: unit.attackDamage });
              unit.lastAttackAtMs = nowMs;

              // COMBAT PERSISTENCE: Track combat engagement
              unit.lastCombatTargetId = target.id;
              unit.lastCombatEngagementMs = nowMs;

              // Track units under attack for immediate response
              unitsUnderAttack.add(target.id);

              // IMMEDIATE: Track this attack for the target unit to enable instant response
              if (!target.currentAttackers) {
                target.currentAttackers = [];
              }
              target.currentAttackers.push(unit.id);

              // DEBUG: Verify attacker tracking is working
              const isTargetPlayer = target.ownerId === draft.localPlayerId;
              if (isTargetPlayer) {
                console.log(`ATTACKER TRACKED: ${unit.animal} (${unit.ownerId}) -> ${target.animal} (PLAYER). Target now has ${target.currentAttackers.length} attackers: [${target.currentAttackers.map(id => draft.units.find(u => u.id === id)?.animal || id).join(', ')}]`);
              }
              console.log(`Combat queued: ${unit.animal} vs ${target.animal}, distance: ${Math.sqrt(distSquared).toFixed(1)}`);
            }

            // Owl should keep flying even while attacking
            if (unit.animal === 'Owl') {
              unit.isFlying = true;
              const flapSpeed = 3; // Flaps per second
              unit.wingPhase = ((unit.wingPhase || 0) + (flapSpeed * dtSec)) % 1;
            }
          }

          // Move toward target if not in melee range
          if (distSquared > 16) { // Move closer until within attack range (4 units)
            const direction = normalize3D(subtract3D(target.position, unit.position));
            const moveDistance = unit.moveSpeed * dtSec;

            const newPosition = {
              x: unit.position.x + direction.x * moveDistance,
              y: unit.position.y,
              z: unit.position.z + direction.z * moveDistance
            };

            // Apply collision detection with more lenient collision for combat units
            unit.position = checkCollision(newPosition, unit, draft.units, 2.5, draft.selectedUnitIds, draft.localPlayerId, draft.unitOrders);

            // Frog and Bunny hopping animation (AI units)
            if (unit.animal === 'Frog' || unit.animal === 'Bunny') {
              unit.isHopping = true;
              const hopSpeed = unit.moveSpeed / 5;
              unit.hopPhase = ((unit.hopPhase || 0) + (hopSpeed * dtSec)) % 1;
            } else {
              unit.isHopping = false;
            }

            // Owl flying animation (AI units)
            if (unit.animal === 'Owl') {
              unit.isFlying = true;
              const flapSpeed = 3; // Flaps per second
              unit.wingPhase = ((unit.wingPhase || 0) + (flapSpeed * dtSec)) % 1;
            } else if (unit.animal !== 'Owl') {
              unit.isFlying = false;
            }
          }
        }

        // ALWAYS update owl wing animation if they're flying (even when idle/hovering)
        if (unit.animal === 'Owl' && unit.isFlying) {
          const flapSpeed = 3; // Flaps per second
          unit.wingPhase = ((unit.wingPhase || 0) + (flapSpeed * dtSec)) % 1;
        }
      }

      // Note: Attacker tracking will be cleared at the end of the tick after all processing

      // Debug: Log combat pairs processing
      if (combatPairs.length > 0 && draft.tickCounter % 60 === 0) {
        console.log(`Processing ${combatPairs.length} combat pairs this tick`);
      }

      // Process combat pairs
      for (const { attacker, target, damage } of combatPairs) {

        // Debug: Log when player units are being attacked
        const targetOwner = draft.players.find(p => p.id === target.ownerId);
        if (targetOwner && !targetOwner.isAI) {
          console.log(`COMBAT: ${attacker.animal} (${attacker.ownerId}) attacking PLAYER ${target.animal} (${target.id})`);
        }

        const oldHp = target.hp;
        target.hp -= damage;
        if (target.hp <= 0) {
          console.log(`Unit ${target.animal} (${target.ownerId}) killed by ${attacker.animal} (${attacker.ownerId})`);
          draft.deadUnitsToRemove.push(target.id);
        }

        // Apply knockback effect (but not to Bases - they should stay stationary)
        const knockbackDistance = 0.8; // Small knockback distance
        const direction = normalize3D(subtract3D(target.position, attacker.position));

        // Only apply knockback if target is still alive, not a Base, and direction is valid
        if (target.hp > 0 && target.kind !== 'Base' && (direction.x !== 0 || direction.z !== 0)) {
          const newPosition = {
            x: target.position.x + direction.x * knockbackDistance,
            y: target.position.y,
            z: target.position.z + direction.z * knockbackDistance
          };

          // Apply collision detection to the knockback position
          target.position = checkCollision(newPosition, target, draft.units, 2.5, draft.selectedUnitIds, draft.localPlayerId, draft.unitOrders);
        }
      }

      // Debug: Log dead unit removal
      if (draft.deadUnitsToRemove.length > 0) {
        console.log(`Removing ${draft.deadUnitsToRemove.length} dead units`);
      }

      // Immediate dead unit removal to prevent regeneration of dead units
      if (draft.deadUnitsToRemove.length > 0) {
        // Clean up references to dead units
        for (const deadUnitId of draft.deadUnitsToRemove) {
          // Clear priority attacker references if the dead unit was a priority attacker
          for (const unit of draft.units) {
            if (unit.priorityAttacker === deadUnitId) {
              delete unit.priorityAttacker;
            }
            // FOCUS-FIRE: Clear last combat target if it died (prevents AI from getting stuck)
            if (unit.lastCombatTargetId === deadUnitId) {
              delete unit.lastCombatTargetId;
              delete unit.lastCombatEngagementMs;
            }
            // Remove from current attackers list
            if (unit.currentAttackers) {
              unit.currentAttackers = unit.currentAttackers.filter(id => id !== deadUnitId);
            }
          }

          // Also clear from target cache
          for (const cacheKey in draft.targetCache) {
            if (draft.targetCache[cacheKey] === deadUnitId) {
              delete draft.targetCache[cacheKey];
            }
          }
        }

        draft.units = draft.units.filter((u) => u.hp > 0 && !draft.deadUnitsToRemove.includes(u.id));
        draft.deadUnitsToRemove = [];

        // Rebuild spatial grid after removing dead units (important for next tick)
        if (draft.spatialGrid) {
          draft.spatialGrid.buildFromUnits(draft.units);
        }
      }

      // DEBUG: Log game state after all processing (every 60 ticks to reduce spam)
      if (draft.debugTickCount % 60 === 0) {
        const playerUnits = draft.units.filter(u => u.ownerId === draft.localPlayerId);
        const aiUnits = draft.units.filter(u => u.ownerId !== draft.localPlayerId);
        const playerUnitsUnderAttack = draft.units.filter(u => u.ownerId === draft.localPlayerId && u.currentAttackers && u.currentAttackers.length > 0);
        console.log(`🎮 GAME TICK #${draft.debugTickCount} - Total Units: ${draft.units.length} (Player: ${playerUnits.length}, AI: ${aiUnits.length}), Combat Pairs: ${combatPairs.length}`);
        if (playerUnitsUnderAttack.length > 0) {
          console.log(`Player units under attack: ${playerUnitsUnderAttack.map(u => `${u.animal}(${u.currentAttackers?.length || 0} attackers)`).join(', ')}`);
        }
      }

      // FINAL: Clean up invalid attackers (dead or too far away) but preserve valid ones
      // This allows persistent attack tracking for proper response
      for (const unit of draft.units) {
        if (unit.currentAttackers && unit.currentAttackers.length > 0) {
          // Remove dead attackers and attackers that are too far away
          unit.currentAttackers = unit.currentAttackers.filter(attackerId => {
            const attacker = draft.units.find(u => u.id === attackerId);
            if (!attacker || attacker.hp <= 0) return false; // Dead attacker
            const distance = Math.sqrt(distanceSquared3D(unit.position, attacker.position));
            return distance <= 50; // Remove if attacker is more than 50 units away
          });
          // Clean up empty arrays
          if (unit.currentAttackers.length === 0) {
            delete unit.currentAttackers;
          }
        }
      }


      // Update bridge animations
      updateBridgeAnimations(draft, nowMs);

      // Throttled win condition checks (every 5 seconds instead of every tick)
      const WIN_CHECK_INTERVAL = 5000; // 5 seconds
      if (!draft.gameOver && (!draft.optimizations.winCheckThrottling || nowMs - draft.lastWinCheckMs >= WIN_CHECK_INTERVAL)) {
        checkWinConditions(draft);
        if (draft.optimizations.winCheckThrottling) {
          draft.lastWinCheckMs = nowMs;
        }
      }
    })
  ),

  moveCommand: (cmd) => set((prev) =>
    produce(prev, (draft) => {
      for (const id of cmd.unitIds) {
        const u = draft.units.find((x) => x.id === id);
        if (!u || u.ownerId !== draft.localPlayerId) continue; // Only allow moving own units

        // Set new movement order
        draft.unitOrders[id] = cmd.target;

        // Reset unit state to prioritize new player order
        u.unitState = 'moving_to_order';
        delete u.arrivedAtDestinationMs;

        // Clear any combat state when new order given (override attack response)
        delete u.lastCombatTargetId;
        delete u.lastCombatEngagementMs;
        delete u.priorityAttacker;

        // Clear blocking state when new order given
        u.collisionAttempts = 0;
        delete u.movementPausedUntilMs;
        delete u.firstBlockedAtMs;

        // Clear owl landing timer
        delete u.nearDestinationSinceMs;

        console.log(`PLAYER issued new order to ${u.animal} - switching to MOVING_TO_ORDER state`);
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

  attackTarget: (cmd) => set((prev) =>
    produce(prev, (draft) => {
      const target = draft.units.find(u => u.id === cmd.targetId);
      if (!target) return;

      for (const id of cmd.unitIds) {
        const unit = draft.units.find(u => u.id === id);
        if (!unit || unit.ownerId !== draft.localPlayerId) continue;

        // Set movement target to enemy position
        draft.unitOrders[id] = { x: target.position.x, y: 0, z: target.position.z };

        // Reset unit state to prioritize attack order
        unit.unitState = 'pursuing_enemy';
        delete unit.arrivedAtDestinationMs;

        // Clear blocking state
        unit.collisionAttempts = 0;
        delete unit.movementPausedUntilMs;
        delete unit.firstBlockedAtMs;

        // Clear owl landing timer
        delete unit.nearDestinationSinceMs;

        console.log(`Unit ${unit.animal} targeting enemy ${cmd.targetId}`);
      }
    })
  ),

  selectUnits: (unitIds) => set({ selectedUnitIds: unitIds }),
  
  addToSelection: (unitIds) => set((prev) => ({
    selectedUnitIds: Array.from(new Set([...prev.selectedUnitIds, ...unitIds]))
  })),
  
  clearSelection: () => set({ selectedUnitIds: [] }),

  toggleOptimization: (key) => set((prev) => ({
    optimizations: {
      ...prev.optimizations,
      [key]: !prev.optimizations[key]
    }
  })),

  updateBridgeAnimations: (nowMs) => set((prev) =>
    produce(prev, (draft) => {
      updateBridgeAnimations(draft, nowMs);
    })
  ),
}));

function baseStats(animal: AnimalId) {
  return ANIMALS[animal];
}

function createBase(ownerId: string, animal: AnimalId, position: Position3D, rotation: number = 0): Unit {
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
    attackCooldownMs: 1500,
    lastAttackAtMs: 0,
    rotation,
  };
}

function createQueen(ownerId: string, animal: AnimalId, position: Position3D, rotation: number = 0): Unit {
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
    moveSpeed: stats.speed * 1.53,
    attackCooldownMs: 1500,
    lastAttackAtMs: 0,
    rotation,
  };
}

function createKing(ownerId: string, animal: AnimalId, position: Position3D, rotation: number = 0): Unit {
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
    moveSpeed: stats.speed * 0.85,
    attackCooldownMs: 1500,
    lastAttackAtMs: 0,
    rotation,
  };
}

function createUnit(ownerId: string, animal: AnimalId, position: Position3D, rotation: number = 0): Unit {
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
    attackCooldownMs: 1500,
    lastAttackAtMs: 0,
    rotation,
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

// Performance-optimized collision detection function
function checkCollision(newPosition: Position3D, currentUnit: Unit, allUnits: Unit[], collisionRadius: number = 2.5, selectedUnitIds: string[] = [], localPlayerId: string | null = null, unitOrders: Record<string, any> = {}): Position3D {
  let adjustedPosition = { ...newPosition };
  let hasCollision = false;

  // Pre-calculate squared collision radius for faster distance checks
  const collisionRadiusSquared = collisionRadius * collisionRadius;

  // Pre-calculate unit classification to avoid repeated lookups
  const isCurrentUnitSelected = selectedUnitIds.includes(currentUnit.id);
  // SIMPLIFIED: Use localPlayerId to identify human player units
  const isCurrentUnitPlayer = currentUnit.ownerId === localPlayerId;

  // Use spatial grid if available for faster nearby unit lookup
  let nearbyUnits: Unit[];
  if (allUnits.length > 50) {
    // For large unit counts, only check units within a reasonable range
    const checkRadius = collisionRadius * 3; // Check slightly larger area
    nearbyUnits = allUnits.filter(other => {
      if (other.id === currentUnit.id || other.kind === 'Base') return false;
      const dx = other.position.x - adjustedPosition.x;
      const dz = other.position.z - adjustedPosition.z;
      return (dx * dx + dz * dz) <= (checkRadius * checkRadius);
    });
  } else {
    nearbyUnits = allUnits.filter(other => other.id !== currentUnit.id && other.kind !== 'Base');
  }

  for (const other of nearbyUnits) {
    // PLAYER MOVEMENT FIX: Allow selected units to gently push through unselected friendly units
    const isOtherUnitPlayer = other.ownerId === localPlayerId;
    const isOtherUnitSelected = selectedUnitIds.includes(other.id);

    // Special handling for selected player units moving through unselected friendly units
    const shouldReduceCollision = isCurrentUnitSelected && isCurrentUnitPlayer &&
                                 isOtherUnitPlayer && !isOtherUnitSelected;

    // Use squared distance for faster comparison (avoid Math.sqrt)
    const dx = adjustedPosition.x - other.position.x;
    const dz = adjustedPosition.z - other.position.z;
    const distanceSquared = dx * dx + dz * dz;

    // Skip collision with enemies when very close (allow units to get within melee range)
    const isEnemy = currentUnit.ownerId !== other.ownerId;
    const isFriendly = currentUnit.ownerId === other.ownerId;

    if (isEnemy && distanceSquared <= 4) { // Within 2 units, allow very close combat
      continue;
    }

    // UNIT SPACING FIX: Enforce 2.5 unit minimum distance for all units
    // Increase spacing for Yetti units by 1 unit
    const baseMinimumDistance = 2.5;
    const yetiSpacingBonus = (currentUnit.animal === 'Yetti' || other.animal === 'Yetti') ? 1.0 : 0;
    const minimumDistance = baseMinimumDistance + yetiSpacingBonus;
    const minimumDistanceSquared = minimumDistance * minimumDistance;

    if (distanceSquared < minimumDistanceSquared) {
      const distance = Math.sqrt(distanceSquared); // Only calculate when needed

      // Calculate push-away direction (optimized)
      let pushDirectionX, pushDirectionZ;

      if (distance < 0.001) {
        // Units at same position - use cached random direction
        const randomAngle = Math.random() * Math.PI * 2;
        pushDirectionX = Math.cos(randomAngle);
        pushDirectionZ = Math.sin(randomAngle);
      } else {
        // Normalize direction vector
        const invDistance = 1.0 / distance;
        pushDirectionX = dx * invDistance;
        pushDirectionZ = dz * invDistance;
      }

      // SPACING FIX: Different behavior for friendly vs enemy units
      if (isFriendly) {
        // PLAYER MOVEMENT FIX: Reduce collision for selected units moving through unselected friendly units
        let pushStrength = 0.5; // Default 50% push strength

        if (shouldReduceCollision) {
          // Selected player units push through unselected friendly units more easily
          pushStrength = 0.2; // Reduced to 20% for easier movement
        }

        const pushDistance = (minimumDistance - distance) * pushStrength;
        adjustedPosition.x += pushDirectionX * pushDistance;
        adjustedPosition.z += pushDirectionZ * pushDistance;
        // Don't set hasCollision = true for friendly units (no movement pause)
      } else {
        // Enemy units: Full push to maintain 2.5 unit spacing + strong collision
        hasCollision = true;
        const pushDistance = minimumDistance - distance + 0.2; // Slightly larger buffer for enemies
        adjustedPosition.x += pushDirectionX * pushDistance;
        adjustedPosition.z += pushDirectionZ * pushDistance;
      }
    }
  }

  // Track collision attempts (only for enemy collisions now)
  if (hasCollision) {
    currentUnit.collisionAttempts = (currentUnit.collisionAttempts || 0) + 1;

    // PLAYER MOVEMENT FIX: Be more lenient with movement pauses for player units with active orders
    const hasActiveOrder = unitOrders[currentUnit.id] !== undefined;
    const isPlayerWithOrder = isCurrentUnitPlayer && hasActiveOrder;

    // Higher threshold for player units with movement orders
    const pauseThreshold = isPlayerWithOrder ? 8 : 5; // 8 attempts for ordered units, 5 for others
    const pauseDuration = isPlayerWithOrder ? 100 : 200; // 0.1s for ordered units, 0.2s for others

    if (currentUnit.collisionAttempts >= pauseThreshold) {
      currentUnit.movementPausedUntilMs = Date.now() + pauseDuration;
      currentUnit.collisionAttempts = 0; // Reset counter
    }
  } else {
    // Reset collision attempts when movement is successful
    currentUnit.collisionAttempts = 0;
  }

  return adjustedPosition;
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

// Memoized distance calculations to avoid expensive sqrt operations
const distanceCache = new Map<string, number>();
const CACHE_SIZE_LIMIT = 1000; // Prevent unlimited growth

function getCacheKey(a: Position3D, b: Position3D): string {
  // Round positions to reduce cache misses for very close positions
  const ax = Math.round(a.x * 10) / 10;
  const ay = Math.round(a.y * 10) / 10;
  const az = Math.round(a.z * 10) / 10;
  const bx = Math.round(b.x * 10) / 10;
  const by = Math.round(b.y * 10) / 10;
  const bz = Math.round(b.z * 10) / 10;
  return `${ax},${ay},${az}:${bx},${by},${bz}`;
}

// 3D utility functions with memoization
function distance3D(a: Position3D, b: Position3D): number {
  const cacheKey = getCacheKey(a, b);

  if (distanceCache.has(cacheKey)) {
    return distanceCache.get(cacheKey)!;
  }

  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // Manage cache size
  if (distanceCache.size >= CACHE_SIZE_LIMIT) {
    distanceCache.clear();
  }

  distanceCache.set(cacheKey, distance);
  return distance;
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

// Bridge animation system
function updateBridgeAnimations(draft: GameState & { bridgeState: BridgeState }, nowMs: number): void {
  // Define bridge trigger zones (center-right and center-left of map)
  const MAP_CENTER = { x: 0, z: 0 }; // Assuming map center is at origin
  const RIGHT_TRIGGER_ZONE = { x: 15, z: 0 }; // Center-right of map
  const LEFT_TRIGGER_ZONE = { x: -15, z: 0 }; // Center-left of map
  const TRIGGER_RADIUS = 10; // Units within 10 units of trigger zone

  // Find player's kings and queens
  const playerUnits = draft.units.filter(unit =>
    unit.ownerId === draft.localPlayerId &&
    (unit.kind === 'King' || unit.kind === 'Queen')
  );

  // Log player units for debugging (every 5 seconds)
  if (Math.floor(nowMs / 5000) !== Math.floor((nowMs - 16) / 5000)) {
    console.log(`Bridge debug: Found ${playerUnits.length} player kings/queens`,
      playerUnits.map(u => `${u.kind} ${u.animal} at (${u.position.x.toFixed(1)}, ${u.position.z.toFixed(1)})`));
  }

  // Check if any player king/queen is in right trigger zone
  const isPlayerInRightZone = playerUnits.some(unit => {
    const distance = Math.sqrt(
      Math.pow(unit.position.x - RIGHT_TRIGGER_ZONE.x, 2) +
      Math.pow(unit.position.z - RIGHT_TRIGGER_ZONE.z, 2)
    );
    if (distance <= TRIGGER_RADIUS) {
      console.log(`${unit.kind} ${unit.animal} in RIGHT trigger zone! Distance: ${distance.toFixed(1)}`);
    }
    return distance <= TRIGGER_RADIUS;
  });

  // Check if any player king/queen is in left trigger zone
  const isPlayerInLeftZone = playerUnits.some(unit => {
    const distance = Math.sqrt(
      Math.pow(unit.position.x - LEFT_TRIGGER_ZONE.x, 2) +
      Math.pow(unit.position.z - LEFT_TRIGGER_ZONE.z, 2)
    );
    if (distance <= TRIGGER_RADIUS) {
      console.log(`${unit.kind} ${unit.animal} in LEFT trigger zone! Distance: ${distance.toFixed(1)}`);
    }
    return distance <= TRIGGER_RADIUS;
  });

  // Update right bridge
  updateSingleBridgeAnimation(draft.bridgeState.rightBridge, isPlayerInRightZone, nowMs, 'right');

  // Update left bridge
  updateSingleBridgeAnimation(draft.bridgeState.leftBridge, isPlayerInLeftZone, nowMs, 'left');
}

function updateSingleBridgeAnimation(
  bridge: BridgeAnimation,
  isPlayerInZone: boolean,
  nowMs: number,
  bridgeName: string
): void {
  const FRAME_DURATION = 1000; // 1 second per frame

  // State machine for bridge animation
  switch (bridge.currentState) {
    case 'up':
      if (isPlayerInZone && !bridge.triggeredByPlayer) {
        // Start lowering animation
        bridge.currentState = 'lowering';
        bridge.animationStartMs = nowMs;
        bridge.frameStartMs = nowMs;
        bridge.triggeredByPlayer = true;
        console.log(`${bridgeName} bridge: Starting lowering animation`);
      }
      break;

    case 'lowering':
      const loweringElapsed = nowMs - bridge.frameStartMs;
      if (loweringElapsed >= FRAME_DURATION) {
        // Advance to next frame
        switch (bridge.currentFrame) {
          case 'Fully_Up':
            bridge.currentFrame = 'Almost_Up';
            bridge.frameStartMs = nowMs;
            console.log(`${bridgeName} bridge: Frame Almost_Up`);
            break;
          case 'Almost_Up':
            bridge.currentFrame = 'Almost_Down';
            bridge.frameStartMs = nowMs;
            console.log(`${bridgeName} bridge: Frame Almost_Down`);
            break;
          case 'Almost_Down':
            bridge.currentFrame = 'Fully_Down';
            bridge.frameStartMs = nowMs;
            bridge.currentState = 'down';
            console.log(`${bridgeName} bridge: Frame Fully_Down - Animation complete`);
            break;
        }
      }
      break;

    case 'down':
      if (!isPlayerInZone) {
        // Start raising animation
        bridge.currentState = 'raising';
        bridge.animationStartMs = nowMs;
        bridge.frameStartMs = nowMs;
        bridge.triggeredByPlayer = false;
        console.log(`${bridgeName} bridge: Starting raising animation`);
      }
      break;

    case 'raising':
      const raisingElapsed = nowMs - bridge.frameStartMs;
      if (raisingElapsed >= FRAME_DURATION) {
        // Advance to next frame (reverse order)
        switch (bridge.currentFrame) {
          case 'Fully_Down':
            bridge.currentFrame = 'Almost_Down';
            bridge.frameStartMs = nowMs;
            console.log(`${bridgeName} bridge: Frame Almost_Down (raising)`);
            break;
          case 'Almost_Down':
            bridge.currentFrame = 'Almost_Up';
            bridge.frameStartMs = nowMs;
            console.log(`${bridgeName} bridge: Frame Almost_Up (raising)`);
            break;
          case 'Almost_Up':
            bridge.currentFrame = 'Fully_Up';
            bridge.frameStartMs = nowMs;
            bridge.currentState = 'up';
            console.log(`${bridgeName} bridge: Frame Fully_Up - Animation complete`);
            break;
        }
      }
      break;
  }
}


