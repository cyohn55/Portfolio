// 3D world coordinates
export type Position3D = { x: number; y: number; z: number };

export type MovementType = 'ground' | 'water' | 'air';

export type AnimalId =
  | 'Bee'
  | 'Bear'
  | 'Bunny'
  | 'Chicken'
  | 'Cat'
  | 'Dolphin'
  | 'Fox'
  | 'Frog'
  | 'Owl'
  | 'Pig'
  | 'Turtle'
  | 'Yetti';

// Movement type mapping for each animal
export const ANIMAL_MOVEMENT_TYPES: Record<AnimalId, MovementType> = {
  Bee: 'air',
  Owl: 'air',
  Frog: 'water',
  Turtle: 'water',
  Dolphin: 'water',
  Bear: 'ground',
  Bunny: 'ground',
  Chicken: 'ground',
  Cat: 'ground',
  Fox: 'ground',
  Pig: 'ground',
  Yetti: 'ground',
};

export type UnitKind = 'Unit' | 'Queen' | 'King' | 'Base';

export interface Unit {
  id: string;
  ownerId: string;
  animal: AnimalId;
  kind: UnitKind;
  position: Position3D;
  hp: number;
  maxHp: number;
  attackDamage: number;
  moveSpeed: number; // units per second
  attackRange: number; // world units; melee animals ~4, ranged animals reach further (enables kiting)
  attackCooldownMs: number;
  lastAttackAtMs: number;
  rotation: number; // rotation angle in radians around y-axis
  arrivedAtDestinationMs?: number; // timestamp when unit first arrived within 5 units of destination
  collisionAttempts?: number; // number of consecutive collision attempts
  movementPausedUntilMs?: number; // timestamp when movement pause expires
  // Hopping animation (for Frog and Bunny)
  hopPhase?: number; // 0 to 1, represents position in hop cycle
  isHopping?: boolean; // true when unit is moving (for Frog and Bunny)
  // Flying animation (for Owl)
  wingPhase?: number; // 0 to 1, represents wing flap cycle
  isFlying?: boolean; // true when unit is moving (for Owl)
  nearDestinationSinceMs?: number; // timestamp when owl first got within 10 units of destination
  lastCombatTargetId?: string; // ID of last target engaged in combat for persistence
  lastCombatEngagementMs?: number; // timestamp of last combat engagement
  unitState?: 'idle' | 'moving_to_order' | 'pursuing_enemy'; // current unit behavior state
  firstBlockedAtMs?: number; // timestamp when unit first became blocked
  currentAttackers?: string[]; // IDs of units currently attacking this unit
  priorityAttacker?: string; // ID of the attacker this unit is focusing on
  // A* path cache (ground units only) — see GridPathfinder. The waypoints to follow, the
  // current index into them, the destination the path was built for, and the bridge-state
  // version it assumed (so it is recomputed when a bridge opens or closes).
  pathWaypoints?: Position3D[];
  pathIndex?: number;
  pathDestX?: number;
  pathDestZ?: number;
  pathVersion?: number;
  pathStall?: number;
  pathProgressDist?: number;
  pathStuckTicks?: number;
  pathLastX?: number;
  pathLastZ?: number;
  // Aura sources (Queen heal / King damage) only. True while the aura is
  // actively benefiting a friendly unit this tick — drives the ground ring's
  // green/pulsing "active" state in the renderer (otherwise it shows idle blue).
  auraActive?: boolean;
  // Turtle "shell" lock (toggled by simultaneous primary+secondary mouse press).
  // While true the unit holds position — checkCollision freezes its movement —
  // but it can still attack in range. The renderer shows the F0 shell pose.
  isShelled?: boolean;
  // Chicken egg-throw ability (triggered by simultaneous primary+secondary mouse
  // press while a friendly Chicken is selected). lastEggAtMs gates the per-press
  // cooldown; eggThrowUntilMs is the timestamp the F3 throw pose (Chicken_F3 +
  // Egg) stays visible until, after which the chicken returns to idle/walk poses.
  // Both are stamped with performance.now() to match the combat clock.
  lastEggAtMs?: number;
  eggThrowUntilMs?: number;
  // Frog tongue-grab ability (triggered by simultaneous primary+secondary mouse
  // press while a friendly Frog is selected). `tongue` holds the live grab state
  // while the ability animates (windup -> extend -> retract); it is cleared once
  // the tongue fully retracts. `lastTongueAtMs` stamps the most recent fire with
  // performance.now() to gate the per-frog cooldown. While `tongue` is set the
  // frog holds position (the tick skips its movement) so the grab reads cleanly.
  tongue?: FrogTongueState;
  lastTongueAtMs?: number;
}

// Live state of a Frog's tongue grab while the ability animates. The tongue
// extends from the frog's mouth toward a single targeted enemy; on contact it
// latches (grabbed=true) and the retract phase drags that enemy back to the
// frog, otherwise it simply reels back empty. A frog may have at most one
// tongue, and two frogs may not target the same enemy at once.
export interface FrogTongueState {
  phase: 'windup' | 'extending' | 'retracting';
  targetId: string;       // the single enemy this frog has claimed
  origin: Position3D;     // tongue base (frog mouth) in world space at fire time
  direction: Position3D;  // normalized aim direction on the XZ plane
  length: number;         // current extension from origin, in world units
  maxLength: number;      // reach this fire was clamped to (apex if it misses)
  grabbed: boolean;       // true once the tongue has latched onto the target
  phaseUntilMs: number;   // performance.now() timestamp the current phase ends at
  damageDealt: boolean;   // guards the one-time grab damage to a latched target
}

