import { test, expect } from '@playwright/test';
import * as THREE from 'three';
import { TerrainValidator } from '../src/utils/TerrainValidator';

/**
 * Pure-logic tests for terrain traversability. These build a synthetic THREE scene
 * (water plane + bridge-deck meshes identified by color) and exercise the real
 * raycast-based detection in TerrainValidator. No browser, WebGL, or GLB needed —
 * raycasting is CPU geometry math — so these run in the Node test process.
 *
 * Water color: #4A99FF. Bridge-deck colors: #D7D7D7 and #9B9B9B.
 */

const WATER = 0x4a99ff;
const BRIDGE_LIGHT = 0xd7d7d7;
const BRIDGE_DARK = 0x9b9b9b;

function coloredBox(color: number, size: [number, number, number], pos: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size[0], size[1], size[2]),
    new THREE.MeshStandardMaterial({ color }),
  );
  mesh.position.set(pos[0], pos[1], pos[2]);
  return mesh;
}

// A lake covering x,z in [-50, 50] at y=0, a right-side bridge deck (+z) painted in
// one bridge color and a left-side deck (-z) in the other.
function buildScene(): THREE.Object3D {
  const scene = new THREE.Group();
  scene.add(coloredBox(WATER, [100, 1, 100], [0, 0, 0]));
  scene.add(coloredBox(BRIDGE_LIGHT, [12, 1, 12], [0, 1, 30])); // right deck
  scene.add(coloredBox(BRIDGE_DARK, [12, 1, 12], [0, 1, -30])); // left deck
  scene.updateMatrixWorld(true);
  return scene;
}

function freshValidator(): TerrainValidator {
  const validator = new TerrainValidator();
  validator.initialize(buildScene());
  return validator;
}

const at = (x: number, z: number) => ({ x, y: 0, z });

test.describe('movement-type traversal over water', () => {
  test('ground animals are blocked over open water but not on land', () => {
    const validator = freshValidator();
    // Over the lake, away from either deck -> blocked for a ground animal.
    expect(validator.canAnimalMoveTo('Bear', at(0, 45))).toBe(false);
    // Well outside the lake footprint -> land, always allowed.
    expect(validator.canAnimalMoveTo('Bear', at(200, 200))).toBe(true);
  });

  test('water and air animals are never blocked by water', () => {
    const validator = freshValidator();
    expect(validator.canAnimalMoveTo('Dolphin', at(0, 45))).toBe(true); // water
    expect(validator.canAnimalMoveTo('Bee', at(0, 45))).toBe(true);     // air
  });
});

test.describe('bridge-deck detection by color', () => {
  test('a lowered bridge deck lets ground animals cross water', () => {
    const validator = freshValidator(); // bridges default to Fully_Down
    expect(validator.canAnimalMoveTo('Bear', at(0, 30))).toBe(true);  // right deck (#D7D7D7)
    expect(validator.canAnimalMoveTo('Bear', at(0, -30))).toBe(true); // left deck (#9B9B9B)
  });

  test('raising a bridge blocks ground animals on that side only', () => {
    const validator = freshValidator();
    validator.updateBridgeState({ right: 'Fully_Up', left: 'Fully_Down' });

    // Right deck raised -> ground blocked there...
    expect(validator.canAnimalMoveTo('Bear', at(0, 30))).toBe(false);
    // ...left deck still down -> still crossable.
    expect(validator.canAnimalMoveTo('Bear', at(0, -30))).toBe(true);
  });

  test('water animals cross a raised bridge regardless of state', () => {
    const validator = freshValidator();
    validator.updateBridgeState({ right: 'Fully_Up', left: 'Fully_Up' });
    expect(validator.canAnimalMoveTo('Dolphin', at(0, 30))).toBe(true);
  });

  test('a deck just off the water footprint is treated as land (passable)', () => {
    const validator = freshValidator();
    // Outside the lake (z=200): not over water, so traversable irrespective of bridges.
    expect(validator.canAnimalMoveTo('Bear', at(0, 200))).toBe(true);
  });
});

test.describe('graceful degradation', () => {
  test('an uninitialized validator allows all movement', () => {
    const validator = new TerrainValidator();
    expect(validator.canAnimalMoveTo('Bear', at(0, 0))).toBe(true);
  });
});
