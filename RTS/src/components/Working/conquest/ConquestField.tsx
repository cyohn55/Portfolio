// The playable Conquest field: units standing on the planet, monarch piloting,
// combat, King/Queen auras, army capture, and the third-person chase camera.
//
// Single responsibility: take the spawn descriptors from the store, give every
// unit a live position on the sphere, let the player drive their selected monarch
// across the surface, keep each army following its current leader, resolve combat
// (including the King's damage aura and the Queen's heal aura) between rival
// armies, and — the defining Conquest mechanic — transfer a defeated army to its
// conqueror when BOTH its King and Queen are downed, so the player commands more
// and more of the planet. It frames everything with a third-person, slightly
// top-down camera locked onto the piloted monarch (the Conquest analogue of Quick
// Play's monarch piloting).
//
// Controls are deliberately the SAME as Quick Play: the monarch is driven by the
// player's remappable camera-drive bindings (camera-relative, default ESDF),
// cycled with the Cycle/Toggle Monarch bindings (default A / G), and zoomed with
// the bound zoom keys plus the scroll wheel — all honoring the player's chosen
// activation modes. Reusing the shared controlBindings / gestureModes layer means
// whatever a player remaps in Settings drives both modes identically.
//
// All per-frame work is imperative (mutating Object3D transforms and the camera
// directly in useFrame) so driving and combat never re-render the React tree. The
// store is read for the static spawn set, current army control, and the selected
// monarch; control changes flow back through the store's `conquerArmy` action.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { AnimalId, MovementType, UnitBehavior } from '../../../game/types';
import { ANIMAL_MOVEMENT_TYPES } from '../../../game/types';
import { ANIMAL_FILE_MAP } from '../../../utils/ModelPreloader';
import { useGameStore } from '../../../game/state';
import { keyboardEventToToken } from '../controlBindings';
import {
  buildTokenDispatch,
  type ActivationMode,
  type TokenGestureConfig,
} from '../gestureModes';
import {
  useConquestStore,
  effectiveController,
  type ConquestUnitKind,
} from './conquestState';
import {
  conquestStatsFor,
  selectNearestEnemy,
  isWithinAttackRange,
  isAttackReady,
  regenAmount,
  kingBuffedDamage,
  queenHealAmount,
  isWithinAura,
  AGGRO_RANGE,
  CHASE_SPEED,
  AURA_RADIUS,
  type ConquestCombatStats,
} from './conquestCombat';
import {
  defaultBehaviorFor,
  stanceParams,
  selectTargetForBehavior,
  type StanceParams,
} from './conquestBehavior';
import {
  abilityFor,
  computeHissPushes,
  selectSwarmTarget,
  swarmStingKills,
  stepGreatCircle,
  surfaceAimDirection,
  eggHitTarget,
  selectNearestUnclaimedEnemy,
  HISS_RANGE,
  HISS_PUSH_SPEED,
  HISS_PUSH_MS,
  HISS_POSE_MS,
  HISS_COOLDOWN_MS,
  SHELL_RETRIGGER_MS,
  SWARM_DIVE_SPEED,
  SWARM_STING_RANGE,
  EGG_DAMAGE,
  EGG_SPEED,
  EGG_HIT_RADIUS,
  EGG_MAX_RANGE,
  EGG_COOLDOWN_MS,
  EGG_THROW_POSE_MS,
  EGG_LIFT,
  TONGUE_RANGE,
  TONGUE_EXTEND_SPEED,
  TONGUE_RETRACT_SPEED,
  TONGUE_HIT_RADIUS,
  TONGUE_WINDUP_MS,
  TONGUE_COOLDOWN_MS,
  TONGUE_DRAG_STOP_DIST,
  OWL_FLIGHT_LIFT,
  OWL_PLUCK_LIFT,
  OWL_CARRY_HANG,
  OWL_SWOOP_SPEED,
  OWL_DESCENT_SPEED,
  OWL_ASCENT_SPEED,
  OWL_GRAB_RANGE,
  OWL_CARRY_DURATION_MS,
  OWL_FALL_DAMAGE,
  OWL_PICKUP_COOLDOWN_MS,
  type ConquestTongue,
  type ConquestPickup,
  type ConquestEgg,
} from './conquestAbilities';
import {
  raySphereHit,
  screenBoxFromDrag,
  pointInScreenBox,
  screenDistanceSquared,
  type ScreenBox,
} from './conquestSelection';
import {
  isFarmableTile,
  countOwnedFarmTiles,
  populationCap,
  canGrowUnit,
  QUEEN_GROWTH_INTERVAL_MS,
  CLAIM_SCAN_INTERVAL_MS,
} from './conquestGrowth';
import {
  buildPoseVariants,
  selectPoseIndex,
  airLiftFactor,
  type PoseVariant,
} from './conquestAnimation';
import type { GoldbergWorld } from './goldbergWorld';
import type { TileBiome } from './conquestBiomes';
import { BIOMES } from './conquestBiomes';
import { tileTopRadius } from './conquestGlobeGeometry';

// Model footprint on the unit-radius globe. A level-3 tile spans ~0.18 units, so
// each tile should read as a large field ("an acre"): an animal is only a small
// fraction of a tile across. Monarchs (King/Queen) are larger so leaders stand out.
const UNIT_SCALE = 0.005;
const MONARCH_SCALE = 0.007;

// Team-color allegiance ring drawn flat on the surface under each unit, in globe
// units. A monarch's ring is larger so leaders are easy to pick out, and the color
// tracks the unit's current controller so a captured army visibly flips to the
// conqueror's color the instant it changes hands.
const UNIT_RING_RADIUS = 0.011;
const MONARCH_RING_RADIUS = 0.018;
const RING_LIFT = 0.001; // sit just above the tile face to avoid z-fighting
const RING_FORWARD = new THREE.Vector3(0, 0, 1); // RingGeometry/CircleGeometry default normal

// King/Queen aura discs: a soft, color-coded field showing each monarch's support
// radius (gold = King's damage buff, green = Queen's heal). They pulse brighter
// while the aura is actively benefiting a friendly unit.
const KING_AURA_COLOR = 0xfbbf24;
const QUEEN_AURA_COLOR = 0x4ade80;
const AURA_OPACITY_IDLE = 0.07;
const AURA_OPACITY_ACTIVE = 0.2;
const AURA_PULSE_HZ = 1.4;
const AURA_LIFT = 0.0008; // just under the allegiance ring
// A King's buff ring counts as "active" while a buffed unit fought this recently.
const RECENT_COMBAT_MS = 2000;

// Piloting feel. Speeds are in globe-radius units per second (the planet has
// radius 1, so a full lap at MOVE_SPEED takes ~2π / MOVE_SPEED seconds). Tuned so
// crossing one acre-sized tile takes a couple of seconds, not a blink. Per-role
// move multipliers (King slower, Queen faster) scale these via combat stats.
const MOVE_SPEED = 0.1;
const FOLLOW_SPEED = 0.12;
const FOLLOW_GAP = 0.012; // followers hold this distance behind their leader

// Chase camera placement, expressed as multiples of the monarch's model scale so
// the third-person framing stays correct no matter how small the animals are.
// HEIGHT vs BACK sets the pitch — these give the requested "slightly top-down"
// angle. Multiplied further by the live zoom factor.
const CAM_BACK_FACTOR = 7.0;
const CAM_HEIGHT_FACTOR = 4.5;
const CAM_LERP = 6.0; // higher = snappier follow
const ZOOM_MIN = 0.45;
const ZOOM_MAX = 4.0;
// Per-second multiplicative rate when a held zoom key (if the player bound one)
// is down, mirroring the wheel's exponential zoom so keyboard and wheel agree.
const ZOOM_KEY_SPEED = 1.6;

// Movement detection for the walk/idle pose split. A unit counts as "moving"
// while its position changed at least MOVE_EPSILON within the last MOVE_HOLD_MS,
// so the walk cycle bridges frames where the unit briefly held still.
const MOVE_EPSILON_SQ = 0.0002 * 0.0002;
const MOVE_HOLD_MS = 160;

// Chicken egg projectiles: a fixed pool of small spheres reused across throws so
// the egg count never re-renders React. Eggs beyond the pool's capacity (a huge
// volley) simply aren't drawn; the simulation still resolves their hits. The
// render radius is a fraction of a tile so an egg reads as a thrown projectile.
const EGG_POOL_SIZE = 64;
const EGG_RENDER_RADIUS = 0.004;
const EGG_COLOR = 0xfff4d6;

// Frog tongue beam: a thin cylinder stretched from the frog's mouth to the tongue
// tip each frame. The beam rides slightly above the surface so it reads over the
// terrain, and its width is a sliver of a tile.
const TONGUE_WIDTH = 0.0016;
const TONGUE_LIFT = 0.004;
const TONGUE_COLOR = 0xd9607a;
const BEAM_UP = new THREE.Vector3(0, 1, 0); // CylinderGeometry's long axis

// Pointer selection (increment 4). A drag past this many pixels is a box-select
// rather than a click; a click within this pixel radius of a unit picks it. The
// selection ring is a bright halo drawn a hair larger than the allegiance ring.
const DRAG_THRESHOLD_PX = 6;
const CLICK_PICK_RADIUS_PX = 28;
const SELECTION_RING_RADIUS = 0.015;
const MONARCH_SELECTION_RING_RADIUS = 0.022;
const SELECTION_RING_LIFT = 0.0014; // just above the allegiance ring
const SELECTION_RING_COLOR = 0xffffff;
// The approximate globe radius a pointer ray is intersected against to place a move
// order (tile tops sit at ~1.0; the exact tile is resolved from the hit direction).
const ORDER_SPHERE_RADIUS = 1.0;

// Queen unit growth (increment 5). A grown unit musters this far from its Queen on
// the tangent plane (a fraction of a tile, so it appears beside her), and the Queen's
// rally marker — where her new units head when she has set one — is sized like a
// monarch ring. Live unit counts are pushed to the store for the HUD on this cadence.
const SPAWN_TANGENT_OFFSET = 0.01;
const RALLY_MARKER_RADIUS = 0.02;
const POPULATION_PUBLISH_INTERVAL_MS = 500;

