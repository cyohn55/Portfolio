// Conquest game-mode state (separate Zustand store).
//
// Single responsibility: own the Conquest match's data model — the generated
// world, the players, which player owns each tile, and (the conquest twist) which
// player currently *controls* each army — plus the deterministic actions that set
// it up and the capture action that transfers a defeated army. Kept independent of
// the main RTS `useGameStore` so the two modes stay low-coupled; Conquest only
// borrows shared primitives (SeededRng, AnimalId, the geometry/biome modules).
//
// Determinism: every random choice (spawn placement) flows through SeededRng
// keyed off the match seed, so a given seed + player config reproduces the same
// planet and the same starting positions for every client — the foundation a
// future lockstep/AI layer builds on.
//
// Conquest rule (the defining mechanic): a player picks ONE animal and fields an
// army of it — a king/queen monarch plus a squad of that animal. When an army's
// monarch falls in battle the whole army is captured: every surviving unit, the
// monarch included, switches to the conqueror's control (see `conquerArmy`). The
// human can then pilot the captured army's monarch too, commanding several armies
// at once. We track control as an `armyController` override keyed by the army's
// original owner id, deliberately separate from the immutable spawn `units` so the
// live field never has to rebuild (and lose unit positions) when control changes.

import { create } from 'zustand';
import * as THREE from 'three';
import type { AnimalId } from '../../../game/types';
import { SeededRng } from '../net/prng';
import { buildGoldbergWorld, type GoldbergWorld } from './goldbergWorld';
import {
  classifyWorld,
  BIOMES,
  DEFAULT_WORLDGEN,
  type TileBiome,
  type WorldGenParams,
} from './conquestBiomes';
import { tileTopRadius } from './conquestGlobeGeometry';

export const MAX_CONQUEST_PLAYERS = 12; // one per pentagon spawn node
export const DEFAULT_CONQUEST_SUBDIVISIONS = 3; // GP(8,0) → 362 tiles

// Army size: every army is led by a King and a Queen (the two monarchs the player
// pilots and captures) plus a squad of the same animal that follows and fights
// alongside them. Kept small so each army reads as a tight cluster on an acre-sized
// tile and so a capture is a meaningful prize. SIZE - 2 are plain units.
export const CONQUEST_SQUAD_SIZE = 6;

/**
 * The role a Conquest unit plays in its army. Mirrors Quick Play's King/Queen/Unit
 * split: the King carries a damage-buff aura and hits hardest, the Queen carries a
 * heal aura, and Units are the rank-and-file. Both King and Queen are "monarchs"
 * (piloted and captured); see [[rts-monarch-piloting]].
 */
export type ConquestUnitKind = 'king' | 'queen' | 'unit';

/** Distinct, high-contrast team colors. Index 0 is always the human player. */
export const CONQUEST_PLAYER_COLORS: readonly number[] = [
  0x4f8cff, 0xff5d5d, 0x4ade80, 0xfbbf24, 0xa855f7, 0xf472b6,
  0x22d3ee, 0xf97316, 0x84cc16, 0xe2e8f0, 0x14b8a6, 0x9333ea,
];

export interface ConquestPlayer {
  id: string;            // 'p0' for the human, 'ai1'… for opponents
  name: string;
  color: number;
  isAI: boolean;
  animal: AnimalId;      // the single animal this player's army is made of
  homeTileId: number;    // the pentagon this player spawned on
}

export interface ConquestSetup {
  seed: number;
  subdivisions: number;
  /** The one animal the human's army is made of. */
  humanAnimal: AnimalId;
  /** Number of AI opponents; human + AI must not exceed MAX_CONQUEST_PLAYERS. */
  aiCount: number;
  worldGen?: WorldGenParams;
}

/**
 * A unit's starting placement on the globe. The live simulation (movement,
 * piloting, combat) reads this as the spawn point and then tracks each unit's
 * position itself; the store keeps the immutable spawn descriptor so a match can
 * be re-derived. `ownerId` here is the army's *original* owner — its permanent
 * army identity — which never changes; live control is tracked separately by
 * `armyController` so capturing an army doesn't rebuild the field.
 */
export interface ConquestUnitSpawn {
  id: string;
  ownerId: string;
  animal: AnimalId;
  kind: ConquestUnitKind;
  /** Convenience flag: true for the King and Queen (the army's two monarchs). */
  isMonarch: boolean;
  /** Spawn position on the tile's top surface (world space, globe radius ~1). */
  position: { x: number; y: number; z: number };
}

