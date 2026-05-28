import * as THREE from 'three';

/**
 * titleScreenChoreography
 * -----------------------
 * Animates the animals embedded in Title_Screen.glb as a sequence of chases.
 * Only one pair is on screen at a time: it enters at its authored spot and
 * walks in a straight line along the leader's facing until both animals leave
 * the camera's view, then the next pair takes over. The pairs cycle in the
 * order they appear in CHASE_PAIRS.
 *
 * Gaits reuse the in-match motion (UnitsLayer's verticalOffset / state.ts tick):
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
 * `rotation = atan2(dir.x, dir.z)` convention). Animals travel the way their eyes
 * point and their authored rotation is left untouched.
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
  /**
   * Optional group-name fragment to steer this pair *toward*. When set, the
   * travel direction points from the leader's start to that group's position
   * instead of being read from the leader's facing — used when the authored
   * rotation doesn't encode the intended heading (e.g. Bunny faces a different
   * way than the artist wants it to travel).
   */
  readonly aimAt?: string;
  /**
   * Optional distance (world units) to push the spawn *backwards* along the
   * travel direction, so the pair starts off-screen and walks into view rather
   * than popping in mid-frame. The pair still passes through its authored spot
   * after travelling `leadIn`.
   */
  readonly leadIn?: number;
  /**
   * Optional scale on the chaser's follow distance (default 1). Use values > 1
   * to stretch the gap for a slow pursuer that should trail well behind its
   * quarry (e.g. the Turtle plodding after the Bunny).
   */
  readonly lagMultiplier?: number;
}

/**
 * Who chases whom, in playback order. Names are matched case-insensitively as
 * substrings so the ".001" suffixes Blender appends on export still resolve
 * ("Black_Bear" matches "Bear"). The sequence plays top to bottom, one pair at
 * a time: Bee/Bear, then Turtle/Bunny, then Chicken/Pig, then Fox/Kitty.
 */
