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
import { BLOCKER_LOOKAHEAD, deflectAroundBlockers, type SteerBlocker } from '../components/Working/movementSteering';
import { clampToArena } from '../components/Working/arenaBoundary';
import {
  type MonarchKind,
  MONARCH_FOLLOW_STOP_DISTANCE,
  MONARCH_FOLLOW_GAP,
  clampPlacementCount,
  findMonarch,
  followGapClearance,
  otherMonarchKind,
  pilotInput,
  selectFollowersForPlacement,
  shouldChaseMonarch,
} from '../components/Working/monarchPilot';
import type { Position3D, AnimalId, CommandMoveUnits, CommandSetPatrol, CommandAttackTarget, CommandThrowEggs, CommandFireTongues, CommandHiss, CommandSwarm, CommandOwlPickup, CommandOwlDeliver, GameConfig, GameState, MatchStats, Player, Unit, PatrolRoute, Projectile } from './types';
import { ANIMAL_MOVEMENT_TYPES } from './types';
import * as leaderboardModule from '../components/Working/leaderboard';
import * as leaderboardRemoteModule from '../components/Working/leaderboardRemote';
import {
  type ControlActionId,
  type ControlBindings,
  type InputDevice,
  applyBinding,
  getDefaultBindings,
  loadBindings,
  saveBindings,
} from '../components/Working/controlBindings';

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

// Chicken egg-throw ability tuning. The chicken keeps its melee peck (the ANIMALS
// stats above) for normal combat; the egg is a separate, player-activated ranged
// strike fired by holding both mouse buttons while a friendly Chicken is selected.
const EGG_DAMAGE = 10;            // hp removed from the first enemy animal an egg hits
const EGG_SPEED = 45;            // world units per second the egg flies
const EGG_HIT_RADIUS = 2.5;      // an egg hits an enemy whose center passes within this
const EGG_HIT_RADIUS_SQ = EGG_HIT_RADIUS * EGG_HIT_RADIUS;
const EGG_MAX_RANGE = 60;        // an egg expires after flying this far without a hit
const EGG_COOLDOWN_MS = 700;     // minimum time between a chicken's egg throws
const EGG_THROW_POSE_MS = 600;   // how long the Chicken_F3 + Egg throw pose stays up
const EGG_SPAWN_HEIGHT = 1.5;    // height above the chicken's base the egg launches from

// Frog tongue-grab ability tuning. The frog keeps its melee tongue (the ANIMALS
// stats: range 8) for normal combat; this is a separate, player-activated grab
// fired by holding both mouse buttons while a friendly Frog is selected. The
// tongue extends from the frog's mouth to a single claimed enemy, latches on
// contact, deals the frog's attack damage once, then reels that enemy back to
// the frog. A missed throw simply retracts. See updateFrogTongues + fireTongues.
const TONGUE_RANGE = 20;             // reach of the grab + full extension length (beyond the frog's melee range of 8)
const TONGUE_RANGE_SQ = TONGUE_RANGE * TONGUE_RANGE;
const TONGUE_EXTEND_SPEED = 60;      // world units/sec the tongue tip reaches out
const TONGUE_RETRACT_SPEED = 35;     // world units/sec the tongue (and any catch) reels back
const TONGUE_HIT_RADIUS = 2.0;       // the tongue latches an enemy whose center is within this of the tip
const TONGUE_HIT_RADIUS_SQ = TONGUE_HIT_RADIUS * TONGUE_HIT_RADIUS;
const TONGUE_WINDUP_MS = 100;        // Frog_F2 mouth-open beat before the tongue shoots out
const TONGUE_COOLDOWN_MS = 1500;     // minimum time between a frog's tongue grabs
const TONGUE_MOUTH_HEIGHT = 1.0;     // height above the frog's base the tongue emerges from
const TONGUE_DRAG_STOP_DIST = 2.5;   // a dragged enemy stops once this close to the frog's mouth

// Cat "Hiss" ability tuning. A player-activated burst fired by holding both mouse
// buttons while a friendly Cat is selected: the cat flashes its Kitty_F2 hiss pose
// and shoves every enemy within HISS_KNOCKBACK_RANGE radially outward — away from
// the cat's own position — by HISS_KNOCKBACK_DISTANCE. The shove plays out over
// HISS_KNOCKBACK_MS as a constant-velocity slide the tick integrates (see the
// knockback intercept in tick + the hiss action). A surrounded cat therefore pushes
// the whole encircling ring outward at once.
const HISS_POSE_MS = 1000;           // how long the Kitty_F2 hiss pose stays visible (cat is movement-locked this whole time)
const HISS_KNOCKBACK_RANGE = 20;     // enemies whose center is within this radius are knocked back
const HISS_KNOCKBACK_RANGE_SQ = HISS_KNOCKBACK_RANGE * HISS_KNOCKBACK_RANGE;
const HISS_KNOCKBACK_DISTANCE = 20;  // how far each affected enemy is shoved outward, in world units
const HISS_KNOCKBACK_MS = 200;       // duration of the shove slide; distance / time sets the speed
const HISS_KNOCKBACK_SPEED = HISS_KNOCKBACK_DISTANCE / (HISS_KNOCKBACK_MS / 1000); // world units/sec
const HISS_COOLDOWN_MS = 3000;       // minimum time between a cat's hisses

// Bee "Swarm" ability tuning. A player-activated, sacrificial dive fired by holding
// both mouse buttons while a friendly Bee is selected: every selected bee claims the
// nearest enemy no other swarming bee has taken and flies straight at it at
// SWARM_DIVE_SPEED. On reaching SWARM_STING_RANGE it stings once — a coin flip that
// either kills BOTH the bee and its target (SWARM_STING_KILL_CHANCE) or fizzles, after
// which the surviving bee disengages and resumes normal behavior. See swarm + updateBeeSwarms.
const SWARM_DIVE_SPEED = 60;          // world units/sec a swarming bee closes on its target (a fast dive)
const SWARM_STING_RANGE = 3.0;        // distance at which the bee reaches its target and stings
const SWARM_STING_RANGE_SQ = SWARM_STING_RANGE * SWARM_STING_RANGE;
const SWARM_STING_KILL_CHANCE = 0.5;  // probability a sting kills both the target and the bee
const SWARM_WING_FLAP_PER_SEC = 3;    // wing-flap cycles/sec kept advancing so the dive reads as active flight

