import { test, expect } from '@playwright/test';
import { buildGoldbergWorld } from '../src/components/Working/conquest/goldbergWorld';
import { classifyWorld, BIOMES } from '../src/components/Working/conquest/conquestBiomes';
import {
  buildGlobeGeometry,
  tileTopRadius,
  DEFAULT_GLOBE_OPTIONS,
} from '../src/components/Working/conquest/conquestGlobeGeometry';
import { useConquestStore } from '../src/components/Working/conquest/conquestState';
import type { AnimalId } from '../src/game/types';

/**
 * Unit tests for the playable Conquest field: the flat/beveled tile geometry,
 * the per-tile passability model that piloting relies on, and the unit + monarch
 * data the controls drive. All pure Node — geometry and store have no DOM/WebGL
 * dependency. Assertions check real geometric properties (face planarity, bevel
 * relief) and store behavior, not constants copied from the implementation.
 */

const HUMAN_ANIMALS: AnimalId[] = ['Bear', 'Owl', 'Frog'];

// Triangles emitted per polygon side: flat top fan + 2 bevel + 2 wall + 1 bottom.
const TRIANGLES_PER_SIDE = 6;

test.describe('Tile passability model', () => {
  test('land tiles admit ground and amphibious (water) units', () => {
    expect(BIOMES.grassland.passableBy.has('ground')).toBe(true);
    expect(BIOMES.grassland.passableBy.has('water')).toBe(true);
    expect(BIOMES.grassland.passableBy.has('air')).toBe(true);
  });

  test('water tiles bar ground but pass water/air', () => {
    expect(BIOMES.ocean.passableBy.has('ground')).toBe(false);
    expect(BIOMES.ocean.passableBy.has('water')).toBe(true);
    expect(BIOMES.ocean.passableBy.has('air')).toBe(true);
  });

  test('mountains are impassable to all but air', () => {
    expect(BIOMES.mountain.passableBy.has('ground')).toBe(false);
    expect(BIOMES.mountain.passableBy.has('water')).toBe(false);
    expect(BIOMES.mountain.passableBy.has('air')).toBe(true);
  });
});

test.describe('Flat, beveled tile geometry', () => {
  const world = buildGoldbergWorld(3);
  const biomes = classifyWorld(world.tiles, 999);
  const built = buildGlobeGeometry(world, biomes, {
    ...DEFAULT_GLOBE_OPTIONS,
    ownerColors: new Map<number, number>(),
  });
  const positions = built.geometry.getAttribute('position').array as ArrayLike<number>;

  const hexId = world.tiles.findIndex((tile) => tile.sides === 6);
  const tileTriangles = built.triangleTileIds
    .map((id, index) => ({ id, index }))
    .filter((entry) => entry.id === hexId)
    .map((entry) => entry.index);

  test('triangle→tile map covers every triangle', () => {
    expect(built.triangleTileIds.length).toBe(built.geometry.getAttribute('position').count / 3);
  });

  test('a hexagon emits sides×6 triangles (top, bevel, wall, bottom)', () => {
    expect(tileTriangles.length).toBe(6 * TRIANGLES_PER_SIDE);
  });

  test('the top face is planar (genuinely flat)', () => {
    const tile = world.tiles[hexId];
    const normal = tile.center.clone().normalize();
    const topRadius = tileTopRadius(biomes[hexId]);

    // The top-face fan is the first triangle of each side's 6-triangle block.
    for (let local = 0; local < tileTriangles.length; local += TRIANGLES_PER_SIDE) {
      const triangle = tileTriangles[local];
      for (let vertex = 0; vertex < 3; vertex++) {
        const offset = (triangle * 3 + vertex) * 3;
        const distanceAlongNormal =
          positions[offset] * normal.x +
          positions[offset + 1] * normal.y +
          positions[offset + 2] * normal.z;
        expect(distanceAlongNormal).toBeCloseTo(topRadius, 5);
      }
    }
  });

  test('the bevel rim drops below the flat top face', () => {
    const tile = world.tiles[hexId];
    const normal = tile.center.clone().normalize();
    const topRadius = tileTopRadius(biomes[hexId]);

    // A bevel triangle (offset 1 within a side's block) has a vertex below the plane.
    let foundBelow = false;
    for (let local = 1; local < tileTriangles.length; local += TRIANGLES_PER_SIDE) {
      const triangle = tileTriangles[local];
      for (let vertex = 0; vertex < 3; vertex++) {
        const offset = (triangle * 3 + vertex) * 3;
        const distanceAlongNormal =
          positions[offset] * normal.x +
          positions[offset + 1] * normal.y +
          positions[offset + 2] * normal.z;
        if (distanceAlongNormal < topRadius - 1e-4) foundBelow = true;
      }
    }
    expect(foundBelow).toBe(true);
  });
});

test.describe('Conquest units and monarch selection', () => {
  function generate(seed: number, aiCount: number) {
    useConquestStore.getState().generate({
      seed, subdivisions: 3, humanAnimals: HUMAN_ANIMALS, aiCount,
    });
    return useConquestStore.getState();
  }

  test('every player fields its full roster with exactly one monarch', () => {
    const state = generate(42, 3);
    expect(state.units.length).toBe(state.players.length * HUMAN_ANIMALS.length);
    for (const player of state.players) {
      const monarchs = state.units.filter((u) => u.ownerId === player.id && u.isMonarch);
      expect(monarchs.length).toBe(1);
    }
  });

  test('the local player pilots their own monarch first', () => {
    const state = generate(42, 3);
    const human = state.players.find((p) => !p.isAI)!;
    const humanMonarch = state.units.find((u) => u.ownerId === human.id && u.isMonarch)!;
    expect(state.selectedMonarchId).toBe(humanMonarch.id);
  });

  test('units spawn on the tile surface (globe radius ~1)', () => {
    const state = generate(42, 3);
    for (const unit of state.units) {
      const radius = Math.hypot(unit.position.x, unit.position.y, unit.position.z);
      expect(radius).toBeGreaterThan(1.0);
      expect(radius).toBeLessThan(1.1);
    }
  });

  test('cycling the monarch advances through the local player\'s units only', () => {
    const state = generate(42, 3);
    const human = state.players.find((p) => !p.isAI)!;
    const before = useConquestStore.getState().selectedMonarchId;

    useConquestStore.getState().cycleMonarch();
    const after = useConquestStore.getState().selectedMonarchId;

    expect(after).not.toBe(before);
    expect(state.units.find((u) => u.id === after)!.ownerId).toBe(human.id);
  });
});
