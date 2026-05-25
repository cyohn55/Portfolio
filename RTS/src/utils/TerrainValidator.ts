import * as THREE from 'three';
import type { Position3D, AnimalId, MovementType } from '../game/types';
import { ANIMAL_MOVEMENT_TYPES } from '../game/types';

// Water color in the battle map: #4A99FFFF
const WATER_COLOR = new THREE.Color(0x4A99FF);
const COLOR_TOLERANCE = 0.1; // Per-channel tolerance when matching terrain colors

// Bridge decks are identified by mesh name, not color: every deck mesh lives under a
// node named "Right_Bridge_<frame>" / "Left_Bridge_<frame>". Color is unusable here —
// the deck spans several grays (#a6a6a6, #676365, #c7c7c7, including the walkable
// surface) and hundreds of unrelated map props share those same grays. A position
// over a bridge deck lets ground units cross water there, provided that bridge is
// lowered (see isBridgeTraversable).
const BRIDGE_NAME_PATTERN = /bridge/i;
const RIGHT_NAME_PATTERN = /right/i;
const LEFT_NAME_PATTERN = /left/i;
const CENTER_NAME_PATTERN = /center/i;

// Which bridge a deck mesh belongs to. The right/left bridges raise and lower; the
// center bridge is a static, always-down crossing.
type BridgeSide = 'right' | 'left' | 'center';

// Max world-space span (largest of x/y/z) a real bridge deck can have. Guards against
// map-sized geometry that happens to be named like a bridge (e.g. a skybox sphere
// accidentally duplicated and renamed) being treated as a crossable deck — which
// would let ground units walk on water everywhere. Real decks are tens of units; the
// longest current one is ~90.
const MAX_BRIDGE_SPAN = 300;

// Reusable straight-down ray direction for terrain raycasts.
const DOWN = new THREE.Vector3(0, -1, 0);

// Side length (world units) of a ground-traversability cache cell. The per-tick
// movement code queries terrain for every ground unit; caching the (raycast-backed)
// result per cell keeps that query O(1) instead of casting a ray every step.
const TERRAIN_CELL_SIZE = 1;

export class TerrainValidator {
  // Accepts any Object3D (Scene or merged Group); only .traverse() is used.
  private battleMapScene: THREE.Object3D | null = null;
  private waterMeshes: THREE.Mesh[] = [];
  // Combined xz bounding box of all water meshes (with a small margin). Used as a
  // cheap broad-phase: a position outside this box cannot be over water, so the
  // far more expensive per-position raycast is skipped. Most combat happens away
  // from water, so this keeps the per-tick terrain cost negligible at scale.
  private waterBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;
  // Bridge deck meshes (all raise/lower frames), split by side so the bridge's
  // raised/lowered state can be checked, plus their combined xz broad-phase box.
  private rightBridgeMeshes: THREE.Mesh[] = [];
  private leftBridgeMeshes: THREE.Mesh[] = [];
  // The center bridge is always traversable (static, no raise/lower state).
  private centerBridgeMeshes: THREE.Mesh[] = [];
  private bridgeBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;
  // Memoized "can a ground unit stand here" per grid cell. Cleared whenever a
  // bridge's raised/lowered state changes (which is the only thing that alters the
  // answer for a fixed cell). Keeps per-tick terrain queries off the raycaster.
  private groundTraversableCache = new Map<number, boolean>();
  private raycaster: THREE.Raycaster;
  private bridgeState: {
    right: 'Fully_Up' | 'Almost_Up' | 'Almost_Down' | 'Fully_Down';
    left: 'Fully_Up' | 'Almost_Up' | 'Almost_Down' | 'Fully_Down';
  } = {
    right: 'Fully_Down',
    left: 'Fully_Down',
  };

  constructor() {
    this.raycaster = new THREE.Raycaster();
  }

  /**
   * Check if the terrain validator is initialized
   */
  public isInitialized(): boolean {
    return this.battleMapScene !== null;
  }

  /**
   * Initialize the terrain validator with the battle map scene
   */
  public initialize(scene: THREE.Object3D) {
    this.battleMapScene = scene;
    this.findTerrainMeshes();
    console.log('✅ Terrain validator initialized');
  }

  /**
   * Update the bridge state
   */
  public updateBridgeState(state: typeof this.bridgeState) {
    // Only the bridge up/down state changes a cell's ground-traversability, so
    // invalidate the cache solely on an actual change (this runs every frame).
    if (state.right !== this.bridgeState.right || state.left !== this.bridgeState.left) {
      this.groundTraversableCache.clear();
    }
    this.bridgeState = state;
  }

  /**
   * Find all water meshes (by color) and bridge-deck meshes (by name) in a single
   * traversal, and cache their broad-phase bounding boxes.
   */
  private findTerrainMeshes() {
    if (!this.battleMapScene) return;

    this.waterMeshes = [];
    this.rightBridgeMeshes = [];
    this.leftBridgeMeshes = [];
    this.centerBridgeMeshes = [];
    this.groundTraversableCache.clear();

    // Ensure world matrices are current so mesh bounding boxes (size guard below)
    // and the raycasts are computed against final world transforms.
    this.battleMapScene.updateMatrixWorld(true);

    this.battleMapScene.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.material) return;