// Owl "Pickup" ability tuning. A player-activated abduction fired by holding both mouse
// buttons over a unit while a friendly Owl is selected: each selected Owl claims the
// nearest unit matching the clicked unit's animal type AND owner that no other Owl has
// taken, swoops down to it (descending from flight height), grabs it, carries it back up
// to OWL_FLIGHT_HEIGHT and hovers for OWL_CARRY_DURATION_MS, then drops it. A dropped
// enemy takes OWL_FALL_DAMAGE; a dropped friendly lands unharmed (a repositioning/rescue).
// See pickup + updateOwlPickups.
const OWL_FLIGHT_HEIGHT = 10;          // world-unit render lift of a flying Owl (matches verticalOffset); the height it returns to
const OWL_SWOOP_SPEED = 40;            // world units/sec an Owl closes on its target on the XZ plane while diving
const OWL_DESCENT_SPEED = 22;          // world units/sec the Owl's lift drops as it swoops toward the ground
const OWL_ASCENT_SPEED = 16;           // world units/sec the Owl's lift rises as it carries its catch back up
const OWL_GRAB_RANGE = 3.0;            // XZ distance at which the Owl reaches its target and grabs it
const OWL_GRAB_RANGE_SQ = OWL_GRAB_RANGE * OWL_GRAB_RANGE;
const OWL_CARRY_HANG_OFFSET = 5;       // world units the carried unit dangles below the Owl so it never clips the model
const OWL_PLUCK_ALTITUDE = OWL_CARRY_HANG_OFFSET; // lift the Owl swoops down to (hovering above the target); a body-length up keeps it clear of the map while the catch still reaches the ground
const OWL_GRAB_LIFT = 1.5;             // tolerance above pluck altitude within which the talons close
const OWL_DELIVERY_ARRIVAL_RANGE = 8.0;   // XZ distance from the ordered drop-off at which a delivering Owl stops and sets its cargo down beneath itself
const OWL_DELIVERY_ARRIVAL_RANGE_SQ = OWL_DELIVERY_ARRIVAL_RANGE * OWL_DELIVERY_ARRIVAL_RANGE;
const OWL_CARRY_DURATION_MS = 2500;    // how long a grabbed unit is held aloft before being dropped
const OWL_FALL_DAMAGE = 25;            // hp removed from a dropped enemy on impact; friendlies take none
const OWL_WING_FLAP_PER_SEC = 4;       // wing-flap cycles/sec kept advancing so the swoop/carry reads as active flight

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
  setMovementHold: (unitId: string | null) => void;
  attackTarget: (cmd: CommandAttackTarget) => void;
  selectUnits: (unitIds: string[]) => void;
  addToSelection: (unitIds: string[]) => void;
  clearSelection: () => void;
  // Direct monarch piloting (A cycles monarchs, G toggles King/Queen, Space
  // rallies). See monarchPilot.ts and the pilot-movement block in tick().
  pilotMonarchBySlot: (slotIndex: number) => void;
  pilotCycleMonarch: () => void;
  togglePilotMonarchKind: () => void;
  rallyToMonarch: () => void;
  // Hold-to-place: while the rally key is held over a piloted monarch, the input
  // layer calls incrementUnitPlacement once per UNIT_PLACEMENT_INTERVAL_MS to
  // designate one more follower; on release placeRalliedUnits peels that many
  // followers off to the monarch's position; resetUnitPlacement clears a gesture
  // that ended without placing (a quick tap, a cancel, or the monarch dying).
  incrementUnitPlacement: () => number;
  placeRalliedUnits: (count: number) => void;
  resetUnitPlacement: () => void;
  clearPilot: () => void;
  toggleTurtleShell: (unitIds: string[]) => void;
  throwEggs: (cmd: CommandThrowEggs) => void;
  fireTongues: (cmd: CommandFireTongues) => void;
  hiss: (cmd: CommandHiss) => void;
  swarm: (cmd: CommandSwarm) => void;
  pickup: (cmd: CommandOwlPickup) => void;
  deliverCargo: (cmd: CommandOwlDeliver) => void;
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
  togglePause: () => void;

  // Remappable controls. Keyboard/mouse and controller each carry a full binding
  // map; see components/Working/controlBindings.ts for the token grammar. Setters
  // persist to localStorage so a player's layout survives reloads.
  keyboardBindings: ControlBindings;
  controllerBindings: ControlBindings;
  setBinding: (device: InputDevice, actionId: ControlActionId, token: string) => void;
  resetBindings: (device: InputDevice) => void;
  // Lighting settings
  lightingSettings: {
    sunBrightness: number;
    moonBrightness: number;
    ambientLight: number;
    dayNightSpeed: number;
    // Renderer tone-mapping exposure (AgX). Higher = brighter overall; lets the player
    // pull highlights back from washing out or lift a too-dark scene without touching
    // individual lights. See SceneLighting.
    exposure: number;
    // Image-based-lighting (IBL) strength: drives material.envMapIntensity for the soft,
    // wrap-around fill from the baked studio environment. Higher = richer, more "rendered"
    // fill on the model's shadowed side. See SceneLighting.
    environmentIntensity: number;
    // Final-image color grade, applied as a CSS filter on the WebGL canvas (cheap, live, and
    // only affects the 3D, not the HUD). Neutral values are 1.0 (and 0° hue). See SceneLighting.
    saturation: number; // 1 = unchanged, >1 more vivid, 0 greyscale
    contrast: number;   // 1 = unchanged
    brightness: number; // 1 = unchanged (a post-grade lift, distinct from exposure)
    hue: number;        // degrees of hue rotation, 0 = unchanged
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

// Persisted lighting settings. Tuned for a bright, stylized ("Pixar"-leaning) look:
// soft IBL fill + AgX tone mapping keep colors vivid without the day/night sun washing
// out highlights or crushing the shadow side to black. The values are the player-facing
// knobs the Settings → Video tab exposes; defaults are the starting point, and any saved
// override is merged on top (so older saves that predate exposure/environmentIntensity
// transparently pick up sensible values for the new fields).
const LIGHTING_STORAGE_KEY = 'lightingSettings';
const DEFAULT_LIGHTING_SETTINGS = {
  sunBrightness: 9.5,
  moonBrightness: 15,
  ambientLight: 5,
  dayNightSpeed: 210,
  exposure: 0.4,
  environmentIntensity: 1.7,
  saturation: 1.5,
  contrast: 1.0,
  brightness: 0.95,
  hue: 0,
};
type LightingSettings = typeof DEFAULT_LIGHTING_SETTINGS;
const loadLightingSettings = (): LightingSettings => {
  try {
    const raw = localStorage.getItem(LIGHTING_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LIGHTING_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<LightingSettings>;
    // Merge over defaults so a missing/older key never yields NaN or undefined.
    return { ...DEFAULT_LIGHTING_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_LIGHTING_SETTINGS };
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
  pilotedUnitId: null,
  movementHeldUnitId: null,
  unitPlacementCount: 0,
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
  projectiles: [],
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
  togglePause: () => set((state) => ({ isPaused: !state.isPaused })),

  keyboardBindings: loadBindings('keyboard'),
  controllerBindings: loadBindings('controller'),
  setBinding: (device, actionId, token) => set((state) => {
    const current = device === 'keyboard' ? state.keyboardBindings : state.controllerBindings;
    const updated = applyBinding(current, actionId, token);
    saveBindings(device, updated);
    return device === 'keyboard'
      ? { keyboardBindings: updated }
      : { controllerBindings: updated };
  }),
  resetBindings: (device) => set(() => {
    const defaults = getDefaultBindings(device);
    saveBindings(device, defaults);
    return device === 'keyboard'
      ? { keyboardBindings: defaults }
      : { controllerBindings: defaults };
  }),
  lightingSettings: loadLightingSettings(),
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

    set({ players, localPlayerId: localId, units: [], matchStarted: false, gameOver: false, winner: null, selectedUnitIds: [], pilotedUnitId: null, movementHeldUnitId: null, unitPlacementCount: 0, unitOrders: {}, lastSpawnAtMsByQueenId: {}, lastRegenAtMsByUnitId: {}, queenPatrols: {}, unitCountCache: {}, spatialGrid: null, lastRegenCheckMs: 0, tickCounter: 0, aiThinkingOffset: {}, movementDirectionCache: {}, targetCache: {}, lastWinCheckMs: 0, deadUnitsToRemove: [], matchStats: createEmptyMatchStats(), projectiles: [], optimizations: { aiThrottling: true, combatBatching: true, movementCaching: true, regenThrottling: true, winCheckThrottling: true, deadUnitBatching: true, spawnOptimization: true } });
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

    // Drop any stale pilot movement intent from a previous match.
    pilotInput.reset();

    set({
      units,
      matchStarted: true,
      isPaused: true,
      gameOver: false,
      winner: null,
      selectedUnitIds: [],
      pilotedUnitId: null,
      movementHeldUnitId: null,
      unitPlacementCount: 0,
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
      projectiles: [],
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
      const REGEN_INTERVAL_MS = 1000; // 1 second (3x faster healing)
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
        // Hiss knockback: while an enemy is mid-shove from a Cat's Hiss, slide it along
        // its stored knockback vector (radially away from the cat) and skip its own AI
        // this tick so the push reads as a clean recoil instead of fighting its pathing.
        // checkCollision keeps it on walkable terrain and inside the arena. The shove ends
        // when its window elapses, after which the unit resumes normal behavior next tick.
        if (unit.knockbackUntilMs !== undefined) {
          if (nowMs >= unit.knockbackUntilMs) {
            delete unit.knockbackUntilMs;
            delete unit.knockbackVelocityX;
            delete unit.knockbackVelocityZ;
          } else {
            const knockbackStep = {
              x: unit.position.x + (unit.knockbackVelocityX ?? 0) * dtSec,
              y: unit.position.y,
              z: unit.position.z + (unit.knockbackVelocityZ ?? 0) * dtSec,
            };
            unit.position = checkCollision(knockbackStep, unit, draft.units, 2.5, draft.selectedUnitIds, draft.localPlayerId, draft.unitOrders, draft.spatialGrid);
            continue;
          }
        }

        // Bee Swarm dive: a bee mid-Swarm is driven entirely by updateBeeSwarms (it flies
        // straight at its claimed target and stings on contact), so skip its normal AI and
        // combat this tick — otherwise the two would fight over the bee's movement.
        if (unit.swarmTargetId !== undefined) {
          continue;
        }

        // Owl Pickup: an Owl mid-Pickup is driven entirely by updateOwlPickups (swoop ->
        // grab -> carry -> drop), and a unit being carried is held by its Owl. Both have
        // their normal AI/combat suppressed so the ability owns their movement this tick.
        if (unit.owlPickup !== undefined || unit.carriedByOwlId !== undefined) {
          continue;
        }

        // Direct piloting: the player is driving this King/Queen with the camera-movement
        // keys (z/x/c selected it). Its movement is purely the `pilotInput` vector — never
        // the AI or order system — and it never auto-attacks (fully manual). Any stale move
        // order is dropped so mouse orders and WASD don't fight, and we skip the rest of the
        // per-unit AI/combat for it this tick.
        if (draft.pilotedUnitId !== null && unit.id === draft.pilotedUnitId) {
          if (draft.unitOrders[unit.id]) delete draft.unitOrders[unit.id];

          const move = pilotInput.getMove();
          const inputMagnitude = Math.hypot(move.x, move.z);
          if (inputMagnitude > 0.0001) {
            // Normalize the steering direction but let an analog stick scale speed
            // (clamped so a digital key press, which reports magnitude 1, is full speed).
            const dirX = move.x / inputMagnitude;
            const dirZ = move.z / inputMagnitude;
            const moveDistance = unit.moveSpeed * dtSec * Math.min(inputMagnitude, 1);
            unit.rotation = Math.atan2(dirX, dirZ);

            // Locomotion animation flags, matching the rest of the movement code.
            if (unit.animal === 'Frog' || unit.animal === 'Bunny') {
              unit.isHopping = true;
              const hopSpeed = unit.moveSpeed / 5;
              unit.hopPhase = ((unit.hopPhase || 0) + hopSpeed * dtSec) % 1;
            }
            if (unit.animal === 'Owl') {
              unit.isFlying = true;
              const flapSpeed = 3;
              unit.wingPhase = ((unit.wingPhase || 0) + flapSpeed * dtSec) % 1;
            }

            const newPosition = {
              x: unit.position.x + dirX * moveDistance,
              y: unit.position.y,
              z: unit.position.z + dirZ * moveDistance,
            };
            unit.position = checkCollision(newPosition, unit, draft.units, 2.5, draft.selectedUnitIds, draft.localPlayerId, draft.unitOrders, draft.spatialGrid);
          } else {
            // No input this frame: hold position and drop the moving animations.
            if (unit.animal === 'Frog' || unit.animal === 'Bunny') unit.isHopping = false;
            if (unit.animal === 'Owl') unit.isFlying = false;
          }

          unit.unitState = 'idle';
          continue;
        }

        // Patrol-draw hold: while the player holds the secondary button to draw a
        // patrol route from this Queen, she stays pinned in place so the line's
        // origin (her gold ring) doesn't drift. Hold position and skip her AI,
        // orders, patrol, and combat movement for this tick. Released on button-up.
        if (draft.movementHeldUnitId !== null && unit.id === draft.movementHeldUnitId) {
          if (unit.animal === 'Frog' || unit.animal === 'Bunny') unit.isHopping = false;
          if (unit.animal === 'Owl') unit.isFlying = false;
          unit.unitState = 'idle';
          continue;
        }

        // AI thinking throttling - each unit thinks on different frames
        const isPlayerUnit = unit.ownerId in isAiByOwnerId && !isAiByOwnerId[unit.ownerId];
        const shouldThinkThisTick = isPlayerUnit || !draft.optimizations.aiThrottling || (draft.tickCounter + (draft.aiThinkingOffset[unit.id] || 0)) % 2 === 0; // Reduced to 2 for better AI responsiveness

        // Initialize AI thinking offset for new units
        if (!draft.aiThinkingOffset[unit.id]) {
          draft.aiThinkingOffset[unit.id] = Math.floor(Math.random() * 2); // Match new thinking interval
        }

        // Monarch rally: a follower keeps its move order pinned to the piloted
        // King/Queen it is trailing, so it chases the monarch as the player drives
        // it. Refreshed before the order is read below, so the standard Priority-1
        // movement (which also auto-engages enemies en route) carries it there.
        // Dropping the order inside the stop band lets it idle near the monarch
        // instead of jittering against it, and a dead/missing monarch ends the rally.
        if (isPlayerUnit && unit.followMonarchId) {
          const monarch = unitById.get(unit.followMonarchId);
          if (!monarch || monarch.hp <= 0) {
            delete unit.followMonarchId;
            delete draft.unitOrders[unit.id];
          } else if (shouldChaseMonarch(distance3D(unit.position, monarch.position), MONARCH_FOLLOW_STOP_DISTANCE)) {
            draft.unitOrders[unit.id] = { x: monarch.position.x, y: 0, z: monarch.position.z };
          } else if (draft.unitOrders[unit.id]) {
            delete draft.unitOrders[unit.id];
          }
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
              let direction = normalize3D(subtract3D(steeringTarget(unit, order), unit.position));

              // Bias the course around stationary friendly clumps so the unit commits to a way
              // around instead of ramming them head-on (see movementSteering). Only own,
              // currently-stationary teammates count as blockers: enemies are left to combat,
              // and teammates that are themselves moving (have an order) are excluded so a group
              // marching together doesn't deflect off one another. Restricted to army Units:
              // a King/Queen instead plows straight through its own army via the make-way shove
              // (clearPathForSelectedRoyals) and must not detour. Skipped on a bridge deck, where
              // steering sideways would push toward the water — there the pathfinder's deck
              // waypoints already track the centerline.
              if (unit.kind === 'Unit' && ANIMAL_MOVEMENT_TYPES[unit.animal] === 'ground' && !onBridgeMidCrossing) {
                const scanRadius = BLOCKER_LOOKAHEAD + UNIT_MINIMUM_SPACING + YETI_SPACING_BONUS;
                const neighbors = draft.spatialGrid
                  ? draft.spatialGrid.getNearbyUnits(unit.position, scanRadius)
                  : draft.units;
                const blockers: SteerBlocker[] = [];
                for (const other of neighbors) {
                  if (other.id === unit.id || other.kind === 'Base') continue;
                  if (other.ownerId !== unit.ownerId) continue; // only own side; enemies are combat
                  if (draft.unitOrders[other.id] !== undefined) continue; // moving teammate, not a clump
                  blockers.push({ position: other.position, laneHalfWidth: minimumSpacingBetween(unit, other) });
                }
                direction = deflectAroundBlockers(unit.position, direction, blockers);
              }

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

          // PRIORITY 1b: A lone Queen with a patrol route walks back and forth
          // between her two patrol points until given a new order. This sits
          // between the explicit move order (Priority 1) and the idle/combat
          // fallback (Priority 2): an active patrol drives the Queen's movement,
          // while a Queen without one still falls through to defend herself.
          // Patrols only ever exist for the local player's Queen (see setPatrol),
          // so this branch must live inside the isPlayerUnit block to run at all.
          else if (patrol && unit.kind === 'Queen') {
            unit.unitState = 'moving_to_order';
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
              // Move toward the current patrol target
              const direction = normalize3D(subtract3D(steeringTarget(unit, targetPos), unit.position));
              const moveDistance = unit.moveSpeed * dtSec;

              // Update rotation to face movement direction
              unit.rotation = Math.atan2(direction.x, direction.z);

              // Locomotion animation flags. A patrolling Queen walks like any other
              // moving unit, so drive the same per-animal cycle the order/piloting
              // movers use — without this the renderer holds a single pose and the
              // Queen appears to slide (e.g. a Frog stuck on Frog_F0 instead of hopping).
              if (unit.animal === 'Frog' || unit.animal === 'Bunny') {
                unit.isHopping = true;
                const hopSpeed = unit.moveSpeed / 5; // Hop frequency
                unit.hopPhase = ((unit.hopPhase || 0) + (hopSpeed * dtSec)) % 1;
              }
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
              // Reached this patrol point, turn around toward the other end
              draft.queenPatrols[unit.id].currentTarget = patrol.currentTarget === 'end' ? 'start' : 'end';
              // Drop the moving-locomotion flags during the momentary pause at the
              // turnaround so the pose settles to idle before the next leg.
              if (unit.animal === 'Frog' || unit.animal === 'Bunny') unit.isHopping = false;
              if (unit.animal === 'Owl') unit.isFlying = false;
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
          creditKill(draft, attacker.ownerId, target);
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

      // Advance in-flight egg projectiles and resolve their hits. Runs before the
      // dead-unit cleanup below so an animal an egg kills this tick is removed in
      // the same pass as melee-combat deaths.
      updateProjectiles(draft, dtSec);

      // Advance every active Frog tongue grab (extend -> latch/damage -> drag/
      // retract). Also runs before dead-unit cleanup so an enemy the grab kills is
      // removed this same pass.
      updateFrogTongues(draft, dtSec, nowMs);

      // Advance every Bee mid-Swarm (dive toward its claimed enemy -> sting on contact).
      // Also runs before dead-unit cleanup so the bee and target a sting kills are both
      // removed in this same pass.
      updateBeeSwarms(draft, dtSec, nowMs);

      // Advance every Owl mid-Pickup (swoop down -> grab -> carry up -> drop). Runs before
      // dead-unit cleanup so an enemy a fatal drop kills is removed in this same pass.
      updateOwlPickups(draft, dtSec, nowMs);

      // Clear a lane for any selected King/Queen by shoving its blocking friendlies aside,
      // BEFORE the relaxation pass so separation can tidy the freshly opened formation and
      // (per its own rule) won't pull the shoved units back toward the selected royal.
      clearPathForSelectedRoyals(draft);

      // Hold rallying followers off their piloted monarch (>= MONARCH_FOLLOW_GAP), BEFORE the
      // relaxation pass so it tidies the formation and won't pull followers back onto the
      // monarch (the monarch is skipped by that pass, so the gap it sets is preserved).
      enforceMonarchFollowGap(draft, unitById);

      // Relax any unit pile-ups now that all movement, combat, and Owl drops have settled this
      // tick. Idle/arrived/just-delivered units don't go through the moving-unit collision, so
      // without this pass their models would stack and clip on a single point.
      separateOverlappingUnits(draft);

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
          // End a rally whose monarch just died so followers stop chasing a ghost.
          if (unit.followMonarchId && deadSet.has(unit.followMonarchId)) {
            delete unit.followMonarchId;
          }
        }

        // Stop piloting if the piloted King/Queen just died (and cancel any
        // in-progress placement hold so the teardrop doesn't linger over a ghost).
        if (draft.pilotedUnitId && deadSet.has(draft.pilotedUnitId)) {
          draft.pilotedUnitId = null;
          draft.unitPlacementCount = 0;
          pilotInput.reset();
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

        // A mouse move order takes manual control back from a piloted King/Queen: stop
        // piloting it so the order actually takes effect. The pilot tick block drives the
        // unit purely from ESDF/pilotInput and deletes any move order each frame, so a
        // selected-but-piloted monarch would otherwise ignore the right-click.
        if (draft.pilotedUnitId === id) {
          draft.pilotedUnitId = null;
          pilotInput.reset();
        }

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

        // Cancel any patrol route: an explicit move order replaces the patrol, so
        // the Queen must NOT resume walking the route once she reaches the order's
        // destination. Without this the order's arrival deletes only unitOrders and
        // the still-present patrol immediately recaptures her. A patrol resumes only
        // when the player draws a new one. See the Queen patrol branch in tick().
        delete draft.queenPatrols[id];

        // Break any monarch rally: an explicit destination means the player wants
        // this unit *here*, not pinned to the King/Queen. Without this the tick's
        // follow logic re-pins the order to the monarch every frame, so a rallied
        // unit could never be redirected.
        delete u.followMonarchId;

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

      // Drawing a patrol takes manual control back from a piloted Queen, exactly
      // as moveCommand/attackTarget do: stop piloting her so the patrol actually
      // takes effect. The pilot tick block (see the pilotedUnitId branch in tick())
      // runs BEFORE the patrol branch, drives the unit purely from ESDF/pilotInput,
      // drops any order, and continues past the rest of the per-unit logic — so a
      // still-piloted Queen would hold the route but never walk it until a separate
      // move order released piloting. This is the A→G (select King, toggle to Queen)
      // case, where the Queen is left as the piloted unit when the patrol is drawn.
      if (draft.pilotedUnitId === cmd.queenId) {
        draft.pilotedUnitId = null;
        pilotInput.reset();
      }

      // Committing a patrol means the patrol-draw hold is over, so lift the
      // movement freeze on this queen here rather than relying solely on the
      // gesture handler's separate setMovementHold(null). Otherwise a missed or
      // out-of-order release would leave her pinned (the tick's freeze block
      // skips all order/patrol movement), so she'd hold the route but never walk it.
      if (draft.movementHeldUnitId === cmd.queenId) {
        draft.movementHeldUnitId = null;
      }

      // Drop the queen's cached A* path and movement-blocking state, exactly as
      // moveCommand/attackTarget do. The patrol tick steers a ground queen via
      // steeringTarget -> pathfinder.nextWaypoint, which reuses a cached path
      // whose goal is within ~12 units of the new one (hasUsablePath). A queen
      // that previously moved and stopped would otherwise keep steering toward
      // her old cached goal — her current position — yielding a (0,0,0)
      // direction, so she'd sit still and never start patrolling. See the
      // stale-path-cache fix in moveCommand and the move-command-stale-path test.
      delete queen.pathWaypoints;
      delete queen.pathIndex;
      delete queen.pathDestX;
      delete queen.pathDestZ;
      delete queen.pathVersion;
      delete queen.pathStall;
      delete queen.pathProgressDist;

      // Reset blocking/stall bookkeeping so a stale "paused" window can't carry
      // over and stall the first leg of the patrol.
      queen.collisionAttempts = 0;
      delete queen.movementPausedUntilMs;
      delete queen.firstBlockedAtMs;
      delete queen.nearDestinationSinceMs;
    })
  ),

  // Freeze (unitId) or release (null) a unit's movement for the duration of the
  // secondary-button patrol-draw hold. Validated to the local player so a held
  // id can only ever pin one of their own units. The tick honors this by holding
  // the unit's position and skipping its AI/order/patrol movement that tick.
  setMovementHold: (unitId) => set((prev) => {
    if (unitId === null) return { movementHeldUnitId: null };
    const unit = prev.units.find(u => u.id === unitId);
    if (!unit || unit.ownerId !== prev.localPlayerId) return {};
    return { movementHeldUnitId: unitId };
  }),

  attackTarget: (cmd) => set((prev) =>
    produce(prev, (draft) => {
      const target = draft.units.find(u => u.id === cmd.targetId);
      if (!target) return;

      for (const id of cmd.unitIds) {
        const unit = draft.units.find(u => u.id === id);
        if (!unit || unit.ownerId !== draft.localPlayerId) continue;

        // A mouse attack order takes manual control back from a piloted King/Queen (see
        // moveCommand): stop piloting it so the order isn't dropped by the pilot tick block.
        if (draft.pilotedUnitId === id) {
          draft.pilotedUnitId = null;
          pilotInput.reset();
        }

        // Set movement target to enemy position
        draft.unitOrders[id] = { x: target.position.x, y: 0, z: target.position.z };

        // Cancel any patrol route (see moveCommand): an explicit attack order
        // replaces the patrol so the Queen won't snap back to her route after the
        // engagement instead of staying on the new command.
        delete draft.queenPatrols[id];

        // Break any monarch rally (see moveCommand): an explicit attack order
        // takes the unit off "follow the King/Queen" so it isn't re-pinned to
        // the monarch by the follow logic each tick.
        delete unit.followMonarchId;

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
  
  // Deselecting fully releases control of the player's units, not just the selection
  // highlight: it stops piloting the monarch (so ESDF/stick no longer drives it) and breaks
  // any rally (followers drop their follow order and stop trailing). Without this a deselect
  // only emptied selectedUnitIds while pilotedUnitId and followMonarchId persisted, leaving
  // the King/Queen and its army still under the player's control after they had let go.
  clearSelection: () => {
    pilotInput.reset();
    set((prev) =>
      produce(prev, (draft) => {
        draft.selectedUnitIds = [];
        draft.pilotedUnitId = null;
        draft.unitPlacementCount = 0; // cancel any in-progress placement hold
        for (const unit of draft.units) {
          if (unit.followMonarchId !== undefined) {
            delete unit.followMonarchId;
            delete draft.unitOrders[unit.id]; // drop the synthetic follow order so it halts
          }
        }
      })
    );
  },

  // --- Direct monarch piloting -------------------------------------------------
  // Start piloting the King of the local player's animal in `slotIndex`
  // (0/1/2 -> z/x/c). Defaults to the King; the player can swap to the Queen
  // with togglePilotMonarchKind. Selecting it also makes it the current
  // selection so the existing ring/HUD highlight the piloted unit, and the
  // camera (which follows the selection) eases onto it. Re-pressing the slot of
  // the unit already being piloted stops piloting.
  pilotMonarchBySlot: (slotIndex) => set((prev) => {
    if (!prev.localPlayerId) return {};
    const animal = prev.selectedAnimalPool[slotIndex];
    if (!animal) return {};

    // If already piloting this animal's monarch, the same key unpilots it.
    const current = prev.pilotedUnitId
      ? prev.units.find((u) => u.id === prev.pilotedUnitId)
      : null;
    if (current && current.animal === animal) {
      pilotInput.reset();
      return { pilotedUnitId: null };
    }

    // Prefer the King; fall back to the Queen if the King is already dead.
    const monarch =
      findMonarch(prev.units, prev.localPlayerId, animal, 'King') ??
      findMonarch(prev.units, prev.localPlayerId, animal, 'Queen');
    if (!monarch) return {};

    pilotInput.reset();
    return { pilotedUnitId: monarch.id, selectedUnitIds: [monarch.id] };
  }),

  // Cycle the piloted monarch through the local player's animal pool (the "A"
  // key). When not piloting, this starts on the first animal's monarch; while
  // piloting, it advances to the next animal that still has a living monarch
  // (wrapping around). Each step prefers the King, falling back to the Queen.
  // Returns to no-pilot is handled by re-pressing nothing — there is always a
  // monarch to land on as long as one animal still has one alive.
  pilotCycleMonarch: () => set((prev) => {
    if (!prev.localPlayerId) return {};
    const pool = prev.selectedAnimalPool;
    if (pool.length === 0) return {};

    // Resolve the pool slot of the animal we are currently piloting, so the
    // next press advances from there; default just before slot 0 otherwise.
    const current = prev.pilotedUnitId
      ? prev.units.find((u) => u.id === prev.pilotedUnitId)
      : null;
    const currentSlot = current ? pool.indexOf(current.animal) : -1;

    // Walk forward through the pool (wrapping) until we find an animal with a
    // living monarch, so dead-monarch animals are skipped rather than stalling.
    for (let step = 1; step <= pool.length; step++) {
      const slot = (currentSlot + step) % pool.length;
      const animal = pool[slot];
      if (!animal) continue;
      const monarch =
        findMonarch(prev.units, prev.localPlayerId, animal, 'King') ??
        findMonarch(prev.units, prev.localPlayerId, animal, 'Queen');
      if (monarch) {
        pilotInput.reset();
        return { pilotedUnitId: monarch.id, selectedUnitIds: [monarch.id] };
      }
    }

    return {};
  }),

  // Swap the piloted unit between the King and Queen of the same animal (G).
  // No-op when not piloting or when the sibling monarch is dead.
  togglePilotMonarchKind: () => set((prev) => {
    if (!prev.localPlayerId || !prev.pilotedUnitId) return {};
    const current = prev.units.find((u) => u.id === prev.pilotedUnitId);
    if (!current || (current.kind !== 'King' && current.kind !== 'Queen')) return {};

    const sibling = findMonarch(
      prev.units,
      prev.localPlayerId,
      current.animal,
      otherMonarchKind(current.kind as MonarchKind)
    );
    if (!sibling) return {};

    pilotInput.reset();
    return { pilotedUnitId: sibling.id, selectedUnitIds: [sibling.id] };
  }),

  // Toggle "rally" on the piloted monarch (Space) and select that animal's army.
  // When rally is on, every living army Unit of the same animal and owner trails
  // the monarch (the tick keeps their move order pinned to its position);
  // pressing again clears the rally. Either way the army is left selected so the
  // player can immediately redirect it with a right-click — and issuing that
  // move order breaks the unit off the monarch (see moveCommand).
  rallyToMonarch: () => set((prev) =>
    produce(prev, (draft) => {
      if (!draft.localPlayerId || !draft.pilotedUnitId) return;
      const monarch = draft.units.find((u) => u.id === draft.pilotedUnitId);
      if (!monarch) return;

      const isFollower = (u: Unit) =>
        u.ownerId === draft.localPlayerId &&
        u.kind === 'Unit' &&
        u.animal === monarch.animal;

      // Toggle off when this animal's units are already rallying to this monarch.
      const alreadyRallying = draft.units.some(
        (u) => isFollower(u) && u.followMonarchId === monarch.id
      );

      const followerIds: string[] = [];
      for (const unit of draft.units) {
        if (!isFollower(unit)) continue;
        if (alreadyRallying) {
          delete unit.followMonarchId;
        } else {
          unit.followMonarchId = monarch.id;
        }
        followerIds.push(unit.id);
      }

      // Select the piloted monarch alongside its army so a right-click redirects
      // the army while the monarch's gold piloting ring stays visible — a piloted
      // King/Queen is always selected (see pilotMonarchBySlot), and rally must not
      // drop it. The monarch leads the id list; followers (if any) trail it.
      draft.selectedUnitIds = [monarch.id, ...followerIds];
    })
  ),

  // Designate one more follower for a placement order while the rally key is held
  // (called once per UNIT_PLACEMENT_INTERVAL_MS by the input layer). The count is
  // capped at the number of followers currently trailing the piloted monarch, so
  // the teardrop indicator stops climbing once the whole rally has been claimed.
  // Returns the resulting count so the caller knows whether a hold (>= 1) or a
  // quick tap (0) occurred on release.
  incrementUnitPlacement: () => {
    const prev = get();
    if (!prev.localPlayerId || !prev.pilotedUnitId) return prev.unitPlacementCount;

    const monarch = prev.units.find((u) => u.id === prev.pilotedUnitId);
    if (!monarch) return prev.unitPlacementCount;

    const followerCount = prev.units.reduce(
      (count, unit) =>
        unit.ownerId === prev.localPlayerId &&
        unit.kind === 'Unit' &&
        unit.animal === monarch.animal &&
        unit.followMonarchId === monarch.id
          ? count + 1
          : count,
      0
    );

    const next = clampPlacementCount(prev.unitPlacementCount + 1, followerCount);
    if (next !== prev.unitPlacementCount) set({ unitPlacementCount: next });
    return next;
  },

  // Execute a placement hold: peel the `count` followers nearest the piloted
  // monarch off the rally and send them to its current position, leaving the rest
  // trailing it. Mirrors moveCommand's per-unit order reset (clears combat,
  // blocking and the stale A* path cache) so the placed units actually travel.
  placeRalliedUnits: (count) => set((prev) =>
    produce(prev, (draft) => {
      draft.unitPlacementCount = 0; // the gesture is consumed regardless of outcome
      if (count <= 0 || !draft.localPlayerId || !draft.pilotedUnitId) return;

      const monarch = draft.units.find((u) => u.id === draft.pilotedUnitId);
      if (!monarch) return;

      const followers = draft.units.filter(
        (unit) =>
          unit.ownerId === draft.localPlayerId &&
          unit.kind === 'Unit' &&
          unit.animal === monarch.animal &&
          unit.followMonarchId === monarch.id
      );

      const destination = { x: monarch.position.x, y: 0, z: monarch.position.z };
      const chosen = selectFollowersForPlacement(followers, monarch.position, count);

      for (const unit of chosen) {
        // Break off the rally and pin an explicit destination at the monarch.
        delete unit.followMonarchId;
        draft.unitOrders[unit.id] = destination;
        unit.unitState = 'moving_to_order';
        delete unit.arrivedAtDestinationMs;

        // Clear combat, blocking and landing carry-over so the new order wins.
        delete unit.lastCombatTargetId;
        delete unit.lastCombatEngagementMs;
        delete unit.priorityAttacker;
        unit.collisionAttempts = 0;
        delete unit.movementPausedUntilMs;
        delete unit.firstBlockedAtMs;
        delete unit.nearDestinationSinceMs;

        // Drop the cached A* path so the unit re-routes to the placement point
        // instead of steering toward its previous goal (see moveCommand).
        delete unit.pathWaypoints;
        delete unit.pathIndex;
        delete unit.pathDestX;
        delete unit.pathDestZ;
        delete unit.pathVersion;
        delete unit.pathStall;
        delete unit.pathProgressDist;
      }
    })
  ),

  // Cancel a placement hold without issuing an order (a quick tap, a deselect, or
  // the monarch dying) so the teardrop indicator disappears.
  resetUnitPlacement: () => {
    if (get().unitPlacementCount !== 0) set({ unitPlacementCount: 0 });
  },

  // Stop piloting entirely (used on death / match end / explicit cancel).
  clearPilot: () => {
    pilotInput.reset();
    set({ pilotedUnitId: null, unitPlacementCount: 0 });
  },

  // Toggle the "shell" lock on the local player's Turtle units in the given
  // selection. Shelling pins the unit in place (see checkCollision) and the
  // renderer swaps it to the F0 shell pose; toggling again releases it.
  toggleTurtleShell: (unitIds) => set((prev) =>
    produce(prev, (draft) => {
      for (const id of unitIds) {
        const unit = draft.units.find((candidate) => candidate.id === id);
        if (!unit || unit.animal !== 'Turtle' || unit.ownerId !== draft.localPlayerId) continue;
        unit.isShelled = !unit.isShelled;
        if (unit.isShelled) {
          // Shelling means "hold here": drop any pending move order and go idle
          // so the turtle doesn't resume a stale path when later released.
          delete draft.unitOrders[id];
          unit.unitState = 'idle';
        }
      }
    })
  ),

  // Chicken egg-throw ability. Each selected friendly Chicken that is off its
  // egg cooldown turns to face the targeted point, shows the throw pose for a
  // short window, and launches one egg projectile toward it (resolved in tick).
  throwEggs: (cmd) => set((prev) =>
    produce(prev, (draft) => {
      const now = performance.now();
      for (const id of cmd.unitIds) {
        const unit = draft.units.find((candidate) => candidate.id === id);
        if (!unit || unit.animal !== 'Chicken' || unit.ownerId !== draft.localPlayerId) continue;
        if (unit.hp <= 0) continue;
        if (unit.lastEggAtMs !== undefined && now - unit.lastEggAtMs < EGG_COOLDOWN_MS) continue;

        const direction = normalize3D(subtract3D(cmd.target, unit.position));
        if (direction.x === 0 && direction.z === 0) continue; // target on top of the chicken

        unit.rotation = Math.atan2(direction.x, direction.z); // face the throw, like movement does
        unit.lastEggAtMs = now;
        unit.eggThrowUntilMs = now + EGG_THROW_POSE_MS;

        const distanceToTarget = Math.sqrt(distanceSquared3D(unit.position, cmd.target));
        draft.projectiles.push({
          id: `egg-${id}-${now.toFixed(0)}-${nanoid(5)}`,
          ownerId: unit.ownerId,
          position: { x: unit.position.x, y: unit.position.y + EGG_SPAWN_HEIGHT, z: unit.position.z },
          velocity: { x: direction.x * EGG_SPEED, y: 0, z: direction.z * EGG_SPEED },
          traveled: 0,
          maxRange: Math.min(Math.max(distanceToTarget, EGG_HIT_RADIUS), EGG_MAX_RANGE),
          damage: EGG_DAMAGE,
        });
      }
    })
  ),

  // Frog tongue-grab ability. Each selected friendly Frog that is off cooldown and
  // not already mid-grab claims one eligible enemy — the enemy within TONGUE_RANGE
  // that is nearest the cursor — turns to face it, and begins the windup. The grab
  // then animates entirely in the tick (see updateFrogTongues). Targeting respects
  // two rules: a frog grabs exactly one enemy, and no two frogs may claim the same
  // enemy at once (so a cluster of frogs spreads its grabs across the enemy front).
  fireTongues: (cmd) => set((prev) =>
    produce(prev, (draft) => {
      const now = performance.now();

      // Enemies already claimed by another friendly frog's active tongue this
      // instant — excluded so two frogs never grab the same target.
      const claimedTargetIds = new Set<string>();
      for (const candidate of draft.units) {
        if (candidate.tongue) claimedTargetIds.add(candidate.tongue.targetId);
      }

      for (const id of cmd.unitIds) {
        const unit = draft.units.find((candidate) => candidate.id === id);
        if (!unit || unit.animal !== 'Frog' || unit.ownerId !== draft.localPlayerId) continue;
        if (unit.hp <= 0) continue;
        if (unit.tongue) continue; // already mid-grab
        if (unit.lastTongueAtMs !== undefined && now - unit.lastTongueAtMs < TONGUE_COOLDOWN_MS) continue;

        // Among enemies within tongue range of THIS frog (and not already claimed),
        // pick the one closest to the cursor so the player can aim the grab while
        // out-of-aim frogs still snap up whatever enemy is nearest them.
        let target: Unit | null = null;
        let bestCursorDistSq = Infinity;
        for (const candidate of draft.units) {
          if (candidate.ownerId === unit.ownerId) continue; // enemies only
          if (candidate.kind === 'Base') continue;          // animals only, never structures
          if (candidate.hp <= 0) continue;
          if (claimedTargetIds.has(candidate.id)) continue; // one frog per enemy
          if (distanceSquared3D(unit.position, candidate.position) > TONGUE_RANGE_SQ) continue;
          const cursorDistSq = distanceSquared3D(cmd.cursor, candidate.position);
          if (cursorDistSq < bestCursorDistSq) {
            bestCursorDistSq = cursorDistSq;
            target = candidate;
          }
        }
        // Every selected frog fires a tongue: if it claimed an enemy it aims the
        // grab at that enemy; otherwise it whiffs — shooting the tongue straight
        // out toward the cursor (or its current facing if the cursor is on top of
        // it) to full length and reeling back empty-handed.
        let targetId = '';
        let direction: Position3D;
        if (target) {
          claimedTargetIds.add(target.id); // reserve it so a later frog in this batch can't reuse it
          targetId = target.id;
          direction = normalize3D(subtract3D(target.position, unit.position));
        } else {
          direction = normalize3D(subtract3D(cmd.cursor, unit.position));
        }
        if (direction.x === 0 && direction.z === 0) {
          // Degenerate aim (target/cursor on top of the frog): shoot out along the
          // frog's current facing so the whiff still plays.
          direction = { x: Math.sin(unit.rotation), y: 0, z: Math.cos(unit.rotation) };
        }

        unit.rotation = Math.atan2(direction.x, direction.z); // face the throw
        unit.lastTongueAtMs = now;
        unit.tongue = {
          phase: 'windup',
          targetId,
          origin: { x: unit.position.x, y: unit.position.y + TONGUE_MOUTH_HEIGHT, z: unit.position.z },
          direction,
          length: 0,
          maxLength: TONGUE_RANGE,
          grabbed: false,
          phaseUntilMs: now + TONGUE_WINDUP_MS,
          damageDealt: false,
        };
      }
    })
  ),

  // Cat "Hiss" ability. Each selected friendly Cat that is off its hiss cooldown
  // flashes the Kitty_F2 hiss pose (for HISS_POSE_MS) and shoves every living enemy
  // within HISS_KNOCKBACK_RANGE radially outward from its own position. The shove is
  // a constant-velocity slide the tick integrates over HISS_KNOCKBACK_MS (see the
  // knockback intercept in tick), so a cat surrounded on all sides pushes the entire
  // encircling ring outward at once. Bases are immovable structures and are skipped.
  hiss: (cmd) => set((prev) =>
    produce(prev, (draft) => {
      const now = performance.now();
      for (const id of cmd.unitIds) {
        const cat = draft.units.find((candidate) => candidate.id === id);
        if (!cat || cat.animal !== 'Cat' || cat.ownerId !== draft.localPlayerId) continue;
        if (cat.hp <= 0) continue;
        if (cat.lastHissAtMs !== undefined && now - cat.lastHissAtMs < HISS_COOLDOWN_MS) continue;

        cat.lastHissAtMs = now;
        cat.hissUntilMs = now + HISS_POSE_MS;

        for (const enemy of draft.units) {
          if (enemy.ownerId === cat.ownerId) continue; // only enemies are knocked back
          if (enemy.kind === 'Base') continue;          // immovable structure
          if (enemy.hp <= 0) continue;

          const dx = enemy.position.x - cat.position.x;
          const dz = enemy.position.z - cat.position.z;
          const distanceSquared = dx * dx + dz * dz;
          if (distanceSquared > HISS_KNOCKBACK_RANGE_SQ) continue;

          // Push direction is radially outward from the cat. If an enemy is sitting
          // exactly on the cat, pick a random outward heading so it still gets shoved.
          let pushDirectionX: number;
          let pushDirectionZ: number;
          if (distanceSquared < 0.0001) {
            const randomAngle = Math.random() * Math.PI * 2;
            pushDirectionX = Math.cos(randomAngle);
            pushDirectionZ = Math.sin(randomAngle);
          } else {
            const invDistance = 1 / Math.sqrt(distanceSquared);
            pushDirectionX = dx * invDistance;
            pushDirectionZ = dz * invDistance;
          }

          enemy.knockbackVelocityX = pushDirectionX * HISS_KNOCKBACK_SPEED;
          enemy.knockbackVelocityZ = pushDirectionZ * HISS_KNOCKBACK_SPEED;
          enemy.knockbackUntilMs = now + HISS_KNOCKBACK_MS;
        }
      }
    })
  ),

  // Bee "Swarm" ability. Each selected friendly Bee that is not already swarming
  // claims the closest living enemy animal no other bee has taken and commits to a
  // dive at it (the dive + sting then plays out entirely in the tick — see
  // updateBeeSwarms). Targeting respects two rules: a bee dives at exactly one enemy,
  // and no two bees may claim the same enemy at once, so a cloud of bees spreads its
  // stings across distinct targets rather than piling onto one.
  swarm: (cmd) => set((prev) =>
    produce(prev, (draft) => {
      // Enemies already claimed by another bee mid-Swarm — excluded so no two bees
      // dive at the same target.
      const claimedTargetIds = new Set<string>();
      for (const candidate of draft.units) {
        if (candidate.swarmTargetId !== undefined) claimedTargetIds.add(candidate.swarmTargetId);
      }

      for (const id of cmd.unitIds) {
        const bee = draft.units.find((candidate) => candidate.id === id);
        if (!bee || bee.animal !== 'Bee' || bee.ownerId !== draft.localPlayerId) continue;
        if (bee.kind !== 'Unit') continue; // sacrificial dive — never risk a Bee King/Queen
        if (bee.hp <= 0) continue;
        if (bee.swarmTargetId !== undefined) continue; // already diving

        // Claim the closest living enemy animal (never a Base) not already claimed.
        let target: Unit | null = null;
        let bestDistSq = Infinity;
        for (const candidate of draft.units) {
          if (candidate.ownerId === bee.ownerId) continue; // enemies only
          if (candidate.kind === 'Base') continue;          // animals only, never structures
          if (candidate.hp <= 0) continue;
          if (claimedTargetIds.has(candidate.id)) continue; // one bee per enemy
          const distSq = distanceSquared3D(bee.position, candidate.position);
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            target = candidate;
          }
        }
        if (!target) continue; // no unclaimed enemy left for this bee — it sits this swarm out

        claimedTargetIds.add(target.id); // reserve so a later bee in this batch can't reuse it
        bee.swarmTargetId = target.id;
        // Drop any pending move order so the dive isn't fighting a stale destination.
        delete draft.unitOrders[bee.id];
      }
    })
  ),

  // Owl "Pickup" ability. Each selected friendly Owl that is not already mid-Pickup claims
  // the closest living unit that matches the clicked unit's animal type AND owner and that no
  // other Owl has taken, then commits to a swoop at it (the dive, grab, carry and drop all
  // play out in the tick — see updateOwlPickups). Targeting respects two rules mirroring the
  // Bee Swarm: an Owl grabs exactly one unit, and no two Owls may claim the same unit, so a
  // flight of Owls spreads its catches across distinct targets rather than piling onto one.
  pickup: (cmd) => set((prev) =>
    produce(prev, (draft) => {
      // Units already claimed by an Owl mid-Pickup (its swoop target) or already in another
      // Owl's talons — excluded so no two Owls grab the same unit.
      const claimedTargetIds = new Set<string>();
      for (const candidate of draft.units) {
        if (candidate.owlPickup !== undefined) claimedTargetIds.add(candidate.owlPickup.targetId);
        if (candidate.carriedByOwlId !== undefined) claimedTargetIds.add(candidate.id);
      }

      for (const id of cmd.unitIds) {
        const owl = draft.units.find((candidate) => candidate.id === id);
        if (!owl || owl.animal !== 'Owl' || owl.ownerId !== draft.localPlayerId) continue;
        if (owl.kind !== 'Unit') continue; // protect a royal Owl from swooping into danger
        if (owl.hp <= 0) continue;
        if (owl.owlPickup !== undefined) continue; // already swooping

        // Claim the closest living unit matching the clicked unit's type AND owner, never a
        // Base, that is not already claimed and is not itself a busy/carried unit.
        let target: Unit | null = null;
        let bestDistSq = Infinity;
        for (const candidate of draft.units) {
          if (candidate.animal !== cmd.targetAnimal) continue;   // same animal type as the clicked unit
          if (candidate.ownerId !== cmd.targetOwnerId) continue; // same side as the clicked unit
          if (candidate.kind === 'Base') continue;               // animals only, never structures
          if (ANIMAL_MOVEMENT_TYPES[candidate.animal] === 'air') continue; // can't pluck flying units (Owls/Bees) out of the air
          if (candidate.hp <= 0) continue;
          if (candidate.id === owl.id) continue;                 // an Owl can't grab itself
          if (candidate.owlPickup !== undefined) continue;       // never grab another mid-Pickup Owl
          if (claimedTargetIds.has(candidate.id)) continue;      // one Owl per target
          const distSq = distanceSquared3D(owl.position, candidate.position);
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            target = candidate;
          }
        }
        if (!target) continue; // no unclaimed match left for this Owl — it sits this pickup out

        claimedTargetIds.add(target.id); // reserve so a later Owl in this batch can't reuse it
        owl.owlPickup = { phase: 'swooping', targetId: target.id, grabbed: false, carryUntilMs: 0 };
        owl.isFlying = true;                                     // keep wings animating through the swoop
        owl.flightLift = OWL_FLIGHT_HEIGHT;                      // start the descent from cruising altitude
        // Drop any pending move order so the swoop isn't fighting a stale destination.
        delete draft.unitOrders[owl.id];
      }
    })
  ),

  // Owl cargo delivery. The second half of the friendly-Pickup flow: each selected Owl that is
  // hovering with friendly cargo ('holding') is sent to the cursor drop-off point, flying there
  // at flight height. Rather than converging on the exact point (which stacked the dropped models),
  // each Owl stops once it is within OWL_DELIVERY_ARRIVAL_RANGE of the destination and sets its
  // cargo down directly beneath itself — so Owls arriving from different directions spread their
  // cargo around the drop-off (see the 'delivering' phase in updateOwlPickups). Owls mid-swoop,
  // carrying an enemy, or already delivering are ignored, so only cargo awaiting orders responds.
  deliverCargo: (cmd) => set((prev) =>
    produce(prev, (draft) => {
      for (const id of cmd.unitIds) {
        const owl = draft.units.find((candidate) => candidate.id === id);
        if (!owl || owl.owlPickup === undefined) continue;
        if (owl.owlPickup.phase !== 'holding') continue; // only cargo awaiting a delivery order
        owl.owlPickup.deliverTo = { x: cmd.target.x, y: cmd.target.y, z: cmd.target.z };
        owl.owlPickup.phase = 'delivering';
      }
    })
  ),

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

// Minimum XZ distance enforced between any two units so massed crowds spread out instead of
// bunching on a point. Shared by the moving-unit collision push (checkCollision) and the
// idle separation pass (separateOverlappingUnits) so a unit's personal space is the same
// whether it is walking or standing still.
const UNIT_MINIMUM_SPACING = 3.75;
// Extra spacing when a Yetti is involved on either side — its model is larger than the rest.
const YETI_SPACING_BONUS = 1.5;

// Minimum spacing required between currentUnit and other, accounting for the Yetti size bonus.
function minimumSpacingBetween(currentUnit: Unit, other: Unit): number {
  const yetiBonus = (currentUnit.animal === 'Yetti' || other.animal === 'Yetti') ? YETI_SPACING_BONUS : 0;
  return UNIT_MINIMUM_SPACING + yetiBonus;
}

function checkCollision(newPosition: Position3D, currentUnit: Unit, allUnits: Unit[], collisionRadius: number = 2.5, selectedUnitIds: string[] = [], localPlayerId: string | null = null, unitOrders: Record<string, any> = {}, spatialGrid: SpatialGrid | null = null): Position3D {
  // A shelled turtle, a frog mid tongue-grab, or a cat mid-Hiss is locked in place:
  // every movement branch funnels its proposed position through here, so refusing the
  // move keeps the unit pinned while still letting combat (which never touches
  // checkCollision) run. The frog must hold position so its tongue's origin stays
  // anchored at the mouth for the whole extend/retract animation; the cat holds while
  // its Kitty_F2 hiss pose plays. The hiss window is stamped with performance.now()
  // (same clock used to set hissUntilMs), and the && short-circuits so the clock read
  // only happens for cats that have actually hissed.
  const hissLocked = currentUnit.hissUntilMs !== undefined && performance.now() < currentUnit.hissUntilMs;
  if (currentUnit.isShelled || currentUnit.tongue || hissLocked) {
    return { x: currentUnit.position.x, y: currentUnit.position.y, z: currentUnit.position.z };
  }

  let adjustedPosition = { ...newPosition };
  let hasCollision = false;

  // Pre-calculate squared collision radius for faster distance checks
  const collisionRadiusSquared = collisionRadius * collisionRadius;

  // Pre-calculate unit classification to avoid repeated lookups
  const isCurrentUnitSelected = selectedUnitIds.includes(currentUnit.id);
  // SIMPLIFIED: Use localPlayerId to identify human player units
  const isCurrentUnitPlayer = currentUnit.ownerId === localPlayerId;
  // A selected local King/Queen plows straight through its own army rather than detouring
  // around it: its "make way" shove (clearPathForSelectedRoyals) knocks blocking friendlies
  // aside each tick, so the royal itself ignores friendly collision below. Enemy collision
  // and terrain are still enforced.
  const isSelectedOwnRoyal = isCurrentUnitSelected && isCurrentUnitPlayer &&
                             (currentUnit.kind === 'King' || currentUnit.kind === 'Queen');

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

    // A selected royal ignores friendly collision entirely — it does not detour around its
    // own army; the make-way shove relocates those friendlies instead (see above).
    if (isFriendly && isSelectedOwnRoyal) {
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

    // UNIT SPACING: enforce each unit's personal space so massed crowds spread out without
    // bunching on a point. The same spacing is reused by the idle separation pass.
    const minimumDistance = minimumSpacingBetween(currentUnit, other);
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
        // A selected player unit must travel AROUND its unselected teammates, never
        // bulldoze through them. When the mover overlaps an unselected friendly we fully
        // eject the *mover* to the edge of that unit's personal space (strength 1.0)
        // instead of letting it penetrate. Only the mover is repositioned here (the idle
        // unit's position is never touched in checkCollision), and because the ejection is
        // radial the mover's residual forward order carries it tangentially around the
        // obstacle. Together with the separation pass holding idle units in place against
        // selected neighbors, this is what stops a moving selection from shoving idle
        // friendlies across the map. Two friendlies that are both idle, both selected, or
        // both AI instead share the spacing softly (0.5) so neither snaps. Ability
        // knockback such as the Cat's Hiss is applied elsewhere and intentionally bypasses
        // this rule.
        const pushStrength = shouldReduceCollision ? 1.0 : 0.5;
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

  // Arena boundary: confine the resolved step to the Arena slab so no unit, Queen, or King
  // can walk off the outermost edge of the map. Applied after collision pushes (which can
  // nudge a unit outward near the rim) and before the terrain slide below, so every return
  // path downstream — slide, hold, or the resolved position — stays inside the arena.
  clampToArena(adjustedPosition);

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

// Idle units never pass through checkCollision — only the active movement branches do — so units
// that have arrived at an order, been set down by an Owl, or are simply standing still would
// overlap and clip into one another (intersecting geometry piled on a single point). This
// relaxation pass runs once per tick over every settled ground unit and nudges any pair closer
// than their minimum spacing apart, so stacks resolve into a spread-out formation. Pushes are
// gentle (a fraction of the overlap) and applied across the whole crowd, so a pile eases apart
// over a few ticks rather than snapping. It reuses the same spacing and terrain rules as the
// moving-unit collision, so a unit's personal space is identical whether it is walking or at rest.
const SEPARATION_RELAX_FACTOR = 0.5;            // fraction of the overlap a unit backs off per tick
const SEPARATION_MELEE_TOLERANCE_SQ = 4;        // enemies within this (2 units) are left close for combat
const SEPARATION_QUERY_RADIUS = UNIT_MINIMUM_SPACING + YETI_SPACING_BONUS; // widest spacing any pair can demand

// Extra clearance, beyond normal spacing, that a selected King/Queen carves out of its own
// army — the "2 unit knockback" that keeps friendlies from blocking the royal's path.
const ROYAL_CLEARANCE_BONUS = 2.0;

// Selected kings/queens get a privileged make-way shove: every friendly unit blocking a
// selected royal is knocked radially outward to a ROYAL_CLEARANCE_BONUS-wider gap than
// normal spacing, so the royal is never hemmed in by its own units. This is the deliberate
// exception to the rule that selected units travel AROUND (never push) their teammates —
// only royalty may shove, and only its own side (enemies are resolved by combat). Only the
// blocking unit is moved (the royal holds its course), and the shove settles once the lane
// is clear, so it reads as a brief knockback rather than a constant force. Ground units are
// kept off forbidden water and inside the arena, mirroring separateOverlappingUnits.
function clearPathForSelectedRoyals(draft: Store): void {
  if (!draft.localPlayerId || draft.selectedUnitIds.length === 0) return;
  const selectedIds = new Set(draft.selectedUnitIds);
  const grid = draft.spatialGrid;
  const queryRadius = SEPARATION_QUERY_RADIUS + ROYAL_CLEARANCE_BONUS;

  for (const royal of draft.units) {
    if (royal.kind !== 'King' && royal.kind !== 'Queen') continue;
    if (royal.ownerId !== draft.localPlayerId) continue;
    if (!selectedIds.has(royal.id)) continue;

    const neighbors = grid ? grid.getNearbyUnits(royal.position, queryRadius) : draft.units;

    for (const other of neighbors) {
      if (other.id === royal.id || other.kind === 'Base') continue;
      if (other.ownerId !== royal.ownerId) continue; // friendly only — enemies are combat, not cargo
      // Units owned by the air/carry systems are positioned elsewhere; don't fight them.
      if (other.carriedByOwlId !== undefined || other.isFlying || (other.flightLift ?? 0) > 0) continue;
      // Only shove UNSELECTED teammates: a selected unit (including another royal) is moving
      // under the player's own control and clears itself, so bulldozing it would fight that.
      if (selectedIds.has(other.id)) continue;

      const dx = other.position.x - royal.position.x;
      const dz = other.position.z - royal.position.z;
      const distanceSquared = dx * dx + dz * dz;
      const clearance = minimumSpacingBetween(royal, other) + ROYAL_CLEARANCE_BONUS;
      if (distanceSquared >= clearance * clearance) continue; // already outside the royal's bubble

      let pushX: number;
      let pushZ: number;
      let distance: number;
      if (distanceSquared < 0.000001) {
        // Coincident with the royal: pick a random escape heading.
        const angle = Math.random() * Math.PI * 2;
        pushX = Math.cos(angle);
        pushZ = Math.sin(angle);
        distance = 0;
      } else {
        distance = Math.sqrt(distanceSquared);
        const invDistance = 1 / distance;
        pushX = dx * invDistance;
        pushZ = dz * invDistance;
      }

      const shove = clearance - distance; // distance out to the edge of the royal's bubble
      const resolved: Position3D = {
        x: other.position.x + pushX * shove,
        y: other.position.y,
        z: other.position.z + pushZ * shove,
      };
      clampToArena(resolved);

      if (ANIMAL_MOVEMENT_TYPES[other.animal] === 'ground' &&
          !terrainValidator.canAnimalMoveTo(other.animal, resolved)) {
        const slideAlongX = { x: resolved.x, y: other.position.y, z: other.position.z };
        if (terrainValidator.canAnimalMoveTo(other.animal, slideAlongX)) {
          other.position.x = slideAlongX.x;
        } else {
          const slideAlongZ = { x: other.position.x, y: other.position.y, z: resolved.z };
          if (terrainValidator.canAnimalMoveTo(other.animal, slideAlongZ)) {
            other.position.z = slideAlongZ.z;
          }
        }
        continue; // boxed against water — shove what we can this tick
      }

      other.position.x = resolved.x;
      other.position.z = resolved.z;
    }
  }
}

// Keep every rallying follower at least MONARCH_FOLLOW_GAP from the monarch it is trailing.
// The piloted monarch is player-driven and immovable by the spacing passes, so this pushes
// ONLY the follower radially outward to the gap — the monarch holds its driven position and
// is never shoved by its own army crowding in. The gap is widened to the pair's normal
// spacing when that is larger (e.g. a Yetti follower) so big models still don't overlap the
// monarch. Ground followers pushed onto forbidden water slide along whichever axis stays
// walkable, mirroring clearPathForSelectedRoyals/separateOverlappingUnits. Runs after the
// royal make-way shove and before the relaxation pass so the formation is then tidied.
function enforceMonarchFollowGap(draft: Store, unitById: Map<string, Unit>): void {
  for (const follower of draft.units) {
    if (follower.followMonarchId === undefined) continue;
    const monarch = unitById.get(follower.followMonarchId);
    if (!monarch || monarch.hp <= 0) continue;

    const gap = Math.max(MONARCH_FOLLOW_GAP, minimumSpacingBetween(monarch, follower));
    const resolved = followGapClearance(follower.position, monarch.position, gap);
    if (!resolved) continue; // already outside the gap

    const target: Position3D = { x: resolved.x, y: follower.position.y, z: resolved.z };
    clampToArena(target);

    if (ANIMAL_MOVEMENT_TYPES[follower.animal] === 'ground' &&
        !terrainValidator.canAnimalMoveTo(follower.animal, target)) {
      const slideAlongX = { x: target.x, y: follower.position.y, z: follower.position.z };
      if (terrainValidator.canAnimalMoveTo(follower.animal, slideAlongX)) {
        follower.position.x = slideAlongX.x;
      } else {
        const slideAlongZ = { x: follower.position.x, y: follower.position.y, z: target.z };
        if (terrainValidator.canAnimalMoveTo(follower.animal, slideAlongZ)) {
          follower.position.z = slideAlongZ.z;
        }
      }
      continue; // boxed against water — push what we can this tick
    }

    follower.position.x = target.x;
    follower.position.z = target.z;
  }
}

function separateOverlappingUnits(draft: Store): void {
  const grid = draft.spatialGrid;
  const nowMs = performance.now();
  // O(1) membership for the asymmetric friendly rule below; selectedUnitIds can be large
  // (e.g. select-all), so a Set avoids a per-neighbor linear scan in this hot pass.
  const selectedIds = new Set(draft.selectedUnitIds);

  for (const unit of draft.units) {
    // Bases are immovable. Units being carried, in flight, or locked in place (shelled turtle,
    // frog mid tongue-grab, hissing cat) are positioned by their own systems — their spacing is
    // not ours to manage, and nudging them would fight those systems.
    if (unit.kind === 'Base') continue;
    if (unit.carriedByOwlId !== undefined) continue;
    if (unit.isFlying || (unit.flightLift ?? 0) > 0 || unit.owlPickup !== undefined) continue;
    if (unit.isShelled || unit.tongue) continue;
    if (unit.hissUntilMs !== undefined && nowMs < unit.hissUntilMs) continue;
    // The piloted monarch's position is owned by the player's pilot input — like carried or
    // flying units above, it is not ours to nudge. Skipping it here is what stops rallying
    // followers (now selected alongside it) from shoving the King/Queen as they crowd in;
    // the followers' own spacing and the follow-gap pass keep them off it instead.
    if (unit.id === draft.pilotedUnitId) continue;

    const neighbors = grid
      ? grid.getNearbyUnits(unit.position, SEPARATION_QUERY_RADIUS)
      : draft.units;

    let pushX = 0;
    let pushZ = 0;
    let overlapped = false;

    for (const other of neighbors) {
      if (other.id === unit.id || other.kind === 'Base') continue;
      // Skip units owned by the air/carry systems, for the same reason we skip them as `unit`.
      if (other.carriedByOwlId !== undefined || other.isFlying || (other.flightLift ?? 0) > 0) continue;

      // Selected units travel AROUND their idle teammates rather than pushing them: an
      // unselected friendly holds its ground against a selected friendly neighbor, so a
      // moving selection can never carry idle units across the map. The selected unit is
      // the one that yields — when it is the unit being processed this guard is false, so
      // it still separates away from the idle other. Ability knockback (e.g. the Cat's
      // Hiss) moves units through a separate system and is unaffected.
      if (unit.ownerId === other.ownerId && selectedIds.has(other.id) && !selectedIds.has(unit.id)) {
        continue;
      }

      const dx = unit.position.x - other.position.x;
      const dz = unit.position.z - other.position.z;
      const distanceSquared = dx * dx + dz * dz;

      // Enemies are allowed to close to melee range without being shoved apart, matching the
      // moving-unit collision rule — otherwise separation would fight combat positioning.
      if (unit.ownerId !== other.ownerId && distanceSquared <= SEPARATION_MELEE_TOLERANCE_SQ) continue;

      const minimumDistance = minimumSpacingBetween(unit, other);
      if (distanceSquared >= minimumDistance * minimumDistance) continue; // already well spaced

      overlapped = true;
      if (distanceSquared < 0.000001) {
        // Exactly coincident (e.g. two units set down on one spot): pick a random escape heading
        // and back off half the full spacing along it.
        const randomAngle = Math.random() * Math.PI * 2;
        const overlap = minimumDistance * SEPARATION_RELAX_FACTOR;
        pushX += Math.cos(randomAngle) * overlap;
        pushZ += Math.sin(randomAngle) * overlap;
      } else {
        const distance = Math.sqrt(distanceSquared);
        const invDistance = 1 / distance;
        const overlap = (minimumDistance - distance) * SEPARATION_RELAX_FACTOR;
        pushX += dx * invDistance * overlap;
        pushZ += dz * invDistance * overlap;
      }
    }

    if (!overlapped) continue;

    const resolved: Position3D = {
      x: unit.position.x + pushX,
      y: unit.position.y,
      z: unit.position.z + pushZ,
    };

    // Keep the nudge inside the arena and off forbidden water (a push can shove a unit toward
    // either). Ground units that would land on water slide along whichever axis stays walkable,
    // mirroring checkCollision; if both axes are blocked the unit holds rather than clip in.
    clampToArena(resolved);
    if (ANIMAL_MOVEMENT_TYPES[unit.animal] === 'ground' &&
        !terrainValidator.canAnimalMoveTo(unit.animal, resolved)) {
      const slideAlongX = { x: resolved.x, y: unit.position.y, z: unit.position.z };
      if (terrainValidator.canAnimalMoveTo(unit.animal, slideAlongX)) {
        unit.position.x = slideAlongX.x;
      } else {
        const slideAlongZ = { x: unit.position.x, y: unit.position.y, z: resolved.z };
        if (terrainValidator.canAnimalMoveTo(unit.animal, slideAlongZ)) {
          unit.position.z = slideAlongZ.z;
        }
      }
      continue; // boxed in this tick (or only one axis free, handled above) — hold the rest
    }

    unit.position.x = resolved.x;
    unit.position.z = resolved.z;
  }
}

// Credit a kill to the match-stats cards based on who landed the killing blow.
// Attribution keys off the killing attacker's owner so allied chip damage never
// double-counts. Player→enemy kills feed the leaderboard score and the Your
// Forces card; AI→player kills are non-scoring but populate the Enemy Forces
// card. Shared by melee combat and the Chicken's egg projectile.
function creditKill(draft: Store, attackerOwnerId: string, target: Unit): void {
  const isPlayerKillingEnemy =
    attackerOwnerId === draft.localPlayerId && target.ownerId !== draft.localPlayerId;
  const isAiKillingPlayer =
    attackerOwnerId !== draft.localPlayerId && target.ownerId === draft.localPlayerId;
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

// Advance every in-flight egg one tick: move it along its flight vector, then
// resolve the first enemy animal (non-Base) it passes within EGG_HIT_RADIUS of.
// A hit removes EGG_DAMAGE hp (crediting the kill and queuing removal through the
// shared dead-unit path) and consumes the egg. Eggs that fly past EGG_MAX_RANGE
// without a hit simply expire. Mutates draft.projectiles in place.
function updateProjectiles(draft: Store, dtSec: number): void {
  if (!draft.projectiles || draft.projectiles.length === 0) return;

  const survivors: Projectile[] = [];
  for (const egg of draft.projectiles) {
    const stepX = egg.velocity.x * dtSec;
    const stepZ = egg.velocity.z * dtSec;
    egg.position.x += stepX;
    egg.position.z += stepZ;
    egg.traveled += Math.sqrt(stepX * stepX + stepZ * stepZ);

    // Resolve the closest enemy animal within the egg's hit radius this tick.
    let hitTarget: Unit | null = null;
    let closestSq = EGG_HIT_RADIUS_SQ;
    for (const candidate of draft.units) {
      if (candidate.ownerId === egg.ownerId) continue; // enemies only
      if (candidate.kind === 'Base') continue;         // animals only
      if (candidate.hp <= 0) continue;
      const dx = candidate.position.x - egg.position.x;
      const dz = candidate.position.z - egg.position.z;
      const distSq = dx * dx + dz * dz; // XZ plane; the egg flies at a fixed height
      if (distSq <= closestSq) {
        closestSq = distSq;
        hitTarget = candidate;
      }
    }

    if (hitTarget) {
      hitTarget.hp -= egg.damage;
      if (hitTarget.hp <= 0) {
        draft.deadUnitsToRemove.push(hitTarget.id);
        creditKill(draft, egg.ownerId, hitTarget);
      }
      continue; // egg is consumed on impact
    }

    if (egg.traveled < egg.maxRange) survivors.push(egg); // else expired in flight
  }
  draft.projectiles = survivors;
}

// Advance every Frog whose tongue is currently out, one tick. The grab is a small
// state machine stored on the unit (unit.tongue). A tongue is either a grab
// attempt (targetId set to a claimed enemy) or a whiff (no targetId — fired when
// the frog had no eligible target, so it just shoots out and reels back):
//   windup     — Frog_F2 mouth-open beat; transitions to `extending` after
//                TONGUE_WINDUP_MS. A grab attempt fizzles here if its claimed
//                target died or left reach; a whiff always proceeds.
//   extending  — the tip reaches out along the aim direction at TONGUE_EXTEND_SPEED.
//                A grab attempt tracks its (possibly moving) target and, on
//                contact, latches: deals the frog's attack damage once and flips
//                to `retracting`. A whiff (and a grab that never connects) extends
//                straight to its apex (maxLength) and then flips to `retracting`.
//   retracting — the tip reels back at TONGUE_RETRACT_SPEED; a latched, still-living
//                target is dragged along to just in front of the frog. Once fully
//                reeled in the tongue is cleared and the frog is free again.
// The frog holds position the whole time (the movement passes skip units with an
// active tongue), so `origin` stays put and the geometry reads cleanly.
function updateFrogTongues(draft: Store, dtSec: number, nowMs: number): void {
  for (const frog of draft.units) {
    const tongue = frog.tongue;
    if (!tongue) continue;

    // A frog that died mid-grab just drops the tongue (handled by the dead-unit
    // cleanup removing the unit; guard here in case it is still in the list).
    if (frog.hp <= 0) { frog.tongue = undefined; continue; }

    const target = draft.units.find((candidate) => candidate.id === tongue.targetId);
    const targetAlive = !!target && target.hp > 0;

    if (tongue.phase === 'windup') {
      if (nowMs < tongue.phaseUntilMs) continue; // hold the Frog_F2 beat
      // A grab attempt (targetId set) only shoots if its claimed enemy is still
      // alive and in reach — otherwise it fizzles. A whiff (no targetId) always
      // shoots out along its fixed cursor-facing direction.
      if (tongue.targetId) {
        if (!targetAlive || distanceSquared3D(frog.position, target!.position) > TONGUE_RANGE_SQ) {
          frog.tongue = undefined; // fizzle — cooldown still applies (lastTongueAtMs set at fire)
          continue;
        }
        tongue.direction = normalize3D(subtract3D(target!.position, frog.position));
      }
      tongue.phase = 'extending';
      continue;
    }

    if (tongue.phase === 'extending') {
      tongue.length = Math.min(tongue.length + TONGUE_EXTEND_SPEED * dtSec, tongue.maxLength);

      // Re-aim at the live target so a moving enemy is still tracked, then test
      // whether the tip has reached it.
      if (targetAlive) {
        tongue.direction = normalize3D(subtract3D(target!.position, frog.position));
        const tipX = tongue.origin.x + tongue.direction.x * tongue.length;
        const tipZ = tongue.origin.z + tongue.direction.z * tongue.length;
        const dx = target!.position.x - tipX;
        const dz = target!.position.z - tipZ;
        if (dx * dx + dz * dz <= TONGUE_HIT_RADIUS_SQ) {
          tongue.grabbed = true;
          if (!tongue.damageDealt) {
            tongue.damageDealt = true;
            target!.hp -= frog.attackDamage;
            frog.lastAttackAtMs = nowMs; // count the grab as a swing for combat/pose timing
            if (target!.hp <= 0) {
              draft.deadUnitsToRemove.push(target!.id);
              creditKill(draft, frog.ownerId, target!);
            }
          }
          tongue.phase = 'retracting';
          continue;
        }
      }

      if (tongue.length >= tongue.maxLength) tongue.phase = 'retracting'; // apex reached: a miss
      continue;
    }

    // retracting — reel the tongue back; drag a living catch along with the tip.
    tongue.length = Math.max(tongue.length - TONGUE_RETRACT_SPEED * dtSec, 0);

    if (tongue.grabbed && targetAlive) {
      const tipX = tongue.origin.x + tongue.direction.x * tongue.length;
      const tipZ = tongue.origin.z + tongue.direction.z * tongue.length;
      // Stop dragging once the catch is right in front of the frog so it doesn't
      // get yanked onto/through it.
      const toFrogX = frog.position.x - target!.position.x;
      const toFrogZ = frog.position.z - target!.position.z;
      if (toFrogX * toFrogX + toFrogZ * toFrogZ > TONGUE_DRAG_STOP_DIST * TONGUE_DRAG_STOP_DIST) {
        target!.position.x = tipX;
        target!.position.z = tipZ;
        // A dragged enemy's stale A* path no longer matches where it now is.
        target!.pathWaypoints = undefined;
      }
    }

    if (tongue.length <= 0) frog.tongue = undefined; // fully reeled in — frog is free
  }
}

// Advance every Bee that is mid-Swarm, one tick. A swarming bee flies straight at its
// claimed enemy at SWARM_DIVE_SPEED (its normal AI is suppressed by the swarm intercept
// in tick). On reaching SWARM_STING_RANGE it stings once: with probability
// SWARM_STING_KILL_CHANCE both the bee and the target die, otherwise the sting glances
// off harmlessly; either way the surviving bee disengages (swarmTargetId cleared) and
// resumes normal behavior. A bee whose target dies or vanishes before contact simply
// breaks off. Bees are air units, so the dive ignores terrain and unit collision.
function updateBeeSwarms(draft: Store, dtSec: number, nowMs: number): void {
  for (const bee of draft.units) {
    if (bee.swarmTargetId === undefined) continue;

    // A bee killed mid-dive just drops the swarm (the dead-unit cleanup removes it).
    if (bee.hp <= 0) { bee.swarmTargetId = undefined; continue; }

    const target = draft.units.find((candidate) => candidate.id === bee.swarmTargetId);
    if (!target || target.hp <= 0) {
      bee.swarmTargetId = undefined; // target gone — break off and resume normal behavior
      continue;
    }

    // Track the live target on the XZ plane so a moving enemy is still chased.
    const toTargetX = target.position.x - bee.position.x;
    const toTargetZ = target.position.z - bee.position.z;
    const distSq = toTargetX * toTargetX + toTargetZ * toTargetZ;

    if (distSq <= SWARM_STING_RANGE_SQ) {
      // Contact: sting once. A coin flip kills both the bee and its target, or neither.
      bee.lastAttackAtMs = nowMs; // count the sting as a swing for pose/combat timing
      if (Math.random() < SWARM_STING_KILL_CHANCE) {
        target.hp = 0;
        draft.deadUnitsToRemove.push(target.id);
        creditKill(draft, bee.ownerId, target);      // the bee's owner killed the target

        bee.hp = 0;
        draft.deadUnitsToRemove.push(bee.id);
        creditKill(draft, target.ownerId, bee);       // the bee dies with the sting
      }
      bee.swarmTargetId = undefined; // sting resolved — a surviving bee disengages
      continue;
    }

    // Dive straight at the target. distSq > range here, so the vector is non-zero.
    const invDist = 1 / Math.sqrt(distSq);
    const dirX = toTargetX * invDist;
    const dirZ = toTargetZ * invDist;
    bee.rotation = Math.atan2(dirX, dirZ);
    bee.isFlying = true;
    bee.wingPhase = ((bee.wingPhase || 0) + dtSec * SWARM_WING_FLAP_PER_SEC) % 1;

    const step = SWARM_DIVE_SPEED * dtSec;
    bee.position.x += dirX * step;
    bee.position.z += dirZ * step;
    bee.pathWaypoints = undefined; // a dive overrides any prior A* route
  }
}

// Move a unit's render lift toward a goal at `speed` world units/sec, returning the new lift
// clamped so it never overshoots. Used to animate an Owl (and its catch) down into a swoop
// and back up to flight height.
function approachLift(currentLift: number, goalLift: number, speed: number, dtSec: number): number {
  const delta = goalLift - currentLift;
  const step = speed * dtSec;
  if (Math.abs(delta) <= step) return goalLift;
  return currentLift + Math.sign(delta) * step;
}

// Glue the carried unit to a position OWL_CARRY_HANG_OFFSET below the Owl, matching its XZ and
// facing, so it dangles beneath the talons clear of the model. Called every carry/hold/deliver
// tick so a moving Owl tows its catch along.
function carryUnitBeneath(owl: Unit, carried: Unit): void {
  carried.position.x = owl.position.x;
  carried.position.z = owl.position.z;
  carried.position.y = owl.position.y; // share the Owl's ground reference so the hang stays exact
  carried.rotation = owl.rotation;
  carried.pathWaypoints = undefined;
  carried.flightLift = Math.max(0, (owl.flightLift ?? 0) - OWL_CARRY_HANG_OFFSET);
}

// Set a carried unit down at its current XZ: ground it on the surface below, clear the carry
// render lift, and (for an enemy, when fallDamage > 0) apply impact damage — a fatal drop is
// credited to the Owl's owner. Friendlies, or any delivery (fallDamage 0), land unharmed.
function dropCarriedUnit(draft: Store, owl: Unit, carried: Unit, fallDamage: number): void {
  carried.carriedByOwlId = undefined;
  carried.position.y = terrainValidator.getBridgeSurfaceY(carried.position) ?? 0; // land on the ground it is over
  carried.flightLift = undefined;
  delete draft.unitOrders[carried.id];

  if (fallDamage > 0 && carried.ownerId !== owl.ownerId) {
    carried.hp -= fallDamage;
    if (carried.hp <= 0) {
      carried.hp = 0;
      draft.deadUnitsToRemove.push(carried.id);
      creditKill(draft, owl.ownerId, carried); // the drop killed the enemy
    }
  }
}

// Detach the unit an Owl is carrying without harming it (used when the Owl dies or its catch
// is lost mid-carry). The unit drops straight down to the ground it is currently over and
// resumes normal behavior next tick.
function releaseCarriedUnit(draft: Store, owl: Unit): void {
  const carried = draft.units.find((candidate) => candidate.carriedByOwlId === owl.id);
  if (!carried) return;
  dropCarriedUnit(draft, owl, carried, 0);
}

// Advance every Owl that is mid-Pickup, one tick. The ability runs as a state machine driven
// entirely here (the Owl's normal AI is suppressed by the pickup intercept in tick):
//   'swooping'   — the Owl flies toward its claimed target on the XZ plane at OWL_SWOOP_SPEED
//     while descending to pluck altitude. Once over the target it grabs it and switches to
//     'carrying'.
//   'carrying'   — the Owl rises back to OWL_FLIGHT_HEIGHT with the unit glued beneath it. An
//     ENEMY catch is then dropped once OWL_CARRY_DURATION_MS has elapsed, taking OWL_FALL_DAMAGE.
//     A FRIENDLY catch is instead held: on reaching flight height the Owl switches to 'holding'.
//   'holding'    — (friendly only) the Owl hovers indefinitely with its cargo, awaiting a
//     delivery order. A second both-buttons press (deliverCargo) sets deliverTo and moves it to
//     'delivering'.
//   'delivering' — (friendly only) the Owl flies to deliverTo at flight height, descends to
//     pluck altitude over the spot, and sets the unit down unharmed.
// An Owl whose target dies or vanishes before the grab simply breaks off and flies home. Owls
// are air units, so the swoop ignores terrain and unit collision.
function updateOwlPickups(draft: Store, dtSec: number, nowMs: number): void {
  for (const owl of draft.units) {
    const pickup = owl.owlPickup;
    if (pickup === undefined) continue;

    // An Owl killed mid-Pickup releases its catch unharmed and drops the ability (the
    // dead-unit cleanup removes the Owl).
    if (owl.hp <= 0) {
      releaseCarriedUnit(draft, owl);
      owl.owlPickup = undefined;
      owl.flightLift = undefined;
      continue;
    }

    const target = draft.units.find((candidate) => candidate.id === pickup.targetId);

    // Target gone (died or removed) — break off. Anything the Owl was carrying is already
    // dead, so just end the ability and let the Owl fly home (flight render restored).
    if (!target || target.hp <= 0) {
      owl.owlPickup = undefined;
      owl.flightLift = undefined;
      continue;
    }

    owl.isFlying = true; // keep the wing-flap animation running through both phases
    owl.wingPhase = ((owl.wingPhase || 0) + dtSec * OWL_WING_FLAP_PER_SEC) % 1;

    const carriedIsFriendly = target.ownerId === owl.ownerId;

    if (pickup.phase === 'carrying') {
      // Rise back to cruising altitude with the catch dangling well below the talons.
      owl.flightLift = approachLift(owl.flightLift ?? 0, OWL_FLIGHT_HEIGHT, OWL_ASCENT_SPEED, dtSec);
      carryUnitBeneath(owl, target);

      const reachedFlightHeight = (owl.flightLift ?? 0) >= OWL_FLIGHT_HEIGHT - 0.01;

      // A friendly catch is carried until the player orders a delivery: once the Owl is back at
      // flight height it switches to hovering ('holding') with its cargo instead of dropping.
      if (carriedIsFriendly) {
        if (reachedFlightHeight) pickup.phase = 'holding';
        continue;
      }

      // An enemy catch is dropped once the carry timer elapses AND the Owl has returned to its
      // original flight height, so it always "returns to its flying height" before dropping.
      if (nowMs >= pickup.carryUntilMs && reachedFlightHeight) {
        dropCarriedUnit(draft, owl, target, OWL_FALL_DAMAGE); // enemies hit the ground hard
        owl.owlPickup = undefined;
        owl.flightLift = undefined; // back to normal flight behavior next tick
      }
      continue;
    }

    if (pickup.phase === 'holding') {
      // Friendly cargo: hover in place at flight height, towing the unit beneath, until the
      // player issues a delivery order (deliverCargo sets deliverTo and flips to 'delivering').
      owl.flightLift = approachLift(owl.flightLift ?? 0, OWL_FLIGHT_HEIGHT, OWL_ASCENT_SPEED, dtSec);
      carryUnitBeneath(owl, target);
      continue;
    }

    if (pickup.phase === 'delivering' && pickup.deliverTo !== undefined) {
      // Friendly cargo: fly to the drop-off point at flight height until within the arrival range,
      // then descend to pluck altitude where it stopped and set the unit down beneath itself. The
      // arrival range (wider than the grab range) lets Owls converging from different directions
      // settle around the drop-off rather than stacking their cargo on the exact point.
      const toDropX = pickup.deliverTo.x - owl.position.x;
      const toDropZ = pickup.deliverTo.z - owl.position.z;
      const dropDistSq = toDropX * toDropX + toDropZ * toDropZ;

      if (dropDistSq > OWL_DELIVERY_ARRIVAL_RANGE_SQ) {
        // Still en route: cruise toward the drop-off at flight height.
        owl.flightLift = approachLift(owl.flightLift ?? 0, OWL_FLIGHT_HEIGHT, OWL_ASCENT_SPEED, dtSec);
        const invDist = 1 / Math.sqrt(dropDistSq);
        const dirX = toDropX * invDist;
        const dirZ = toDropZ * invDist;
        owl.rotation = Math.atan2(dirX, dirZ);
        const step = Math.min(OWL_SWOOP_SPEED * dtSec, Math.sqrt(dropDistSq));
        owl.position.x += dirX * step;
        owl.position.z += dirZ * step;
        owl.pathWaypoints = undefined;
        carryUnitBeneath(owl, target);
        continue;
      }

      // Arrived near the drop-off: descend in place to pluck altitude, then set the friendly down
      // unharmed directly beneath the Owl.
      owl.flightLift = approachLift(owl.flightLift ?? OWL_FLIGHT_HEIGHT, OWL_PLUCK_ALTITUDE, OWL_DESCENT_SPEED, dtSec);
      carryUnitBeneath(owl, target);
      if ((owl.flightLift ?? 0) <= OWL_PLUCK_ALTITUDE + OWL_GRAB_LIFT) {
        dropCarriedUnit(draft, owl, target, 0); // delivered safely — no fall damage
        owl.owlPickup = undefined;
        owl.flightLift = undefined; // back to normal flight behavior next tick
      }
      continue;
    }

    // phase === 'swooping': dive toward the target on the XZ plane while descending.
    const toTargetX = target.position.x - owl.position.x;
    const toTargetZ = target.position.z - owl.position.z;
    const distSq = toTargetX * toTargetX + toTargetZ * toTargetZ;

    // Swoop only down to pluck altitude — the Owl hovers a body-length above the target so
    // its own model never sinks into the map; the catch (hung OWL_CARRY_HANG_OFFSET below)
    // still reaches the ground from there.
    owl.flightLift = approachLift(owl.flightLift ?? OWL_FLIGHT_HEIGHT, OWL_PLUCK_ALTITUDE, OWL_DESCENT_SPEED, dtSec);

    // Grab once the Owl is both over the target and has settled to pluck altitude.
    if (distSq <= OWL_GRAB_RANGE_SQ && (owl.flightLift ?? 0) <= OWL_PLUCK_ALTITUDE + OWL_GRAB_LIFT) {
      target.carriedByOwlId = owl.id;
      delete draft.unitOrders[target.id];
      carryUnitBeneath(owl, target);

      pickup.phase = 'carrying';
      pickup.grabbed = true;
      pickup.carryUntilMs = nowMs + OWL_CARRY_DURATION_MS;
      continue;
    }

    // Still closing: steer straight at the target (distSq may be ~0 if already overhead but
    // still too high to grab, in which case the Owl just keeps descending in place).
    if (distSq > 1e-6) {
      const invDist = 1 / Math.sqrt(distSq);
      const dirX = toTargetX * invDist;
      const dirZ = toTargetZ * invDist;
      owl.rotation = Math.atan2(dirX, dirZ);
      const step = Math.min(OWL_SWOOP_SPEED * dtSec, Math.sqrt(distSq));
      owl.position.x += dirX * step;
      owl.position.z += dirZ * step;
    }
    owl.pathWaypoints = undefined; // a swoop overrides any prior A* route
  }
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