export const CHASE_PAIRS: readonly ChasePairConfig[] = [
  { chaser: 'Bee', leader: 'Bear' },
  { chaser: 'Turtle', leader: 'Bunny', aimAt: 'Pig', lagMultiplier: 2 },
  { chaser: 'Chicken', leader: 'Pig', leadIn: 60 },
  { chaser: 'Fox', leader: 'Kitty' },
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

/** Forward travel speed along the facing line, world units / second. */
const TRAVEL_SPEED = 15;
/** How far behind the leader the chaser lags, world units. */
const MIN_CHASE_GAP = 12;
/** If the pair was authored further apart than MIN_CHASE_GAP, keep that gap. */
const CHASE_GAP_FACTOR = 1.0;
/**
 * Safety cap: advance to the next pair after this distance even if the frustum
 * test never reports the animals as gone (e.g. no camera supplied in tests).
 */
const MAX_TRAVEL_DISTANCE = 400;
/**
 * Extra distance travelled after both animals' pivots leave the frustum, so the
 * model bodies (not just the pivots) fully clear before the next pair starts.
 * Sized to the largest title-screen animal's footprint.
 */
const EXIT_MARGIN = 16;

/** Peak height of a hop above the baseline, world units. */
const HOP_HEIGHT = 2.2;
/** Distance covered by one full hop stride, world units (one arch per stride). */
const HOP_STRIDE = 9;

/** Vertical bob applied to a flyer so it never looks frozen mid-air. */
const FLY_BOB_AMPLITUDE = 1.1;
const FLY_BOB_FREQUENCY = 2.4; // radians / second

/**
 * Walk gait rock: a grounded animal pitches its nose up by this angle and back
 * to level once per WALK_STRIDE travelled, so it appears to stride rather than
 * slide. Tilt is applied about the animal's local X axis, on top of its
 * authored facing.
 */
const WALK_TILT_RADIANS = THREE.MathUtils.degToRad(15);
/** Distance covered by one full up-and-back-down rock, world units. */
const WALK_STRIDE = 6;

const LOCAL_FORWARD = new THREE.Vector3(0, 0, 1);
const LOCAL_X_AXIS = new THREE.Vector3(1, 0, 0);
/** Scratch quaternion for composing the per-frame walk tilt; never aliased. */
const tiltQuaternion = new THREE.Quaternion();

interface AnimalRoute {
  readonly group: THREE.Object3D;
  readonly gait: Gait;
  /** Authored world position; the travel offset is added to this each frame. */
  readonly startX: number;
  readonly startY: number;
  readonly startZ: number;
  /** Authored facing; the walk tilt is composed onto this so eyes still point right. */
  readonly startQuaternion: THREE.Quaternion;
  /** Distance this animal lags behind the leader along the travel line. */
  readonly lagDistance: number;
  /** Constant phase so two flyers don't bob in lockstep. */
  readonly bobPhase: number;
  /** Last world position written this frame, reused for the frustum test. */
  readonly lastPosition: THREE.Vector3;
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
  readonly visible: boolean;
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
 * World-space forward direction (XZ, normalized) the group's eyes point, derived
 * from its authored rotation (+Z local forward, the game's facing convention).
 */
function facingDirectionXZ(group: THREE.Object3D): THREE.Vector2 {
  const quaternion = group.getWorldQuaternion(new THREE.Quaternion());
  const forward = LOCAL_FORWARD.clone().applyQuaternion(quaternion);
  const dir = new THREE.Vector2(forward.x, forward.z);
  if (dir.length() < 1e-5) dir.set(0, -1); // degenerate (looking straight up/down)
  return dir.normalize();
}

/**
 * Drives the title-screen chase. Construct once with the loaded scene root, then
 * call `update(elapsedSeconds, camera)` every frame.
 */
export class TitleChaseChoreographer {
  private readonly pairs: PreparedPair[] = [];
  private readonly frustum = new THREE.Frustum();
  private readonly projScreenMatrix = new THREE.Matrix4();
  private activePairIndex = 0;
  /** Elapsed time at which the active pair began its run. */
  private activePairStartTime = 0;
  /**
   * Whether the active pair has been inside the view yet this run. A pair can
   * start off-screen (its authored spot sits past a frustum edge) and walk in,
   * so it must be seen before it is allowed to exit — otherwise the in→out
   * transition that retires it could never be distinguished from the approach.
   */
  private activePairSeen = false;
  /**
   * Leader distance at which both pivots first left the view after being seen;
   * the pair retires once it has travelled EXIT_MARGIN beyond this. Null while
   * the pair is still (partly) on screen.
   */
  private activePairExitDistance: number | null = null;

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

  /** Index of the pair currently playing, for tests / debugging. */
  get activeIndex(): number {
    return this.activePairIndex;
  }

  private preparePair(
    sceneRoot: THREE.Object3D,
    config: ChasePairConfig,
    leaderGroup: THREE.Object3D,
    chaserGroup: THREE.Object3D,
  ): PreparedPair {
    const leaderStart = leaderGroup.getWorldPosition(new THREE.Vector3());
    const chaserStart = chaserGroup.getWorldPosition(new THREE.Vector3());

    // Travel direction: steer toward `aimAt` if given, else the leader's facing.
    const dir = this.travelDirection(sceneRoot, config, leaderGroup, leaderStart);

    // Push the spawn back along travel so the pair walks in from off-screen
    // (the leader still passes through its authored spot after `leadIn` units).
    const leadIn = config.leadIn ?? 0;
    const baseX = leaderStart.x - dir.x * leadIn;
    const baseZ = leaderStart.z - dir.y * leadIn;

    // Keep at least MIN_CHASE_GAP behind (or the authored spacing if larger),
    // then stretch by the pair's lag multiplier for a deliberately slow pursuer.
    const authoredGap = Math.hypot(leaderStart.x - chaserStart.x, leaderStart.z - chaserStart.z);
    const lagDistance = Math.max(authoredGap * CHASE_GAP_FACTOR, MIN_CHASE_GAP) * (config.lagMultiplier ?? 1);

    // Re-parent to the (identity) scene root so local space equals world space;
    // attach() preserves the authored world transform, including scale.
    sceneRoot.attach(leaderGroup);
    sceneRoot.attach(chaserGroup);

    const leader: AnimalRoute = {
      group: leaderGroup,
      gait: gaitForName(config.leader),
      startX: baseX,
      startY: leaderStart.y,
      startZ: baseZ,
      startQuaternion: leaderGroup.quaternion.clone(),
      lagDistance: 0,
      bobPhase: 0,
      lastPosition: new THREE.Vector3(),
    };
    const chaser: AnimalRoute = {
      group: chaserGroup,
      gait: gaitForName(config.chaser),
      // Anchor the chaser on the leader's line, a clean gap behind, so the two
      // form a straight procession regardless of their tiny authored offset.
      startX: baseX,
      startY: chaserStart.y,
      startZ: baseZ,
      startQuaternion: chaserGroup.quaternion.clone(),
      lagDistance,
      bobPhase: Math.PI,
      lastPosition: new THREE.Vector3(),
    };

    return { dirX: dir.x, dirZ: dir.y, leader, chaser };
  }

  /**
   * Travel heading for a pair: toward the `aimAt` group when configured (and
   * found), otherwise the leader's authored facing. Falls back to facing if the
   * aim target is missing or coincident with the leader.
   */
  private travelDirection(
    sceneRoot: THREE.Object3D,
    config: ChasePairConfig,
    leaderGroup: THREE.Object3D,
    leaderStart: THREE.Vector3,
  ): THREE.Vector2 {
    if (config.aimAt) {
      const target = findGroupByName(sceneRoot, config.aimAt, new Set());
      if (target) {
        const targetPos = target.getWorldPosition(new THREE.Vector3());
        const toTarget = new THREE.Vector2(targetPos.x - leaderStart.x, targetPos.z - leaderStart.z);
        if (toTarget.length() >= 1e-3) return toTarget.normalize();
      }
    }
    return facingDirectionXZ(leaderGroup);
  }

  /**
   * Advance the sequence. `elapsedSeconds` is monotonic wall-clock since start;
   * `camera` (when supplied) lets the active pair retire once it leaves view.
   */
  update(elapsedSeconds: number, camera?: THREE.Camera): void {
    if (this.pairs.length === 0) return;

    const leaderDistance = TRAVEL_SPEED * (elapsedSeconds - this.activePairStartTime);

    for (let i = 0; i < this.pairs.length; i++) {
      const pair = this.pairs[i];
      const isActive = i === this.activePairIndex;
      // Inactive pairs wait, hidden, parked at their start (distance 0) so they
      // are ready the instant their turn comes around.
      const distance = isActive ? leaderDistance : 0;
      this.placeAnimal(pair, pair.leader, distance, elapsedSeconds, isActive);
      this.placeAnimal(pair, pair.chaser, distance, elapsedSeconds, isActive);
    }

    if (this.hasActivePairExited(leaderDistance, camera)) {
      this.activePairIndex = (this.activePairIndex + 1) % this.pairs.length;
      this.activePairStartTime = elapsedSeconds;
      this.activePairSeen = false;
      this.activePairExitDistance = null;
    }
  }

  /** True once the active pair has been seen and then walked back out of view. */
  private hasActivePairExited(leaderDistance: number, camera?: THREE.Camera): boolean {
    if (leaderDistance >= MAX_TRAVEL_DISTANCE) return true;
    if (!camera) return false;

    this.projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    const pair = this.pairs[this.activePairIndex];
    const onScreen =
      this.frustum.containsPoint(pair.leader.lastPosition) ||
      this.frustum.containsPoint(pair.chaser.lastPosition);

    if (onScreen) {
      // Still (partly) visible: mark as seen and cancel any pending exit so a
      // pair walking IN from off-screen isn't mistaken for one walking out.
      this.activePairSeen = true;
      this.activePairExitDistance = null;
      return false;
    }

    if (!this.activePairSeen) return false; // hasn't entered the view yet

    // Both pivots have left after being seen — start (or continue) the margin
    // that lets the model bodies clear before handing off.
    if (this.activePairExitDistance === null) this.activePairExitDistance = leaderDistance;
    return leaderDistance >= this.activePairExitDistance + EXIT_MARGIN;
  }

  private placeAnimal(
    pair: PreparedPair,
    route: AnimalRoute,
    leaderDistance: number,
    elapsedSeconds: number,
    visible: boolean,
  ): void {
    const distance = leaderDistance - route.lagDistance;
    const x = route.startX + pair.dirX * distance;
    const z = route.startZ + pair.dirZ * distance;
    const y = route.startY + this.gaitHeight(route, distance, elapsedSeconds);

    route.lastPosition.set(x, y, z);
    route.group.position.set(x, y, z);
    route.group.visible = visible;
    this.applyGaitRotation(route, distance);
  }

  /**
   * Re-applies the authored facing each frame, adding a stride-synced nose-up
   * rock for walkers so they appear to stride instead of slide. Flyers and
   * hoppers keep their authored rotation untouched.
   */
  private applyGaitRotation(route: AnimalRoute, distance: number): void {
    if (route.gait !== 'walk') {
      route.group.quaternion.copy(route.startQuaternion);
      return;
    }
    // 0 -> 15deg -> 0 once per stride; abs(sin) keeps the pitch nose-up only.
    const strideProgress = ((distance / WALK_STRIDE) % 1 + 1) % 1;
    const tilt = Math.sin(strideProgress * Math.PI) * WALK_TILT_RADIANS;
    tiltQuaternion.setFromAxisAngle(LOCAL_X_AXIS, -tilt); // negative pitches the nose up
    route.group.quaternion.copy(route.startQuaternion).multiply(tiltQuaternion);
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
          visible: route.group.visible,
          position: { x: p.x, y: p.y, z: p.z },
        });
      }
    }
    return routes;
  }
}
