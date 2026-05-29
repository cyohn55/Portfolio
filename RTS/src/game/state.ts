import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { produce, setAutoFreeze } from 'immer';
import { SpatialGrid } from '../utils/SpatialGrid';

// The per-frame `tick` mutates unit objects in place for performance (see the
// comment on `tick`). The other store actions still use Immer's produce(), whose
// default auto-freeze would deep-freeze the shared `units` objects and make the
// next tick's in-place mutation throw. Disabling auto-freeze keeps both paths
// compatible (and slightly speeds up the remaining produce() calls).
setAutoFreeze(false);
import { terrainValidator } from '../utils/TerrainValidator';
import { pathfinder } from '../components/Working/pathfinder';
import type { Position3D, AnimalId, CommandMoveUnits, CommandSetPatrol, CommandAttackTarget, GameConfig, GameState, MatchStats, Player, Unit, PatrolRoute } from './types';
import { ANIMAL_MOVEMENT_TYPES } from './types';
import * as leaderboardModule from '../components/Working/leaderboard';
import * as leaderboardRemoteModule from '../components/Working/leaderboardRemote';

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


// Per-animal base stats across four combat axes: HP, per-hit damage, move speed,
// attack range, and attack cooldown (attack speed). Damage-per-second is
// dmg / (attackCooldownMs / 1000), so two animals with very different per-hit
// numbers can share a DPS while feeling completely different (a fast flurry of
// pecks vs a slow heavy slam).
//
// Every animal is tuned to the same overall power budget. Normalising attack
// speed to an "effective damage per 1.5s" lets us reuse one index:
//   effDmg      = dmg * 1500 / attackCooldownMs
//   speedFactor = 1 + speed / 40            (mobility is a modest premium)
//   rangeFactor = 1 + 0.085 * (range - 4)   (reach lets ranged units kite)
//   index       = sqrt(HP * effDmg) * speedFactor * rangeFactor  ~= 60 for all.
// Range and attack cooldown are real power, so they are paid for: ranged animals
// (Bee, Frog, Owl) trade away HP/DPS for reach, and fast attackers trade per-hit
// damage for cadence. Speed and range remain the identity axes; HP and per-hit
// damage are the levers used to settle the budget.
const ANIMALS: Record<AnimalId, { baseHp: number; dmg: number; speed: number; range: number; attackCooldownMs: number }> = {
  Bee: { baseHp: 40, dmg: 11, speed: 20.4, range: 9, attackCooldownMs: 800 },      // Fastest: fragile flying ranged kiter, rapid stings
  Bear: { baseHp: 95, dmg: 36, speed: 8.16, range: 4, attackCooldownMs: 2050 },    // Slow heavy slammer, biggest single hit
  Bunny: { baseHp: 80, dmg: 14, speed: 18.36, range: 4, attackCooldownMs: 1000 },  // Fast evasive melee skirmisher
  Chicken: { baseHp: 70, dmg: 14, speed: 19.04, range: 4, attackCooldownMs: 900 }, // Fast melee harasser, quick pecks
  Cat: { baseHp: 65, dmg: 20, speed: 16.32, range: 4, attackCooldownMs: 1100 },    // Agile melee duelist, high DPS
  Dolphin: { baseHp: 105, dmg: 19, speed: 13.6, range: 4, attackCooldownMs: 1500 },// Tanky aquatic all-rounder
  Fox: { baseHp: 90, dmg: 19, speed: 14.28, range: 4, attackCooldownMs: 1300 },    // Balanced melee bruiser
  Frog: { baseHp: 60, dmg: 14, speed: 17.68, range: 8, attackCooldownMs: 1300 },   // Amphibious ranged skirmisher (tongue)
  Owl: { baseHp: 45, dmg: 15, speed: 14.96, range: 11, attackCooldownMs: 1400 },   // Longest-range flying sniper, fragile
  Pig: { baseHp: 120, dmg: 20, speed: 12.24, range: 4, attackCooldownMs: 1700 },   // Sturdy slow tank, heavy hits
  Turtle: { baseHp: 155, dmg: 23, speed: 6.8, range: 4, attackCooldownMs: 2000 },  // HP wall, slow weighty blows
  Yetti: { baseHp: 120, dmg: 27, speed: 7.48, range: 4, attackCooldownMs: 1900 },  // Slow juggernaut, high HP and damage
};

// Attack range below which an animal is treated as melee. Above it, the combat
// loop lets the unit attack from distance and back away from faster-closing melee
// threats (kiting) instead of walking into their swing.
const MELEE_RANGE = 5;

// Full roster of playable animals, derived from the stats table so it stays in
// sync automatically when animals are added or removed.
const ALL_ANIMALS = Object.keys(ANIMALS) as AnimalId[];

/**
 * Returns `count` distinct animals chosen uniformly at random from the full
 * roster. Used to give the AI opponent a varied lineup each match instead of a
 * fixed set. Uses a partial Fisher-Yates shuffle so every animal has an equal
 * chance of being picked without repeats.
 */
function pickRandomAnimals(count: number): AnimalId[] {
  const roster = [...ALL_ANIMALS];
  for (let i = roster.length - 1; i > 0; i--) {
    const swapIndex = Math.floor(Math.random() * (i + 1));
    [roster[i], roster[swapIndex]] = [roster[swapIndex], roster[i]];
  }
  return roster.slice(0, count);
}

const defaultConfig: GameConfig = {
  mapSize: 50,
  spawnIntervalMs: 5_000,
  regenPerSecondNearQueen: 5,
  regenRadius: 8,
  kingAuraRadius: 8,
  kingDamageMultiplier: 2,
};

// Zero-valued match scoring counters. Used as the starting point on every new
// match and re-exported as a factory so callers don't share a mutable reference.
function createEmptyMatchStats(): MatchStats {
  return {
    unitsGenerated: 0,
    enemyUnitsKilled: 0,
    enemyBasesDestroyed: 0,
    enemyKingsKilled: 0,
    enemyQueensKilled: 0,
    aiUnitsGenerated: 0,
    playerUnitsKilled: 0,
    playerBasesDestroyed: 0,
    playerKingsKilled: 0,
    playerQueensKilled: 0,
    matchDurationMs: 0,
    rightBridgeDownMs: 0,
    leftBridgeDownMs: 0,
    enemyRightBridgeDownMs: 0,
    enemyLeftBridgeDownMs: 0,
  };
}

