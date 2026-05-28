import * as THREE from 'three';

/**
 * titleScreenChoreography
 * -----------------------
 * Animates the animals embedded in Title_Screen.glb so each pair reads as a
 * chase: the two animals travel in a straight line along the direction the
 * leader is facing, with the chaser lagging a fixed gap behind. Gaits reuse the
 * in-match motion (UnitsLayer's verticalOffset / state.ts tick):
 *
 *   - hop  : a single vertical arch per stride (Bunny / Frog in-game)
 *   - fly  : held aloft with a gentle bob (Bee / Owl in-game)
 *   - walk : glides along the ground (everyone else)
 *
 * The choreographer is intentionally free of any React / R3F dependency so it
 * can be unit-tested with plain three.js objects.
 *
 * Heading: the two animals in a pair are authored almost on top of each other,
 * so their relative offset is too small to define a reliable direction. Instead
 * the travel direction is read from the LEADER's authored facing — its world
 * quaternion applied to the model's local forward axis (+Z, matching the game's
 * `rotation = atan2(dir.x, dir.z)` convention). Animals therefore travel exactly
 * the way their eyes point, and their authored rotation is left untouched.
 *
 * Height: the lawn is flat and the artist placed each animal at the right
 * height, so each keeps its authored Y as a constant baseline; the gait only
 * adds to it.
 */

export type Gait = 'hop' | 'fly' | 'walk';

export interface ChasePairConfig {
  /** Group-name fragment of the pursuer (matched case-insensitively). */
  readonly chaser: string;
  /** Group-name fragment of the pursued, whose facing sets the travel line. */
  readonly leader: string;
}

/**
 * Who chases whom. Names are matched case-insensitively as substrings so the
 * ".001" suffixes Blender appends on export still resolve ("Black_Bear" matches
 * "Bear").
 */
export const CHASE_PAIRS: readonly ChasePairConfig[] = [
  { chaser: 'Bee', leader: 'Bear' },
  { chaser: 'Turtle', leader: 'Bunny' },
  { chaser: 'Fox', leader: 'Kitty' },
  { chaser: 'Chicken', leader: 'Pig' },
];

/**
 * Gait per animal, keyed by the lower-cased name fragment. Mirrors the in-game
 * motion: only Bunny hops and only Bee flies among the title-screen cast; the
 * rest glide along the ground. `Cat` is an alias for the `Kitty` group name.
 */
export const ANIMAL_GAITS: Readonly<Record<string, Gait>> = {
  bee: 'fly',
  bear: 'walk',
  turtle: 'walk',
  bunny: 'hop',
  fox: 'walk',
  kitty: 'walk',
  cat: 'walk',
  pig: 'walk',
  chicken: 'walk',
};

/**
 * Models whose local forward is -Z rather than +Z. Mirrors the Math.PI Y-flip
 * applied to these models in ModelPreloader.createPreparedScene, so the travel
 * direction matches the way the model visually faces. Keyed by name fragment.
 */
const FLIPPED_FORWARD_MODELS: readonly string[] = ['bunny', 'yetti', 'yeti'];

// --- Tuning constants -------------------------------------------------------
// Grouped here so the chase can be re-tuned in one place.

/** Forward travel speed along the facing line, world units / second. */
const TRAVEL_SPEED = 4;
/** Distance travelled before the pair loops back to its start, world units. */
const TRAVEL_DISTANCE = 40;
/** How far behind the leader the chaser lags, world units. */
const MIN_CHASE_GAP = 4;
/** If the pair was authored further apart than MIN_CHASE_GAP, keep that gap. */
const CHASE_GAP_FACTOR = 1.0;

/** Peak height of a hop above the baseline, world units. */
const HOP_HEIGHT = 2.2;
/** Distance covered by one full hop stride, world units (one arch per stride). */
const HOP_STRIDE = 9;

/** Vertical bob applied to a flyer so it never looks frozen mid-air. */
const FLY_BOB_AMPLITUDE = 1.1;
const FLY_BOB_FREQUENCY = 2.4; // radians / second

