import * as THREE from 'three';

/**
 * titleScreenChoreography
 * -----------------------
 * Animates the animals embedded in Title_Screen.glb so each pair reads as a
 * chase, reusing the same gaits the animals use in-match (UnitsLayer's
 * verticalOffset / state.ts tick):
 *
 *   - hop  : a single vertical arch per stride (Bunny / Frog in-game)
 *   - fly  : held aloft with a gentle bob (Bee / Owl in-game)
 *   - walk : glides along the ground (everyone else)
 *
 * The choreographer is intentionally free of any React / R3F dependency so it
 * can be unit-tested with plain three.js objects.
 *
 * Pathing: each pair shares one circular loop. The two animals are authored
 * almost on top of each other, so the loop is anchored on the *leader's*
 * authored position and sent off along the chaser→leader heading; the chaser
 * trails by a fixed gap angle, so it is forever a step behind — a chase that
 * never resolves.
 *
 * Height: the title-screen play area (the lawn) is flat, and the artist already
 * placed each animal at the right height, so each animal keeps its authored Y as
 * a constant baseline and the gait only adds to it. This avoids per-frame ground
 * raycasts and the drift they caused when a loop crossed a decorative mound.
 */

export type Gait = 'hop' | 'fly' | 'walk';

export interface ChasePairConfig {
  /** Group-name fragment of the pursuer (matched case-insensitively). */
  readonly chaser: string;
  /** Group-name fragment of the pursued. */
  readonly leader: string;
}

/**
 * Who chases whom. Names are matched case-insensitively as substrings so the
 * ".001" suffixes Blender appends on export still resolve ("Black_Bear" matches
 * "Bear"). The pursued animal anchors the loop at its authored position.
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

// --- Tuning constants -------------------------------------------------------
// Grouped here so the chase can be re-tuned in one place.

/** Loop radius as a multiple of the pair's authored separation. */
const LOOP_RADIUS_FACTOR = 1.15;
/** Hard floor / ceiling on loop radius in world units, regardless of spacing. */
const MIN_LOOP_RADIUS = 14;
const MAX_LOOP_RADIUS = 70;
/** Angular speed of the chase around the loop (radians / second). */
const ANGULAR_SPEED = 0.32;
/** How far behind the leader the chaser rides, in radians of arc. */
const CHASE_GAP_ANGLE = THREE.MathUtils.degToRad(38);
/**
 * Fallback heading when the two animals are authored almost on top of each other
 * (separation ~0), so there is no reliable chaser→leader direction to read.
 */
const DEFAULT_CHASE_DIR = new THREE.Vector2(1, 0);

/** Peak height of a hop above the baseline, world units. */
const HOP_HEIGHT = 2.2;
/** Arc length of one full hop stride, world units (one arch per stride). */
const HOP_STRIDE = 9;

/** Vertical bob applied to a flyer so it never looks frozen mid-air. */
const FLY_BOB_AMPLITUDE = 1.1;
const FLY_BOB_FREQUENCY = 2.4; // radians / second

const Y_AXIS = new THREE.Vector3(0, 1, 0);

interface AnimalRoute {
  readonly group: THREE.Object3D;
  readonly gait: Gait;
  /** Authored world-space height; gait offsets are added on top of this. */
  readonly baselineY: number;
  /** Angular lead relative to the leader (0 for the leader, negative for chaser). */
  readonly angleLead: number;
  /** Per-animal yaw correction in radians (authored facing is unknown). */
  readonly yawOffset: number;
  /** Constant phase so two flyers don't bob in lockstep. */
  readonly bobPhase: number;
}

interface PreparedPair {
  readonly centerX: number;
  readonly centerZ: number;
  readonly radius: number;
  /** Angle (radians) of the leader's authored position around the loop. */
  readonly leaderStartAngle: number;
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

/**
 * Drives the title-screen chase. Construct once with the loaded scene root, then
 * call `update(elapsedSeconds)` every frame.
 */
export class TitleChaseChoreographer {
  private readonly pairs: PreparedPair[] = [];
  private readonly scratchQuaternion = new THREE.Quaternion();

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