      // Bridge decks are identified by name (covers the whole deck regardless of
      // its several grays), so check that before color.
      const side = this.bridgeSideOf(child);
      if (side) {
        const span = this.maxSpan(child);
        if (span <= MAX_BRIDGE_SPAN) {
          const bucket = side === 'right' ? this.rightBridgeMeshes
            : side === 'left' ? this.leftBridgeMeshes
            : this.centerBridgeMeshes;
          bucket.push(child);
        } else {
          console.warn(
            `⚠️ TerrainValidator: ignoring bridge-named "${child.name}" — ` +
            `${span.toFixed(0)}u across, too large to be a deck (likely a mis-named/duplicated object).`
          );
        }
        return; // bridge-named meshes never count as water
      }

      const material = Array.isArray(child.material) ? child.material[0] : child.material;
      if (material instanceof THREE.MeshStandardMaterial ||
          material instanceof THREE.MeshBasicMaterial ||
          material instanceof THREE.MeshPhongMaterial) {
        if (this.colorsMatch(material.color, WATER_COLOR)) {
          this.waterMeshes.push(child);
        }
      }
    });

    console.log(
      `✅ Found ${this.waterMeshes.length} water meshes, ` +
      `${this.rightBridgeMeshes.length + this.leftBridgeMeshes.length + this.centerBridgeMeshes.length} bridge meshes ` +
      `(R:${this.rightBridgeMeshes.length} L:${this.leftBridgeMeshes.length} C:${this.centerBridgeMeshes.length})`
    );
    this.waterBounds = this.computeBounds(this.waterMeshes);
    this.bridgeBounds = this.computeBounds([
      ...this.rightBridgeMeshes, ...this.leftBridgeMeshes, ...this.centerBridgeMeshes,
    ]);
  }

  /**
   * Which bridge a mesh belongs to, by walking its ancestor names, or null if the
   * mesh is not part of a bridge. Deck meshes sit under "Right_Bridge_<frame>" /
   * "Left_Bridge_<frame>" / "Center_Bridge_<frame>" nodes.
   */
  private bridgeSideOf(object: THREE.Object3D): BridgeSide | null {
    let isBridge = false;
    let side: BridgeSide | null = null;
    for (let node: THREE.Object3D | null = object; node; node = node.parent) {
      const name = node.name;
      if (!name) continue;
      if (BRIDGE_NAME_PATTERN.test(name)) isBridge = true;
      if (RIGHT_NAME_PATTERN.test(name)) side = 'right';
      else if (LEFT_NAME_PATTERN.test(name)) side = 'left';
      else if (CENTER_NAME_PATTERN.test(name)) side = 'center';
    }
    return isBridge ? side : null;
  }

  /**
   * Largest world-space dimension (x, y, or z) of an object's bounding box. Used to
   * reject map-sized geometry that is named like a bridge but clearly isn't a deck.
   */
  private maxSpan(object: THREE.Object3D): number {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return 0;
    const size = box.getSize(new THREE.Vector3());
    return Math.max(size.x, size.y, size.z);
  }

  /**
   * Combined xz bounding box of a set of meshes (plus a margin), or null if empty.
   * Used as a cheap broad-phase so positions clearly away from a feature can be
   * ruled out without a raycast.
   */
  private computeBounds(meshes: THREE.Mesh[]): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
    if (meshes.length === 0) return null;

    const combined = new THREE.Box3();
    for (const mesh of meshes) {
      combined.expandByObject(mesh);
    }
    if (combined.isEmpty()) return null;

    const margin = 5; // world units of slack around the footprint
    return {
      minX: combined.min.x - margin,
      maxX: combined.max.x + margin,
      minZ: combined.min.z - margin,
      maxZ: combined.max.z + margin,
    };
  }

  /**
   * Check if two colors match within tolerance
   */
  private colorsMatch(color1: THREE.Color, color2: THREE.Color): boolean {
    return (
      Math.abs(color1.r - color2.r) < COLOR_TOLERANCE &&
      Math.abs(color1.g - color2.g) < COLOR_TOLERANCE &&
      Math.abs(color1.b - color2.b) < COLOR_TOLERANCE
    );
  }

  /**
   * Check if a position is over water using raycasting
   */
  public isPositionOverWater(position: Position3D): boolean {
    if (this.waterMeshes.length === 0) return false;

    // Cheap broad-phase: positions outside the water bounding box are inland and
    // need no raycast.
    if (this.waterBounds &&
        (position.x < this.waterBounds.minX || position.x > this.waterBounds.maxX ||
         position.z < this.waterBounds.minZ || position.z > this.waterBounds.maxZ)) {
      return false;
    }

    // Cast ray downward from position
    const origin = new THREE.Vector3(position.x, position.y + 100, position.z);
    this.raycaster.set(origin, DOWN);
    const intersects = this.raycaster.intersectObjects(this.waterMeshes, true);

    return intersects.length > 0;
  }

  /**
   * Check whether a position sits over a bridge deck, by raycasting straight down
   * against the deck meshes (which side is hit determines bridgeSide). All raise/
   * lower frames are static meshes (only their visibility is toggled), so the lowered
   * deck's footprint is always present for the raycast; whether it is actually
   * crossable is gated separately by the bridge's raised/lowered state
   * (isBridgeTraversable).
   */
  private isPositionOnBridge(position: Position3D): { onBridge: boolean; bridgeSide: BridgeSide | null } {
    if (this.rightBridgeMeshes.length === 0 &&
        this.leftBridgeMeshes.length === 0 &&
        this.centerBridgeMeshes.length === 0) {
      return { onBridge: false, bridgeSide: null };
    }

    // Cheap broad-phase: positions outside the bridge bounding box need no raycast.
    if (this.bridgeBounds &&
        (position.x < this.bridgeBounds.minX || position.x > this.bridgeBounds.maxX ||
         position.z < this.bridgeBounds.minZ || position.z > this.bridgeBounds.maxZ)) {
      return { onBridge: false, bridgeSide: null };
    }

    const origin = new THREE.Vector3(position.x, position.y + 100, position.z);
    this.raycaster.set(origin, DOWN);

    if (this.rightBridgeMeshes.length > 0 &&
        this.raycaster.intersectObjects(this.rightBridgeMeshes, true).length > 0) {
      return { onBridge: true, bridgeSide: 'right' };
    }
    if (this.leftBridgeMeshes.length > 0 &&
        this.raycaster.intersectObjects(this.leftBridgeMeshes, true).length > 0) {
      return { onBridge: true, bridgeSide: 'left' };
    }
    if (this.centerBridgeMeshes.length > 0 &&
        this.raycaster.intersectObjects(this.centerBridgeMeshes, true).length > 0) {
      return { onBridge: true, bridgeSide: 'center' };
    }
    return { onBridge: false, bridgeSide: null };
  }

  /**
   * Check if a bridge is traversable for ground animals. The center bridge is static
   * and always crossable; the right/left bridges must be fully lowered.
   */
  private isBridgeTraversable(bridgeSide: BridgeSide): boolean {
    if (bridgeSide === 'center') return true;
    return this.bridgeState[bridgeSide] === 'Fully_Down';
  }

  /**
   * Check if an animal can move to a specific position
   */
  public canAnimalMoveTo(animal: AnimalId, position: Position3D): boolean {
    // If not initialized, allow all movement (graceful degradation)
    if (!this.isInitialized()) {
      return true;
    }

    const movementType = ANIMAL_MOVEMENT_TYPES[animal];

    // Air and water animals are never blocked (air flies over anything; water
    // animals cross water and walk on land), so they skip the raycast entirely.
    if (movementType === 'air' || movementType === 'water') {
      return true;
    }

    // Ground animals: blocked by water unless standing on a lowered bridge deck.
    // Cached per cell so the raycasts run at most once per cell between bridge
    // state changes.
    return this.isGroundTraversable(position);
  }

  /**
   * Whether a ground unit can stand at this position, memoized per grid cell.
   * Only ground animals can be blocked, so this is the sole raycast path on the
   * per-tick movement hot loop.
   */
  private isGroundTraversable(position: Position3D): boolean {
    const cellX = Math.floor(position.x / TERRAIN_CELL_SIZE) + 32768;
    const cellZ = Math.floor(position.z / TERRAIN_CELL_SIZE) + 32768;
    const key = cellX * 65536 + cellZ;

    const cached = this.groundTraversableCache.get(key);
    if (cached !== undefined) return cached;

    let traversable: boolean;
    if (!this.isPositionOverWater(position)) {
      traversable = true; // on land
    } else {
      const { onBridge, bridgeSide } = this.isPositionOnBridge(position);
      traversable = onBridge && bridgeSide ? this.isBridgeTraversable(bridgeSide) : false;
    }

    // Guard against unbounded growth if units roam the whole map.
    if (this.groundTraversableCache.size > 200_000) this.groundTraversableCache.clear();
    this.groundTraversableCache.set(key, traversable);
    return traversable;
  }

  /**
   * Check if movement path from start to end crosses invalid terrain
   * Returns true if movement is valid
   */
  public isPathValid(animal: AnimalId, start: Position3D, end: Position3D, checkPoints: number = 5): boolean {
    // If not initialized, allow all movement (graceful degradation)
    if (!this.isInitialized()) {
      return true;
    }

    // Air animals can always move
    if (ANIMAL_MOVEMENT_TYPES[animal] === 'air') {
      return true;
    }

    // Check multiple points along the path
    for (let i = 0; i <= checkPoints; i++) {
      const t = i / checkPoints;
      const checkPos: Position3D = {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
        z: start.z + (end.z - start.z) * t,
      };

      if (!this.canAnimalMoveTo(animal, checkPos)) {
        return false;
      }
    }

    return true;
  }
}

// Singleton instance
export const terrainValidator = new TerrainValidator();