/** How a match ends, from the human player's perspective. */
export type ConquestOutcome = 'playing' | 'victory' | 'defeat';

/** A capture event surfaced to the HUD as a transient banner. */
export interface ConquestCaptureEvent {
  conquerorId: string;
  defeatedId: string;
  atMs: number;
}

interface ConquestState {
  world: GoldbergWorld | null;
  biomes: TileBiome[];
  seed: number;
  players: ConquestPlayer[];
  units: ConquestUnitSpawn[];
  /** tileId → owning player id (absent/null = unclaimed). */
  tileOwners: Record<number, string>;
  /**
   * armyId (original owner id) → the player currently controlling that army.
   * Absent means the army is still controlled by its original owner. Updated by
   * `conquerArmy` when a monarch is captured.
   */
  armyController: Record<string, string>;
  /**
   * controllerId → number of living units that controller commands right now.
   * Published from the live field on a throttle (the field owns unit life/death);
   * the HUD reads it against each controller's territory-derived population cap.
   */
  controlledUnitCounts: Record<string, number>;
  outcome: ConquestOutcome;
  lastCapture: ConquestCaptureEvent | null;
  selectedTileId: number | null;
  /** Id of the human monarch the camera follows and the player pilots. */
  selectedMonarchId: string | null;

  generate: (setup: ConquestSetup) => void;
  reset: () => void;
  selectTile: (tileId: number | null) => void;
  /** Pilot the next monarch the human controls (Tab/cycle in-match). */
  cycleMonarch: () => void;
  setSelectedMonarch: (unitId: string) => void;
  /** Transfer a defeated army to its conqueror (the core conquest mechanic). */
  conquerArmy: (defeatedArmyId: string, conquerorId: string, atMs: number) => void;
  /**
   * Flip the owner of one or more tiles in a single update (occupation claiming —
   * Increment 5). Merges `updates` (tileId → new owner) into `tileOwners`; a no-op
   * when nothing actually changes, so the field can call it without thrashing React.
   */
  claimTiles: (updates: Record<number, string>) => void;
  /** Publish the live per-controller unit counts from the field (throttled). */
  setControlledUnitCounts: (counts: Record<string, number>) => void;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
// How far roster members sit from their home tile center at spawn, in the tile's
// tangent plane. Kept tight (animals are tiny vs an acre-sized tile) so the army
// reads as a small cluster near the tile center rather than spread across it.
const SPAWN_CLUSTER_RADIUS = 0.012;

// Army composition: index 0 is the King, index 1 the Queen (both monarchs, held
// near the tile center), and the remaining indices the unit squad ringed behind
// them. Index → kind so the field can scale stats and auras per role.
function kindForIndex(index: number): ConquestUnitKind {
  if (index === 0) return 'king';
  if (index === 1) return 'queen';
  return 'unit';
}

/** Place a player's same-animal army (King + Queen at center, squad ringed) on its home tile. */
function buildUnitsForPlayer(
  player: ConquestPlayer,
  world: GoldbergWorld,
  biomes: TileBiome[],
): ConquestUnitSpawn[] {
  const tile = world.tiles[player.homeTileId];
  const tileBiome = biomes[player.homeTileId];
  if (!tile || !tileBiome) return [];

  const normal = tile.center.clone().normalize();
  const surfaceRadius = tileTopRadius(tileBiome);
  const surfacePoint = normal.clone().multiplyScalar(surfaceRadius);

  const reference = Math.abs(normal.x) < 0.9 ? X_AXIS : Y_AXIS;
  const right = new THREE.Vector3().crossVectors(normal, reference).normalize();
  const forward = new THREE.Vector3().crossVectors(normal, right).normalize();

  const followerCount = CONQUEST_SQUAD_SIZE - 2;
  const units: ConquestUnitSpawn[] = [];
  for (let index = 0; index < CONQUEST_SQUAD_SIZE; index++) {
    const kind = kindForIndex(index);
    const position = surfacePoint.clone();
    if (kind === 'king') {
      // King holds the tile center; Queen stands just beside him.
      position.addScaledVector(right, -SPAWN_CLUSTER_RADIUS * 0.4);
    } else if (kind === 'queen') {
      position.addScaledVector(right, SPAWN_CLUSTER_RADIUS * 0.4);
    } else {
      const angle = ((index - 2) / Math.max(1, followerCount)) * Math.PI * 2;
      position
        .addScaledVector(right, Math.cos(angle) * SPAWN_CLUSTER_RADIUS)
        .addScaledVector(forward, Math.sin(angle) * SPAWN_CLUSTER_RADIUS);
    }
    units.push({
      id: `${player.id}-u${index}`,
      ownerId: player.id,
      animal: player.animal,
      kind,
      isMonarch: kind !== 'unit',
      position: { x: position.x, y: position.y, z: position.z },
    });
  }
  return units;
}

/** Deterministic in-place Fisher–Yates over a copy, driven by a seeded RNG. */
function seededShuffle<T>(items: readonly T[], rng: SeededRng): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const swap = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = swap;
  }
  return shuffled;
}

