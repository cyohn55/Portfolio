// The playable Conquest field: units standing on the planet, monarch piloting,
// combat, army capture, and the third-person chase camera.
//
// Single responsibility: take the spawn descriptors from the store, give every
// unit a live position on the sphere, let the player drive their selected monarch
// across the surface, keep each army following its own monarch, resolve combat
// between rival armies, and — the defining Conquest mechanic — transfer a defeated
// army to its conqueror so the player commands more and more of the planet. It
// frames everything with a third-person, slightly top-down camera locked onto the
// piloted monarch (the Conquest analogue of Quick Play's monarch piloting).
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
import type { AnimalId, MovementType } from '../../../game/types';
import { ANIMAL_MOVEMENT_TYPES } from '../../../game/types';
import { ANIMAL_FILE_MAP } from '../../../utils/ModelPreloader';
import { useGameStore } from '../../../game/state';
import { keyboardEventToToken } from '../controlBindings';
import {
  buildTokenDispatch,
  type ActivationMode,
  type TokenGestureConfig,
} from '../gestureModes';
import { useConquestStore, effectiveController } from './conquestState';
import {
  conquestStatsFor,
  selectNearestEnemy,
  isWithinAttackRange,
  isAttackReady,
  regenAmount,
  AGGRO_RANGE,
  CHASE_SPEED,
  type ConquestCombatStats,
} from './conquestCombat';
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
// fraction of a tile across. The piloted monarch is a touch larger so the
// controlled unit stands out.
const UNIT_SCALE = 0.005;
const MONARCH_SCALE = 0.007;

// Team-color allegiance ring drawn flat on the surface under each unit, in globe
// units. The monarch's ring is larger so leaders are easy to pick out, and the
// color tracks the unit's current controller so a captured army visibly flips to
// the conqueror's color the instant it changes hands.
const UNIT_RING_RADIUS = 0.011;
const MONARCH_RING_RADIUS = 0.018;
const RING_LIFT = 0.001; // sit just above the tile face to avoid z-fighting
const RING_FORWARD = new THREE.Vector3(0, 0, 1); // RingGeometry's default normal

