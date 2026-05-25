import { test, expect } from '@playwright/test';
import * as THREE from 'three';
import { TerrainValidator } from '../src/utils/TerrainValidator';
import { buildOptimizedBattleMap } from '../src/components/Working/mergeBattleMap';

/**
 * Pure-logic tests for terrain traversability. These build a synthetic THREE scene
 * (a water plane identified by color, plus bridge decks identified by node name, as
 * on the real map) and exercise the real raycast-based detection in TerrainValidator.
 * No browser, WebGL, or GLB needed — raycasting is CPU geometry math — so these run
 * in the Node test process.
 *
 * Water is detected by color (#4A99FF); bridge decks are detected by their
 * "Right_Bridge_*" / "Left_Bridge_*" node names (deck colors are ambiguous grays).
 */

const WATER = 0x4a99ff;
const DECK = 0xa6a6a6; // a real deck gray — irrelevant to detection, which is by name

function coloredBox(color: number, size: [number, number, number], pos: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size[0], size[1], size[2]),
    new THREE.MeshStandardMaterial({ color }),
  );
  mesh.position.set(pos[0], pos[1], pos[2]);
  return mesh;
}

// A bridge deck wrapped in a named node, mirroring the real map's structure
// (Right_Bridge_Fully_Down > deck meshes).
function namedBridge(nodeName: string, pos: [number, number, number]): THREE.Object3D {
  const node = new THREE.Group();
  node.name = nodeName;
  node.add(coloredBox(DECK, [12, 1, 12], pos));
  return node;
}