/** AI armies cycle through distinct, recognizable animals for variety. */
const AI_ANIMALS: AnimalId[] = [
  'Bear', 'Fox', 'Turtle', 'Owl', 'Pig', 'Bee',
  'Yetti', 'Dolphin', 'Cat', 'Frog', 'Chicken', 'Bunny',
];

function buildPlayers(
  setup: ConquestSetup,
  pentagonIds: number[],
  rng: SeededRng,
): ConquestPlayer[] {
  const totalPlayers = Math.min(
    1 + Math.max(0, setup.aiCount),
    MAX_CONQUEST_PLAYERS,
    pentagonIds.length,
  );

  // Spawn nodes are assigned by shuffling the 12 pentagons, so no player can
  // predict or be advantaged by a fixed home — only the seed decides.
  const spawnTileIds = seededShuffle(pentagonIds, rng).slice(0, totalPlayers);

  const players: ConquestPlayer[] = [{
    id: 'p0',
    name: 'You',
    color: CONQUEST_PLAYER_COLORS[0],
    isAI: false,
    animal: setup.humanAnimal,
    homeTileId: spawnTileIds[0],
  }];

  // AI armies avoid the human's animal where possible so allegiance reads clearly.
  const aiPool = AI_ANIMALS.filter((animal) => animal !== setup.humanAnimal);
  for (let aiIndex = 1; aiIndex < totalPlayers; aiIndex++) {
    players.push({
      id: `ai${aiIndex}`,
      name: `AI ${aiIndex}`,
      color: CONQUEST_PLAYER_COLORS[aiIndex % CONQUEST_PLAYER_COLORS.length],
      isAI: true,
      animal: aiPool[(aiIndex - 1) % aiPool.length],
      homeTileId: spawnTileIds[aiIndex],
    });
  }

  return players;
}

/**
 * Resolve who currently controls an army from the override map (defaulting to its
 * original owner). Exported so the field sim and tests share one definition of
 * "whose unit is this now?".
 */
export function effectiveController(
  armyController: Record<string, string>,
  armyId: string,
): string {
  return armyController[armyId] ?? armyId;
}

/** Compute the human's match outcome from current army control. */
function evaluateOutcome(
  players: ConquestPlayer[],
  armyController: Record<string, string>,
  humanId: string,
): ConquestOutcome {
  const controllers = players.map((player) => effectiveController(armyController, player.id));
  if (controllers.every((controller) => controller === humanId)) return 'victory';
  if (!controllers.some((controller) => controller === humanId)) return 'defeat';
  return 'playing';
}