type GameScreen = 'menu' | 'lobby' | 'playing' | 'postgame' | 'leaderboard';

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
  unpauseGame: () => void;
  // Lighting settings
  lightingSettings: {
    sunBrightness: number;
    moonBrightness: number;
    ambientLight: number;
    dayNightSpeed: number;
  };
  updateLightingSettings: (settings: Partial<Store['lightingSettings']>) => void;
  // Render quality
  shadowsEnabled: boolean;
  setShadowsEnabled: (enabled: boolean) => void;
  // Floating unit health bars (shown only while a unit is taking damage or healing)
  healthBarsEnabled: boolean;
  setHealthBarsEnabled: (enabled: boolean) => void;
  // Background music on/off (persisted across sessions)
  musicEnabled: boolean;
  setMusicEnabled: (enabled: boolean) => void;
};

// Persisted render-quality toggle. Shadows default OFF: enabling them adds a
// full shadow-map render pass that hurts FPS most on the low-end / integrated
// GPUs a portfolio visitor may be on. Players opt in from the pause menu.
const SHADOWS_STORAGE_KEY = 'rts-shadows-enabled';
const loadShadowsEnabled = (): boolean => {
  try {
    return localStorage.getItem(SHADOWS_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

// Persisted health-bar toggle. Defaults ON so players see damage/heal feedback;
// the video settings tab flips it and the choice survives page reloads. Stored
// as a string so the absence of the key (first visit) resolves to the default.
const HEALTH_BARS_STORAGE_KEY = 'rts-health-bars-enabled';
const loadHealthBarsEnabled = (): boolean => {
  try {
    const raw = localStorage.getItem(HEALTH_BARS_STORAGE_KEY);
    if (raw === null) return true; // default on
    return raw === 'true';
  } catch {
    return true;
  }
};

// Persisted background-music toggle. Defaults ON so first-time visitors hear
// the soundtrack; the speaker icon in the HUD flips it and the choice survives
// page reloads. Stored as a string so the absence of the key (first visit)
// resolves to the default rather than a forced "off".
const MUSIC_STORAGE_KEY = 'rts-music-enabled';
const loadMusicEnabled = (): boolean => {
  try {
    const raw = localStorage.getItem(MUSIC_STORAGE_KEY);
    if (raw === null) return true; // default on
    return raw === 'true';
  } catch {
    return true;
  }
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
  matchStats: createEmptyMatchStats(),
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
  unpauseGame: () => set({ isPaused: false }),
  lightingSettings: {
    sunBrightness: 5.0,
    moonBrightness: 5.0,
    ambientLight: 1.6,
    dayNightSpeed: 60,
  },
  updateLightingSettings: (settings) => set((state) => ({
    lightingSettings: { ...state.lightingSettings, ...settings }
  })),
  shadowsEnabled: loadShadowsEnabled(),
  setShadowsEnabled: (enabled) => {
    try {
      localStorage.setItem(SHADOWS_STORAGE_KEY, String(enabled));
    } catch {
      /* localStorage unavailable (private mode); setting still applies for the session */
    }
    set({ shadowsEnabled: enabled });
  },
  healthBarsEnabled: loadHealthBarsEnabled(),
  setHealthBarsEnabled: (enabled) => {
    try {
      localStorage.setItem(HEALTH_BARS_STORAGE_KEY, String(enabled));
    } catch {
      /* localStorage unavailable; setting still applies for the session */
    }
    set({ healthBarsEnabled: enabled });
  },
  musicEnabled: loadMusicEnabled(),
  setMusicEnabled: (enabled) => {
    try {
      localStorage.setItem(MUSIC_STORAGE_KEY, String(enabled));
    } catch {
      /* localStorage unavailable; setting still applies for the session */
    }
    set({ musicEnabled: enabled });
  },
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
        // Randomized each match so the player faces a varied opponent lineup.
        animals: pickRandomAnimals(3),
        basePositions: [{ x: 76.5, y: 0.25, z: -248 }, { x: 1, y: 0.25, z: -248 }, { x: -74, y: 0.25, z: -248 }],
      },
    ];

    set({ players, localPlayerId: localId, units: [], matchStarted: false, gameOver: false, winner: null, selectedUnitIds: [], unitOrders: {}, lastSpawnAtMsByQueenId: {}, lastRegenAtMsByUnitId: {}, queenPatrols: {}, unitCountCache: {}, spatialGrid: null, lastRegenCheckMs: 0, tickCounter: 0, aiThinkingOffset: {}, movementDirectionCache: {}, targetCache: {}, lastWinCheckMs: 0, deadUnitsToRemove: [], matchStats: createEmptyMatchStats(), optimizations: { aiThrottling: true, combatBatching: true, movementCaching: true, regenThrottling: true, winCheckThrottling: true, deadUnitBatching: true, spawnOptimization: true } });
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
      isPaused: true,
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
      matchStats: createEmptyMatchStats(),
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

  // Per-frame simulation runs OUTSIDE Immer. At hundreds of units, produce()
  // clones the units array plus every mutated unit each tick, and that garbage
  // causes periodic GC pauses (frame-time spikes). Here we read the live state
  // via get(), mutate units/records in place, and republish a fresh `units`
  // array reference at the end so ref-equality selectors still update. Other
  // (infrequent, user-triggered) store actions keep using Immer.
  tick: (dtSec, nowMs) => {
      const draft = get();
      // Halt simulation once the match has been decided. Otherwise queens keep
      // spawning, surviving units keep landing kills, and bridge-down time
      // keeps ticking — all of which accumulate into matchStats and inflate
      // the post-game score while the player is staring at it. (PostGameScreen
      // subscribes to `units`, which still gets a fresh array reference from
      // the set() at the end of tick, so the screen re-renders every frame
      // and the numbers visibly climb.)
      if (!draft.matchStarted || draft.isPaused || draft.gameOver) return;

      // DEBUG: Initialize tick counter
      if (!draft.debugTickCount) {
        draft.debugTickCount = 0;
        console.log('🎮 GAME LOOP STARTED - Debug logging initialized');
      }
      draft.debugTickCount++;

      draft.tickCounter++;

      // Reset the pathfinder's per-tick A* compute budget so bursts of new cross-map
      // orders are spread over a few ticks instead of hitching a single frame.
      pathfinder.beginTick(draft.tickCounter);

      // Verbose AI/combat logging is gated behind a dev flag. Building these
      // strings and writing to the console for hundreds of units every frame is
      // itself a dominant cost — and the fixed-timestep catch-up loop multiplies
      // it when a tick runs long. Off by default; enable in a dev session with
      // `window.__rtsTickDebug = true`.
      const tickDebug =
        import.meta.env.DEV &&
        typeof window !== 'undefined' &&
        (window as any).__rtsTickDebug === true;

      // Debug: Log game is running (every 5 seconds)
      if (tickDebug && draft.tickCounter % 300 === 0) {
        console.log(`Game tick ${draft.tickCounter}, units: ${draft.units.length}, started: ${draft.matchStarted}`);
      }

      // Owner lookup built once per tick. Avoids a draft.players.find() scan per
      // unit (cheap when players are few, but it ran for every unit every tick).
      const isAiByOwnerId: Record<string, boolean> = {};
      for (const player of draft.players) {
        isAiByOwnerId[player.id] = player.isAI;
      }

      // Reuse spatial grid instead of rebuilding every tick (major optimization).
      // A small cell size keeps neighbor queries cheap even when hundreds of
      // units pile into the same area during dense melee — a large cell would
      // return nearly every unit and collapse back toward O(n^2).
      if (!draft.spatialGrid) {
        draft.spatialGrid = new SpatialGrid(1000, 16);
      }
      draft.spatialGrid.buildFromUnits(draft.units);

      // Optimized single-pass unit filtering and caching (major CPU optimization)
      const unitCategories = {
        queens: [] as Unit[],
        kings: [] as Unit[],
        unitsNeedingHealing: [] as Unit[],
        movableUnits: [] as Unit[],
        playerUnits: {} as Record<string, Unit[]>,
        aiUnits: {} as Record<string, Unit[]>
      };

      // Single pass through units for all categorization
      const newUnitCountCache: Record<string, Record<AnimalId, number>> = {};

      // id -> unit lookup, built once per tick so combat/targeting can resolve
      // references in O(1) instead of scanning draft.units (was O(n^2)).
      let unitById = new Map<string, Unit>();

      for (const unit of draft.units) {
        unitById.set(unit.id, unit);

        // Type-based categorization
        if (unit.kind === 'Queen') unitCategories.queens.push(unit);
        if (unit.kind === 'King') unitCategories.kings.push(unit);
        if (unit.hp < unit.maxHp) unitCategories.unitsNeedingHealing.push(unit);
        if (unit.kind !== 'Base') unitCategories.movableUnits.push(unit);

        // Owner-based categorization for later use
        if (unit.ownerId in isAiByOwnerId) {
          const category = isAiByOwnerId[unit.ownerId] ? 'aiUnits' : 'playerUnits';
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
      const { queens, kings, unitsNeedingHealing, movableUnits } = unitCategories;

      // Aura pass (Queen heal + King damage). Computed once per tick off the
      // freshly built spatial grid so both gameplay (the King's damage buff) and
      // the on-ground ring visuals (auraActive) read the same proximity result.
      //
      // - Queen ring is "active" while a friendly army unit inside the radius is
      //   below max HP (i.e. it is actually being healed).
      // - King ring is "active" while a buffed army unit inside the radius is in
      //   recent combat. The King itself is never buffed (its base damage already
      //   one-shots most units); only Units/Queens around it get the multiplier.
      const RECENT_COMBAT_MS = 2000;
      const kingBuffedUnitIds = new Set<string>();
      {
        const grid = draft.spatialGrid!;
        for (const queen of queens) {
          const nearby = grid.getNearbyUnits(queen.position, draft.config.regenRadius);
          queen.auraActive = nearby.some(
            (u) => u.ownerId === queen.ownerId && u.kind === 'Unit' && u.hp < u.maxHp
          );
        }
        for (const king of kings) {
          const nearby = grid.getNearbyUnits(king.position, draft.config.kingAuraRadius);
          let active = false;
          for (const u of nearby) {
            if (u.ownerId !== king.ownerId || u.kind === 'Base' || u.kind === 'King') continue;
            kingBuffedUnitIds.add(u.id);
            if (!active && u.lastCombatEngagementMs && nowMs - u.lastCombatEngagementMs < RECENT_COMBAT_MS) {
              active = true;
            }
          }
          king.auraActive = active;
        }
      }

      // BALANCED: Moderate health regeneration throttling
      const REGEN_INTERVAL_MS = 3000; // 3 seconds
      const REGEN_AMOUNT = 1;
      const REGEN_CHECK_FREQUENCY = 3; // Restored to 3 ticks

      // Heal scaled by a unit's HP tier so larger pools top off quickly instead
      // of trickling for many minutes. Army Units heal at the base amount; the
      // bigger-pool kinds get a multiplier so they refill fast (Kings boosted to
      // 6x by request, not strict maxHp/baseHp).
      const REGEN_TIER_BY_KIND: Record<Unit['kind'], number> = {
        Unit: 1,
        Queen: 2,
        King: 6,
        Base: 8,
      };

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
            const healAmount = REGEN_AMOUNT * REGEN_TIER_BY_KIND[unit.kind];
            unit.hp = Math.min(unit.maxHp, unit.hp + healAmount);
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

          // Cap of 50 units per animal, per team (150 per team across 3 animals)
          if (existingCount < 50) {
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
            const finalSpawnPos = checkCollision(tentativeSpawnPos, tempUnit, draft.units, 2.5, draft.selectedUnitIds, draft.localPlayerId, draft.unitOrders, draft.spatialGrid);
            tempUnit.position = finalSpawnPos;
            draft.units.push(tempUnit);

            // Scoring + post-game stats: count units generated per side. Only
            // the local player's unitsGenerated feeds the leaderboard score
            // (see computeScore); the AI mirror is for the side-by-side
            // comparison on the post-game screen.
            if (q.ownerId === draft.localPlayerId) {
              draft.matchStats.unitsGenerated++;
            } else {
              draft.matchStats.aiUnitsGenerated++;
            }
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
        const isPlayerUnit = unit.ownerId in isAiByOwnerId && !isAiByOwnerId[unit.ownerId];
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
          if (tickDebug && unit.id.endsWith('0') && draft.tickCounter % 120 === 0) {
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

            // On a bridge deck there is no good "give up here" position: dropping the
            // order leaves the unit idling on a narrow chokepoint where it will be
            // killed in place. Hold the order — the unwedge/pass-through logic in
            // checkCollision is what lets it actually complete the crossing.
            const onBridgeMidCrossing =
              ANIMAL_MOVEMENT_TYPES[unit.animal] === 'ground' &&
              terrainValidator.bridgeAt(unit.position).onBridge;

            if (isCurrentlyBlocked && !onBridgeMidCrossing) {
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

                if (tickDebug && unit.id.endsWith('0')) {
                  console.log(`PLAYER unit ${unit.animal} BLOCKED for ${(blockedDuration/1000).toFixed(1)}s - abandoning order and switching to IDLE state`);
                }
              }
            } else {
              // Unit is not blocked (or is mid-crossing) - clear block tracking
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
                if (tickDebug) console.log(`Owl ${unit.id} landing after hovering near destination`);
              }
            } else if (unit.animal === 'Owl' && distanceToOrder > 15) {
              // Reset timer if moved away from destination
              delete unit.nearDestinationSinceMs;
            }

            // Move toward ordered position (but allow combat interruption)
            if (distanceToOrder > 0.5 && !isMovementPaused) {
              const direction = normalize3D(subtract3D(steeringTarget(unit, order), unit.position));
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
              } else {
                unit.isFlying = false;
              }

              const newPosition = {
                x: unit.position.x + direction.x * moveDistance,
                y: unit.position.y,
                z: unit.position.z + direction.z * moveDistance
              };

              // Always apply collision detection for player-ordered movement (highest priority)
              unit.position = checkCollision(newPosition, unit, draft.units, 2.5, draft.selectedUnitIds, draft.localPlayerId, draft.unitOrders, draft.spatialGrid);

              // Debug: Log movement for player units
              if (tickDebug && unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
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
              if (tickDebug) console.log(`PLAYER unit ${unit.animal} reached destination - entering IDLE state`);
            }
          }

          // PRIORITY 2: When idle (no movement orders), check for attack response
          else {
            // Debug: Log when entering Priority 2 (idle state) logic
            if (tickDebug && unit.id.endsWith('0') && draft.tickCounter % 30 === 0) {
              console.log(`📍 PLAYER ${unit.animal} entered IDLE state - no active movement orders`);
            }

            // ATTACK RESPONSE: When idle and under attack, fight back until enemy defeated or new order given
            if (unit.currentAttackers && unit.currentAttackers.length > 0) {
              // Debug: Log when player units are under attack while idle
              if (tickDebug && unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
                console.log(`PLAYER unit ${unit.animal} IDLE but UNDER ATTACK by ${unit.currentAttackers.length} attackers`);
              }

              // Select priority attacker (focus-fire: attack one until dead)
              let priorityAttacker: Unit | null = null;

              // First try to stick with current priority attacker if still attacking
              if (unit.priorityAttacker && unit.currentAttackers.includes(unit.priorityAttacker)) {
                priorityAttacker = unitById.get(unit.priorityAttacker) || null;
              }

              // If no priority attacker or they're not attacking anymore, find closest attacker
              if (!priorityAttacker) {
                const attackers = unit.currentAttackers
                  .map(id => unitById.get(id))
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
                if (tickDebug) console.log(`✅ PLAYER ${unit.animal} IDLE → fighting back against ${target.animal} (focus-fire)`);

                // Debug: Confirm target is set for combat
                if (tickDebug && unit.id.endsWith('0')) {
                  console.log(`PLAYER unit ${unit.animal} combat target: ${target.animal} - will fight until defeated or new order given`);
                }
              }
            }
            // Clear priority attacker if no longer under attack and return to idle
            else if (unit.priorityAttacker) {
              delete unit.priorityAttacker;
              unit.unitState = 'idle';
              if (tickDebug) console.log(`PLAYER unit ${unit.animal} defeated all attackers → returning to IDLE state`);
            }

            // PRIORITY 3: Autonomous enemy detection when idle (enabled but with limited range)
            // Player units will engage nearby enemies when not under attack and idle
            else if (unit.unitState === 'idle' || unit.unitState === 'pursuing_enemy') {
              // Detect nearby enemies
              let enemyTarget: Unit | null = null;

              // If we have a priority attacker that was just defeated, clear it
              if (unit.priorityAttacker) {
                const priorityAttackerUnit = unitById.get(unit.priorityAttacker);
                if (!priorityAttackerUnit || priorityAttackerUnit.hp <= 0) {
                  delete unit.priorityAttacker;
                  if (tickDebug) console.log(`PLAYER unit ${unit.animal} defeated attacker - checking for other enemies`);
                }
              }

              // First try to re-engage recent combat target (unless it was our priority attacker we just defeated)
              if (unit.lastCombatTargetId && unit.lastCombatEngagementMs &&
                  nowMs - unit.lastCombatEngagementMs < 3000 &&
                  unit.lastCombatTargetId !== unit.priorityAttacker) {
                const lastTarget = unitById.get(unit.lastCombatTargetId);
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
                if (tickDebug && unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
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
            const direction = normalize3D(subtract3D(steeringTarget(unit, order), unit.position));
            const moveDistance = unit.moveSpeed * dtSec;
            unit.rotation = Math.atan2(direction.x, direction.z);

            // Owl flying animation (AI units with orders)
            if (unit.animal === 'Owl') {
              unit.isFlying = true;
              const flapSpeed = 3; // Flaps per second
              unit.wingPhase = ((unit.wingPhase || 0) + (flapSpeed * dtSec)) % 1;
            } else {
              unit.isFlying = false;
            }

            const newPosition = {
              x: unit.position.x + direction.x * moveDistance,
              y: unit.position.y,
              z: unit.position.z + direction.z * moveDistance
            };

            unit.position = checkCollision(newPosition, unit, draft.units, 2.5, draft.selectedUnitIds, draft.localPlayerId, draft.unitOrders, draft.spatialGrid);
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
            const direction = normalize3D(subtract3D(steeringTarget(unit, targetPos), unit.position));
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
            unit.position = checkCollision(newPosition, unit, draft.units, 2.5, draft.selectedUnitIds, draft.localPlayerId, draft.unitOrders, draft.spatialGrid);
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
              const lastTarget = unitById.get(unit.lastCombatTargetId);
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
              const focusTarget = unitById.get(unit.lastCombatTargetId);
              if (focusTarget && focusTarget.ownerId !== unit.ownerId && focusTarget.hp > 0) {
                const distanceToFocus = Math.sqrt(distanceSquared3D(unit.position, focusTarget.position));
                // Stick with current target if it's within reasonable range (50 units)
                if (distanceToFocus <= 50) {
                  currentTarget = focusTarget;
                  if (tickDebug && unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
                    console.log(`AI unit ${unit.animal} FOCUS-FIRE: sticking with ${focusTarget.animal}, distance: ${distanceToFocus.toFixed(1)}`);
                  }
                }
              }
            }

            // Only find new target if current focus target is dead/invalid
            if (!currentTarget) {
              currentTarget = findClosestEnemy(unit, draft.spatialGrid, draft.units);
              if (currentTarget) {
                // Log new target acquisition
                const distance = Math.sqrt(distanceSquared3D(unit.position, currentTarget.position));
                if (tickDebug && unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
                  console.log(`AI unit ${unit.animal} NEW TARGET: ${currentTarget.animal}, distance: ${distance.toFixed(1)} units`);
                }
              } else {
                // Log when no enemies found (should be rare)
                if (tickDebug && unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
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
              if (tickDebug) console.log(`AI unit ${unit.animal} (${unit.id}) found no enemies anywhere on map`);
            }
          } else if (!isPlayerUnit) {
            // COMBAT PERSISTENCE: First try to re-engage last combat target if still valid
            if (unit.lastCombatTargetId && unit.lastCombatEngagementMs &&
                nowMs - unit.lastCombatEngagementMs < 3000) { // 3 second combat persistence
              const lastTarget = unitById.get(unit.lastCombatTargetId);
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
                const focusTarget = unitById.get(unit.lastCombatTargetId);
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
                  const cached = unitById.get(cachedTargetId);
                  target = cached && cached.hp > 0 ? cached : null;
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
          const attackRangeSq = unit.attackRange * unit.attackRange;
          const isRangedUnit = unit.attackRange > MELEE_RANGE;

          // Debug: Log target acquisition and movement (throttled to avoid spam)
          if (tickDebug && unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
            const playerType = isPlayerUnit ? 'PLAYER' : 'AI';
            console.log(`${playerType} ${unit.animal} found target: ${target.animal}, distance: ${Math.sqrt(distSquared).toFixed(1)}`);
          }

          // Always face the enemy when in combat
          const direction = normalize3D(subtract3D(target.position, unit.position));
          unit.rotation = Math.atan2(direction.x, direction.z);

          // Debug: Check if player units are reaching combat logic
          if (tickDebug && isPlayerUnit && unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
            console.log(`PLAYER unit ${unit.animal} has TARGET: ${target.animal}, distance: ${Math.sqrt(distSquared).toFixed(1)}, attack range: ${unit.attackRange}`);
          }

          if (distSquared <= attackRangeSq) { // Within this animal's attack range
            // Within attack range - attack AND continue moving closer for more aggressive behavior
            if (nowMs - unit.lastAttackAtMs >= unit.attackCooldownMs) {
              // Add to combat batch instead of immediate damage. Army units
              // standing inside a friendly King's aura deal multiplied damage.
              const buffedDamage = kingBuffedUnitIds.has(unit.id)
                ? unit.attackDamage * draft.config.kingDamageMultiplier
                : unit.attackDamage;
              combatPairs.push({ attacker: unit, target, damage: buffedDamage });
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
              if (tickDebug && target.ownerId === draft.localPlayerId) {
                console.log(`ATTACKER TRACKED: ${unit.animal} (${unit.ownerId}) -> ${target.animal} (PLAYER). Target now has ${target.currentAttackers.length} attackers: [${target.currentAttackers.map(id => draft.units.find(u => u.id === id)?.animal || id).join(', ')}]`);
              }
              if (tickDebug) console.log(`Combat queued: ${unit.animal} vs ${target.animal}, distance: ${Math.sqrt(distSquared).toFixed(1)}`);
            }

            // Owl should keep flying even while attacking
            if (unit.animal === 'Owl') {
              unit.isFlying = true;
              const flapSpeed = 3; // Flaps per second
              unit.wingPhase = ((unit.wingPhase || 0) + (flapSpeed * dtSec)) % 1;
            }
          }

          // Combat movement: close the gap when out of range, or — for a ranged
          // unit that a faster melee threat has closed in on — back away to keep
          // shooting from distance (kiting). Player move orders stay authoritative,
          // so neither advance-to-engage nor kiting kicks in while an order is set:
          // without this guard the order step (south toward dest) and the engage step
          // (north toward target) cancel out and the unit freezes mid-bridge.
          let combatMoveDir: Position3D | null = null;
          if (distSquared > attackRangeSq && !order) {
            // Out of range: advance toward the target (ground units route via bridges).
            combatMoveDir = normalize3D(subtract3D(steeringTarget(unit, target.position), unit.position));
          } else if (isRangedUnit && !order && target.kind !== 'Base' &&
                     unit.moveSpeed > target.moveSpeed) {
            // In range but a mobile threat is too close: retreat to the standoff
            // band (~85% of max range) so we keep firing without being meleed.
            const standoff = unit.attackRange * 0.85;
            if (distSquared < standoff * standoff) {
              combatMoveDir = normalize3D(subtract3D(unit.position, target.position));
            }
          }

          if (combatMoveDir) {
            const moveDistance = unit.moveSpeed * dtSec;

            const newPosition = {
              x: unit.position.x + combatMoveDir.x * moveDistance,
              y: unit.position.y,
              z: unit.position.z + combatMoveDir.z * moveDistance
            };

            // Apply collision detection with more lenient collision for combat units.
            // Ground animals are also kept out of water here (see checkCollision).
            unit.position = checkCollision(newPosition, unit, draft.units, 2.5, draft.selectedUnitIds, draft.localPlayerId, draft.unitOrders, draft.spatialGrid);

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
            } else {
              unit.isFlying = false;
            }
          }
        }

        // ALWAYS update owl wing animation if they're flying (even when idle/hovering)
        if (unit.animal === 'Owl' && unit.isFlying) {
          const flapSpeed = 3; // Flaps per second
          unit.wingPhase = ((unit.wingPhase || 0) + (flapSpeed * dtSec)) % 1;
        }

        // After all XZ movement/collision/combat for this unit is settled, snap Y to
        // the terrain so a ground unit on an arched bridge walks on top of the deck
        // instead of clipping through its walls at water level.
        applyDeckElevation(unit, dtSec);
      }

      // Note: Attacker tracking will be cleared at the end of the tick after all processing

      // Debug: Log combat pairs processing
      if (tickDebug && combatPairs.length > 0 && draft.tickCounter % 60 === 0) {
        console.log(`Processing ${combatPairs.length} combat pairs this tick`);
      }

      // Process combat pairs
      for (const { attacker, target, damage } of combatPairs) {

        // Debug: Log when player units are being attacked
        if (tickDebug && !isAiByOwnerId[target.ownerId]) {
          console.log(`COMBAT: ${attacker.animal} (${attacker.ownerId}) attacking PLAYER ${target.animal} (${target.id})`);
        }

        target.hp -= damage;
        if (target.hp <= 0) {
          if (tickDebug) console.log(`Unit ${target.animal} (${target.ownerId}) killed by ${attacker.animal} (${attacker.ownerId})`);
          draft.deadUnitsToRemove.push(target.id);

          // Attribution keys off the killing-blow attacker, so a target chipped
          // down by allied damage doesn't double-count. Track both sides:
          // - Player→enemy kills feed the leaderboard score AND the Your
          //   Forces card.
          // - AI→player kills are non-scoring but populate the Enemy Forces
          //   card so players can see how the AI fared against them.
          const isPlayerKillingEnemy =
            attacker.ownerId === draft.localPlayerId &&
            target.ownerId !== draft.localPlayerId;
          const isAiKillingPlayer =
            attacker.ownerId !== draft.localPlayerId &&
            target.ownerId === draft.localPlayerId;
          if (isPlayerKillingEnemy) {
            switch (target.kind) {
              case 'Base':  draft.matchStats.enemyBasesDestroyed++; break;
              case 'King':  draft.matchStats.enemyKingsKilled++;    break;
              case 'Queen': draft.matchStats.enemyQueensKilled++;   break;
              case 'Unit':  draft.matchStats.enemyUnitsKilled++;    break;
            }
          } else if (isAiKillingPlayer) {
            switch (target.kind) {
              case 'Base':  draft.matchStats.playerBasesDestroyed++; break;
              case 'King':  draft.matchStats.playerKingsKilled++;    break;
              case 'Queen': draft.matchStats.playerQueensKilled++;   break;
              case 'Unit':  draft.matchStats.playerUnitsKilled++;    break;
            }
          }
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
          target.position = checkCollision(newPosition, target, draft.units, 2.5, draft.selectedUnitIds, draft.localPlayerId, draft.unitOrders, draft.spatialGrid);
        }
      }

      // Debug: Log dead unit removal
      if (tickDebug && draft.deadUnitsToRemove.length > 0) {
        console.log(`Removing ${draft.deadUnitsToRemove.length} dead units`);
      }

      // Immediate dead unit removal to prevent regeneration of dead units
      if (draft.deadUnitsToRemove.length > 0) {
        // Set-based membership test turns the cleanup from O(dead * units) into
        // a single O(units) pass.
        const deadSet = new Set(draft.deadUnitsToRemove);

        // Clean up references to dead units in one pass.
        for (const unit of draft.units) {
          // Clear priority attacker reference if it died.
          if (unit.priorityAttacker && deadSet.has(unit.priorityAttacker)) {
            delete unit.priorityAttacker;
          }
          // FOCUS-FIRE: Clear last combat target if it died (prevents AI from getting stuck)
          if (unit.lastCombatTargetId && deadSet.has(unit.lastCombatTargetId)) {
            delete unit.lastCombatTargetId;
            delete unit.lastCombatEngagementMs;
          }
          // Remove dead attackers from current attackers list.
          if (unit.currentAttackers) {
            unit.currentAttackers = unit.currentAttackers.filter(id => !deadSet.has(id));
          }
        }

        // Clear dead units from the target cache in one pass.
        for (const cacheKey in draft.targetCache) {
          if (deadSet.has(draft.targetCache[cacheKey])) {
            delete draft.targetCache[cacheKey];
          }
        }

        draft.units = draft.units.filter((u) => u.hp > 0 && !deadSet.has(u.id));
        draft.deadUnitsToRemove = [];

        // Rebuild the id lookup so post-removal cleanup uses live units only.
        unitById = new Map(draft.units.map((u) => [u.id, u]));

        // Rebuild spatial grid after removing dead units (important for next tick)
        if (draft.spatialGrid) {
          draft.spatialGrid.buildFromUnits(draft.units);
        }
      }

      // DEBUG: Log game state after all processing (every 60 ticks to reduce spam)
      if (tickDebug && draft.debugTickCount % 60 === 0) {
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
            const attacker = unitById.get(attackerId);
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


      // Update bridge animations and capture who's currently holding each
      // trigger so we can credit Fully_Down time per side.
      const bridgePresence = updateBridgeAnimations(draft, nowMs);

      // Bridge time is scored independently per side. Sampled by dtSec so it
      // reflects real elapsed seconds independent of frame rate; scored in
      // 5-second slices in computeScore(). When both sides have a K/Q in the
      // zone simultaneously (contested), both sides accrue time — neither is
      // "stealing" credit from the other, and the leaderboard score still
      // rewards being there.
      const dtMs = dtSec * 1000;

      // Wall-clock match duration. The tick() function early-returns at the
      // top of the function when gameOver is true (see line ~384), so this
      // counter naturally freezes the instant the match is decided — exactly
      // what we want for the post-game "Match Time" stat and the leaderboard
      // tie-break.
      draft.matchStats.matchDurationMs += dtMs;
      if (draft.bridgeState.rightBridge.currentFrame === 'Fully_Down') {
        if (bridgePresence.playerInRightZone) draft.matchStats.rightBridgeDownMs       += dtMs;
        if (bridgePresence.enemyInRightZone)  draft.matchStats.enemyRightBridgeDownMs  += dtMs;
      }
      if (draft.bridgeState.leftBridge.currentFrame === 'Fully_Down') {
        if (bridgePresence.playerInLeftZone)  draft.matchStats.leftBridgeDownMs        += dtMs;
        if (bridgePresence.enemyInLeftZone)   draft.matchStats.enemyLeftBridgeDownMs   += dtMs;
      }

      // Throttled win condition checks (every 5 seconds instead of every tick)
      const WIN_CHECK_INTERVAL = 5000; // 5 seconds
      if (!draft.gameOver && (!draft.optimizations.winCheckThrottling || nowMs - draft.lastWinCheckMs >= WIN_CHECK_INTERVAL)) {
        checkWinConditions(draft);
        if (draft.optimizations.winCheckThrottling) {
          draft.lastWinCheckMs = nowMs;
        }
      }

      // Publish a fresh `units` array reference so ref-equality selectors (minimap,
      // HUD, interaction/keyboard layers) re-render this tick; every other field
      // was mutated in place on the live state and is carried through unchanged.
      set({ units: draft.units.slice() });
  },

  moveCommand: (cmd) => set((prev) =>
    produce(prev, (draft) => {
      for (const id of cmd.unitIds) {
        const u = draft.units.find((x) => x.id === id);
        if (!u || u.ownerId !== draft.localPlayerId) continue; // Only allow moving own units

        // Validate the destination tile only — whether the unit can actually
        // reach it is the pathfinder's job (grid A* routes around water/bridges),
        // not a per-unit straight-line raster precheck.
        //
        // The old straight-line `isPathValid(u.animal, u.position, cmd.target)`
        // precheck silently dropped this unit's order whenever the line from its
        // current position to the click happened to cross water — even though
        // A* would have routed it around. Because the verdict depended on each
        // unit's own position, units in the same selection got different answers
        // once they had spread out across the map: members on one side of a
        // river would ignore an order across it while members on the other side
        // accepted it. To the player: "some clusters listen, others don't,
        // especially after they reach their destination" (because that's when
        // the group is spread out enough for the straight lines to diverge).
        // The destination check below is shared by every unit in the command,
        // so it can't cause that asymmetry.
        try {
          if (!terrainValidator.canAnimalMoveTo(u.animal, cmd.target)) {
            console.log(`❌ ${u.animal} cannot move to target position (blocked by water/terrain)`);
            continue; // Skip this unit
          }
        } catch (error) {
          // Validator not initialized yet — allow movement (graceful degradation).
          console.warn(`⚠️ Terrain validator not ready, allowing movement for ${u.animal}`);
        }

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

        // Drop any cached A* path. hasUsablePath() reuses a stored path whose goal is
        // within ~12 units of the new destination, so a unit that just finished its
        // previous order at A and is then ordered to a nearby B would keep steering
        // toward A — its current position — and not move until the stall detector
        // eventually re-paths (~0.75s). Looks to the player like the order was ignored.
        delete u.pathWaypoints;
        delete u.pathIndex;
        delete u.pathDestX;
        delete u.pathDestZ;
        delete u.pathVersion;
        delete u.pathStall;
        delete u.pathProgressDist;

        console.log(`✅ PLAYER issued new order to ${u.animal} - switching to MOVING_TO_ORDER state`);
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

        // Drop any cached A* path (see moveCommand for why — same stale-route trap
        // applies when right-click attack picks a target near the unit's last goal).
        delete unit.pathWaypoints;
        delete unit.pathIndex;
        delete unit.pathDestX;
        delete unit.pathDestZ;
        delete unit.pathVersion;
        delete unit.pathStall;
        delete unit.pathProgressDist;

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

// Dev-only debug handle for performance testing (stripped from production
// builds, where import.meta.env.DEV is false). Lets tooling inspect/inject
// game state to exercise high unit counts. Also exposes the raw stats table and
// melee threshold so automated balance tests can assert against the real data
// instead of duplicating the numbers.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as any).__rtsStore = useGameStore;
  (window as any).__rtsAnimals = ANIMALS;
  (window as any).__rtsMeleeRange = MELEE_RANGE;
  // Expose leaderboard utilities so the spec in Unit Tests/ can exercise the
  // real scoring / profanity-filter / persistence code rather than a copy.
  (window as any).__rtsLeaderboard = leaderboardModule;
  // Remote (Firestore-backed) leaderboard layer, exposed so the spec in
  // Unit Tests/ can exercise the real fetch/submit-with-cache-fallback code.
  (window as any).__rtsLeaderboardRemote = leaderboardRemoteModule;
}

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
    attackRange: stats.range,
    attackCooldownMs: stats.attackCooldownMs,
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
    attackRange: stats.range,
    attackCooldownMs: stats.attackCooldownMs,
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
    attackRange: stats.range,
    attackCooldownMs: stats.attackCooldownMs,
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
    attackRange: stats.range,
    attackCooldownMs: stats.attackCooldownMs,
    lastAttackAtMs: 0,
    rotation,
  };
}

// Radii (world units) probed in order by the expanding-ring search below.
// Tuned so dense melee resolves on the first ring while the early-game approach
// phase still finds distant enemies. The widest ring spans the full battlefield
// (bases sit ~500 units apart on the z axis).
const ENEMY_SEARCH_RADII = [30, 80, 200, 600];

// Finds the nearest enemy using the spatial grid. An expanding-ring search keeps
// the common case (enemies already nearby) to a handful of cell lookups instead
// of scanning every unit, which previously made this O(n^2) across the tick. The
// full-scan fallback guarantees correctness if no enemy falls inside the widest
// ring (e.g. the two armies are still further apart than expected).
function findClosestEnemy(unit: Unit, grid: SpatialGrid | null, all: Unit[]): Unit | null {
  if (grid) {
    for (const radius of ENEMY_SEARCH_RADII) {
      const enemy = grid.findClosestEnemy(unit, radius);
      if (enemy) return enemy;
    }
  }

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
// Ticks a ground unit may be wedged (essentially motionless while trying to move) before
// it is allowed to pass through friendly units to free itself. At 60 Hz this is ~1s.
const UNWEDGE_STUCK_TICKS = 60;

function checkCollision(newPosition: Position3D, currentUnit: Unit, allUnits: Unit[], collisionRadius: number = 2.5, selectedUnitIds: string[] = [], localPlayerId: string | null = null, unitOrders: Record<string, any> = {}, spatialGrid: SpatialGrid | null = null): Position3D {
  let adjustedPosition = { ...newPosition };
  let hasCollision = false;

  // Pre-calculate squared collision radius for faster distance checks
  const collisionRadiusSquared = collisionRadius * collisionRadius;

  // Pre-calculate unit classification to avoid repeated lookups
  const isCurrentUnitSelected = selectedUnitIds.includes(currentUnit.id);
  // SIMPLIFIED: Use localPlayerId to identify human player units
  const isCurrentUnitPlayer = currentUnit.ownerId === localPlayerId;

  // Precompute the bridge pass-through predicate ONCE per call — it depends only on
  // currentUnit.position (constant for this checkCollision pass), not on `other`. The
  // raycast-backed bridgeAt() is now cached per grid cell, but the cheap preconditions
  // here also let us skip even the hashmap lookup for the common case (non-ground unit
  // without an order, or any non-Unit kind). Without this hoist, N units crowded on a
  // bridge paid an O(N) per-neighbor query each — the perf cliff users see on crossings.
  const canPassThroughEnemyOnBridge =
    currentUnit.kind === 'Unit' &&
    ANIMAL_MOVEMENT_TYPES[currentUnit.animal] === 'ground' &&
    unitOrders[currentUnit.id] !== undefined &&
    terrainValidator.bridgeAt(currentUnit.position).onBridge;

  // Use spatial grid if available for faster nearby unit lookup
  let nearbyUnits: Unit[];
  const checkRadius = collisionRadius * 3; // Check slightly larger area
  if (spatialGrid && allUnits.length > 50) {
    // Spatial broad-phase: only the handful of units near the target position,
    // instead of scanning every unit (was O(n) per call -> O(n^2) per tick).
    nearbyUnits = spatialGrid
      .getNearbyUnits(adjustedPosition, checkRadius)
      .filter(other => other.id !== currentUnit.id && other.kind !== 'Base');
  } else if (allUnits.length > 50) {
    // Fallback broad-phase when no grid is available.
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

    // Unwedge: a unit that has been physically stuck for a while (crowd-pinned against
    // terrain at a chokepoint, even after the pathfinder re-routes it) temporarily ignores
    // friendly units so it can squeeze along its valid path and escape. Water is still
    // enforced below, so it never ghosts into the moat — it just passes through teammates.
    if (isFriendly && (currentUnit.pathStuckTicks ?? 0) > UNWEDGE_STUCK_TICKS) {
      continue;
    }

    // Bridge pass-through: a ground unit with an active move order that is currently on
    // a bridge deck ignores enemy *collision push* (combat damage is still applied below
    // by the combat phase). Without this, an enemy parked on the narrow Center_Bridge
    // shoves the player unit sideways off the deck centerline until every adjacent step
    // hits water and the unit is terrain-trapped at the chokepoint — the user-visible
    // "frozen on the deck" symptom. Letting it slip past the enemy lets it complete the
    // crossing and re-engage on open ground. Scoped to bridge + ordered ground units so
    // open-field combat positioning is unaffected. The bridge predicate is hoisted to
    // canPassThroughEnemyOnBridge above so this loop body stays O(1) per neighbor.
    if (isEnemy && canPassThroughEnemyOnBridge) {
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

  // Movement-type terrain rule: the only animals ever blocked are GROUND animals
  // trying to enter water without a lowered bridge. Air and water animals are
  // never blocked, so we skip the (raycast-backed) terrain query for them to keep
  // the per-tick cost down at high unit counts.
  if (ANIMAL_MOVEMENT_TYPES[currentUnit.animal] === 'ground' &&
      !terrainValidator.canAnimalMoveTo(currentUnit.animal, adjustedPosition)) {
    // The resolved step lands on forbidden water — usually because a friendly push shoved
    // the unit diagonally off a bridge deck. Rather than dead-stall (which jams crowds at
    // the chokepoint, with units pinned against the water's edge), slide along whichever
    // single axis stays on walkable ground, so the unit keeps flowing down the deck.
    const slideAlongX = { x: adjustedPosition.x, y: currentUnit.position.y, z: currentUnit.position.z };
    if (terrainValidator.canAnimalMoveTo(currentUnit.animal, slideAlongX)) {
      return slideAlongX;
    }
    const slideAlongZ = { x: currentUnit.position.x, y: currentUnit.position.y, z: adjustedPosition.z };
    if (terrainValidator.canAnimalMoveTo(currentUnit.animal, slideAlongZ)) {
      return slideAlongZ;
    }
    return currentUnit.position; // boxed in on all sides this frame — hold
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


// Resolve the point a unit should actually steer toward to reach `destination`. For
// ground units the A* pathfinder returns the next waypoint of a route around the water
// moat (a straight beeline when the way is clear), so they cross on a bridge and reach
// the destination instead of stalling at the water's edge. Air/water units (which ignore
// water) and an un-built pathfinder fall through to the destination, so callers can wrap
// any "advance toward" target unconditionally.
function steeringTarget(unit: Unit, destination: Position3D): Position3D {
  if (ANIMAL_MOVEMENT_TYPES[unit.animal] !== 'ground' || !pathfinder.isReady()) {
    return destination;
  }
  return pathfinder.nextWaypoint(unit, destination);
}

// Vertical speed (world units per second) at which a ground unit's Y closes toward the
// terrain target Y. Fast enough that crossing onto the deck reads as stepping up rather
// than levitating, slow enough that one frame of sampling a slightly-higher rail edge
// doesn't pop the unit. ~30 covers the right/left bridge's ~5u deck rise in a sixth of
// a second.
const DECK_LIFT_RATE = 30;

// Snap-distance below which the unit's Y is set directly to the target rather than
// lerped — avoids residual floating-point chatter once basically at deck height.
const DECK_LIFT_SNAP = 0.02;

// Match a surface-traversing unit's Y to the terrain it's standing on so an arched
// bridge's deck (Right_Bridge_Fully_Down sits ~5u above the water with a tall arch
// above) is walked across on top rather than clipped through at water level. Off-bridge
// positions return to base ground (y=0). Smooths the transition so stepping onto/off
// the deck reads as a brief ramp instead of an instant jump.
//
// Applies to ground AND water units: ground units must use bridges to cross the moat,
// and water units — which beeline straight through the moat — would otherwise swim
// through bridge pillars/rails/decks at y=0 whenever their path passes under a span.
// Lifting them onto the deck while their XZ is over a (traversable) deck cell makes
// them walk across the bridge surface for that span and drop back into the water on
// the far side, so they never clip the bridge geometry. Air units are excluded because
// they manage their own flight Y via the render-time vertical offset (Owl's +10 lift).
function applyDeckElevation(unit: Unit, dtSec: number): void {
  if (ANIMAL_MOVEMENT_TYPES[unit.animal] === 'air') return;
  const targetY = terrainValidator.getBridgeSurfaceY(unit.position) ?? 0;
  const currentY = unit.position.y;
  const delta = targetY - currentY;
  if (Math.abs(delta) < DECK_LIFT_SNAP) {
    unit.position.y = targetY;
    return;
  }
  const maxStep = DECK_LIFT_RATE * dtSec;
  unit.position.y = currentY + Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
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

/**
 * Snapshot of which side's King/Queen is inside each bridge trigger zone on
 * this tick. Used by the tick loop to (a) drive the bridge open/close state
 * (it lowers if either side is in the zone) and (b) credit Fully_Down time
 * to whichever side is currently holding the trigger.
 */
interface BridgeZonePresence {
  playerInRightZone: boolean;
  playerInLeftZone: boolean;
  enemyInRightZone: boolean;
  enemyInLeftZone: boolean;
}

// Bridge animation system
function updateBridgeAnimations(
  draft: GameState & { bridgeState: BridgeState },
  nowMs: number,
): BridgeZonePresence {
  // Define bridge trigger zones (center-right and center-left of map)
  const RIGHT_TRIGGER_ZONE = { x: 15, z: 0 }; // Center-right of map
  const LEFT_TRIGGER_ZONE = { x: -15, z: 0 }; // Center-left of map
  const TRIGGER_RADIUS = 10; // Units within 10 units of trigger zone

  // Find every King/Queen on the field, partitioned by side. Both sides can
  // capture a bridge by putting a K/Q in the trigger zone; the bridge stays
  // down as long as anyone holds it.
  const playerKQs: typeof draft.units = [];
  const enemyKQs: typeof draft.units = [];
  for (const unit of draft.units) {
    if (unit.kind !== 'King' && unit.kind !== 'Queen') continue;
    if (unit.ownerId === draft.localPlayerId) {
      playerKQs.push(unit);
    } else {
      enemyKQs.push(unit);
    }
  }

  const inZone = (
    units: typeof draft.units,
    zone: { x: number; z: number },
  ): boolean => {
    for (const unit of units) {
      const dx = unit.position.x - zone.x;
      const dz = unit.position.z - zone.z;
      if (dx * dx + dz * dz <= TRIGGER_RADIUS * TRIGGER_RADIUS) return true;
    }
    return false;
  };

  const presence: BridgeZonePresence = {
    playerInRightZone: inZone(playerKQs, RIGHT_TRIGGER_ZONE),
    playerInLeftZone:  inZone(playerKQs, LEFT_TRIGGER_ZONE),
    enemyInRightZone:  inZone(enemyKQs,  RIGHT_TRIGGER_ZONE),
    enemyInLeftZone:   inZone(enemyKQs,  LEFT_TRIGGER_ZONE),
  };

  // The bridge animation only needs to know whether anyone is in the zone —
  // attribution for scoring happens at the caller.
  updateSingleBridgeAnimation(
    draft.bridgeState.rightBridge,
    presence.playerInRightZone || presence.enemyInRightZone,
    nowMs,
    'right',
  );
  updateSingleBridgeAnimation(
    draft.bridgeState.leftBridge,
    presence.playerInLeftZone || presence.enemyInLeftZone,
    nowMs,
    'left',
  );

  return presence;
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