// Piloting feel. Speeds are in globe-radius units per second (the planet has
// radius 1, so a full lap at MOVE_SPEED takes ~2π / MOVE_SPEED seconds). Tuned
// so crossing one acre-sized tile takes a couple of seconds, not a blink.
const MOVE_SPEED = 0.1;
const FOLLOW_SPEED = 0.12;
const FOLLOW_GAP = 0.012; // followers hold this distance behind the monarch

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
  isMonarch: boolean;
  animal: AnimalId;
  movement: MovementType;
  combat: ConquestCombatStats;
  hp: number;
  maxHp: number;
  lastAttackMs: number;
  lastCombatMs: number;
  /** Controller of the unit that most recently damaged this one (the would-be conqueror). */
  lastAttackerController: string | null;
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

  // One shared ring geometry (unit-radius disc); each unit scales it and tints its
  // own material instance. Disposed when the field unmounts to free the GPU buffer.
  const ringGeometry = useMemo(() => new THREE.RingGeometry(0.6, 1.0, 24), []);
  useEffect(() => () => ringGeometry.dispose(), [ringGeometry]);

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
      const combat = conquestStatsFor(spawn.animal);
      return {
        id: spawn.id,
        armyId: spawn.ownerId,
        controllerId: spawn.ownerId,
        isMonarch: spawn.isMonarch,
        animal: spawn.animal,
        movement: ANIMAL_MOVEMENT_TYPES[spawn.animal],
        combat,
        hp: combat.maxHp,
        maxHp: combat.maxHp,
        lastAttackMs: 0,
        lastCombatMs: 0,
        lastAttackerController: null,
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
      };
    });
  }, [world, biomes, unitSpawns, gltfs, inPlayAnimals]);

  // Each army's monarch, looked up by army id. Monarchs persist for the match
  // (capture changes their controller, never removes them), so this is stable.
  const monarchByArmy = useMemo(() => {
    const map = new Map<string, LiveUnit>();
    liveUnits.forEach((unit) => { if (unit.isMonarch) map.set(unit.armyId, unit); });
    return map;
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
    // In Conquest there is no King/Queen split, so both the "cycle" and "toggle"
    // pilot bindings simply switch which controlled monarch (army) is piloted —
    // the natural analogue that keeps each Quick Play key doing something useful.
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
    const travel = Math.min(speed * delta, distance - stopDistance);
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
    //    combat and ring color below reflect any army that changed hands.
    for (const unit of liveUnits) {
      unit.controllerId = effectiveController(armyController, unit.armyId);
    }

    const monarch = liveUnits.find((unit) => unit.id === monarchId && !unit.dead) ?? null;

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
    //    constrained to passable tiles. When the player gives no input the monarch
    //    is handled by the combat/idle pass below (so it auto-defends).
    let drivingInput = false;
    if (monarch) {
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
        step.copy(drive).multiplyScalar(MOVE_SPEED * delta);
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

    // 2) Resolve each living unit's engage target (nearest enemy within aggro).
    for (const unit of liveUnits) {
      unit.target = unit.dead ? null : selectNearestEnemy(unit, liveUnits, AGGRO_RANGE);
    }

    // 3) Movement: engaged units close on (then hold at) their target; idle
    //    monarchs hold position; followers trail their own army's monarch. The
    //    actively piloted monarch is skipped here — its input drive already ran.
    for (const unit of liveUnits) {
      if (unit.dead) continue;
      if (unit === monarch && drivingInput) continue;

      if (unit.target) {
        const moved = moveToward(unit, unit.target.position, CHASE_SPEED, unit.combat.attackRange, delta);
        if (!moved) {
          up.copy(unit.position).normalize();
          unit.facing.subVectors(unit.target.position, unit.position);
          tangentize(unit.facing, up);
        }
      } else if (!unit.isMonarch) {
        const armyMonarch = monarchByArmy.get(unit.armyId);
        if (armyMonarch && !armyMonarch.dead) {
          moveToward(unit, armyMonarch.position, FOLLOW_SPEED, FOLLOW_GAP, delta);
        }
      }
      // Idle monarchs (no target, not driven) simply hold their position.
    }

    // 4) Attacks: a unit in range of its target lands a hit on cooldown, recording
    //    the attacker's controller so a slain monarch knows who conquered it.
    for (const unit of liveUnits) {
      const target = unit.target;
      if (unit.dead || !target || target.dead) continue;
      if (!isWithinAttackRange(unit, target, unit.combat.attackRange)) continue;
      if (!isAttackReady(unit.lastAttackMs, unit.combat.attackCooldownMs, elapsedMs)) continue;
      unit.lastAttackMs = elapsedMs;
      unit.lastCombatMs = elapsedMs;
      target.hp -= unit.combat.damage;
      target.lastCombatMs = elapsedMs;
      target.lastAttackerController = unit.controllerId;
    }

    // 5) Out-of-combat regeneration keeps lulls from being permanently crippling.
    for (const unit of liveUnits) {
      if (unit.dead || unit.hp >= unit.maxHp) continue;
      const heal = regenAmount(unit.maxHp, unit.lastCombatMs, elapsedMs, delta);
      if (heal > 0) unit.hp = Math.min(unit.maxHp, unit.hp + heal);
    }

    // 6) Resolve casualties. A fallen follower is removed; a fallen monarch means
    //    the whole army is CAPTURED — its survivors and the revived monarch switch
    //    to the conqueror's control (the core Conquest mechanic).
    for (const unit of liveUnits) {
      if (unit.dead || unit.hp > 0) continue;
      if (!unit.isMonarch) {
        unit.dead = true;
        if (unit.group) unit.group.visible = false;
        if (unit.ring) unit.ring.visible = false;
        continue;
      }
      const conqueror = unit.lastAttackerController;
      if (!conqueror || conqueror === unit.controllerId) {
        unit.hp = unit.maxHp; // anomaly: no valid captor — recover rather than die
        continue;
      }
      const armyId = unit.armyId;
      for (const member of liveUnits) {
        if (member.armyId !== armyId || member.dead) continue;
        member.controllerId = conqueror;
        member.hp = member.maxHp; // captured units rally to full strength
        member.lastAttackerController = null;
        member.target = null;
      }
      conquest.conquerArmy(armyId, conqueror, elapsedMs);
    }

    // 7) Push every living unit's transform + animation pose + allegiance ring.
    for (const unit of liveUnits) {
      if (unit.dead || !unit.group) continue;

      // Movement detection drives the walk/idle pose split (with a short hold so
      // the walk cycle bridges momentary stops).
      if (unit.position.distanceToSquared(unit.lastPosition) > MOVE_EPSILON_SQ) {
        unit.lastMovedMs = elapsedMs;
      }
      unit.lastPosition.copy(unit.position);
      const isMoving = elapsedMs - unit.lastMovedMs < MOVE_HOLD_MS;

      const activePose = selectPoseIndex(unit.animal, isMoving, elapsedMs);
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
      if (unit.ring) {
        unit.ring.position.copy(unit.position).addScaledVector(up, RING_LIFT);
        ringQuat.setFromUnitVectors(RING_FORWARD, up);
        unit.ring.quaternion.copy(ringQuat);
        const color = colorRef.current.get(unit.controllerId);
        if (color !== undefined && color !== unit.ringColor) {
          (unit.ring.material as THREE.MeshBasicMaterial).color.setHex(color);
          unit.ringColor = color;
        }
      }
    }

    // 8) Third-person chase camera, locked onto the piloted monarch. Camera
    //    distance is proportional to the monarch's size so small animals fill the
    //    frame. With no controlled monarch (defeat), the camera simply holds.
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
    </group>
  );
}