interface LiveUnit {
  id: string;
  /** Original owner id — the army's permanent identity, used for following/grouping. */
  armyId: string;
  /** Player currently controlling this unit; flips on capture. Drives friend/foe. */
  controllerId: string;
  kind: ConquestUnitKind;
  isMonarch: boolean;
  animal: AnimalId;
  movement: MovementType;
  combat: ConquestCombatStats;
  /** Combat posture (stance / fire / priority); drives auto-target and chase leashing. */
  behavior: UnitBehavior;
  /** Globe-scaled engagement radii resolved from `behavior.stance` (cached per unit). */
  posture: StanceParams;
  hp: number;
  maxHp: number;
  /** A monarch at 0 HP is downed (not killed): it can't act and awaits capture or healing. */
  downed: boolean;
  /** True this frame while the monarch's aura is actively helping an ally (drives the pulse). */
  auraActive: boolean;
  lastAttackMs: number;
  lastCombatMs: number;
  /** Controller of the unit that most recently damaged this one (the would-be conqueror). */
  lastAttackerController: string | null;
  // --- Per-animal ability state (increment 3) ---
  /** Turtle Shell: while true the unit is immovable, invulnerable, and cannot attack. */
  shelled: boolean;
  /** Stamp of the last shell toggle, so a held both-button press can't flicker it each frame. */
  lastShellToggleMs: number;
  /** Cat Hiss: when the cat last hissed (gates its cooldown). */
  lastHissMs: number;
  /** Cat Hiss: while in the future, this cat shows the Kitty_F2 hiss pose. */
  hissUntilMs: number;
  /** Cat Hiss knockback on THIS unit: while in the future, slide it along `knockbackDir`. */
  knockbackUntilMs: number;
  knockbackDir: THREE.Vector3;
  /** Bee Swarm: the enemy unit id this follower bee is diving at, or null when not swarming. */
  swarmTargetId: string | null;
  /** Chicken Eggs: when this chicken last threw (gates its cooldown). */
  lastEggMs: number;
  /** Chicken Eggs: while in the future, this chicken holds its egg-throw pose. */
  eggThrowUntilMs: number;
  /** Frog Tongue: the live grab state machine, or null when no tongue is out. */
  tongue: ConquestTongue | null;
  /** Frog Tongue: when this frog last fired (gates its cooldown). */
  lastTongueMs: number;
  /** Owl Pickup: the live abduction state machine (this unit is the owl), or null. */
  pickup: ConquestPickup | null;
  /** Owl Pickup: when this owl last abducted (gates its cooldown). */
  lastPickupMs: number;
  /** Owl Pickup: id of the owl carrying THIS unit, or null. A carried unit is owned by its owl. */
  carriedByOwlId: string | null;
  /** Radial lift above the surface in globe units (a flying/abducting owl, or its dangling catch). */
  flightLift: number;
  // --- Player commands (increment 4: pointer selection + orders) ---
  /** A move order's destination on the sphere surface, or null. Overrides auto-follow. */
  orderPos: THREE.Vector3 | null;
  /** An attack order's target unit id, or null. Forces engagement of that unit. */
  orderAttackId: string | null;
  // --- Growth + territory (increment 5) ---
  /** A grown unit's garrison point: when set it musters/holds here instead of following the army. */
  rallyPos: THREE.Vector3 | null;
  /** The tile this unit last stood on, for occupation-claim transition detection (-1 = none yet). */
  currentTileId: number;
  /** Queens only: when this Queen last grew a unit (gates her growth interval). */
  lastGrowthMs: number;
  dead: boolean;
  /** Resolved each frame: the enemy this unit is engaging, if any. */
  target: LiveUnit | null;
  poseVariants: PoseVariant[];
  poseGroups: (THREE.Group | null)[];
  scale: number;
  airLift: number;
  position: THREE.Vector3;
  facing: THREE.Vector3;
  lastPosition: THREE.Vector3;
  lastMovedMs: number;
  group: THREE.Group | null;
  ring: THREE.Mesh | null;
  ringColor: number; // last hex applied to the ring, so we only recolor on change
  auraMesh: THREE.Mesh | null; // monarchs only
  tongueMesh: THREE.Mesh | null; // frogs only: the grab beam
  selectionRing: THREE.Mesh | null; // shown while the unit is selected
  rallyMesh: THREE.Mesh | null; // queens only: the rally-point marker
}

/**
 * Build a fresh live unit with all per-frame state at its defaults. Used both to seed
 * the match's starting armies and to mint a Queen's grown reinforcements (Increment 5),
 * so a spawned unit is indistinguishable from a starting one. Render refs (group, ring,
 * …) start null and are wired when React mounts the unit's meshes.
 */
function buildLiveUnit(args: {
  id: string;
  armyId: string;
  controllerId: string;
  animal: AnimalId;
  kind: ConquestUnitKind;
  isMonarch: boolean;
  position: THREE.Vector3;
  facing: THREE.Vector3;
  poseVariants: PoseVariant[];
}): LiveUnit {
  const scale = args.isMonarch ? MONARCH_SCALE : UNIT_SCALE;
  const combat = conquestStatsFor(args.animal, args.kind);
  const behavior = defaultBehaviorFor(args.animal, args.kind);
  return {
    id: args.id,
    armyId: args.armyId,
    controllerId: args.controllerId,
    kind: args.kind,
    isMonarch: args.isMonarch,
    animal: args.animal,
    movement: ANIMAL_MOVEMENT_TYPES[args.animal],
    combat,
    behavior,
    posture: stanceParams(behavior.stance, combat.attackRange),
    hp: combat.maxHp,
    maxHp: combat.maxHp,
    downed: false,
    auraActive: false,
    lastAttackMs: 0,
    lastCombatMs: 0,
    lastAttackerController: null,
    shelled: false,
    lastShellToggleMs: 0,
    lastHissMs: 0,
    hissUntilMs: 0,
    knockbackUntilMs: 0,
    knockbackDir: new THREE.Vector3(),
    swarmTargetId: null,
    lastEggMs: 0,
    eggThrowUntilMs: 0,
    tongue: null,
    lastTongueMs: 0,
    pickup: null,
    lastPickupMs: 0,
    carriedByOwlId: null,
    flightLift: 0,
    orderPos: null,
    orderAttackId: null,
    rallyPos: null,
    currentTileId: -1,
    lastGrowthMs: 0,
    dead: false,
    target: null,
    poseVariants: args.poseVariants,
    poseGroups: new Array(args.poseVariants.length).fill(null),
    scale,
    airLift: airLiftFactor(args.animal) * scale,
    position: args.position,
    facing: args.facing,
    lastPosition: args.position.clone(),
    lastMovedMs: 0,
    group: null,
    ring: null,
    ringColor: -1,
    auraMesh: null,
    tongueMesh: null,
    selectionRing: null,
    rallyMesh: null,
  };
}

function modelPath(animal: AnimalId): string {
  return `${import.meta.env.BASE_URL}models/${ANIMAL_FILE_MAP[animal]}`;
}

// The discrete (non-held) Quick Play pilot gestures Conquest honors. Drive and
// zoom are held keys read directly each frame; these fire on a tap/double-tap/hold
// of their bound input, exactly as KeyboardShortcuts dispatches them in Quick Play.
const PILOT_GESTURE_ACTIONS: readonly string[] = ['pilotCycleMonarch', 'pilotToggleMonarch'];

/**
 * A camera-drive / zoom binding is only usable as a held key when it is a single
 * plain key — no modifier chord, and not a mouse button or wheel direction.
 * Returns that key token for matching against the pressed-keys set, or null.
 * Mirrors CameraController so both modes read the same bindings the same way.
 */
function plainKeyToken(token: string): string | null {
  if (!token || token.includes('+') || token.startsWith('mouse:') || token === 'wheelup' || token === 'wheeldown') {
    return null;
  }
  return token;
}

/** Index of the tile whose center is nearest a direction on the sphere. */
function nearestTileId(direction: THREE.Vector3, world: GoldbergWorld): number {
  let best = 0;
  let bestDot = -Infinity;
  for (const tile of world.tiles) {
    const dot = tile.center.dot(direction);
    if (dot > bestDot) {
      bestDot = dot;
      best = tile.id;
    }
  }
  return best;
}

function isPassable(tileBiome: TileBiome | undefined, movement: MovementType): boolean {
  if (!tileBiome) return false;
  return BIOMES[tileBiome.biome].passableBy.has(movement);
}

/**
 * Move a radial lift toward `goal` at `speed` globe units/sec without overshooting.
 * Used to animate an abducting Owl (and its dangling catch) down into a swoop and
 * back up to flight height.
 */
function approachLift(current: number, goal: number, speed: number, deltaSeconds: number): number {
  const remaining = goal - current;
  const step = speed * deltaSeconds;
  if (Math.abs(remaining) <= step) return goal;
  return current + Math.sign(remaining) * step;
}

/** Re-orthogonalize `facing` to be a unit tangent at the surface point `up`. */
function tangentize(facing: THREE.Vector3, up: THREE.Vector3): void {
  facing.addScaledVector(up, -facing.dot(up));
  if (facing.lengthSq() < 1e-8) {
    // Degenerate (facing was parallel to up): pick any tangent.
    facing.crossVectors(up, Math.abs(up.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0));
  }
  facing.normalize();
}

