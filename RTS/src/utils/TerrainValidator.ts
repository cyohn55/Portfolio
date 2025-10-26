import * as THREE from 'three';
import type { Position3D, AnimalId, MovementType } from '../game/types';
import { ANIMAL_MOVEMENT_TYPES } from '../game/types';

// Water color in the battle map: #4A99FFFF
const WATER_COLOR = new THREE.Color(0x4A99FF);
const WATER_COLOR_TOLERANCE = 0.1; // Allow some variation in color detection

// Bridge positions and dimensions (approximate - adjust based on actual map)
const BRIDGE_ZONES = {
  right: {
    center: { x: 0, z: 100 }, // Adjust based on actual bridge position
    width: 40,
    length: 60,
  },
  left: {
    center: { x: 0, z: -100 }, // Adjust based on actual bridge position
    width: 40,
    length: 60,
  },
};

export class TerrainValidator {
  private battleMapScene: THREE.Scene | null = null;
  private waterMeshes: THREE.Mesh[] = [];
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
   * Initialize the terrain validator with the battle map scene
   */
  public initialize(scene: THREE.Scene) {
    this.battleMapScene = scene;
    this.findWaterMeshes();
  }

  /**
   * Update the bridge state
   */
  public updateBridgeState(state: typeof this.bridgeState) {
    this.bridgeState = state;
  }

  /**
   * Find all water meshes in the scene by color
   */
  private findWaterMeshes() {
    if (!this.battleMapScene) return;

    this.waterMeshes = [];

    this.battleMapScene.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material) {
        const material = Array.isArray(child.material) ? child.material[0] : child.material;

        if (material instanceof THREE.MeshStandardMaterial ||
            material instanceof THREE.MeshBasicMaterial ||
            material instanceof THREE.MeshPhongMaterial) {

          const color = material.color;

          // Check if color matches water color within tolerance
          if (this.colorsMatch(color, WATER_COLOR)) {
            this.waterMeshes.push(child);
            console.log('💧 Found water mesh:', child.name || 'unnamed', 'Color:', color.getHexString());
          }
        }
      }
    });

    console.log(`✅ Found ${this.waterMeshes.length} water meshes`);
  }

  /**
   * Check if two colors match within tolerance
   */
  private colorsMatch(color1: THREE.Color, color2: THREE.Color): boolean {
    return (
      Math.abs(color1.r - color2.r) < WATER_COLOR_TOLERANCE &&
      Math.abs(color1.g - color2.g) < WATER_COLOR_TOLERANCE &&
      Math.abs(color1.b - color2.b) < WATER_COLOR_TOLERANCE
    );
  }

  /**
   * Check if a position is over water using raycasting
   */
  public isPositionOverWater(position: Position3D): boolean {
    if (this.waterMeshes.length === 0) return false;

    // Cast ray downward from position
    const origin = new THREE.Vector3(position.x, position.y + 100, position.z);
    const direction = new THREE.Vector3(0, -1, 0);

    this.raycaster.set(origin, direction);
    const intersects = this.raycaster.intersectObjects(this.waterMeshes, true);

    return intersects.length > 0;
  }

  /**
   * Check if position is on a bridge
   */
  private isPositionOnBridge(position: Position3D): { onBridge: boolean; bridgeSide: 'right' | 'left' | null } {
    // Check right bridge
    const rightDist = Math.sqrt(
      Math.pow(position.x - BRIDGE_ZONES.right.center.x, 2) +
      Math.pow(position.z - BRIDGE_ZONES.right.center.z, 2)
    );

    if (rightDist < BRIDGE_ZONES.right.width / 2) {
      return { onBridge: true, bridgeSide: 'right' };
    }

    // Check left bridge
    const leftDist = Math.sqrt(
      Math.pow(position.x - BRIDGE_ZONES.left.center.x, 2) +
      Math.pow(position.z - BRIDGE_ZONES.left.center.z, 2)
    );

    if (leftDist < BRIDGE_ZONES.left.width / 2) {
      return { onBridge: true, bridgeSide: 'left' };
    }

    return { onBridge: false, bridgeSide: null };
  }

  /**
   * Check if a bridge is traversable for ground/water animals
   */
  private isBridgeTraversable(bridgeSide: 'right' | 'left'): boolean {
    const state = this.bridgeState[bridgeSide];
    return state === 'Fully_Down';
  }

  /**
   * Check if an animal can move to a specific position
   */
  public canAnimalMoveTo(animal: AnimalId, position: Position3D): boolean {
    const movementType = ANIMAL_MOVEMENT_TYPES[animal];

    // Air animals can go anywhere
    if (movementType === 'air') {
      return true;
    }

    // Check if position is over water
    const overWater = this.isPositionOverWater(position);

    if (!overWater) {
      // Position is on land - all animals can move here
      return true;
    }

    // Position is over water
    const { onBridge, bridgeSide } = this.isPositionOnBridge(position);

    if (onBridge && bridgeSide) {
      // On a bridge - check if bridge is down
      const bridgeTraversable = this.isBridgeTraversable(bridgeSide);

      if (movementType === 'water') {
        // Water animals can cross water regardless of bridge state
        return true;
      } else {
        // Ground animals need bridge to be fully down
        return bridgeTraversable;
      }
    } else {
      // Over water but not on bridge
      if (movementType === 'water') {
        return true; // Water animals can cross
      } else {
        return false; // Ground animals cannot cross water
      }
    }
  }

  /**
   * Check if movement path from start to end crosses invalid terrain
   * Returns true if movement is valid
   */
  public isPathValid(animal: AnimalId, start: Position3D, end: Position3D, checkPoints: number = 5): boolean {
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
