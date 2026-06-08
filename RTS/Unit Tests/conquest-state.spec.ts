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

const HUMAN_ANIMAL: AnimalId = 'Bear';

function generateMatch(seed: number, aiCount: number) {
  useConquestStore.getState().generate({
    seed,
    subdivisions: 3,
    humanAnimal: HUMAN_ANIMAL,
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
    expect(state.players[0].animal).toBe(HUMAN_ANIMAL);
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
    expect(state.armyController).toEqual({});
    expect(state.outcome).toBe('playing');
    expect(state.lastCapture).toBeNull();
    expect(state.selectedTileId).toBeNull();
  });
});

test.describe('Conquest capture mechanic', () => {
  test('conquering an army transfers its control, territory, and a capture event', () => {
    const state = generateMatch(42, 3);
    const conqueror = state.players[0].id; // the human
    const victim = state.players[1].id;    // an AI rival
    const victimHome = state.players[1].homeTileId;

    expect(state.tileOwners[victimHome]).toBe(victim);

    useConquestStore.getState().conquerArmy(victim, conqueror, 1000);
    const after = useConquestStore.getState();

    // The defeated army is now controlled by the conqueror...
    expect(after.armyController[victim]).toBe(conqueror);
    // ...its territory has changed hands...
    expect(after.tileOwners[victimHome]).toBe(conqueror);
    // ...and the capture is surfaced to the HUD.
    expect(after.lastCapture).toEqual({ conquerorId: conqueror, defeatedId: victim, atMs: 1000 });
  });

  test('a captured army adds its monarch to the human\'s cycle', () => {
    const state = generateMatch(42, 3);
    const human = state.players[0].id;
    const victim = state.players[1].id;

    // Before capture the human controls only their own monarch, so cycling is a
    // no-op (one army = one monarch).
    const startMonarch = useConquestStore.getState().selectedMonarchId;
    useConquestStore.getState().cycleMonarch();
    expect(useConquestStore.getState().selectedMonarchId).toBe(startMonarch);

    // After capturing a rival, cycling reaches the captured army's monarch.
    useConquestStore.getState().conquerArmy(victim, human, 500);
    useConquestStore.getState().cycleMonarch();
    const cycled = useConquestStore.getState();
    const cycledUnit = cycled.units.find((u) => u.id === cycled.selectedMonarchId)!;
    expect(cycledUnit.isMonarch).toBe(true);
    expect(cycledUnit.ownerId).toBe(victim); // now controlled by the human via capture
  });

  test('losing every army to a rival is a defeat; controlling them all is victory', () => {
    const state = generateMatch(42, 1); // human + one AI
    const human = state.players[0].id;
    const ai = state.players[1].id;

    useConquestStore.getState().conquerArmy(ai, human, 100);
    expect(useConquestStore.getState().outcome).toBe('victory');

    // A fresh match where the human's own army falls to the AI is a defeat.
    generateMatch(42, 1);
    useConquestStore.getState().conquerArmy(human, ai, 200);
    expect(useConquestStore.getState().outcome).toBe('defeat');
  });
});