    const separation = Math.hypot(leaderStart.x - chaserStart.x, leaderStart.z - chaserStart.z);
    const radius = THREE.MathUtils.clamp(
      separation * LOOP_RADIUS_FACTOR,
      MIN_LOOP_RADIUS,
      MAX_LOOP_RADIUS,
    );

    // Chase heading = from the chaser toward the leader (the leader flees ahead).
    // Authored pairs sit nearly on top of each other, so anchor the loop on the
    // leader's authored spot and let it set off along this heading — otherwise
    // both animals would pop ~radius units away the instant animation starts.
    const heading = new THREE.Vector2(
      leaderStart.x - chaserStart.x,
      leaderStart.z - chaserStart.z,
    );
    if (heading.length() < 1e-3) heading.copy(DEFAULT_CHASE_DIR);
    heading.normalize();

    // Place the loop centre so the leader lies on the circle and its tangent
    // (counter-clockwise) points along `heading`. radial = R·rotate(heading,-90°).
    const centerX = leaderStart.x - radius * heading.y;
    const centerZ = leaderStart.z + radius * heading.x;
    const leaderStartAngle = Math.atan2(leaderStart.z - centerZ, leaderStart.x - centerX);

    // Re-parent to the (identity) scene root so local space equals world space;
    // attach() preserves the authored world transform, including scale.
    sceneRoot.attach(leaderGroup);
    sceneRoot.attach(chaserGroup);

    const leader: AnimalRoute = {
      group: leaderGroup,
      gait: gaitForName(config.leader),
      baselineY: leaderStart.y,
      angleLead: 0,
      yawOffset: 0,
      bobPhase: 0,
    };
    const chaser: AnimalRoute = {
      group: chaserGroup,
      gait: gaitForName(config.chaser),
      baselineY: chaserStart.y,
      angleLead: -CHASE_GAP_ANGLE,
      yawOffset: 0,
      bobPhase: Math.PI,
    };

    return { centerX, centerZ, radius, leaderStartAngle, leader, chaser };
  }

  /** Advance the chase. `elapsedSeconds` is monotonic wall-clock since start. */
  update(elapsedSeconds: number): void {
    const leaderAngle = ANGULAR_SPEED * elapsedSeconds;
    for (const pair of this.pairs) {
      this.placeAnimal(pair, pair.leader, leaderAngle, elapsedSeconds);
      this.placeAnimal(pair, pair.chaser, leaderAngle, elapsedSeconds);
    }
  }

  private placeAnimal(
    pair: PreparedPair,
    route: AnimalRoute,
    leaderAngle: number,
    elapsedSeconds: number,
  ): void {
    const angle = pair.leaderStartAngle + leaderAngle + route.angleLead;
    const x = pair.centerX + pair.radius * Math.cos(angle);
    const z = pair.centerZ + pair.radius * Math.sin(angle);
    const y = route.baselineY + this.gaitHeight(route, angle, pair.radius, elapsedSeconds);

    // Tangent of a counter-clockwise circle: derivative of (cos, sin) is
    // (-sin, cos). yaw is measured from +Z toward +X to match three.js.
    const yaw = Math.atan2(-Math.sin(angle), Math.cos(angle)) + route.yawOffset;

    route.group.position.set(x, y, z);
    this.scratchQuaternion.setFromAxisAngle(Y_AXIS, yaw);
    route.group.quaternion.copy(this.scratchQuaternion);
  }

  /** Vertical gait offset above the baseline for the current frame. */
  private gaitHeight(route: AnimalRoute, angle: number, radius: number, elapsedSeconds: number): number {
    switch (route.gait) {
      case 'hop': {
        // One upward arch per HOP_STRIDE of arc length travelled.
        const arcLength = angle * radius;
        const strideProgress = ((arcLength / HOP_STRIDE) % 1 + 1) % 1;
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