// A lake covering x,z in [-50, 50] at y=0, with a right-side deck (+z), a left-side
// deck (-z), and a static center deck (+x), each under a side-named node like the
// real map.
function buildScene(): THREE.Object3D {
  const scene = new THREE.Group();
  scene.add(coloredBox(WATER, [100, 1, 100], [0, 0, 0]));
  scene.add(namedBridge('Right_Bridge_Fully_Down', [0, 1, 30]));
  scene.add(namedBridge('Left_Bridge_Fully_Down', [0, 1, -30]));
  scene.add(namedBridge('Center_Bridge_Fully_Down', [30, 1, 0]));
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

test.describe('bridge-deck detection by name', () => {
  test('a lowered bridge deck lets ground animals cross water', () => {
    const validator = freshValidator(); // bridges default to Fully_Down
    expect(validator.canAnimalMoveTo('Bear', at(0, 30))).toBe(true);  // right deck
    expect(validator.canAnimalMoveTo('Bear', at(0, -30))).toBe(true); // left deck
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

test.describe('center bridge (static, always crossable)', () => {
  test('ground animals can cross the center bridge', () => {
    const validator = freshValidator();
    expect(validator.canAnimalMoveTo('Bear', at(30, 0))).toBe(true);
  });

  test('the center bridge stays crossable even when the side bridges are raised', () => {
    const validator = freshValidator();
    validator.updateBridgeState({ right: 'Fully_Up', left: 'Fully_Up' });
    expect(validator.canAnimalMoveTo('Bear', at(30, 0))).toBe(true);  // center unaffected
    expect(validator.canAnimalMoveTo('Bear', at(0, 30))).toBe(false); // right raised -> blocked
  });

  test('a map-sized object named like a bridge (e.g. a skybox duplicate) is ignored', () => {
    // Mirrors a real mistake: a giant sphere/box accidentally named Center_Bridge_*.
    // If treated as a deck it would make all water crossable; it must be rejected.
    const scene = new THREE.Group();
    scene.add(coloredBox(WATER, [100, 1, 100], [0, 0, 0]));
    const bogus = new THREE.Group();
    bogus.name = 'Center_Bridge_Fully_Down';
    bogus.add(coloredBox(DECK, [4000, 4000, 4000], [0, 0, 0])); // map-sized
    scene.add(bogus);
    scene.updateMatrixWorld(true);
    const validator = new TerrainValidator();
    validator.initialize(scene);

    // Open water is still blocked for ground despite the bogus "bridge".
    expect(validator.canAnimalMoveTo('Bear', at(0, 45))).toBe(false);
  });
});

test.describe('center bridge survives the draw-call merge as a crossable deck', () => {
  // Regression for: "ground animals cannot cross the Center_Bridge". The shipped
  // Center_Bridge is a FLAT, single-sided (THREE.FrontSide) deck plane whose node
  // carries a net-negative scale. The negative scale flips the deck's winding so its
  // one rendered face points DOWN; TerrainValidator's straight-down traversability
  // ray then hits a culled back-face and registers no hit, so a ground unit standing
  // on the deck is treated as standing on open water and held in place. The earlier
  // synthetic decks used upward-facing BoxGeometry and never reproduced this. These
  // tests drive the real path (buildOptimizedBattleMap -> TerrainValidator), so they
  // would fail without the merge step forcing deck materials double-sided.

  // The shipped Center_Bridge as the GLB actually exports it: a single mesh named
  // "Center_Bridge" (the glTF node has no children, so the loaded mesh carries the
  // name itself), a FLAT single-sided (FrontSide) deck plane, with a net-negative
  // node scale baked onto the mesh. The negative scale flips the deck's winding so
  // its one rendered face points down.
  function flippedSingleSidedCenterDeck(position: [number, number, number]): THREE.Object3D {
    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.rotateX(-Math.PI / 2); // lay flat, front face up before the flip
    const deck = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: DECK, side: THREE.FrontSide }),
    );
    deck.name = 'Center_Bridge';
    deck.position.set(position[0], position[1], position[2]);
    deck.scale.set(-5.8, -5.8, -43.53); // net-negative scale flips the winding
    return deck;
  }

  function buildMergedScene(): THREE.Object3D {
    const source = new THREE.Group();
    source.add(coloredBox(WATER, [100, 1, 100], [0, 0, 0]));
    source.add(flippedSingleSidedCenterDeck([30, 1, 0]));
    source.updateMatrixWorld(true);
    return buildOptimizedBattleMap(source).root;
  }

  test('a ground unit can cross a flipped single-sided center deck after merge', () => {
    const validator = new TerrainValidator();
    validator.initialize(buildMergedScene());

    expect(validator.canAnimalMoveTo('Bear', at(30, 0))).toBe(true);  // on the deck
    expect(validator.canAnimalMoveTo('Bear', at(0, 45))).toBe(false); // open water still blocks
  });
});

test.describe('performance: ground queries are cached', () => {
  // Counts how many raycasts a sequence of ground queries triggers. Before
  // caching, every per-tick movement step raycast against the water mesh; this
  // guards that repeated queries in a cell collapse to a single raycast.
  function countRaycasts(validator: TerrainValidator, run: () => void): number {
    const raycaster = (validator as unknown as { raycaster: THREE.Raycaster }).raycaster;
    const original = raycaster.intersectObjects.bind(raycaster);
    let calls = 0;
    raycaster.intersectObjects = ((...args: Parameters<typeof original>) => {
      calls++;
      return original(...args);
    }) as typeof raycaster.intersectObjects;
    run();
    raycaster.intersectObjects = original;
    return calls;
  }

  test('repeated queries in the same over-water cell raycast at most once', () => {
    const validator = freshValidator();
    const calls = countRaycasts(validator, () => {
      for (let i = 0; i < 500; i++) validator.canAnimalMoveTo('Bear', at(0, 45));
    });
    // One water raycast for the cell; the rest are cache hits (no bridge raycast
    // here because this cell is outside the bridge bounding box).
    expect(calls).toBeLessThanOrEqual(2);
  });

  test('a bridge state change re-validates cells (cache invalidation works)', () => {
    const validator = freshValidator();
    // Warm the cache for an over-bridge cell.
    validator.canAnimalMoveTo('Bear', at(0, 30));
    const beforeChange = countRaycasts(validator, () => {
      for (let i = 0; i < 100; i++) validator.canAnimalMoveTo('Bear', at(0, 30));
    });
    expect(beforeChange).toBe(0); // fully cached

    validator.updateBridgeState({ right: 'Fully_Up', left: 'Fully_Down' });
    const afterChange = countRaycasts(validator, () => {
      validator.canAnimalMoveTo('Bear', at(0, 30));
    });
    expect(afterChange).toBeGreaterThan(0); // cache cleared -> recomputed
  });
});

test.describe('graceful degradation', () => {
  test('an uninitialized validator allows all movement', () => {
    const validator = new TerrainValidator();
    expect(validator.canAnimalMoveTo('Bear', at(0, 0))).toBe(true);
  });
});