const LOCAL_FORWARD = new THREE.Vector3(0, 0, 1);

interface AnimalRoute {
  readonly group: THREE.Object3D;
  readonly gait: Gait;
  /** Authored world position; the travel offset is added to this each frame. */
  readonly startX: number;
  readonly startY: number;
  readonly startZ: number;
  /** Distance this animal lags behind the leader along the travel line. */
  readonly lagDistance: number;
  /** Constant phase so two flyers don't bob in lockstep. */
  readonly bobPhase: number;
}

interface PreparedPair {
  /** Unit travel direction in the XZ plane (from the leader's facing). */
  readonly dirX: number;
  readonly dirZ: number;
  readonly leader: AnimalRoute;
  readonly chaser: AnimalRoute;
}

/** Snapshot of a prepared route, for tests and debugging. */
export interface RouteDebugInfo {
  readonly name: string;
  readonly role: 'leader' | 'chaser';
  readonly gait: Gait;
  readonly position: { x: number; y: number; z: number };
}

/**
 * Locates the first descendant whose name contains `fragment` (case-insensitive)
 * and is not already claimed. Returns null when no match exists so a missing
 * animal degrades to "that pair simply doesn't animate" rather than throwing.
 */
function findGroupByName(
  root: THREE.Object3D,
  fragment: string,
  claimed: Set<THREE.Object3D>,
): THREE.Object3D | null {
  const needle = fragment.toLowerCase();
  let match: THREE.Object3D | null = null;
  root.traverse((object) => {
    if (match || claimed.has(object) || object === root) return;
    if (object.name && object.name.toLowerCase().includes(needle)) {
      match = object;
    }
  });
  return match;
}

function gaitForName(name: string): Gait {
  const lower = name.toLowerCase();
  for (const key of Object.keys(ANIMAL_GAITS)) {
    if (lower.includes(key)) return ANIMAL_GAITS[key];
  }
  return 'walk';
}

function hasFlippedForward(name: string): boolean {
  const lower = name.toLowerCase();
  return FLIPPED_FORWARD_MODELS.some((key) => lower.includes(key));
}

/**
 * World-space forward direction (XZ, normalized) the group's eyes point, derived
 * from its authored rotation. Flipped models negate the axis so the result is
 * the visual front, not the back.
 */
function facingDirectionXZ(group: THREE.Object3D, name: string): THREE.Vector2 {
  const quaternion = group.getWorldQuaternion(new THREE.Quaternion());
  const forward = LOCAL_FORWARD.clone().applyQuaternion(quaternion);
  if (hasFlippedForward(name)) forward.negate();
  const dir = new THREE.Vector2(forward.x, forward.z);
  if (dir.length() < 1e-5) dir.set(0, -1); // degenerate (looking straight up/down)
  return dir.normalize();
}

/**
 * Drives the title-screen chase. Construct once with the loaded scene root, then
 * call `update(elapsedSeconds)` every frame.
 */
export class TitleChaseChoreographer {
  private readonly pairs: PreparedPair[] = [];

  constructor(sceneRoot: THREE.Object3D) {
    sceneRoot.updateMatrixWorld(true);

    const claimed = new Set<THREE.Object3D>();
    for (const config of CHASE_PAIRS) {
      const leaderGroup = findGroupByName(sceneRoot, config.leader, claimed);
      const chaserGroup = findGroupByName(sceneRoot, config.chaser, claimed);
      if (!leaderGroup || !chaserGroup) continue;
      claimed.add(leaderGroup);
      claimed.add(chaserGroup);
      this.pairs.push(this.preparePair(sceneRoot, config, leaderGroup, chaserGroup));
    }
  }

  /** Number of pairs that resolved both animals and are being animated. */
  get pairCount(): number {
    return this.pairs.length;
  }

