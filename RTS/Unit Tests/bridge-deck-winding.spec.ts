import { test, expect } from '@playwright/test';
import * as THREE from 'three';
import { TerrainValidator } from '../src/utils/TerrainValidator';

/**
 * Regression for the center-island freeze: the real Center_Bridge deck is a flat quad
 * whose top face is wound so a default FrontSide material culls a straight-down raycast.
 * TerrainValidator's deck/bridge detection casts exactly such a ray, so it missed the deck
 * entirely — the bridge's water cells never classified as walkable deck, the center island
 * became an isolated component in the A* grid, and ground units routed to/from it got no
 * path, beelined into the moat, and froze at the bank (reported at the bridge mouths, on
 * the island, and along the shore on both sides).
 *
 * These tests build a deck quad facing DOWN (reproducing the bad winding) over water and
 * assert the validator still detects it as a crossable deck. The earlier terrain tests used
 * BoxGeometry decks — every face correctly wound outward — so they could never surface this;
 * a single downward-wound quad is the minimal reproduction. Pure raycast geometry, so it
 * runs in the Node test process with no browser.
 *
 * Run with: npx playwright test --config "Unit Tests/playwright.config.ts" bridge-deck-winding
 */

const WATER = 0x4a99ff;
const DECK = 0xa6a6a6;

function waterBox(size: [number, number, number], pos: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(...size),
    new THREE.MeshStandardMaterial({ color: WATER }),
  );
  mesh.position.set(...pos);
  return mesh;
}

// A horizontal deck quad whose front face points DOWN (normal -Y), mirroring the real
// Center_Bridge winding: a top-down ray hits its back face, which a FrontSide material
// culls. Wrapped in a "*_Bridge_*" node so TerrainValidator classifies it as a deck.
function downwardWoundDeck(nodeName: string, center: [number, number, number], size: [number, number]): THREE.Object3D {
  const plane = new THREE.PlaneGeometry(size[0], size[1]);
  plane.rotateX(Math.PI / 2); // +Z-facing plane -> faces -Y (down)
  const mesh = new THREE.Mesh(plane, new THREE.MeshStandardMaterial({ color: DECK, side: THREE.FrontSide }));
  mesh.position.set(...center);
  const node = new THREE.Group();
  node.name = nodeName;
  node.add(mesh);
  return node;
}

// Lake in x,z ∈ [-50, 50] at y=0 with a static center bridge crossing it as a downward-wound
// deck sitting just above the water surface, like the real map.
function buildScene(): { scene: THREE.Object3D; deckMesh: THREE.Mesh } {
  const scene = new THREE.Group();
  scene.add(waterBox([100, 1, 100], [0, 0, 0]));
  const bridge = downwardWoundDeck('Center_Bridge', [0, 1, 0], [12, 100]);
  scene.add(bridge);
  scene.updateMatrixWorld(true);
  const deckMesh = bridge.children[0] as THREE.Mesh;
  return { scene, deckMesh };
}

test.describe('TerrainValidator — downward-wound bridge deck detection', () => {
  test('a deck quad facing down is still detected as a crossable deck (the center-island fix)', () => {
    const { scene } = buildScene();
    const validator = new TerrainValidator();
    validator.initialize(scene);

    // A point over the bridge but also over water: this is the cell that must classify as
    // deck for the crossing to exist. Before the fix the FrontSide quad was invisible here.
    const overBridgeOverWater = { x: 0, y: 1, z: 0 };
    expect(validator.isPositionOverWater(overBridgeOverWater)).toBe(true);
    expect(validator.deckAt(overBridgeOverWater).onDeck).toBe(true);
    expect(validator.deckAt(overBridgeOverWater).side).toBe('center');
    expect(validator.bridgeAt(overBridgeOverWater).onBridge).toBe(true);
  });

  test('a ground animal may cross where the downward-wound deck spans the water', () => {
    const { scene } = buildScene();
    const validator = new TerrainValidator();
    validator.initialize(scene);

    // The center bridge is static (always down), so a ground animal must be allowed across.
    expect(validator.canAnimalMoveTo('Bear', { x: 0, y: 1, z: 0 })).toBe(true);
    expect(validator.canAnimalMoveTo('Bear', { x: 0, y: 1, z: 30 })).toBe(true);
    // Off the deck, still over open water: blocked, proving detection is the deck's footprint
    // and not a blanket "bridge bounds" pass.
    expect(validator.canAnimalMoveTo('Bear', { x: 40, y: 1, z: 0 })).toBe(false);
  });

  test('the fix forces the collected bridge material double-sided', () => {
    const { scene, deckMesh } = buildScene();
    const material = deckMesh.material as THREE.Material;
    expect(material.side).toBe(THREE.FrontSide); // precondition: starts single-sided

    new TerrainValidator().initialize(scene);
    expect(material.side).toBe(THREE.DoubleSide); // initialize flips it so raycasts hit
  });
});