export function ConquestField() {
  const world = useConquestStore((s) => s.world);
  const biomes = useConquestStore((s) => s.biomes);
  const unitSpawns = useConquestStore((s) => s.units);
  const players = useConquestStore((s) => s.players);
  const cycleMonarch = useConquestStore((s) => s.cycleMonarch);

  // Team colors keyed by player id, mirrored to a ref so the per-frame loop can
  // recolor allegiance rings (on capture) without re-subscribing each render.
  const colorByController = useMemo(() => {
    const map = new Map<string, number>();
    players.forEach((player) => map.set(player.id, player.color));
    return map;
  }, [players]);
  const colorRef = useRef(colorByController);
  colorRef.current = colorByController;

  // The SAME remappable bindings Quick Play uses, read from the shared store so a
  // player's Settings layout drives both modes. Mirrored to a ref so the per-frame
  // loop reads the current layout without re-subscribing each render.
  const keyboardBindings = useGameStore((s) => s.keyboardBindings);
  const keyboardBindingModes = useGameStore((s) => s.keyboardBindingModes);
  const bindingsRef = useRef(keyboardBindings);
  bindingsRef.current = keyboardBindings;

  const { camera, gl } = useThree();

  // Load the models actually fielded this match (stable for the screen's life).
  const inPlayAnimals = useMemo<AnimalId[]>(() => {
    const set = new Set<AnimalId>();
    unitSpawns.forEach((unit) => set.add(unit.animal));
    return Array.from(set);
  }, [unitSpawns]);
  const gltfs = useGLTF(inPlayAnimals.map(modelPath)) as any[];

  // Shared geometry: one ring (allegiance) and one disc (monarch aura). Each unit
  // scales and tints its own material instance. Disposed when the field unmounts.
  const ringGeometry = useMemo(() => new THREE.RingGeometry(0.6, 1.0, 24), []);
  const auraGeometry = useMemo(() => new THREE.CircleGeometry(1.0, 36), []);
  // Egg projectile sphere and tongue beam cylinder (unit-sized; each instance scales
  // itself). The cylinder is built along +Y, centered, so a midpoint placement plus a
  // (0,1,0)->beam rotation orients it; its Y scale becomes the beam length.
  const eggGeometry = useMemo(() => new THREE.SphereGeometry(EGG_RENDER_RADIUS, 8, 8), []);
  const tongueGeometry = useMemo(() => new THREE.CylinderGeometry(1, 1, 1, 6), []);
  useEffect(() => () => {
    ringGeometry.dispose(); auraGeometry.dispose();
    eggGeometry.dispose(); tongueGeometry.dispose();
  }, [ringGeometry, auraGeometry, eggGeometry, tongueGeometry]);

  // Whether this match fields any Frog army, so the tongue beam meshes are only
  // mounted when a frog can actually fire one (most matches have none).
  const hasFrog = useMemo(() => inPlayAnimals.includes('Frog'), [inPlayAnimals]);

  // In-flight eggs (a mutable pool the sim owns) and the meshes that draw them.
  const eggs = useRef<ConquestEgg[]>([]);
  const eggIdCounter = useRef(0);
  const eggMeshes = useRef<(THREE.Mesh | null)[]>(new Array(EGG_POOL_SIZE).fill(null));

  // Pose-frame variants per animal, built from the loaded models. Hoisted so both the
  // initial army build and a Queen's grown reinforcements (increment 5) mint units
  // with the same pose set.
  const posesByAnimal = useMemo(() => {
    const map = new Map<AnimalId, PoseVariant[]>();
    inPlayAnimals.forEach((animal, index) => {
      const gltf = gltfs[index];
      if (gltf) map.set(animal, buildPoseVariants(animal, gltf));
    });
    return map;
  }, [inPlayAnimals, gltfs]);

  // The match's STARTING armies. Positions/facings/HP here are mutated every frame by
  // the sim; React never re-renders for movement or combat. Deliberately does NOT
  // depend on army control — capturing an army mutates `controllerId` in place, so the
  // starting set never rebuilds and loses state.
  const initialUnits = useMemo<LiveUnit[]>(() => {
    if (!world || biomes.length === 0) return [];
    return unitSpawns.map((spawn) => {
      const position = new THREE.Vector3(spawn.position.x, spawn.position.y, spawn.position.z);
      const up = position.clone().normalize();
      // Seed facing as an arbitrary tangent; piloting/following/combat overwrite it.
      const facing = new THREE.Vector3().crossVectors(
        up, Math.abs(up.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0),
      ).normalize();
      return buildLiveUnit({
        id: spawn.id,
        armyId: spawn.ownerId,
        controllerId: spawn.ownerId,
        animal: spawn.animal,
        kind: spawn.kind,
        isMonarch: spawn.isMonarch,
        position,
        facing,
        poseVariants: posesByAnimal.get(spawn.animal) ?? [],
      });
    });
  }, [world, biomes, unitSpawns, posesByAnimal]);

  // Queen-grown reinforcements, appended over the match (increment 5). Kept SEPARATE
  // from the starting set so growth only ever APPENDS units — the existing live units
  // keep their identity and positions (no teleport), and only a new spawn re-renders.
  const [spawnedUnits, setSpawnedUnits] = useState<LiveUnit[]>([]);
  useEffect(() => { setSpawnedUnits([]); }, [initialUnits]); // a new match starts with no growth

  // The full live set the sim and renderer iterate: starting armies plus any grown
  // reinforcements. Appending a spawn rebuilds this array reference (mounting the new
  // unit's meshes) while preserving every existing unit object.
  const liveUnits = useMemo<LiveUnit[]>(
    () => (spawnedUnits.length > 0 ? [...initialUnits, ...spawnedUnits] : initialUnits),
    [initialUnits, spawnedUnits],
  );
  // The current live set, mirrored to a ref so the pointer handlers read it without
  // re-binding their listeners every time a unit is grown.
  const unitsRef = useRef(liveUnits);
  unitsRef.current = liveUnits;

  // Each army's King and Queen, looked up by army id. Monarchs persist for the
  // match (capture changes their controller; they down but never leave), so these
  // are stable for the field's life.
  const { kingByArmy, queenByArmy } = useMemo(() => {
    const kings = new Map<string, LiveUnit>();
    const queens = new Map<string, LiveUnit>();
    liveUnits.forEach((unit) => {
      if (unit.kind === 'king') kings.set(unit.armyId, unit);
      else if (unit.kind === 'queen') queens.set(unit.armyId, unit);
    });
    return { kingByArmy: kings, queenByArmy: queens };
  }, [liveUnits]);

  // The human player's id ('p0'); only units this player currently controls can be
  // selected and ordered (the army-command model — see effectiveController).
  const humanId = useMemo(
    () => players.find((player) => !player.isAI)?.id ?? null,
    [players],
  );

  // --- Input: pressed keys + zoom, tracked in refs (no per-key re-render). ---
  const keys = useRef<Set<string>>(new Set());
  const zoom = useRef(1.0);
  const cameraInitialized = useRef(false);

  // Pointer selection (increment 4): the set of selected unit ids, tracked in a ref
  // so selecting never re-renders the field (the per-frame loop reads it to draw the
  // selection rings, exactly as it reads control for the allegiance rings).
  const selectedIds = useRef<Set<string>>(new Set());

  // Queen unit growth (increment 5): each Queen's rally point (id → muster destination),
  // a monotonic id source for grown units, and the throttle clocks for the claim scan
  // and the HUD population publish. Reset per match alongside the camera below.
  const queenRallies = useRef<Map<string, THREE.Vector3>>(new Map());
  const spawnCounter = useRef(0);
  const lastClaimScanMs = useRef(0);
  const lastPopulationPublishMs = useRef(0);

  useEffect(() => {
    selectedIds.current.clear();       // drop any selection on a new match
    cameraInitialized.current = false; // re-frame on a new match
    eggs.current = [];                 // clear any in-flight projectiles
    queenRallies.current.clear();      // clear standing rally points
    spawnCounter.current = 0;
    lastClaimScanMs.current = 0;
    lastPopulationPublishMs.current = 0;
  }, [initialUnits]);

  // Re-subscribe only when the binding layout changes. The discrete pilot
  // gestures (cycle / toggle monarch) run through the same gestureModes dispatch
  // Quick Play uses, so they honor the player's chosen activation mode; the held
  // drive/zoom keys are matched against the live layout in the per-frame loop.
  useEffect(() => {
    // Both the "cycle" and "toggle" pilot bindings switch which controlled monarch
    // (King or Queen of any army the player commands) is piloted — the analogue
    // that keeps each Quick Play key doing something useful in Conquest.
    const runPilotAction = () => cycleMonarch();

    const configFor = (
      _actionId: string,
      mode: ActivationMode,
    ): Partial<TokenGestureConfig> | undefined => {
      if (mode === 'tap') return { onTap: runPilotAction };
      if (mode === 'double-tap') return { onDoubleTap: runPilotAction };
      if (mode === 'hold') return { onHoldStart: runPilotAction };
      return undefined; // chord fires on press below
    };

    const dispatch = buildTokenDispatch({
      bindings: keyboardBindings,
      modes: keyboardBindingModes,
      actionIds: PILOT_GESTURE_ACTIONS,
      configFor,
    });
    const ownsToken = (token: string) =>
      dispatch.resolvers.has(token) || dispatch.chordActions.some((c) => c.token === token);

    const onKeyDown = (event: KeyboardEvent) => {
      const raw = event.key.toLowerCase();
      keys.current.add(raw === ' ' ? 'space' : raw);

      const token = keyboardEventToToken(event);
      if (token === '' || !ownsToken(token)) return;
      event.preventDefault();
      if (event.repeat) return; // OS auto-repeat; the resolver owns held cadence
      for (const chord of dispatch.chordActions) {
        if (chord.token === token) runPilotAction();
      }
      dispatch.resolvers.get(token)?.press(performance.now());
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const raw = event.key.toLowerCase();
      keys.current.delete(raw === ' ' ? 'space' : raw);
      dispatch.resolvers.get(keyboardEventToToken(event))?.release(performance.now());
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(event.deltaY * 0.0012);
      zoom.current = THREE.MathUtils.clamp(zoom.current * factor, ZOOM_MIN, ZOOM_MAX);
    };
    // A lost focus never delivers keyup: drop held keys and abandon any pending
    // gesture timing so the monarch doesn't drift in the last-held direction.
    const onBlur = () => {
      keys.current.clear();
      dispatch.resolvers.forEach((resolver) => resolver.reset());
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    const canvas = gl.domElement;
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('blur', onBlur);
      dispatch.resolvers.forEach((resolver) => resolver.reset());
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [cycleMonarch, gl, keyboardBindings, keyboardBindingModes]);

  // Pointer interaction, mirroring Quick Play's mouse model so the player commands
  // their armies the same way on the globe (the camera stays the chase cam):
  //   • LEFT click            — select the controlled unit under the cursor (or clear).
  //   • LEFT drag (a box)     — box-select every controlled unit inside the rectangle.
  //   • RIGHT click on a tile — move-order the selection there (great-circle travel).
  //   • RIGHT click on an enemy — attack-order the selection onto that enemy.
  //   • BOTH buttons together — fire the piloted army's ability (suppresses the above).
  // Only units the human currently controls can be selected/ordered (the army-command
  // model). The ability fire is recorded as an edge the per-frame loop consumes.
  const abilityRequested = useRef(false);
  useEffect(() => {
    const canvas = gl.domElement;

    // A green rubber-band box drawn during a left-drag select (page-positioned).
    const selectionBox = document.createElement('div');
    Object.assign(selectionBox.style, {
      position: 'fixed', border: '1px solid #ffffff',
      backgroundColor: 'rgba(255,255,255,0.12)', pointerEvents: 'none',
      display: 'none', zIndex: '1000',
    } as CSSStyleDeclaration);
    document.body.appendChild(selectionBox);

    let leftDown = false;
    let rightDown = false;
    let abilityGesture = false; // both buttons were held during this gesture
    let dragActive = false;
    let dragMoved = false;
    let startX = 0;
    let startY = 0;

    // Project a world point to client (page) pixels; `behind` flags points off-frustum.
    const projectToClient = (worldPos: THREE.Vector3) => {
      const ndc = worldPos.clone().project(camera);
      const rect = canvas.getBoundingClientRect();
      return {
        x: (ndc.x * 0.5 + 0.5) * rect.width + rect.left,
        y: (-ndc.y * 0.5 + 0.5) * rect.height + rect.top,
        behind: ndc.z > 1,
      };
    };

    // A unit is selectable/visible only when it faces the camera (on the near side of
    // the globe), so a click never picks a unit hidden behind the planet.
    const isFrontFacing = (unit: LiveUnit) => {
      const normal = unit.position.clone().normalize();
      return unit.position.clone().sub(camera.position).dot(normal) < 0;
    };

    const controls = (unit: LiveUnit) =>
      humanId !== null
      && effectiveController(useConquestStore.getState().armyController, unit.armyId) === humanId;

    // The nearest on-screen unit to a client point passing `filter`, within the pick radius.
    const pickUnitAt = (clientX: number, clientY: number, filter: (u: LiveUnit) => boolean) => {
      let best: LiveUnit | null = null;
      let bestSq = CLICK_PICK_RADIUS_PX * CLICK_PICK_RADIUS_PX;
      for (const unit of unitsRef.current) {
        if (unit.dead || unit.carriedByOwlId !== null || !filter(unit) || !isFrontFacing(unit)) continue;
        const screen = projectToClient(unit.position);
        if (screen.behind) continue;
        const distSq = screenDistanceSquared(clientX, clientY, screen.x, screen.y);
        if (distSq <= bestSq) { bestSq = distSq; best = unit; }
      }
      return best;
    };

    const applyBoxSelection = (box: ScreenBox) => {
      const next = new Set<string>();
      for (const unit of unitsRef.current) {
        if (unit.dead || unit.carriedByOwlId !== null || !controls(unit) || !isFrontFacing(unit)) continue;
        const screen = projectToClient(unit.position);
        if (!screen.behind && pointInScreenBox(screen.x, screen.y, box)) next.add(unit.id);
      }
      selectedIds.current = next;
    };

    // Project a pointer ray onto the planet and resolve the surface point of the tile
    // it lands on, or null if it misses. Shared by move orders and Queen rally points.
    const tileDestFromClient = (clientX: number, clientY: number): THREE.Vector3 | null => {
      if (!world) return null;
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
      const rayDir = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
      const hit = raySphereHit(camera.position, rayDir, ORDER_SPHERE_RADIUS);
      if (!hit) return null;
      const direction = hit.normalize();
      const tileId = nearestTileId(direction, world);
      return direction.multiplyScalar(tileTopRadius(biomes[tileId]));
    };

    // Resolve a right-click into a move or attack order for the current selection.
    const issueOrder = (clientX: number, clientY: number) => {
      if (selectedIds.current.size === 0 || !world) return;

      // An enemy under the cursor turns the order into an attack on that unit.
      const enemy = pickUnitAt(clientX, clientY, (u) => !controls(u) && !u.downed);
      if (enemy) {
        for (const unit of unitsRef.current) {
          if (!selectedIds.current.has(unit.id) || unit.dead || unit.downed || unit.carriedByOwlId !== null) continue;
          unit.orderAttackId = enemy.id;
          unit.orderPos = null;
        }
        return;
      }

      // Otherwise move-order the selection to the tile the pointer lands on.
      const dest = tileDestFromClient(clientX, clientY);
      if (!dest) return;
      for (const unit of unitsRef.current) {
        if (!selectedIds.current.has(unit.id) || unit.dead || unit.downed || unit.carriedByOwlId !== null) continue;
        unit.orderPos = dest.clone();
        unit.orderAttackId = null;
      }
    };

    // Shift + right-click sets the rally point of every selected Queen the player
    // controls: her future grown units muster there instead of joining the army
    // (increment 5). Selecting no controlled Queen leaves any standing rally untouched.
    const setQueenRally = (clientX: number, clientY: number) => {
      const dest = tileDestFromClient(clientX, clientY);
      if (!dest) return;
      for (const unit of unitsRef.current) {
        if (unit.kind !== 'queen' || unit.dead || !controls(unit)) continue;
        if (!selectedIds.current.has(unit.id)) continue;
        queenRallies.current.set(unit.id, dest.clone());
      }
    };

    const hideBox = () => { selectionBox.style.display = 'none'; };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button === 0) leftDown = true;
      else if (event.button === 2) rightDown = true;
      if (leftDown && rightDown) {
        // Both buttons: an ability fire. Cancel any drag-select the first button began.
        abilityGesture = true;
        abilityRequested.current = true;
        dragActive = false;
        dragMoved = false;
        hideBox();
        return;
      }
      if (event.button === 0) {
        dragActive = true;
        dragMoved = false;
        startX = event.clientX;
        startY = event.clientY;
      }
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!dragActive || abilityGesture) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!dragMoved && dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      dragMoved = true;
      const box = screenBoxFromDrag(startX, startY, event.clientX, event.clientY);
      Object.assign(selectionBox.style, {
        display: 'block',
        left: `${box.minX}px`, top: `${box.minY}px`,
        width: `${box.maxX - box.minX}px`, height: `${box.maxY - box.minY}px`,
      } as CSSStyleDeclaration);
    };

    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 0) {
        if (!abilityGesture) {
          if (dragMoved) {
            applyBoxSelection(screenBoxFromDrag(startX, startY, event.clientX, event.clientY));
          } else {
            const picked = pickUnitAt(event.clientX, event.clientY, controls);
            selectedIds.current = picked ? new Set([picked.id]) : new Set();
          }
        }
        dragActive = false;
        dragMoved = false;
        hideBox();
        leftDown = false;
      } else if (event.button === 2) {
        if (!abilityGesture) {
          if (event.shiftKey) setQueenRally(event.clientX, event.clientY);
          else issueOrder(event.clientX, event.clientY);
        }
        rightDown = false;
      }
      if (!leftDown && !rightDown) abilityGesture = false; // gesture fully released
    };

    // The right button is a command input here, never a browser context menu.
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    const onBlur = () => {
      leftDown = false; rightDown = false; abilityGesture = false;
      dragActive = false; dragMoved = false; hideBox();
    };

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('blur', onBlur);
    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('blur', onBlur);
      document.body.removeChild(selectionBox);
    };
  }, [gl, camera, world, biomes, humanId]);

  // Reusable scratch (no per-frame allocation in the hot loop).
  const scratch = useRef({
    up: new THREE.Vector3(),
    right: new THREE.Vector3(),
    forward: new THREE.Vector3(),
    step: new THREE.Vector3(),
    candidateDir: new THREE.Vector3(),
    basis: new THREE.Matrix4(),
    quat: new THREE.Quaternion(),
    ringQuat: new THREE.Quaternion(),
    renderPos: new THREE.Vector3(),
    camDesired: new THREE.Vector3(),
    camBack: new THREE.Vector3(),
    camForwardTangent: new THREE.Vector3(),
    camRightTangent: new THREE.Vector3(),
    drive: new THREE.Vector3(),
    beamTip: new THREE.Vector3(),
    beamMid: new THREE.Vector3(),
    beamVec: new THREE.Vector3(),
    beamQuat: new THREE.Quaternion(),
  });

  // Per-frame combat scratch reused across frames (cleared at the top of each).
  const kingBuffed = useRef<Set<string>>(new Set());
  const queenHealed = useRef<Set<string>>(new Set());

  // Move `unit` toward `targetPos` along the sphere surface, stopping when within
  // `stopDistance`. Honors per-biome passability and re-seats the unit on the tile
  // top. Returns true if it actually stepped (was outside the stop radius).
  const moveToward = (
    unit: LiveUnit,
    targetPos: THREE.Vector3,
    speed: number,
    stopDistance: number,
    delta: number,
  ): boolean => {
    const { up, step, candidateDir } = scratch.current;
    step.subVectors(targetPos, unit.position);
    const distance = step.length();
    if (distance <= stopDistance) return false;
    const travel = Math.min(speed * unit.combat.moveMultiplier * delta, distance - stopDistance);
    candidateDir.copy(unit.position).addScaledVector(step.normalize(), travel).normalize();
    const tileId = nearestTileId(candidateDir, world!);
    if (isPassable(biomes[tileId], unit.movement)) {
      unit.position.copy(candidateDir).multiplyScalar(tileTopRadius(biomes[tileId]));
    }
    up.copy(unit.position).normalize();
    unit.facing.subVectors(targetPos, unit.position);
    tangentize(unit.facing, up);
    return true;
  };

  // Fire the piloted army's per-animal special (both-mouse-button trigger). The
  // player commands the WHOLE army, so every living unit of the army's single
  // animal acts at once: turtles shell up, cats hiss, bee followers commit to a
  // dive, chickens lob eggs, frogs shoot tongues, owl followers swoop to abduct.
  // The projectile / beam / carry abilities auto-aim at each unit's nearest enemy
  // (Conquest has no cursor pick yet — selection arrives in the next increment);
  // an animal without a special simply does nothing here.
  const fireArmyAbility = (piloted: LiveUnit | null, nowMs: number) => {
    if (!piloted) return;
    const ability = abilityFor(piloted.animal);
    if (!ability) return;
    const armyId = piloted.armyId;

    if (ability === 'shell') {
      for (const unit of liveUnits) {
        if (unit.armyId !== armyId || unit.dead || unit.downed) continue;
        if (nowMs - unit.lastShellToggleMs < SHELL_RETRIGGER_MS) continue;
        unit.shelled = !unit.shelled;
        unit.lastShellToggleMs = nowMs;
        if (unit.shelled) unit.target = null; // pulling in drops any current engagement
      }
      return;
    }

    if (ability === 'hiss') {
      for (const cat of liveUnits) {
        if (cat.armyId !== armyId || cat.dead || cat.downed || cat.shelled) continue;
        if (nowMs - cat.lastHissMs < HISS_COOLDOWN_MS) continue;
        cat.lastHissMs = nowMs;
        cat.hissUntilMs = nowMs + HISS_POSE_MS;
        for (const push of computeHissPushes(cat, liveUnits, HISS_RANGE)) {
          const enemy = liveUnits.find((unit) => unit.id === push.id);
          if (!enemy || enemy.shelled || enemy.downed) continue; // shelled/downed resist the shove
          enemy.knockbackDir.copy(push.direction);
          enemy.knockbackUntilMs = nowMs + HISS_PUSH_MS;
        }
      }
      return;
    }

    if (ability === 'swarm') {
      // Enemies already claimed by a bee mid-dive, so a cloud spreads its stings.
      const claimedTargetIds = new Set<string>();
      for (const unit of liveUnits) {
        if (unit.swarmTargetId !== null) claimedTargetIds.add(unit.swarmTargetId);
      }
      for (const bee of liveUnits) {
        if (bee.armyId !== armyId || bee.dead || bee.isMonarch) continue; // sacrificial: followers only
        if (bee.swarmTargetId !== null) continue;                         // already diving
        const prey = selectSwarmTarget(bee, liveUnits, claimedTargetIds);
        if (!prey) continue;
        bee.swarmTargetId = prey.id;
        claimedTargetIds.add(prey.id);
      }
      return;
    }

    if (ability === 'eggs') {
      // Each chicken lobs an egg toward its nearest enemy (or straight ahead if none
      // is near), riding it slightly above the surface; the per-frame egg pass curves
      // it along the planet and resolves the first enemy it grazes.
      for (const chicken of liveUnits) {
        if (chicken.armyId !== armyId || chicken.dead || chicken.downed) continue;
        if (nowMs - chicken.lastEggMs < EGG_COOLDOWN_MS) continue;
        chicken.lastEggMs = nowMs;
        chicken.eggThrowUntilMs = nowMs + EGG_THROW_POSE_MS;
        const prey = selectNearestEnemy(chicken, liveUnits, AGGRO_RANGE * 5);
        const aim = prey ? surfaceAimDirection(chicken.position, prey.position) : chicken.facing.clone();
        chicken.facing.copy(aim); // face the throw
        const launchRadius = chicken.position.length() + EGG_LIFT;
        eggs.current.push({
          id: ++eggIdCounter.current,
          controllerId: chicken.controllerId,
          position: chicken.position.clone().normalize().multiplyScalar(launchRadius),
          direction: aim.clone(),
          traveled: 0,
          damage: EGG_DAMAGE,
        });
      }
      // Keep the pool bounded: a huge volley drops its oldest eggs from the draw list.
      if (eggs.current.length > EGG_POOL_SIZE) {
        eggs.current.splice(0, eggs.current.length - EGG_POOL_SIZE);
      }
      return;
    }

    if (ability === 'tongue') {
      // Each frog claims its nearest unclaimed enemy in reach and begins the grab
      // (one enemy per frog, so a line of frogs spreads its grabs). A frog with no
      // enemy in range still fires a whiff straight ahead.
      const claimedTargetIds = new Set<string>();
      for (const unit of liveUnits) {
        if (unit.tongue?.targetId) claimedTargetIds.add(unit.tongue.targetId);
      }
      for (const frog of liveUnits) {
        if (frog.armyId !== armyId || frog.dead || frog.downed) continue;
        if (frog.tongue) continue; // already mid-grab
        if (nowMs - frog.lastTongueMs < TONGUE_COOLDOWN_MS) continue;
        const prey = selectNearestUnclaimedEnemy(frog, liveUnits, claimedTargetIds, TONGUE_RANGE);
        const aim = prey ? surfaceAimDirection(frog.position, prey.position) : frog.facing.clone();
        if (prey) claimedTargetIds.add(prey.id);
        frog.lastTongueMs = nowMs;
        frog.facing.copy(aim);
        frog.target = null; // the grab supersedes any current engagement
        frog.tongue = {
          phase: 'windup',
          targetId: prey?.id ?? null,
          direction: aim.clone(),
          length: 0,
          maxLength: TONGUE_RANGE,
          grabbed: false,
          phaseUntilMs: nowMs + TONGUE_WINDUP_MS,
          damageDealt: false,
        };
      }
      return;
    }

    if (ability === 'pickup') {
      // Each follower owl (royals never risk a swoop) claims its nearest unclaimed
      // enemy ground/water unit — air units can't be plucked from flight — and dives
      // to abduct it.
      const claimedTargetIds = new Set<string>();
      for (const unit of liveUnits) {
        if (unit.pickup) claimedTargetIds.add(unit.pickup.targetId);
        if (unit.carriedByOwlId !== null) claimedTargetIds.add(unit.id);
      }
      const grabbable = liveUnits.filter(
        (unit) => unit.movement !== 'air' && unit.carriedByOwlId === null,
      );
      for (const owl of liveUnits) {
        if (owl.armyId !== armyId || owl.dead || owl.downed || owl.isMonarch) continue;
        if (owl.pickup) continue; // already swooping
        if (nowMs - owl.lastPickupMs < OWL_PICKUP_COOLDOWN_MS) continue;
        const prey = selectNearestUnclaimedEnemy(owl, grabbable, claimedTargetIds, AGGRO_RANGE * 3);
        if (!prey) continue;
        claimedTargetIds.add(prey.id);
        owl.lastPickupMs = nowMs;
        owl.target = null;
        owl.pickup = { phase: 'swooping', targetId: prey.id, grabbed: false, carryUntilMs: 0 };
        owl.flightLift = OWL_FLIGHT_LIFT; // descend from cruising altitude into the swoop
      }
    }
  };

  // Advance one Frog's tongue grab a frame (the frog is pinned for the whole grab,
  // so this is called in lieu of its normal movement). Mirrors Quick Play's
  // updateFrogTongues, re-derived for the sphere (great-circle tip + surface drag).
  const advanceFrogTongue = (frog: LiveUnit, nowMs: number, delta: number) => {
    const tongue = frog.tongue!;
    const target = tongue.targetId
      ? liveUnits.find((unit) => unit.id === tongue.targetId) ?? null
      : null;
    const targetAlive = !!target && !target.dead && !target.downed;
    const rangeSq = TONGUE_RANGE * TONGUE_RANGE;

    if (tongue.phase === 'windup') {
      if (nowMs < tongue.phaseUntilMs) return; // hold the mouth-open beat
      if (tongue.targetId) {
        if (!targetAlive || frog.position.distanceToSquared(target!.position) > rangeSq) {
          frog.tongue = null; // claimed enemy died or fled reach — fizzle (cooldown still applies)
          return;
        }
        tongue.direction.copy(surfaceAimDirection(frog.position, target!.position));
      }
      tongue.phase = 'extending';
      return;
    }

    if (tongue.phase === 'extending') {
      tongue.length = Math.min(tongue.length + TONGUE_EXTEND_SPEED * delta, tongue.maxLength);
      if (targetAlive) {
        tongue.direction.copy(surfaceAimDirection(frog.position, target!.position));
        const tip = stepGreatCircle(frog.position, tongue.direction, tongue.length).position;
        if (tip.distanceToSquared(target!.position) <= TONGUE_HIT_RADIUS * TONGUE_HIT_RADIUS) {
          tongue.grabbed = true;
          if (!tongue.damageDealt) {
            tongue.damageDealt = true;
            target!.hp -= frog.combat.damage;
            target!.lastCombatMs = nowMs;
            target!.lastAttackerController = frog.controllerId;
            frog.lastAttackMs = nowMs;
            frog.lastCombatMs = nowMs;
          }
          tongue.phase = 'retracting';
          return;
        }
      }
      if (tongue.length >= tongue.maxLength) tongue.phase = 'retracting'; // apex: a miss
      return;
    }

    // retracting — reel back; drag a latched, living catch along the surface.
    tongue.length = Math.max(tongue.length - TONGUE_RETRACT_SPEED * delta, 0);
    if (tongue.grabbed && targetAlive
      && frog.position.distanceToSquared(target!.position) > TONGUE_DRAG_STOP_DIST * TONGUE_DRAG_STOP_DIST) {
      const tip = stepGreatCircle(frog.position, tongue.direction, tongue.length).position;
      const tileId = nearestTileId(scratch.current.up.copy(tip).normalize(), world!);
      target!.position.copy(scratch.current.up).multiplyScalar(tileTopRadius(biomes[tileId]));
    }
    if (tongue.length <= 0) frog.tongue = null; // fully reeled in — the frog is free
  };

  // Glue an abducted unit to a point OWL_CARRY_HANG below its owl, matching the
  // owl's surface position and facing so it dangles beneath the talons.
  const glueCarried = (owl: LiveUnit, carried: LiveUnit) => {
    carried.position.copy(owl.position);
    carried.facing.copy(owl.facing);
    carried.flightLift = Math.max(0, owl.flightLift - OWL_CARRY_HANG);
  };

  // Advance one Owl's abduction a frame (the owl drives itself and its catch in lieu
  // of normal movement). Mirrors Quick Play's updateOwlPickups: swoop down, grab,
  // carry up, then drop the enemy for fall damage. Sphere-native (radial lift).
  const advanceOwlPickup = (owl: LiveUnit, nowMs: number, delta: number) => {
    const pickup = owl.pickup!;
    const target = liveUnits.find((unit) => unit.id === pickup.targetId) ?? null;
    const lostTarget = !target || target.dead || target.downed
      || (target.carriedByOwlId !== null && target.carriedByOwlId !== owl.id);
    if (lostTarget) {
      if (target && target.carriedByOwlId === owl.id) { target.carriedByOwlId = null; target.flightLift = 0; }
      owl.pickup = null;
      owl.flightLift = 0;
      return;
    }

    if (pickup.phase === 'swooping') {
      owl.flightLift = approachLift(owl.flightLift, OWL_PLUCK_LIFT, OWL_DESCENT_SPEED, delta);
      const overTarget = owl.position.distanceToSquared(target!.position) <= OWL_GRAB_RANGE * OWL_GRAB_RANGE;
      if (overTarget && owl.flightLift <= OWL_PLUCK_LIFT + 1e-5) {
        target!.carriedByOwlId = owl.id;
        target!.target = null;
        target!.swarmTargetId = null;
        pickup.phase = 'carrying';
        pickup.grabbed = true;
        pickup.carryUntilMs = nowMs + OWL_CARRY_DURATION_MS;
        glueCarried(owl, target!);
        return;
      }
      moveToward(owl, target!.position, OWL_SWOOP_SPEED, 0, delta);
      return;
    }

    // carrying — rise to flight height towing the catch, then drop it once the timer
    // elapses at cruising altitude (an enemy takes fall damage on impact).
    owl.flightLift = approachLift(owl.flightLift, OWL_FLIGHT_LIFT, OWL_ASCENT_SPEED, delta);
    glueCarried(owl, target!);
    if (nowMs >= pickup.carryUntilMs && owl.flightLift >= OWL_FLIGHT_LIFT - 1e-5) {
      target!.carriedByOwlId = null;
      target!.flightLift = 0;
      if (target!.controllerId !== owl.controllerId) {
        target!.hp -= OWL_FALL_DAMAGE;
        target!.lastCombatMs = nowMs;
        target!.lastAttackerController = owl.controllerId;
      }
      owl.pickup = null;
      owl.flightLift = 0;
    }
  };

  useFrame((state, rawDelta) => {
    if (!world || liveUnits.length === 0) return;
    const delta = Math.min(rawDelta, 0.05); // clamp hitches
    const elapsedMs = state.clock.elapsedTime * 1000;
    const {
      up, step, candidateDir, basis, quat, ringQuat, renderPos, camDesired, camBack,
      camForwardTangent, camRightTangent, drive,
    } = scratch.current;

    const conquest = useConquestStore.getState();
    const armyController = conquest.armyController;
    const monarchId = conquest.selectedMonarchId;

    // 0) Refresh allegiance from the store (the capture source of truth), so the
    //    combat, auras, and ring colors below reflect any army that changed hands.
    for (const unit of liveUnits) {
      unit.controllerId = effectiveController(armyController, unit.armyId);
    }

    // Resolve the piloted monarch. If the selected monarch is downed/dead, hand the
    // camera to another monarch the same player controls so control never strands.
    const selectedUnit = liveUnits.find((unit) => unit.id === monarchId) ?? null;
    let monarch: LiveUnit | null =
      selectedUnit && !selectedUnit.dead && !selectedUnit.downed ? selectedUnit : null;
    if (!monarch && selectedUnit) {
      monarch = liveUnits.find((unit) =>
        unit.isMonarch && !unit.dead && !unit.downed
        && unit.controllerId === selectedUnit.controllerId) ?? null;
    }

    // Ability dispatch: a both-mouse-button press fires the piloted army's special.
    if (abilityRequested.current) {
      abilityRequested.current = false;
      fireArmyAbility(monarch, elapsedMs);
    }

    // Resolve the player's live drive/zoom bindings (default ESDF + wheel). Held
    // keys are matched the same way CameraController matches them in Quick Play.
    const bindings = bindingsRef.current;
    const pressed = keys.current;
    const forwardKey = plainKeyToken(bindings.cameraForward);
    const backwardKey = plainKeyToken(bindings.cameraBackward);
    const leftKey = plainKeyToken(bindings.cameraLeft);
    const rightKey = plainKeyToken(bindings.cameraRight);

    // 1) Drive the piloted monarch from input, camera-relative on the sphere's
    //    tangent plane (matching Quick Play's camera-relative ESDF drive) and
    //    constrained to passable tiles. With no input the monarch is handled by the
    //    combat/idle pass below (so it auto-defends).
    // A shelled monarch is immovable; a monarch mid-hiss-knockback is owned by the
    // shove (handled in the movement pass), so neither is driven by input this frame.
    let drivingInput = false;
    if (monarch && !monarch.shelled && monarch.knockbackUntilMs <= elapsedMs) {
      up.copy(monarch.position).normalize();

      camera.getWorldDirection(camForwardTangent);
      camForwardTangent.addScaledVector(up, -camForwardTangent.dot(up));
      if (camForwardTangent.lengthSq() < 1e-8) camForwardTangent.copy(monarch.facing);
      camForwardTangent.normalize();
      camRightTangent.crossVectors(camForwardTangent, up).normalize();

      const forwardBack = (forwardKey && pressed.has(forwardKey) ? 1 : 0)
        - (backwardKey && pressed.has(backwardKey) ? 1 : 0);
      const rightLeft = (rightKey && pressed.has(rightKey) ? 1 : 0)
        - (leftKey && pressed.has(leftKey) ? 1 : 0);

      if (forwardBack !== 0 || rightLeft !== 0) {
        drivingInput = true;
        monarch.orderPos = null;       // taking the wheel cancels any standing order
        monarch.orderAttackId = null;
        drive.copy(camForwardTangent).multiplyScalar(forwardBack)
          .addScaledVector(camRightTangent, rightLeft)
          .normalize();
        step.copy(drive).multiplyScalar(MOVE_SPEED * monarch.combat.moveMultiplier * delta);
        candidateDir.copy(monarch.position).add(step).normalize();
        const tileId = nearestTileId(candidateDir, world);
        if (isPassable(biomes[tileId], monarch.movement)) {
          const radius = tileTopRadius(biomes[tileId]);
          monarch.position.copy(candidateDir).multiplyScalar(radius);
          up.copy(candidateDir);
          monarch.facing.copy(drive);
          tangentize(monarch.facing, up);
        }
      }
    }

    // Held zoom keys (only if the player bound plain keys to zoom; the default
    // zoom bindings are the wheel, handled in onWheel).
    const zoomInKey = plainKeyToken(bindings.cameraZoomIn);
    const zoomOutKey = plainKeyToken(bindings.cameraZoomOut);
    const zoomDir = (zoomOutKey && pressed.has(zoomOutKey) ? 1 : 0)
      - (zoomInKey && pressed.has(zoomInKey) ? 1 : 0);
    if (zoomDir !== 0) {
      zoom.current = THREE.MathUtils.clamp(
        zoom.current * Math.exp(zoomDir * ZOOM_KEY_SPEED * delta), ZOOM_MIN, ZOOM_MAX,
      );
    }

    // 2) Each army's current leader (whom its units follow): the piloted monarch if
    //    it belongs to that army, else the standing King, else the standing Queen.
    const leaderByArmy = new Map<string, LiveUnit>();
    for (const [armyId, king] of kingByArmy) {
      const queen = queenByArmy.get(armyId);
      const leader = (!king.dead && !king.downed) ? king
        : (queen && !queen.dead && !queen.downed) ? queen : null;
      if (leader) leaderByArmy.set(armyId, leader);
    }
    if (monarch) leaderByArmy.set(monarch.armyId, monarch);

    // 3) Resolve each living unit's engage target under its combat posture: the best
    //    enemy within the stance's detection radius ranked by the unit's target
    //    priority. A weapons-tight (fire 'hold') or non-engaging (flee) unit acquires
    //    nothing and simply stays with its army.
    for (const unit of liveUnits) {
      // A shelled turtle can't fight, a swarming bee / abducting owl is committed to
      // its dive, a frog mid-grab fights through its tongue, and a carried unit is
      // helpless — none of them acquire a normal engagement target.
      const busyWithAbility = unit.shelled || unit.swarmTargetId !== null
        || unit.tongue !== null || unit.pickup !== null || unit.carriedByOwlId !== null;
      unit.target = (unit.dead || busyWithAbility)
        ? null
        : selectTargetForBehavior(unit, liveUnits, unit.behavior, unit.posture);
    }

    // 4) Aura pass (Queen heal + King damage), mirroring Quick Play. Computed once
    //    here so combat (the King buff) and the visuals (auraActive) agree. A downed
    //    or dead monarch projects nothing.
    const buffed = kingBuffed.current; buffed.clear();
    const healed = queenHealed.current; healed.clear();
    const livingKings: LiveUnit[] = [];
    const livingQueens: LiveUnit[] = [];
    for (const king of kingByArmy.values()) if (!king.dead && !king.downed) livingKings.push(king);
    for (const queen of queenByArmy.values()) if (!queen.dead && !queen.downed) livingQueens.push(queen);

    for (const king of livingKings) {
      king.auraActive = false;
      for (const unit of liveUnits) {
        if (unit.dead || unit.controllerId !== king.controllerId || unit.kind === 'king') continue;
        if (!isWithinAura(king, unit, AURA_RADIUS)) continue;
        buffed.add(unit.id);
        if (elapsedMs - unit.lastCombatMs < RECENT_COMBAT_MS) king.auraActive = true;
      }
    }
    for (const queen of livingQueens) {
      queen.auraActive = false;
      for (const unit of liveUnits) {
        if (unit.dead || unit.controllerId !== queen.controllerId) continue;
        if (!isWithinAura(queen, unit, AURA_RADIUS)) continue;
        if (unit.hp < unit.maxHp) { healed.add(unit.id); queen.auraActive = true; }
      }
    }

    // 5) Movement, governed by each unit's stance. An engaged unit closes on (then
    //    holds at) its target unless its stance forbids advancing (hold-ground) or
    //    pursuit would pull it past its chase leash from the army leader (its anchor)
    //    — keeping defensive/guard units with the army while aggressive units pursue
    //    far. With nothing to chase, a unit trails its leader; the leader itself, idle
    //    and untargeted, holds. Downed monarchs and the actively piloted monarch are
    //    skipped (the latter's drive already ran).
    for (const unit of liveUnits) {
      if (unit.dead || unit.downed) continue;

      // A unit in an Owl's talons is positioned by that Owl (glueCarried), so its
      // own movement and combat are suspended this frame.
      if (unit.carriedByOwlId !== null) continue;

      // Owl Pickup: an abducting owl drives its whole swoop/carry/drop machine in
      // place of normal movement (it owns its catch too).
      if (unit.pickup) { advanceOwlPickup(unit, elapsedMs, delta); continue; }

      // Frog Tongue: a frog mid-grab is pinned while its tongue extends/retracts.
      if (unit.tongue) { advanceFrogTongue(unit, elapsedMs, delta); continue; }

      // Turtle Shell: pulled in, the unit is pinned in place (and ignores knockback).
      if (unit.shelled) continue;

      // Cat Hiss knockback: while shoved, the unit slides along the stored tangent
      // and its normal AI is suppressed (the impulse owns its motion this frame).
      if (unit.knockbackUntilMs > elapsedMs) {
        up.copy(unit.position).normalize();
        tangentize(unit.knockbackDir, up); // keep the shove along the surface as it curves
        step.copy(unit.knockbackDir).multiplyScalar(HISS_PUSH_SPEED * delta);
        candidateDir.copy(unit.position).add(step).normalize();
        const tileId = nearestTileId(candidateDir, world);
        unit.position.copy(candidateDir).multiplyScalar(tileTopRadius(biomes[tileId]));
        unit.facing.copy(unit.knockbackDir);
        tangentize(unit.facing, candidateDir);
        continue;
      }
      unit.knockbackUntilMs = 0;

      // Bee Swarm dive: a committed bee flies straight at its claimed enemy and, on
      // contact, stings once — a coin flip that kills both it and the target or fizzles.
      if (unit.swarmTargetId !== null) {
        const prey = liveUnits.find((candidate) => candidate.id === unit.swarmTargetId);
        if (prey && !prey.dead && !prey.downed) {
          if (unit.position.distanceToSquared(prey.position) <= SWARM_STING_RANGE * SWARM_STING_RANGE) {
            unit.lastAttackMs = elapsedMs;
            unit.lastCombatMs = elapsedMs;
            if (swarmStingKills(Math.random())) {
              prey.hp = 0;
              prey.lastCombatMs = elapsedMs;
              prey.lastAttackerController = unit.controllerId; // credit the would-be conqueror
              // The bee dies with the sting — kill it outright so a friendly Queen's
              // heal can't undo the sacrifice before the casualty pass runs.
              unit.hp = 0;
              unit.dead = true;
              if (unit.group) unit.group.visible = false;
              if (unit.ring) unit.ring.visible = false;
            }
            unit.swarmTargetId = null;
          } else {
            moveToward(unit, prey.position, SWARM_DIVE_SPEED, 0, delta);
          }
          continue;
        }
        unit.swarmTargetId = null; // target gone — break off and resume normal AI below
      }

      if (unit === monarch && drivingInput) continue;

      // Player orders (increment 4) take precedence over auto-follow. An attack order
      // forces the unit to close on and engage the ordered enemy; a move order sends
      // it to the destination while still auto-engaging threats it passes (per stance),
      // and clears once it arrives so the unit resumes following its army.
      if (unit.orderAttackId !== null) {
        const ordered = liveUnits.find((candidate) => candidate.id === unit.orderAttackId) ?? null;
        if (!ordered || ordered.dead || ordered.downed) {
          unit.orderAttackId = null;
        } else {
          unit.target = ordered; // override stance acquisition: strike what the player picked
          const moved = moveToward(unit, ordered.position, CHASE_SPEED, unit.combat.attackRange, delta);
          if (!moved) {
            up.copy(unit.position).normalize();
            unit.facing.subVectors(ordered.position, unit.position);
            tangentize(unit.facing, up);
          }
          continue;
        }
      }
      if (unit.orderPos !== null) {
        const enRouteTarget = unit.target;
        const chasingSq = unit.posture.chaseRadius * unit.posture.chaseRadius;
        if (enRouteTarget && unit.posture.movesToEngage
          && unit.position.distanceToSquared(enRouteTarget.position) <= chasingSq) {
          moveToward(unit, enRouteTarget.position, CHASE_SPEED, unit.combat.attackRange, delta);
        } else if (!moveToward(unit, unit.orderPos, MOVE_SPEED, FOLLOW_GAP, delta)) {
          unit.orderPos = null; // arrived — resume following the army
        }
        continue;
      }

      const leader = leaderByArmy.get(unit.armyId);
      const target = unit.target;

      if (target) {
        // Hold-ground: face and strike only what is already in range, never advance.
        if (!unit.posture.movesToEngage) {
          up.copy(unit.position).normalize();
          unit.facing.subVectors(target.position, unit.position);
          tangentize(unit.facing, up);
          continue;
        }
        // Leash chasers to their anchor (the army leader): an aggressive unit's wide
        // chase radius lets it pursue, a defensive unit's tight one pulls it home.
        const beyondLeash = !!leader && leader !== unit
          && leader.position.distanceToSquared(unit.position) > unit.posture.chaseRadius * unit.posture.chaseRadius;
        if (!beyondLeash) {
          const moved = moveToward(unit, target.position, CHASE_SPEED, unit.combat.attackRange, delta);
          if (!moved) {
            up.copy(unit.position).normalize();
            unit.facing.subVectors(target.position, unit.position);
            tangentize(unit.facing, up);
          }
          continue;
        }
        // Beyond the leash: abandon pursuit this frame and return to the leader below.
      }

      // A grown unit with a rally point garrisons there (mustering to a Queen-set
      // front) instead of trailing the army; everyone else follows the army leader.
      if (unit.rallyPos) {
        moveToward(unit, unit.rallyPos, FOLLOW_SPEED, FOLLOW_GAP, delta);
      } else if (leader && leader !== unit) {
        moveToward(unit, leader.position, FOLLOW_SPEED, FOLLOW_GAP, delta);
      }
    }

    // 6) Attacks: a unit in range of its target lands a hit on cooldown (doubled in
    //    a friendly King's aura), recording the attacker's controller so a downed
    //    monarch knows who is conquering it. Downed monarchs cannot attack.
    for (const unit of liveUnits) {
      const target = unit.target;
      if (unit.dead || unit.downed || !target || target.dead) continue;
      if (target.shelled) continue; // a shelled turtle shrugs off the blow
      if (!isWithinAttackRange(unit, target, unit.combat.attackRange)) continue;
      if (!isAttackReady(unit.lastAttackMs, unit.combat.attackCooldownMs, elapsedMs)) continue;
      unit.lastAttackMs = elapsedMs;
      unit.lastCombatMs = elapsedMs;
      target.hp -= kingBuffedDamage(unit.combat.damage, buffed.has(unit.id));
      target.lastCombatMs = elapsedMs;
      target.lastAttackerController = unit.controllerId;
    }

    // 7) Healing: the Queen's aura (even mid-fight) plus passive out-of-combat
    //    regen. A monarch healed back above 0 HP rises from being downed.
    for (const unit of liveUnits) {
      if (unit.dead || unit.hp >= unit.maxHp) continue;
      let healAmount = healed.has(unit.id) ? queenHealAmount(unit.maxHp, delta) : 0;
      healAmount += regenAmount(unit.maxHp, unit.lastCombatMs, elapsedMs, delta);
      if (healAmount > 0) {
        unit.hp = Math.min(unit.maxHp, unit.hp + healAmount);
        if (unit.downed && unit.hp > 0) unit.downed = false;
      }
    }

    // 7.5) Advance in-flight Chicken eggs: each curves along its great circle, and
    //      the first enemy it grazes takes its damage and pops it; an egg that flies
    //      its full range without a hit simply expires.
    const eggList = eggs.current;
    for (let i = eggList.length - 1; i >= 0; i--) {
      const egg = eggList[i];
      const stepLength = EGG_SPEED * delta;
      const advanced = stepGreatCircle(egg.position, egg.direction, stepLength);
      egg.position.copy(advanced.position);
      egg.direction.copy(advanced.direction);
      egg.traveled += stepLength;
      const hit = eggHitTarget(egg.position, egg.controllerId, liveUnits, EGG_HIT_RADIUS);
      if (hit) {
        hit.hp -= egg.damage;
        hit.lastCombatMs = elapsedMs;
        hit.lastAttackerController = egg.controllerId;
        eggList.splice(i, 1);
        continue;
      }
      if (egg.traveled >= EGG_MAX_RANGE) eggList.splice(i, 1);
    }

    // 8) Resolve casualties + capture. A fallen Unit is removed. A monarch at 0 HP
    //    is downed (not killed); when BOTH an army's King and Queen are downed the
    //    army is CAPTURED — its survivors and the revived monarchs switch to the
    //    conqueror's control (the core Conquest mechanic).
    for (const unit of liveUnits) {
      if (unit.dead || unit.downed || unit.hp > 0) continue;
      if (!unit.isMonarch) {
        unit.dead = true;
        if (unit.group) unit.group.visible = false;
        if (unit.ring) unit.ring.visible = false;
        continue;
      }
      unit.downed = true;
      unit.hp = 0;
      unit.target = null;
    }
    for (const [armyId, king] of kingByArmy) {
      const queen = queenByArmy.get(armyId);
      if (!queen || !king.downed || !queen.downed) continue;
      const conqueror = king.lastAttackerController ?? queen.lastAttackerController;
      if (!conqueror || conqueror === king.controllerId) continue;
      for (const member of liveUnits) {
        if (member.armyId !== armyId || member.dead) continue;
        member.controllerId = conqueror;
        member.hp = member.maxHp;     // captured units rally to full strength
        member.downed = false;        // King and Queen rise again under new command
        member.lastAttackerController = null;
        member.target = null;
        member.orderPos = null;       // an army changing hands drops its old orders
        member.orderAttackId = null;
        member.rallyPos = null;       // and grown units stop garrisoning the old front
        selectedIds.current.delete(member.id);
      }
      queenRallies.current.delete(queen.id); // the captured Queen's rally is void
      conquest.conquerArmy(armyId, conqueror, elapsedMs);
    }

    // 8.5) Occupation claiming (increment 5): a living unit standing on a farmable
    //      (grassland) tile flips that tile to its controller — the farmland a Queen
    //      grows on. Throttled (a unit rarely crosses onto new farmland between scans)
    //      and batched into one store update, so it never thrashes the HUD's re-render.
    if (elapsedMs - lastClaimScanMs.current >= CLAIM_SCAN_INTERVAL_MS) {
      lastClaimScanMs.current = elapsedMs;
      const owners = conquest.tileOwners;
      const claims: Record<number, string> = {};
      for (const unit of liveUnits) {
        if (unit.dead || unit.downed || unit.carriedByOwlId !== null) continue;
        up.copy(unit.position).normalize();
        const tileId = nearestTileId(up, world);
        unit.currentTileId = tileId;
        if (!isFarmableTile(biomes[tileId])) continue;
        if (owners[tileId] === unit.controllerId) continue;
        claims[tileId] = unit.controllerId; // a contested tile goes to the last unit scanned
      }
      if (Object.keys(claims).length > 0) conquest.claimTiles(claims);
    }

    // 8.6) Queen unit growth (increment 5): tally each controller's living units, then
    //      let every standing Queen grow one unit on her interval while her controller
    //      is under its territory-derived population cap (two per owned farmable tile).
    //      A grown unit musters by the Queen and either joins the army or marches to her
    //      rally point. Counting includes units queued earlier this frame so two Queens
    //      of one nation can't both overshoot the shared cap.
    const controllerCounts = new Map<string, number>();
    for (const unit of liveUnits) {
      if (unit.dead) continue;
      controllerCounts.set(unit.controllerId, (controllerCounts.get(unit.controllerId) ?? 0) + 1);
    }
    const grownUnits: LiveUnit[] = [];
    const owners = conquest.tileOwners;
    for (const queen of queenByArmy.values()) {
      if (queen.dead || queen.downed) continue;
      if (elapsedMs - queen.lastGrowthMs < QUEEN_GROWTH_INTERVAL_MS) continue;
      const controller = queen.controllerId;
      const cap = populationCap(countOwnedFarmTiles(owners, biomes, controller));
      const current = controllerCounts.get(controller) ?? 0;
      if (!canGrowUnit(current, cap)) continue;
      queen.lastGrowthMs = elapsedMs;
      controllerCounts.set(controller, current + 1);

      // Muster a fraction of a tile from the Queen, spread by a golden-angle step so
      // successive recruits fan out rather than stack; fall back to her own tile if the
      // chosen spot is impassable for the army's animal.
      up.copy(queen.position).normalize();
      const reference = Math.abs(up.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      scratch.current.right.crossVectors(up, reference).normalize();
      scratch.current.forward.crossVectors(up, scratch.current.right).normalize();
      const angle = spawnCounter.current * 2.39996323; // golden angle (radians)
      candidateDir.copy(queen.position)
        .addScaledVector(scratch.current.right, Math.cos(angle) * SPAWN_TANGENT_OFFSET)
        .addScaledVector(scratch.current.forward, Math.sin(angle) * SPAWN_TANGENT_OFFSET)
        .normalize();
      const spawnTileId = nearestTileId(candidateDir, world);
      const position = isPassable(biomes[spawnTileId], queen.movement)
        ? candidateDir.clone().multiplyScalar(tileTopRadius(biomes[spawnTileId]))
        : queen.position.clone();

      const recruit = buildLiveUnit({
        id: `${queen.armyId}-s${++spawnCounter.current}`,
        armyId: queen.armyId,
        controllerId: controller,
        animal: queen.animal,
        kind: 'unit',
        isMonarch: false,
        position,
        facing: queen.facing.clone(),
        poseVariants: posesByAnimal.get(queen.animal) ?? [],
      });
      const rally = queenRallies.current.get(queen.id);
      recruit.rallyPos = rally ? rally.clone() : null;
      grownUnits.push(recruit);
    }
    if (grownUnits.length > 0) setSpawnedUnits((prev) => [...prev, ...grownUnits]);

    // 8.7) Publish each controller's live unit count for the HUD (throttled), so the
    //      population readout reflects growth, losses, and captures without per-frame
    //      store writes.
    if (elapsedMs - lastPopulationPublishMs.current >= POPULATION_PUBLISH_INTERVAL_MS) {
      lastPopulationPublishMs.current = elapsedMs;
      const published: Record<string, number> = {};
      controllerCounts.forEach((count, controller) => { published[controller] = count; });
      const previous = conquest.controlledUnitCounts;
      let changed = Object.keys(published).length !== Object.keys(previous).length;
      if (!changed) {
        for (const key in published) {
          if (published[key] !== previous[key]) { changed = true; break; }
        }
      }
      if (changed) conquest.setControlledUnitCounts(published);
    }

    // 9) Push every living unit's transform + animation pose + allegiance ring, and
    //    each monarch's aura disc.
    const auraPulse = (Math.sin(elapsedMs * 0.001 * AURA_PULSE_HZ * Math.PI * 2) + 1) * 0.5;
    for (const unit of liveUnits) {
      if (unit.dead || !unit.group) continue;

      // Movement detection drives the walk/idle pose split (with a short hold so
      // the walk cycle bridges momentary stops). Downed monarchs read as idle.
      if (unit.position.distanceToSquared(unit.lastPosition) > MOVE_EPSILON_SQ) {
        unit.lastMovedMs = elapsedMs;
      }
      unit.lastPosition.copy(unit.position);
      const isMoving = !unit.downed && elapsedMs - unit.lastMovedMs < MOVE_HOLD_MS;

      let activePose = selectPoseIndex(unit.animal, isMoving, elapsedMs);
      // Ability poses override the walk/idle cycle: a shelled Turtle holds its shell
      // frame (F0); a hissing Cat flashes the Kitty_F2 hiss frame for the pose window.
      if (unit.shelled && unit.animal === 'Turtle') activePose = 0;
      else if (unit.animal === 'Cat' && unit.hissUntilMs > elapsedMs) {
        activePose = Math.min(2, unit.poseGroups.length - 1);
      }
      // A chicken mid-throw and a frog mid-grab hold their action pose.
      else if (unit.animal === 'Chicken' && unit.eggThrowUntilMs > elapsedMs) {
        activePose = unit.poseGroups.length - 1;
      } else if (unit.animal === 'Frog' && unit.tongue) {
        activePose = Math.min(2, unit.poseGroups.length - 1);
      }
      for (let i = 0; i < unit.poseGroups.length; i++) {
        const poseGroup = unit.poseGroups[i];
        if (poseGroup) poseGroup.visible = i === activePose;
      }

      // Stand on the surface (air units hover above it), facing `facing`, up along
      // the surface normal. A flying/abducting owl (or its dangling catch) adds its
      // radial flight lift on top of the baseline hover.
      up.copy(unit.position).normalize();
      renderPos.copy(unit.position).addScaledVector(up, unit.airLift + unit.flightLift);
      scratch.current.right.crossVectors(up, unit.facing).normalize();
      scratch.current.forward.crossVectors(scratch.current.right, up).normalize();
      basis.makeBasis(scratch.current.right, up, scratch.current.forward);
      quat.setFromRotationMatrix(basis);
      unit.group.position.copy(renderPos);
      unit.group.quaternion.copy(quat);

      // Allegiance ring: lie flat on the surface, recolored when the controller
      // changes (so a captured army flips to its new owner's color instantly).
      ringQuat.setFromUnitVectors(RING_FORWARD, up);
      if (unit.ring) {
        unit.ring.position.copy(unit.position).addScaledVector(up, RING_LIFT);
        unit.ring.quaternion.copy(ringQuat);
        const color = colorRef.current.get(unit.controllerId);
        if (color !== undefined && color !== unit.ringColor) {
          (unit.ring.material as THREE.MeshBasicMaterial).color.setHex(color);
          unit.ringColor = color;
        }
      }

      // Selection halo: a bright ring shown only while the unit is selected.
      if (unit.selectionRing) {
        const selected = selectedIds.current.has(unit.id);
        unit.selectionRing.visible = selected;
        if (selected) {
          unit.selectionRing.position.copy(unit.position).addScaledVector(up, SELECTION_RING_LIFT);
          unit.selectionRing.quaternion.copy(ringQuat);
        }
      }

      // Monarch aura disc: pulse brighter while actively helping; hide while downed.
      if (unit.auraMesh) {
        const showAura = unit.isMonarch && !unit.downed;
        unit.auraMesh.visible = showAura;
        if (showAura) {
          unit.auraMesh.position.copy(unit.position).addScaledVector(up, AURA_LIFT);
          unit.auraMesh.quaternion.copy(ringQuat);
          const material = unit.auraMesh.material as THREE.MeshBasicMaterial;
          material.opacity = unit.auraActive
            ? AURA_OPACITY_IDLE + (AURA_OPACITY_ACTIVE - AURA_OPACITY_IDLE) * auraPulse
            : AURA_OPACITY_IDLE;
        }
      }

      // Frog tongue beam: a thin cylinder from the frog's mouth to the live tip,
      // stretched along its length. Hidden whenever no tongue is out.
      if (unit.tongueMesh) {
        const tongue = unit.tongue;
        if (tongue && tongue.length > 1e-4) {
          const { beamTip, beamMid, beamVec, beamQuat } = scratch.current;
          beamTip.copy(stepGreatCircle(unit.position, tongue.direction, tongue.length).position);
          renderPos.copy(unit.position).addScaledVector(up, TONGUE_LIFT); // mouth point
          beamTip.addScaledVector(up, TONGUE_LIFT);
          beamVec.subVectors(beamTip, renderPos);
          const beamLength = beamVec.length();
          if (beamLength > 1e-5) {
            beamMid.copy(renderPos).addScaledVector(beamVec, 0.5);
            beamQuat.setFromUnitVectors(BEAM_UP, beamVec.normalize());
            unit.tongueMesh.visible = true;
            unit.tongueMesh.position.copy(beamMid);
            unit.tongueMesh.quaternion.copy(beamQuat);
            unit.tongueMesh.scale.set(TONGUE_WIDTH, beamLength, TONGUE_WIDTH);
          } else {
            unit.tongueMesh.visible = false;
          }
        } else {
          unit.tongueMesh.visible = false;
        }
      }
    }

    // Draw the in-flight eggs from the pool (extra eggs beyond the pool go undrawn).
    const eggMeshList = eggMeshes.current;
    for (let i = 0; i < EGG_POOL_SIZE; i++) {
      const mesh = eggMeshList[i];
      if (!mesh) continue;
      const egg = eggList[i];
      if (egg) {
        mesh.visible = true;
        mesh.position.copy(egg.position);
      } else if (mesh.visible) {
        mesh.visible = false;
      }
    }

    // 9.5) Queen rally markers (increment 5): a team-colored ring on the tile where a
    //      Queen's grown units muster, shown only while she has set a rally point.
    for (const queen of queenByArmy.values()) {
      if (!queen.rallyMesh) continue;
      const rally = queenRallies.current.get(queen.id);
      const show = !!rally && !queen.dead;
      queen.rallyMesh.visible = show;
      if (show && rally) {
        up.copy(rally).normalize();
        ringQuat.setFromUnitVectors(RING_FORWARD, up);
        queen.rallyMesh.position.copy(rally).addScaledVector(up, RING_LIFT);
        queen.rallyMesh.quaternion.copy(ringQuat);
        const color = colorRef.current.get(queen.controllerId);
        if (color !== undefined) {
          (queen.rallyMesh.material as THREE.MeshBasicMaterial).color.setHex(color);
        }
      }
    }

    // 10) Third-person chase camera, locked onto the piloted monarch. Camera
    //     distance is proportional to the monarch's size so small animals fill the
    //     frame. With no controllable monarch (defeat), the camera simply holds.
    if (monarch) {
      up.copy(monarch.position).normalize();
      const backDistance = monarch.scale * CAM_BACK_FACTOR * zoom.current;
      const heightDistance = monarch.scale * CAM_HEIGHT_FACTOR * zoom.current;
      camBack.copy(monarch.facing).multiplyScalar(-backDistance);
      camDesired.copy(monarch.position)
        .add(camBack)
        .addScaledVector(up, heightDistance);

      if (!cameraInitialized.current) {
        camera.position.copy(camDesired);
        cameraInitialized.current = true;
      } else {
        const t = 1 - Math.exp(-CAM_LERP * delta);
        camera.position.lerp(camDesired, t);
      }
      camera.up.copy(up);
      camera.lookAt(monarch.position);
    }
  });

  return (
    <group>
      {liveUnits.map((unit) => (
        <group
          key={unit.id}
          ref={(element) => { unit.group = element; }}
          scale={unit.scale}
        >
          {/* One child group per pose frame; the sim toggles which is visible so
              swapping poses never re-renders React. */}
          {unit.poseVariants.map((variant, variantIndex) => (
            <group
              key={variant.key}
              ref={(element) => { unit.poseGroups[variantIndex] = element; }}
              visible={variantIndex === 0}
            >
              {variant.parts.map((part, partIndex) => (
                <mesh key={partIndex} geometry={part.geometry} material={part.material} castShadow />
              ))}
            </group>
          ))}
        </group>
      ))}

      {/* Allegiance rings live outside the scaled unit groups so their size stays
          fixed in globe space; the sim positions, orients, and recolors them. */}
      {liveUnits.map((unit) => (
        <mesh
          key={`${unit.id}-ring`}
          ref={(element) => { unit.ring = element; }}
          geometry={ringGeometry}
          scale={unit.isMonarch ? MONARCH_RING_RADIUS : UNIT_RING_RADIUS}
          renderOrder={1}
        >
          <meshBasicMaterial
            color={colorByController.get(unit.controllerId) ?? 0xffffff}
            transparent
            opacity={0.8}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      ))}

      {/* King/Queen aura discs (gold = damage buff, green = heal). */}
      {liveUnits.filter((unit) => unit.isMonarch).map((unit) => (
        <mesh
          key={`${unit.id}-aura`}
          ref={(element) => { unit.auraMesh = element; }}
          geometry={auraGeometry}
          scale={AURA_RADIUS}
          renderOrder={0}
        >
          <meshBasicMaterial
            color={unit.kind === 'king' ? KING_AURA_COLOR : QUEEN_AURA_COLOR}
            transparent
            opacity={AURA_OPACITY_IDLE}
            side={THREE.DoubleSide}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      ))}

      {/* Selection halos (one per unit; the sim shows the selected ones). */}
      {liveUnits.map((unit) => (
        <mesh
          key={`${unit.id}-sel`}
          ref={(element) => { unit.selectionRing = element; }}
          geometry={ringGeometry}
          scale={unit.isMonarch ? MONARCH_SELECTION_RING_RADIUS : SELECTION_RING_RADIUS}
          visible={false}
          renderOrder={2}
        >
          <meshBasicMaterial
            color={SELECTION_RING_COLOR}
            transparent
            opacity={0.9}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      ))}

      {/* Queen rally markers (one per Queen; the sim shows/positions each). */}
      {liveUnits.filter((unit) => unit.kind === 'queen').map((unit) => (
        <mesh
          key={`${unit.id}-rally`}
          ref={(element) => { unit.rallyMesh = element; }}
          geometry={ringGeometry}
          scale={RALLY_MARKER_RADIUS}
          visible={false}
          renderOrder={2}
        >
          <meshBasicMaterial
            color={colorByController.get(unit.controllerId) ?? 0xffffff}
            transparent
            opacity={0.7}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      ))}

      {/* Frog tongue beams (one per frog; the sim stretches/hides each). */}
      {hasFrog && liveUnits.filter((unit) => unit.animal === 'Frog').map((unit) => (
        <mesh
          key={`${unit.id}-tongue`}
          ref={(element) => { unit.tongueMesh = element; }}
          geometry={tongueGeometry}
          visible={false}
          renderOrder={2}
        >
          <meshBasicMaterial color={TONGUE_COLOR} />
        </mesh>
      ))}

      {/* Chicken egg projectile pool (the sim positions/hides each). */}
      {liveUnits.some((unit) => unit.animal === 'Chicken') &&
        Array.from({ length: EGG_POOL_SIZE }, (_, index) => (
          <mesh
            key={`egg-${index}`}
            ref={(element) => { eggMeshes.current[index] = element; }}
            geometry={eggGeometry}
            visible={false}
            renderOrder={2}
          >
            <meshBasicMaterial color={EGG_COLOR} />
          </mesh>
        ))}
    </group>
  );
}