export const useConquestStore = create<ConquestState>((set, get) => ({
  world: null,
  biomes: [],
  seed: 0,
  players: [],
  units: [],
  tileOwners: {},
  armyController: {},
  controlledUnitCounts: {},
  outcome: 'playing',
  lastCapture: null,
  selectedTileId: null,
  selectedMonarchId: null,

  generate: (setup) => {
    const world = buildGoldbergWorld(setup.subdivisions);
    const biomes = classifyWorld(world.tiles, setup.seed, setup.worldGen ?? DEFAULT_WORLDGEN);

    const rng = new SeededRng(setup.seed);
    const players = buildPlayers(setup, world.pentagonIds, rng);

    // Each player begins owning their spawn pentagon (always grassland/claimable).
    const tileOwners: Record<number, string> = {};
    for (const player of players) {
      tileOwners[player.homeTileId] = player.id;
    }

    const units = players.flatMap((player) => buildUnitsForPlayer(player, world, biomes));
    // The local player pilots their own monarch first.
    const human = players.find((player) => !player.isAI);
    const humanMonarch = units.find((unit) => unit.ownerId === human?.id && unit.isMonarch);

    set({
      world, biomes, seed: setup.seed, players, units, tileOwners,
      armyController: {}, controlledUnitCounts: {}, outcome: 'playing', lastCapture: null,
      selectedTileId: null, selectedMonarchId: humanMonarch?.id ?? null,
    });
  },

  reset: () => set({
    world: null, biomes: [], seed: 0, players: [], units: [], tileOwners: {},
    armyController: {}, controlledUnitCounts: {}, outcome: 'playing', lastCapture: null,
    selectedTileId: null, selectedMonarchId: null,
  }),

  selectTile: (tileId) => set({ selectedTileId: tileId }),

  setSelectedMonarch: (unitId) => set({ selectedMonarchId: unitId }),

  cycleMonarch: () => {
    const { units, players, armyController, selectedMonarchId } = get();
    const human = players.find((player) => !player.isAI);
    if (!human) return;
    // Cycle only through the monarchs the human currently controls — each leads an
    // army, so switching monarchs is how the player commands a different army.
    const controlledMonarchs = units.filter((unit) =>
      unit.isMonarch && effectiveController(armyController, unit.ownerId) === human.id);
    if (controlledMonarchs.length === 0) return;
    const currentIndex = controlledMonarchs.findIndex((unit) => unit.id === selectedMonarchId);
    const next = controlledMonarchs[(currentIndex + 1) % controlledMonarchs.length];
    set({ selectedMonarchId: next.id });
  },

  conquerArmy: (defeatedArmyId, conquerorId, atMs) => {
    const { players, armyController, tileOwners, selectedMonarchId, units } = get();
    // Guard: an army can only be captured once into a given controller, and never
    // re-captures itself (a monarch dying to its own controller is a no-op).
    if (effectiveController(armyController, defeatedArmyId) === conquerorId) return;

    const nextArmyController = { ...armyController, [defeatedArmyId]: conquerorId };

    // The defeated army's territory passes to the conqueror.
    const nextTileOwners: Record<number, string> = { ...tileOwners };
    for (const [tileIdKey, ownerId] of Object.entries(nextTileOwners)) {
      if (ownerId === defeatedArmyId) nextTileOwners[Number(tileIdKey)] = conquerorId;
    }

    const human = players.find((player) => !player.isAI);
    const outcome = human
      ? evaluateOutcome(players, nextArmyController, human.id)
      : 'playing';

    // If the human just lost the army they were piloting, hand the camera to any
    // monarch they still control so control never strands on an enemy unit.
    let nextSelected = selectedMonarchId;
    const selected = units.find((unit) => unit.id === selectedMonarchId);
    if (human && selected
        && effectiveController(nextArmyController, selected.ownerId) !== human.id) {
      const fallback = units.find((unit) =>
        unit.isMonarch && effectiveController(nextArmyController, unit.ownerId) === human.id);
      nextSelected = fallback?.id ?? null;
    }

    set({
      armyController: nextArmyController,
      tileOwners: nextTileOwners,
      outcome,
      lastCapture: { conquerorId, defeatedId: defeatedArmyId, atMs },
      selectedMonarchId: nextSelected,
    });
  },

  claimTiles: (updates) => {
    const { tileOwners } = get();
    // Only commit a new object (and the re-render it triggers) if some tile's owner
    // actually changes, so a unit standing on already-owned farmland is free.
    let changed = false;
    const nextTileOwners: Record<number, string> = { ...tileOwners };
    for (const [tileIdKey, ownerId] of Object.entries(updates)) {
      const tileId = Number(tileIdKey);
      if (nextTileOwners[tileId] !== ownerId) {
        nextTileOwners[tileId] = ownerId;
        changed = true;
      }
    }
    if (changed) set({ tileOwners: nextTileOwners });
  },

  setControlledUnitCounts: (counts) => set({ controlledUnitCounts: counts }),
}));

/** Convenience: the biome rules for a tile, or null if the world isn't built. */
export function tileBiomeDefinition(tileId: number) {
  const { biomes } = useConquestStore.getState();
  const tileBiome = biomes[tileId];
  return tileBiome ? BIOMES[tileBiome.biome] : null;
}