// A flying egg fired by a Chicken's throw ability. Travels in a straight line on
// the XZ plane toward the targeted point, dealing `damage` to the first enemy
// animal (non-Base) it passes within EGG_HIT_RADIUS of, then expiring. Expires
// on its own once it has flown `maxRange` world units without a hit.
export interface Projectile {
  id: string;
  ownerId: string;            // the firing chicken's owner; egg only hits other owners
  position: Position3D;       // current world position (flies at a fixed height)
  velocity: Position3D;       // world units per second (y is 0 — flat flight)
  traveled: number;           // world units flown so far, vs maxRange for expiry
  maxRange: number;           // distance to the targeted area, clamped to EGG_MAX_RANGE
  damage: number;             // hp removed from the animal it strikes
}

export interface Player {
  id: string;
  name: string;
  isAI: boolean;
  animals: AnimalId[]; // length 3
  basePositions: Position3D[]; // length 3
}

export interface GameConfig {
  mapSize: number;
  spawnIntervalMs: number; // 10s
  regenPerSecondNearQueen: number; // hp/sec within radius
  regenRadius: number; // in world units
  kingAuraRadius: number; // world units; friendly army units within this of a King deal extra damage
  kingDamageMultiplier: number; // attack-damage multiplier applied to army units inside a King's aura
}

export interface PatrolRoute {
  startPosition: Position3D;
  endPosition: Position3D;
  currentTarget: 'start' | 'end'; // which position the queen is currently moving toward
}

// Per-match scoring counters for the local player and a mirrored set for the
// AI, so the post-game screen can show a symmetric comparison. Reset on every
// startMatch so each round produces an independent leaderboard score. Tracked
// inside the tick loop where the relevant events fire (spawn, combat kill,
// bridge animation).
//
// Field naming convention: the `enemy*` / `player*` fields describe the
// *target* of the action, not the actor. So `enemyUnitsKilled` is "enemy units
// killed (by the local player)" and `playerUnitsKilled` is "local-player units
// killed (by the AI)" — i.e. the mirror image used for the Enemy Forces card.
export interface MatchStats {
  // Local player's accomplishments (used by computeScore and the Your Forces card)
  unitsGenerated: number;        // Local player's queens have spawned a Unit
  enemyUnitsKilled: number;      // Local player killed an enemy Unit
  enemyBasesDestroyed: number;   // Local player destroyed an enemy Base
  enemyKingsKilled: number;      // Local player killed an enemy King
  enemyQueensKilled: number;     // Local player killed an enemy Queen

  // AI's accomplishments (used by the Enemy Forces card for side-by-side
  // comparison; not scored toward the leaderboard).
  aiUnitsGenerated: number;      // AI's queens have spawned a Unit
  playerUnitsKilled: number;     // AI killed one of the local player's Units
  playerBasesDestroyed: number;  // AI destroyed one of the local player's Bases
  playerKingsKilled: number;     // AI killed one of the local player's Kings
  playerQueensKilled: number;    // AI killed one of the local player's Queens

  // Wall-clock match duration in milliseconds. Accumulates `dtMs` each tick
  // while the match is running and freezes the moment `gameOver` flips true
  // (tick() returns early on gameOver). Used both to display "Match Time" on
  // the post-game cards and as the leaderboard's tie-break: with two equal
  // scores, the lower matchTimeMs ranks higher (a faster win is better).
  matchDurationMs: number;

  // Per-side bridge control. Either team can position a King/Queen on the
  // bridge trigger and hold it down; the elapsed Fully_Down time is credited
  // to whichever side has a K/Q inside the trigger zone that tick (both, if
  // both sides are contesting). The legacy `rightBridgeDownMs` /
  // `leftBridgeDownMs` names are retained for the LOCAL player's contribution
  // so the existing computeScore signature and its unit tests keep working
  // unchanged — the AI's mirror lives on `enemy*BridgeDownMs`.
  rightBridgeDownMs: number;       // Local-player time holding the right bridge down (ms)
  leftBridgeDownMs: number;        // Local-player time holding the left bridge down (ms)
  enemyRightBridgeDownMs: number;  // AI time holding the right bridge down (ms)
  enemyLeftBridgeDownMs: number;   // AI time holding the left bridge down (ms)
}

export interface GameState {
  config: GameConfig;
  players: Player[];
  units: Unit[];
  lastSpawnAtMsByQueenId: Record<string, number>;
  lastRegenAtMsByUnitId: Record<string, number>; // track individual unit regen timing
  selectedAnimalPool: AnimalId[]; // UI selection for local player pre-game
  localPlayerId: string | null;
  matchStarted: boolean;
  gameOver: boolean;
  winner: string | null; // player id who won
  selectedUnitIds: string[]; // currently selected units
  unitOrders: Record<string, Position3D>; // unit id -> target position for movement orders
  queenPatrols: Record<string, PatrolRoute>; // queen id -> patrol route
  matchStats: MatchStats; // scoring counters for the current match (local player)
  projectiles: Projectile[]; // in-flight egg projectiles (Chicken ability)
}

export interface CommandMoveUnits {
  unitIds: string[];
  target: Position3D;
}

export interface CommandSetPatrol {
  queenId: string;
  startPosition: Position3D;
  endPosition: Position3D;
}

export interface CommandAttackTarget {
  unitIds: string[];
  targetId: string; // Enemy unit ID to attack
}

export interface CommandThrowEggs {
  unitIds: string[];      // selected units; only friendly Chickens off cooldown fire
  target: Position3D;     // world point the eggs are thrown toward
}

export interface CommandFireTongues {
  unitIds: string[];      // selected units; only friendly Frogs off cooldown fire
  cursor: Position3D;     // world point under the cursor, used to aim each grab
}


