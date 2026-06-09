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

import { useEffect, useMemo, useRef } from 'react';
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
  isWithinAttackRange,
  isAttackReady,
  regenAmount,
  kingBuffedDamage,
  queenHealAmount,
  isWithinAura,
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
  HISS_RANGE,
  HISS_PUSH_SPEED,
  HISS_PUSH_MS,
  HISS_POSE_MS,
  HISS_COOLDOWN_MS,
  SHELL_RETRIGGER_MS,
  SWARM_DIVE_SPEED,
  SWARM_STING_RANGE,
} from './conquestAbilities';
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
  useEffect(() => () => { ringGeometry.dispose(); auraGeometry.dispose(); }, [ringGeometry, auraGeometry]);

  // Build the live (mutable) unit set once per match. Positions/facings/HP here are
  // mutated every frame by the sim; React never re-renders for movement or combat.
  // Note this deliberately does NOT depend on army control — capturing an army
  // mutates `controllerId` in place, so the field never rebuilds and loses state.
  const liveUnits = useMemo<LiveUnit[]>(() => {
    if (!world || biomes.length === 0) return [];
    const posesByAnimal = new Map<AnimalId, PoseVariant[]>();
    inPlayAnimals.forEach((animal, index) => {
      const gltf = gltfs[index];
      if (gltf) posesByAnimal.set(animal, buildPoseVariants(animal, gltf));
    });

    return unitSpawns.map((spawn) => {
      const position = new THREE.Vector3(spawn.position.x, spawn.position.y, spawn.position.z);
      const up = position.clone().normalize();
      // Seed facing as an arbitrary tangent; piloting/following/combat overwrite it.
      const facing = new THREE.Vector3().crossVectors(
        up, Math.abs(up.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0),
      ).normalize();
      const poseVariants = posesByAnimal.get(spawn.animal) ?? [];
      const scale = spawn.isMonarch ? MONARCH_SCALE : UNIT_SCALE;
      const combat = conquestStatsFor(spawn.animal, spawn.kind);
      const behavior = defaultBehaviorFor(spawn.animal, spawn.kind);
      return {
        id: spawn.id,
        armyId: spawn.ownerId,
        controllerId: spawn.ownerId,
        kind: spawn.kind,
        isMonarch: spawn.isMonarch,
        animal: spawn.animal,
        movement: ANIMAL_MOVEMENT_TYPES[spawn.animal],
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
        dead: false,
        target: null,
        poseVariants,
        poseGroups: new Array(poseVariants.length).fill(null),
        scale,
        airLift: airLiftFactor(spawn.animal) * scale,
        position,
        facing,
        lastPosition: position.clone(),
        lastMovedMs: 0,
        group: null,
        ring: null,
        ringColor: -1,
        auraMesh: null,
      };
    });
  }, [world, biomes, unitSpawns, gltfs, inPlayAnimals]);

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

  // --- Input: pressed keys + zoom, tracked in refs (no per-key re-render). ---
  const keys = useRef<Set<string>>(new Set());
  const zoom = useRef(1.0);
  const cameraInitialized = useRef(false);

  useEffect(() => {
    cameraInitialized.current = false; // re-frame on a new match
  }, [liveUnits]);

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

  // Ability trigger: both mouse buttons pressed together fire the piloted army's
  // per-animal special, mirroring Quick Play's simultaneous primary+secondary
  // press. Recorded here as an edge (one fire per both-down transition); the
  // per-frame loop consumes the flag and dispatches it against the live army.
  const abilityRequested = useRef(false);
  useEffect(() => {
    const canvas = gl.domElement;
    let leftDown = false;
    let rightDown = false;
    const onMouseDown = (event: MouseEvent) => {
      if (event.button === 0) leftDown = true;
      else if (event.button === 2) rightDown = true;
      if (leftDown && rightDown) abilityRequested.current = true;
    };
    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 0) leftDown = false;
      else if (event.button === 2) rightDown = false;
    };
    // The right-button press is an ability input here, not a context menu.
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    const onBlur = () => { leftDown = false; rightDown = false; };

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('blur', onBlur);
    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('blur', onBlur);
    };
  }, [gl]);

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
  // dive. The projectile / beam / carry abilities (eggs, tongue, pickup) are wired
  // in the next increment; an unsupported animal simply does nothing here.
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
      // A shelled turtle can't fight, and a swarming bee is committed to its dive,
      // so neither acquires a normal engagement target.
      unit.target = (unit.dead || unit.shelled || unit.swarmTargetId !== null)
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

      if (leader && leader !== unit) {
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
      }
      conquest.conquerArmy(armyId, conqueror, elapsedMs);
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
      for (let i = 0; i < unit.poseGroups.length; i++) {
        const poseGroup = unit.poseGroups[i];
        if (poseGroup) poseGroup.visible = i === activePose;
      }

      // Stand on the surface (air units hover above it), facing `facing`, up along
      // the surface normal.
      up.copy(unit.position).normalize();
      renderPos.copy(unit.position).addScaledVector(up, unit.airLift);
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
    </group>
  );
}
