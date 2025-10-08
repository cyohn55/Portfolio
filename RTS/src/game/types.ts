// 3D world coordinates
export type Position3D = { x: number; y: number; z: number };

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
}

export interface PatrolRoute {
  startPosition: Position3D;
  endPosition: Position3D;
  currentTarget: 'start' | 'end'; // which position the queen is currently moving toward
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


