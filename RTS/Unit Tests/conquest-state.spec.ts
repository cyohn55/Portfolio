import { test, expect } from '@playwright/test';
import { useConquestStore } from '../src/components/Working/conquest/conquestState';
import type { AnimalId } from '../src/game/types';

/**
 * Unit tests for the Conquest store's match setup. Pure Node: the Zustand store
 * has no DOM dependency, so we drive it directly with getState() and assert the
 * data model that the renderer and (future) simulation consume.
 *
 * Focus is the determinism contract — a given seed + roster must reproduce the
 * same players, the same spawn assignment, and the same opening ownership — plus
 * the structural rule that every player spawns on a distinct pentagon node.
 */

const HUMAN_ANIMALS: AnimalId[] = ['Bear', 'Owl', 'Frog'];

function generateMatch(seed: number, aiCount: number) {
  useConquestStore.getState().generate({
    seed,
    subdivisions: 3,
    humanAnimals: HUMAN_ANIMALS,
    aiCount,
  });
  return useConquestStore.getState();
}

test.describe('Conquest match setup', () => {
  test('builds the requested number of players (human + AI)', () => {
    const state = generateMatch(42, 5);
    expect(state.players.length).toBe(6);
    expect(state.players[0].id).toBe('p0');
    expect(state.players[0].isAI).toBe(false);
    expect(state.players[0].animals).toEqual(HUMAN_ANIMALS);
    expect(state.players.slice(1).every((p) => p.isAI)).toBe(true);
  });

  test('every player spawns on a distinct pentagon node', () => {
    const state = generateMatch(42, 11);
    const homeTiles = state.players.map((p) => p.homeTileId);
    const uniqueHomes = new Set(homeTiles);

    expect(uniqueHomes.size).toBe(homeTiles.length);
    for (const tileId of homeTiles) {
      expect(state.world!.tiles[tileId].sides).toBe(5);
    }
  });

  test('each player begins owning exactly their home tile', () => {
    const state = generateMatch(42, 4);
    expect(Object.keys(state.tileOwners).length).toBe(state.players.length);
    for (const player of state.players) {
      expect(state.tileOwners[player.homeTileId]).toBe(player.id);
    }
  });

  test('player count is capped at twelve regardless of AI request', () => {
    const state = generateMatch(7, 50);
    expect(state.players.length).toBe(12);
  });

  test('same seed reproduces identical spawn assignment', () => {
    const first = generateMatch(123, 7).players.map((p) => p.homeTileId);
    const second = generateMatch(123, 7).players.map((p) => p.homeTileId);
    expect(second).toEqual(first);
  });

  test('different seeds generally relocate spawns', () => {
    const first = generateMatch(1, 11).players.map((p) => p.homeTileId);
    const second = generateMatch(2, 11).players.map((p) => p.homeTileId);
    expect(second).not.toEqual(first);
  });

  test('reset clears the match back to an empty world', () => {
    generateMatch(5, 3);
    useConquestStore.getState().reset();
    const state = useConquestStore.getState();

    expect(state.world).toBeNull();
    expect(state.players).toEqual([]);
    expect(state.tileOwners).toEqual({});
    expect(state.selectedTileId).toBeNull();
  });
});
