// Conquest game-mode state (separate Zustand store).
//
// Single responsibility: own the Conquest match's data model — the generated
// world, the players, and which player owns each tile — and the deterministic
// actions that set it up. Kept independent of the main RTS `useGameStore` so the
// two modes stay low-coupled; Conquest only borrows shared primitives (SeededRng,
// AnimalId, the geometry/biome modules).
//
// Determinism: every random choice (spawn placement) flows through SeededRng
// keyed off the match seed, so a given seed + player config reproduces the same
// planet and the same starting positions for every client — the foundation a
// future lockstep/AI layer builds on.

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
  animals: AnimalId[];   // reused RTS roster (length 3)
  homeTileId: number;    // the pentagon this player spawned on
}

export interface ConquestSetup {
  seed: number;
  subdivisions: number;
  humanAnimals: AnimalId[];
  /** Number of AI opponents; human + AI must not exceed MAX_CONQUEST_PLAYERS. */
  aiCount: number;
  worldGen?: WorldGenParams;
}

/**
 * A unit's starting placement on the globe. The live simulation (movement,
 * piloting) reads this as the spawn point and then tracks each unit's position
 * itself; the store keeps the immutable spawn descriptor so a match can be
 * re-derived. Each player fields one monarch (their roster leader) plus the
 * rest of the roster as followers.
 */
export interface ConquestUnitSpawn {
  id: string;
  ownerId: string;
  animal: AnimalId;
  isMonarch: boolean;
  /** Spawn position on the tile's top surface (world space, globe radius ~1). */
  position: { x: number; y: number; z: number };
}

interface ConquestState {
  world: GoldbergWorld | null;
  biomes: TileBiome[];
  seed: number;
  players: ConquestPlayer[];
  units: ConquestUnitSpawn[];
  /** tileId → owning player id (absent/null = unclaimed). */
  tileOwners: Record<number, string>;
  selectedTileId: number | null;
  /** Id of the human monarch the camera follows and the player pilots. */
  selectedMonarchId: string | null;

  generate: (setup: ConquestSetup) => void;
  reset: () => void;
  selectTile: (tileId: number | null) => void;
  /** Pilot the next of the local player's units (Tab in-match). */
  cycleMonarch: () => void;
  setSelectedMonarch: (unitId: string) => void;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
// How far roster members sit from their home tile center at spawn, in the tile's
// tangent plane. Kept tight (animals are tiny vs an acre-sized tile) so the army
// reads as a small cluster near the tile center rather than spread across it.
const SPAWN_CLUSTER_RADIUS = 0.012;

/** Place a player's roster as units clustered on their home tile's surface. */
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

  return player.animals.map((animal, index) => {
    const angle = (index / Math.max(1, player.animals.length)) * Math.PI * 2;
    const position = surfacePoint.clone()
      .addScaledVector(right, Math.cos(angle) * SPAWN_CLUSTER_RADIUS)
      .addScaledVector(forward, Math.sin(angle) * SPAWN_CLUSTER_RADIUS);
    return {
      id: `${player.id}-u${index}`,
      ownerId: player.id,
      animal,
      isMonarch: index === 0, // roster leader pilots
      position: { x: position.x, y: position.y, z: position.z },
    };
  });
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

/** Default AI rosters cycle distinct, recognizable archetypes for variety. */
const AI_ROSTERS: AnimalId[][] = [
  ['Bear', 'Owl', 'Bunny'],
  ['Turtle', 'Frog', 'Chicken'],
  ['Pig', 'Bee', 'Cat'],
  ['Yetti', 'Fox', 'Dolphin'],
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
    animals: setup.humanAnimals,
    homeTileId: spawnTileIds[0],
  }];

  for (let aiIndex = 1; aiIndex < totalPlayers; aiIndex++) {
    players.push({
      id: `ai${aiIndex}`,
      name: `AI ${aiIndex}`,
      color: CONQUEST_PLAYER_COLORS[aiIndex % CONQUEST_PLAYER_COLORS.length],
      isAI: true,
      animals: AI_ROSTERS[(aiIndex - 1) % AI_ROSTERS.length],
      homeTileId: spawnTileIds[aiIndex],
    });
  }

  return players;
}

export const useConquestStore = create<ConquestState>((set, get) => ({
  world: null,
  biomes: [],
  seed: 0,
  players: [],
  units: [],
  tileOwners: {},
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
      selectedTileId: null, selectedMonarchId: humanMonarch?.id ?? null,
    });
  },

  reset: () => set({
    world: null, biomes: [], seed: 0, players: [], units: [], tileOwners: {},
    selectedTileId: null, selectedMonarchId: null,
  }),

  selectTile: (tileId) => set({ selectedTileId: tileId }),

  setSelectedMonarch: (unitId) => set({ selectedMonarchId: unitId }),

  cycleMonarch: () => {
    const { units, players, selectedMonarchId } = get();
    const human = players.find((player) => !player.isAI);
    if (!human) return;
    // Cycle through every unit the local player controls, in stable order.
    const ownUnits = units.filter((unit) => unit.ownerId === human.id);
    if (ownUnits.length === 0) return;
    const currentIndex = ownUnits.findIndex((unit) => unit.id === selectedMonarchId);
    const next = ownUnits[(currentIndex + 1) % ownUnits.length];
    set({ selectedMonarchId: next.id });
  },
}));

/** Convenience: the biome rules for a tile, or null if the world isn't built. */
export function tileBiomeDefinition(tileId: number) {
  const { biomes } = useConquestStore.getState();
  const tileBiome = biomes[tileId];
  return tileBiome ? BIOMES[tileBiome.biome] : null;
}