  private preparePair(
    sceneRoot: THREE.Object3D,
    config: ChasePairConfig,
    leaderGroup: THREE.Object3D,
    chaserGroup: THREE.Object3D,
  ): PreparedPair {
    const leaderStart = leaderGroup.getWorldPosition(new THREE.Vector3());
    const chaserStart = chaserGroup.getWorldPosition(new THREE.Vector3());

    // Travel direction = the way the leader's eyes point.
    const dir = facingDirectionXZ(leaderGroup, config.leader);

    // Keep at least MIN_CHASE_GAP behind, or the authored spacing if larger.
    const authoredGap = Math.hypot(leaderStart.x - chaserStart.x, leaderStart.z - chaserStart.z);
    const lagDistance = Math.max(authoredGap * CHASE_GAP_FACTOR, MIN_CHASE_GAP);

    // Re-parent to the (identity) scene root so local space equals world space;
    // attach() preserves the authored world transform, including scale.
    sceneRoot.attach(leaderGroup);
    sceneRoot.attach(chaserGroup);

    const leader: AnimalRoute = {
      group: leaderGroup,
      gait: gaitForName(config.leader),
      startX: leaderStart.x,
      startY: leaderStart.y,
      startZ: leaderStart.z,
      lagDistance: 0,
      bobPhase: 0,
    };
    const chaser: AnimalRoute = {
      group: chaserGroup,
      gait: gaitForName(config.chaser),
      // Anchor the chaser on the leader's line, a clean gap behind, so the two
      // form a straight procession regardless of their tiny authored offset.
      startX: leaderStart.x,
      startY: chaserStart.y,
      startZ: leaderStart.z,
      lagDistance,
      bobPhase: Math.PI,
    };

    return { dirX: dir.x, dirZ: dir.y, leader, chaser };
  }

  /** Advance the chase. `elapsedSeconds` is monotonic wall-clock since start. */
  update(elapsedSeconds: number): void {
    // Distance the leader has travelled along its line, wrapping so the pair
    // loops back to the start instead of drifting away forever.
    const leaderDistance = (TRAVEL_SPEED * elapsedSeconds) % TRAVEL_DISTANCE;
    for (const pair of this.pairs) {
      this.placeAnimal(pair, pair.leader, leaderDistance, elapsedSeconds);
      this.placeAnimal(pair, pair.chaser, leaderDistance, elapsedSeconds);
    }
  }

  private placeAnimal(
    pair: PreparedPair,
    route: AnimalRoute,
    leaderDistance: number,
    elapsedSeconds: number,
  ): void {
    const distance = leaderDistance - route.lagDistance;
    const x = route.startX + pair.dirX * distance;
    const z = route.startZ + pair.dirZ * distance;
    const y = route.startY + this.gaitHeight(route, distance, elapsedSeconds);

    // Position only — the authored rotation (where the eyes face) is preserved.
    route.group.position.set(x, y, z);
  }

  /** Vertical gait offset above the baseline for the current frame. */
  private gaitHeight(route: AnimalRoute, distance: number, elapsedSeconds: number): number {
    switch (route.gait) {
      case 'hop': {
        // One upward arch per HOP_STRIDE of distance travelled.
        const strideProgress = ((distance / HOP_STRIDE) % 1 + 1) % 1;
        return Math.sin(strideProgress * Math.PI) * HOP_HEIGHT;
      }
      case 'fly':
        return Math.sin(elapsedSeconds * FLY_BOB_FREQUENCY + route.bobPhase) * FLY_BOB_AMPLITUDE;
      case 'walk':
      default:
        return 0;
    }
  }

  /** Current placement of every animated animal, for tests / debugging. */
  getDebugRoutes(): RouteDebugInfo[] {
    const routes: RouteDebugInfo[] = [];
    for (const pair of this.pairs) {
      for (const [role, route] of [
        ['leader', pair.leader],
        ['chaser', pair.chaser],
      ] as const) {
        const p = route.group.position;
        routes.push({
          name: route.group.name,
          role,
          gait: route.gait,
          position: { x: p.x, y: p.y, z: p.z },
        });
      }
    }
    return routes;
  }
}
