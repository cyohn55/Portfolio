import { Suspense, useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { shallow } from 'zustand/shallow';
import { useGameStore } from '../game/state';
import type { AnimalId, Unit } from '../game/types';
import {
  ALL_ANIMAL_PATHS,
  ANIMAL_FILE_MAP,
  OWL_WING_MODELS,
  TURTLE_FRAME_COUNT,
  FOX_FRAME_COUNT,
  YETI_FRAME_COUNT,
  CAT_FRAME_COUNT,
  BEE_FRAME_COUNT,
  FROG_FRAME_COUNT,
  FROG_WINDUP_FRAME,
  FROG_STRIKE_FRAME,
  FROG_TONGUE_VARIANT_KEY,
  CHICKEN_FRAME_COUNT,
  CHICKEN_THROW_FRAME,
  EGG_PROJECTILE_VARIANT_KEY,
  baseVariantKey,
  owlWingVariantKey,
  turtleFrameVariantKey,
  foxFrameVariantKey,
  yetiFrameVariantKey,
  catFrameVariantKey,
  beeFrameVariantKey,
  frogFrameVariantKey,
  chickenFrameVariantKey,
  getKindTargetScale,
  getBakedAnimalParts,
  getBakedOwlWingParts,
  getBakedTurtleFrameParts,
  getBakedFoxFrameParts,
  getBakedYetiFrameParts,
  getBakedCatFrameParts,
  getBakedBeeFrameParts,
  getBakedFrogFrameParts,
  getBakedFrogTongueParts,
  getFrogTongueAnchors,
  getBakedChickenFrameParts,
  getBakedEggProjectileParts,
  getBakedRoyalAccessoryParts,
  getBakedOwlWingRoyalAccessoryParts,
  hasRoyalAccessories,
  royalAccessoryNodeFor,
  royalAccessoryVariantKey,
  owlWingRoyalAccessoryVariantKey,
  ROYAL_ACCESSORY_NODE_NAMES,
  ROYAL_ACCESSORY_CAPACITY,
  type BakedPart,
  type FrogTongueAnchors,
} from '../utils/ModelPreloader';
import * as THREE from 'three';

// Maximum instances drawn for a single animal variant. Sized to comfortably
// hold hundreds of units per team even if they all share one animal.
const MAX_INSTANCES_PER_VARIANT = 1200;
// Owner/selection rings are not per-variant, so they need room for every unit.
const RING_CAPACITY = 4096;
// Units beyond this distance from the camera are skipped (distance LOD).
const MAX_RENDER_DISTANCE = 400;

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
// Reusable scratch for the frog tongue beam (no per-frame alloc): the world-space
// mouth point and aim axis derived from the model's Tongue_Origin / Tongue_Tip
// markers, plus the yaw quaternion that rotates those model-space offsets into the
// frog's current facing.
const tongueMouth = new THREE.Vector3();
const tongueAxis = new THREE.Vector3();
const tongueYaw = new THREE.Quaternion();
const FLAT_ROTATION = -Math.PI / 2;

const isMobileDevice = (): boolean =>
  typeof window !== 'undefined' && (window.innerWidth <= 768 || 'ontouchstart' in window);

// Flat (ground-plane) ring geometries, rotated once at module load so each
// instance matrix only needs a translation.
const ownerRingGeometry = new THREE.RingGeometry(0.7, 1.0, 16);
ownerRingGeometry.rotateX(FLAT_ROTATION);
const selectionOuterGeometry = new THREE.RingGeometry(0.9, 1.5, 16);
selectionOuterGeometry.rotateX(FLAT_ROTATION);
const selectionInnerGeometry = new THREE.RingGeometry(1.0, 1.4, 16);
selectionInnerGeometry.rotateX(FLAT_ROTATION);

// Queen/King area-of-effect ring — a flat-lying annulus built at outer radius
// 1 and scaled per instance by each aura's world radius (the ring's thickness
// scales with it, so a bigger aura draws a proportionally thicker outline).
// DoubleSide keeps it visible from below if the camera ever tips under it.
const auraRingGeometry = new THREE.RingGeometry(0.88, 1.0, 96);
auraRingGeometry.rotateX(FLAT_ROTATION);
const AURA_RING_GROUND_LIFT = 0.1;

const NEON_GREEN = '#39ff14';

// Max Queen + King aura sources on the field at once (3 animals x 2 sides x 2 kinds).
const AURA_CAPACITY = 64;

// The aura ring is hidden by default and only drawn while the aura is actively
// working — a Queen healing a below-full-health unit in range, or a King
// buffing a unit in range that is in combat (unit.auraActive).
// transparent:true + depthWrite:false routes it through the transparent queue
// so it draws after all opaque terrain/decals (otherwise terrain rendered
// later in the opaque queue can overpaint it). depthTest stays on so unit
// bodies still occlude it.
const AURA_ACTIVE_MAT = new THREE.MeshStandardMaterial({
  color: NEON_GREEN,
  emissive: NEON_GREEN,
  emissiveIntensity: 3.0,
  toneMapped: false,
  transparent: true,
  opacity: 1.0,
  depthWrite: false,
  side: THREE.DoubleSide,
});

// Per-unit neon-green glow pool, drawn on the ground beneath any friendly unit
// currently standing inside an active aura. Additive blending + pulsing scale
// and opacity (see useFrame) read as a radiant green aura around the unit.
const auraUnitGlowGeometry = new THREE.CircleGeometry(1, 28);
auraUnitGlowGeometry.rotateX(FLAT_ROTATION);
// depthTest stays on so unit bodies properly occlude the glow (it's a ground
// decal, not an overlay). depthWrite off keeps it from competing with other
// coplanar decals in the depth buffer. renderOrder is set on the mesh so the
// selection rings always paint over the glow in the transparent queue.
const AURA_UNIT_GLOW_MAT = new THREE.MeshBasicMaterial({
  color: NEON_GREEN,
  transparent: true,
  opacity: 0.45,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
});
// Base ground radius of a unit's green glow pool (scaled per frame by the pulse).
const AURA_UNIT_GLOW_RADIUS = 1.6;
// Plenty of room for a whole army clustered around a Queen/King.
const AURA_GLOW_CAPACITY = 4096;

// Floating health bars — a dark backing quad with a colored fill quad in front,
// billboarded to face the camera and drawn above each unit/Queen/King whose HP
// is below maximum. The bar persists until the unit heals to full or dies. Two
// instanced meshes keep the whole field's bars to two draw calls.
const HEALTH_BAR_WIDTH = 3.2;
const HEALTH_BAR_HEIGHT = 0.44;
// Bars are only drawn for damaged units, but a large battle can light up most of
// the field at once, so size generously.
const HEALTH_BAR_CAPACITY = 4096;

const healthBarBgGeometry = new THREE.PlaneGeometry(HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT);
// Fill geometry is shifted so its LEFT edge sits at the local origin; scaling x
// by the HP ratio then drains the bar from the right while the left edge stays
// pinned to the backing bar's left edge.
const healthBarFillGeometry = new THREE.PlaneGeometry(HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT);
healthBarFillGeometry.translate(HEALTH_BAR_WIDTH / 2, 0, 0);

// depthTest off + a high render order keeps bars readable on top of the scene.
const HEALTH_BAR_BG_MAT = new THREE.MeshBasicMaterial({
  color: '#000000',
  transparent: true,
  opacity: 0.6,
  side: THREE.DoubleSide,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
});
const HEALTH_BAR_FILL_MAT = new THREE.MeshBasicMaterial({
  color: '#ffffff', // multiplied by per-instance color (see setColorAt)
  transparent: true,
  opacity: 0.95,
  side: THREE.DoubleSide,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
});

// depthWrite off so two adjacent units' owner rings don't z-fight when they
// overlap on the ground plane — they share an exact Y and would otherwise
// flicker against each other. They still depth-test against terrain/units.
const OWN_OWNER_RING_MAT = new THREE.MeshBasicMaterial({ color: '#4169E1', depthWrite: false });
const ENEMY_OWNER_RING_MAT = new THREE.MeshBasicMaterial({ color: '#DC143C', depthWrite: false });
const SELECTION_OUTER_MAT = new THREE.MeshStandardMaterial({
  color: '#000080',
  transparent: true,
  opacity: 0.4,
  emissive: '#000080',
  emissiveIntensity: 2.0,
  toneMapped: false,
  depthWrite: false,
});
const SELECTION_INNER_MAT = new THREE.MeshStandardMaterial({
  color: '#000080',
  transparent: true,
  opacity: 0.8,
  emissive: '#000080',
  emissiveIntensity: 3.0,
  toneMapped: false,
  depthWrite: false,
});

// King/Queen rings are GOLD to mark royalty apart from the blue/red owner rings and
// blue selection rings of regular units. Only the local player's royals are gilded —
// enemy royals keep their red owner ring so friend/foe stays legible at a glance.
// These reuse the unit ring geometries but are drawn into their own instanced meshes,
// scaled per-royal (see royalRingScale) so the ring sits visibly around the larger
// king/queen models instead of being buried beneath them.
const ROYAL_GOLD = '#FFD700';
const ROYAL_OWNER_RING_MAT = new THREE.MeshBasicMaterial({ color: ROYAL_GOLD, depthWrite: false });
const ROYAL_SELECTION_OUTER_MAT = new THREE.MeshStandardMaterial({
  color: ROYAL_GOLD,
  transparent: true,
  opacity: 0.4,
  emissive: ROYAL_GOLD,
  emissiveIntensity: 2.0,
  toneMapped: false,
  depthWrite: false,
});
const ROYAL_SELECTION_INNER_MAT = new THREE.MeshStandardMaterial({
  color: ROYAL_GOLD,
  transparent: true,
  opacity: 0.8,
  emissive: ROYAL_GOLD,
  emissiveIntensity: 3.0,
  toneMapped: false,
  depthWrite: false,
});

// Baseline enlargement of a royal ring over a unit ring, then scaled further by how
// much bigger the royal's model is than its own animal's unit so oversized royals
// (Cat, Yetti, Bear) keep a proportionally sized ring.
const ROYAL_RING_BASE_SCALE = 1.6;
function royalRingScale(unit: Unit): number {
  const unitScale = getKindTargetScale(unit.animal, 'Unit');
  if (unitScale <= 0) return ROYAL_RING_BASE_SCALE;
  return ROYAL_RING_BASE_SCALE * (getKindTargetScale(unit.animal, unit.kind) / unitScale);
}

type VariantSpec = {
  key: string;
  parts: BakedPart[];
  // Max instances for this variant's meshes. Defaults to MAX_INSTANCES_PER_VARIANT;
  // royal accessories use the much smaller ROYAL_ACCESSORY_CAPACITY (only Kings and
  // Queens ever wear one).
  capacity?: number;
};

// Resolve the accessory (crown/tiara) variant a royal unit should wear this frame.
// Mirrors variantKeyForUnit's owl-flying branch so a flying owl's crown is baked
// from — and tracks — the same wing frame as its body. Returns null for non-royal
// units, which never wear an accessory.
function accessoryVariantKeyForUnit(unit: Unit, isOwnUnit: boolean): string | null {
  if (unit.kind !== 'King' && unit.kind !== 'Queen') return null;
  const node = royalAccessoryNodeFor(isOwnUnit, unit.kind);
  if (unit.animal === 'Owl' && unit.isFlying) {
    const wingFrameIndex = Math.floor((unit.wingPhase || 0) * 4) % OWL_WING_MODELS.length;
    return owlWingRoyalAccessoryVariantKey(wingFrameIndex, node);
  }
  return royalAccessoryVariantKey(unit.animal, node);
}

function BaseMarker({ x, y, z }: { x: number; y: number; z: number }) {
  const tileSize = 2; // Fixed size for bases
  return (
    <group position={[x, y + 0.4, z]}>
      <mesh castShadow receiveShadow>
        <cylinderGeometry args={[tileSize * 0.9, tileSize * 0.9, 0.8, 6]} />
        <meshStandardMaterial color="#06d6a0" />
      </mesh>
      <mesh position={[0, 0.45, 0]} castShadow>
        <boxGeometry args={[0.4, 0.4, 0.4]} />
        <meshStandardMaterial color="#15a37a" />
      </mesh>
    </group>
  );
}

// Bases are few (<=6) and effectively static, so they stay as plain meshes.
// A shallow-compared selector keeps this from re-rendering on every game tick.
function Bases() {
  const bases = useGameStore((s) => s.units.filter((u) => u.kind === 'Base'), shallow);
  return (
    <group>
      {bases.map((base) => (
        <BaseMarker key={base.id} x={base.position.x} y={base.position.y} z={base.position.z} />
      ))}
    </group>
  );
}

// Turtle pose timing: while moving, the walk cycle (F1..F5) advances one frame
// every 100ms; idle holds F1; the shell lock shows F0.
const TURTLE_WALK_FRAME_MS = 100;
const TURTLE_WALK_FRAME_COUNT = TURTLE_FRAME_COUNT - 1; // F1..F5
const TURTLE_WALK_FIRST_FRAME = 1; // F1

// Fox pose timing: while moving, the walk cycle (F0, F1, F2) advances one frame
// every 100ms and loops; idle holds F2.
const FOX_WALK_FRAME_MS = 100;
const FOX_IDLE_FRAME = 2; // Fox_F2

// Yeti pose timing: while moving, the walk alternates between F1 and F2 every
// 100ms; idle holds F0.
const YETI_WALK_FRAME_MS = 100;
const YETI_WALK_FIRST_FRAME = 1; // F1
const YETI_WALK_FRAME_COUNT = 2; // alternate F1 <-> F2
const YETI_IDLE_FRAME = 0; // Yeti_F0

// Cat pose timing: while moving, the walk alternates Kitty_F0 <-> F1 every
// 200ms; idle holds Kitty_F0. While attacking (and not moving) it loops the
// Kitty_F2 strike pose for CAT_ATTACK_F2_HOLD_MS, then the Kitty_F1 recoil
// pose for CAT_ATTACK_F1_HOLD_MS before repeating.
const CAT_FRAME_MS = 200;
const CAT_IDLE_FRAME = 0; // Kitty_F0
const CAT_WALK_FRAMES = [0, 1] as const; // Kitty_F0 <-> F1
const CAT_ATTACK_F1_FRAME = 1; // Kitty_F1 (brief recoil)
const CAT_ATTACK_F2_FRAME = 2; // Kitty_F2 (held strike)
const CAT_ATTACK_F2_HOLD_MS = 300; // how long Kitty_F2 strike stays
const CAT_ATTACK_F1_HOLD_MS = 50; // how long Kitty_F1 recoil stays
const CAT_ATTACK_CYCLE_MS = CAT_ATTACK_F2_HOLD_MS + CAT_ATTACK_F1_HOLD_MS;

// Bee pose timing: the bee is always airborne, so it alternates its two
// wing-flap poses (Bee_F0 <-> F1) every 50ms continuously, regardless of
// movement or combat.
const BEE_FLAP_FRAME_MS = 50;
const BEE_FLAP_FRAMES = [0, 1] as const; // Bee_F0 <-> F1

// Bee vertical bob: a gentle sine hover so an idle bee never looks frozen
// mid-air, mirroring the title screen's flyer bob (FLY_BOB_* there).
const BEE_BOB_AMPLITUDE = 1.1; // world units
const BEE_BOB_FREQUENCY = 2.4; // radians / second

// Frog pose timing: while moving, the frog alternates its grounded crouch
// (Frog_F0) and its mid-leap pose (Frog_F1) to read as a hop; idle holds the
// grounded Frog_F0. The swap is driven by the unit's own hopPhase (which the tick
// advances 0->1 per hop and which also drives the vertical bob, peaking at 0.5),
// so the leap pose stays centered on the apex of the arc instead of drifting
// against it on a wall clock.
const FROG_GROUNDED_FRAME = 0; // Frog_F0 (crouch / idle)
const FROG_LEAP_FRAME = 1; // Frog_F1 (mid-leap)
const FROG_LEAP_PHASE_START = 0.25; // hopPhase window where the leap pose shows,
const FROG_LEAP_PHASE_END = 0.75; // centered on the hop apex at phase 0.5

// Tongue beam: cross-section thickness (the baked tongue has a longest edge of 1,
// re-stretched to the live extension along its length axis each frame). The beam
// is authored along local +Z, so the renderer rotates +Z onto the aim direction.
const TONGUE_BEAM_THICKNESS = 0.9;

// Chicken pose timing: idle holds Chicken_F0; while walking it alternates
// Chicken_F1 <-> Chicken_F2 every 100ms. The egg-throw pose (Chicken_F3 + Egg)
// overrides both for EGG_THROW_POSE_MS after a throw — see the eggThrowUntilMs
// check below, which reads the same performance.now() clock the throw stamps.
const CHICKEN_WALK_FRAME_MS = 100;
const CHICKEN_IDLE_FRAME = 0; // Chicken_F0
const CHICKEN_WALK_FRAMES = [1, 2] as const; // Chicken_F1 <-> Chicken_F2

// Flying egg projectile: world size (the baked egg has a longest edge of 1) and
// a gentle spin so it tumbles in flight rather than sliding rigidly.
const EGG_WORLD_SIZE = 1.3;
const EGG_SPIN_RAD_PER_MS = 0.006;

// Per-unit visual context resolved each render frame (turtle pose selection
// needs wall-clock time and whether the unit is currently moving; the cat also
// needs to know whether it is in an attack exchange; the chicken needs the
// performance.now() clock to time its egg-throw pose).
type VariantContext = { elapsedMs: number; isMoving: boolean; isAttacking: boolean; nowMs: number };

// Resolve the variant key for a unit's current visual state. Owls swap to a
// wing frame while flying; turtles cycle pose frames by movement/shell state.
function variantKeyForUnit(unit: Unit, ctx: VariantContext): string {
  if (unit.animal === 'Owl' && unit.isFlying) {
    const wingFrameIndex = Math.floor((unit.wingPhase || 0) * 4) % OWL_WING_MODELS.length;
    return owlWingVariantKey(wingFrameIndex);
  }
  if (unit.animal === 'Bee') {
    // The bee always flaps: alternate Bee_F0 <-> F1 on a fixed cadence whether
    // it is moving, idling, or fighting.
    const step = Math.floor(ctx.elapsedMs / BEE_FLAP_FRAME_MS) % BEE_FLAP_FRAMES.length;
    return beeFrameVariantKey(BEE_FLAP_FRAMES[step]);
  }
  if (unit.animal === 'Turtle') {
    if (unit.isShelled) return turtleFrameVariantKey(0); // F0 shell-lock pose
    if (!ctx.isMoving) return turtleFrameVariantKey(TURTLE_WALK_FIRST_FRAME); // idle -> F1
    const step = Math.floor(ctx.elapsedMs / TURTLE_WALK_FRAME_MS) % TURTLE_WALK_FRAME_COUNT;
    return turtleFrameVariantKey(TURTLE_WALK_FIRST_FRAME + step); // F1..F5 loop
  }
  if (unit.animal === 'Fox') {
    if (!ctx.isMoving) return foxFrameVariantKey(FOX_IDLE_FRAME); // idle -> F2
    const step = Math.floor(ctx.elapsedMs / FOX_WALK_FRAME_MS) % FOX_FRAME_COUNT;
    return foxFrameVariantKey(step); // F0, F1, F2 loop
  }
  if (unit.animal === 'Yetti') {
    if (!ctx.isMoving) return yetiFrameVariantKey(YETI_IDLE_FRAME); // idle -> F0
    const step = Math.floor(ctx.elapsedMs / YETI_WALK_FRAME_MS) % YETI_WALK_FRAME_COUNT;
    return yetiFrameVariantKey(YETI_WALK_FIRST_FRAME + step); // alternate F1 <-> F2
  }
  if (unit.animal === 'Cat') {
    // The Hiss pose (Kitty_F2) takes precedence over everything for a brief window
    // after a hiss, so the strike pose reads clearly even while the cat is moving.
    if (unit.hissUntilMs !== undefined && ctx.nowMs < unit.hissUntilMs) {
      return catFrameVariantKey(CAT_ATTACK_F2_FRAME);
    }
    // Walk takes precedence over attack: a moving cat plays the walk cycle even
    // if it swung recently (e.g. repositioning), matching the other animals.
    if (ctx.isMoving) {
      const step = Math.floor(ctx.elapsedMs / CAT_FRAME_MS) % CAT_WALK_FRAMES.length;
      return catFrameVariantKey(CAT_WALK_FRAMES[step]); // alternate F0 <-> F1
    }
    if (ctx.isAttacking) {
      // Hold Kitty_F2 (strike) for CAT_ATTACK_F2_HOLD_MS, then Kitty_F1 (recoil)
      // for CAT_ATTACK_F1_HOLD_MS, then repeat.
      const phaseMs = ctx.elapsedMs % CAT_ATTACK_CYCLE_MS;
      const frame = phaseMs < CAT_ATTACK_F2_HOLD_MS ? CAT_ATTACK_F2_FRAME : CAT_ATTACK_F1_FRAME;
      return catFrameVariantKey(frame);
    }
    return catFrameVariantKey(CAT_IDLE_FRAME); // idle -> F0
  }
  if (unit.animal === 'Frog') {
    // The tongue grab overrides the hop: the strike pose (Frog_F3) shows while the
    // tongue is shooting out, and the mouth-open pose (Frog_F2) covers the windup
    // and the reel-back. Both take precedence over idle/walk.
    if (unit.tongue) {
      return frogFrameVariantKey(unit.tongue.phase === 'extending' ? FROG_STRIKE_FRAME : FROG_WINDUP_FRAME);
    }
    // Idle frogs hold the grounded crouch; moving frogs swap to the mid-leap pose
    // over the airborne portion of each hop and back to the crouch on landing.
    if (!ctx.isMoving) return frogFrameVariantKey(FROG_GROUNDED_FRAME); // idle -> F0
    const phase = unit.hopPhase || 0;
    const airborne = phase >= FROG_LEAP_PHASE_START && phase < FROG_LEAP_PHASE_END;
    return frogFrameVariantKey(airborne ? FROG_LEAP_FRAME : FROG_GROUNDED_FRAME);
  }
  if (unit.animal === 'Chicken') {
    // The throw pose (Chicken_F3 + Egg) takes precedence for a brief window after
    // an egg is launched; otherwise idle holds F0 and walking alternates F1<->F2.
    if (unit.eggThrowUntilMs !== undefined && ctx.nowMs < unit.eggThrowUntilMs) {
      return chickenFrameVariantKey(CHICKEN_THROW_FRAME);
    }
    if (!ctx.isMoving) return chickenFrameVariantKey(CHICKEN_IDLE_FRAME); // idle -> F0
    const step = Math.floor(ctx.elapsedMs / CHICKEN_WALK_FRAME_MS) % CHICKEN_WALK_FRAMES.length;
    return chickenFrameVariantKey(CHICKEN_WALK_FRAMES[step]); // F1 <-> F2
  }
  return baseVariantKey(unit.animal);
}

// Minimum horizontal displacement (squared) between consecutive samples that
// counts as a unit having moved. Below this it is treated as standing still.
const MOVE_EPSILON_SQ = 0.01 * 0.01;
// How long after the last detected movement a unit keeps playing its walk
// animation, smoothing over frames where the fixed-timestep tick didn't advance.
const MOVE_HOLD_MS = 150;

// Bear walk tilt: while moving, the bear sways smoothly on its local x-axis,
// peaking at +10deg and -10deg. One full sway (up to +10, down to -10, back)
// completes every 700ms — matching a 350ms swing in each direction. Idle bears
// hold their original (level) pose.
const BEAR_TILT_RAD = (10 * Math.PI) / 180;
const BEAR_TILT_PERIOD_MS = 700;

// Resolve the bear's walk-tilt pitch (radians about its local x-axis) for this
// frame. Returns 0 for non-bears and for idle bears so they sit upright.
function bearTiltPitch(unit: Unit, elapsedMs: number, isMoving: boolean): number {
  if (unit.animal !== 'Bear' || !isMoving) return 0;
  const phase = (elapsedMs / BEAR_TILT_PERIOD_MS) * Math.PI * 2;
  return Math.sin(phase) * BEAR_TILT_RAD;
}

// How long after a unit's last swing it is still treated as "attacking", on top
// of its own swing cadence. The grace bridges the gap between swings (so the
// attack pose stays alive while engaged) and lets it fall back to idle shortly
// after combat ends.
const ATTACK_ANIM_GRACE_MS = 250;

// Whether a unit is currently in an attack exchange, for pose selection (e.g.
// the cat's attack cycle). The game tick stamps lastAttackAtMs with
// performance.now() on every hit and attackCooldownMs is the fixed inter-swing
// interval, so a unit counts as attacking until one full cadence (plus grace)
// passes with no new swing. `nowMs` must come from performance.now() to match
// lastAttackAtMs. A unit that has never attacked has lastAttackAtMs === 0.
function isUnitAttacking(unit: Unit, nowMs: number): boolean {
  if (!unit.lastAttackAtMs) return false; // 0 => has never attacked
  return nowMs - unit.lastAttackAtMs < unit.attackCooldownMs + ATTACK_ANIM_GRACE_MS;
}

// Stable per-unit phase in [0, 2π) derived from the unit id, so flyers bob out
// of lockstep with one another instead of pulsing as a single mass.
function unitBobPhase(unitId: string): number {
  let hash = 0;
  for (let index = 0; index < unitId.length; index++) {
    hash = (hash * 31 + unitId.charCodeAt(index)) | 0;
  }
  return (Math.abs(hash) % 1000) / 1000 * Math.PI * 2;
}

// Vertical animation/positioning offsets applied per unit (hop, flight, Yetti).
// `elapsedMs` is the render clock, used for the bee's continuous hover bob.
function verticalOffset(unit: Unit, elapsedMs: number): number {
  let offset = 0;
  // Ability-controlled altitude (an Owl mid-Pickup and the unit it carries) fully overrides
  // the default per-animal flight/bob so the Owl can swoop to the ground and lift its catch.
  if (unit.flightLift !== undefined) {
    return unit.flightLift;
  }
  // A frog mid tongue-grab is pinned (the tick refuses its movement), so suppress
  // the hop bob and keep it planted on the ground for the grab animation.
  if ((unit.animal === 'Frog' || unit.animal === 'Bunny') && unit.isHopping && !unit.tongue) {
    offset += Math.sin((unit.hopPhase || 0) * Math.PI) * 1.5;
  }
  if (unit.animal === 'Owl' && unit.isFlying) {
    offset += 10;
  }
  // Bees have no land/takeoff state — they're always airborne, so apply the
  // same +10 lift as a flying Owl unconditionally to keep flight altitudes
  // consistent across air units, plus a gentle sine bob so they hover rather
  // than hang frozen (mirrors the title screen's flyer bob).
  if (unit.animal === 'Bee') {
    offset += 10;
    const bobPhase = unitBobPhase(unit.id);
    offset += Math.sin((elapsedMs / 1000) * BEE_BOB_FREQUENCY + bobPhase) * BEE_BOB_AMPLITUDE;
  }
  if (unit.animal === 'Yetti') {
    offset -= 0.9;
  }
  return offset;
}

function InstancedUnits() {
  const { camera } = useThree();
  const isMobile = useMemo(isMobileDevice, []);

  // Load every animal + owl-wing model up front (stable hook call order).
  const gltfs = useGLTF(ALL_ANIMAL_PATHS) as any[];

  // Which animals are actually fielded this match — limits how many instanced
  // meshes we create. Recomputed only when players/selection change.
  const players = useGameStore((s) => s.players);
  const selectedAnimalPool = useGameStore((s) => s.selectedAnimalPool);
  const inPlayAnimals = useMemo<AnimalId[]>(() => {
    const set = new Set<AnimalId>();
    players.forEach((p) => p.animals.forEach((a) => set.add(a)));
    selectedAnimalPool.forEach((a) => set.add(a));
    return Array.from(set);
  }, [players, selectedAnimalPool]);

  // Local-space mouth point and aim axis for the frog tongue beam, read from the
  // model's Tongue_Origin / Tongue_Tip markers. Resolved once when frogs enter
  // play; the render loop scales/rotates these onto each live frog (see below).
  const frogTongueAnchors = useMemo<FrogTongueAnchors | null>(() => {
    if (!inPlayAnimals.includes('Frog')) return null;
    const animalIds = Object.keys(ANIMAL_FILE_MAP) as AnimalId[];
    const frogGltf = gltfs[animalIds.indexOf('Frog')];
    return frogGltf ? getFrogTongueAnchors(frogGltf) : null;
  }, [gltfs, inPlayAnimals]);

  // Build the baked variant specs (one entry per animal, plus owl wing frames
  // when owls are present). Geometry baking itself is cached module-side.
  const variants = useMemo<VariantSpec[]>(() => {
    const animalIds = Object.keys(ANIMAL_FILE_MAP) as AnimalId[];
    const gltfByAnimal = new Map<AnimalId, any>();
    animalIds.forEach((animal, index) => gltfByAnimal.set(animal, gltfs[index]));
    const wingGltfs = gltfs.slice(animalIds.length);

    const specs: VariantSpec[] = [];
    for (const animal of inPlayAnimals) {
      const gltf = gltfByAnimal.get(animal);
      if (!gltf) continue;
      if (animal === 'Turtle') {
        // Turtle ships its poses as separate objects in one glb — bake each
        // Turtle_F# into its own variant so the renderer can swap poses.
        for (let frame = 0; frame < TURTLE_FRAME_COUNT; frame++) {
          specs.push({ key: turtleFrameVariantKey(frame), parts: getBakedTurtleFrameParts(gltf, frame) });
        }
        continue;
      }
      if (animal === 'Fox') {
        // Fox ships its poses as separate objects in one glb — bake each
        // Fox_F# into its own variant so the renderer can swap poses.
        for (let frame = 0; frame < FOX_FRAME_COUNT; frame++) {
          specs.push({ key: foxFrameVariantKey(frame), parts: getBakedFoxFrameParts(gltf, frame) });
        }
        continue;
      }
      if (animal === 'Yetti') {
        // Yeti ships its poses as separate objects in one glb — bake each
        // Yeti_F# into its own variant so the renderer can swap poses.
        for (let frame = 0; frame < YETI_FRAME_COUNT; frame++) {
          specs.push({ key: yetiFrameVariantKey(frame), parts: getBakedYetiFrameParts(gltf, frame) });
        }
        continue;
      }
      if (animal === 'Cat') {
        // Cat ships its poses as separate objects in one glb — bake each
        // Kitty_F# into its own variant so the renderer can swap the
        // walk/attack/idle poses (see variantKeyForUnit).
        for (let frame = 0; frame < CAT_FRAME_COUNT; frame++) {
          specs.push({ key: catFrameVariantKey(frame), parts: getBakedCatFrameParts(gltf, frame) });
        }
        continue;
      }
      if (animal === 'Bee') {
        // Bee ships its two wing-flap poses as separate objects in one glb —
        // bake each Bee_F# into its own variant so the renderer can alternate
        // them for the continuous flap loop (see variantKeyForUnit).
        for (let frame = 0; frame < BEE_FRAME_COUNT; frame++) {
          specs.push({ key: beeFrameVariantKey(frame), parts: getBakedBeeFrameParts(gltf, frame) });
        }
        continue;
      }
      if (animal === 'Frog') {
        // Frog ships F0 (grounded), F1 (mid-leap), F2 (windup) and F3 (strike)
        // poses plus a Tongue in one glb. Bake each pose into its own variant so
        // the renderer shows exactly one — the hop loop alternates F0/F1, while
        // the tongue-grab ability swaps to F2/F3 (see variantKeyForUnit). The
        // stretchable tongue beam is a separate variant, drawn from the live
        // tongue state below.
        for (let frame = 0; frame < FROG_FRAME_COUNT; frame++) {
          specs.push({ key: frogFrameVariantKey(frame), parts: getBakedFrogFrameParts(gltf, frame) });
        }
        specs.push({ key: FROG_TONGUE_VARIANT_KEY, parts: getBakedFrogTongueParts(gltf) });
        continue;
      }
      if (animal === 'Chicken') {
        // Chicken ships F0 (idle), F1/F2 (walk), F3 (throw) + an Egg in one glb.
        // Bake each pose into its own variant — F3 carries the held Egg — so the
        // renderer shows exactly one pose and the spare poses/egg stay hidden
        // (see variantKeyForUnit). The flying egg is a separate variant below.
        for (let frame = 0; frame < CHICKEN_FRAME_COUNT; frame++) {
          specs.push({ key: chickenFrameVariantKey(frame), parts: getBakedChickenFrameParts(gltf, frame) });
        }
        specs.push({ key: EGG_PROJECTILE_VARIANT_KEY, parts: getBakedEggProjectileParts(gltf) });
        continue;
      }
      specs.push({ key: baseVariantKey(animal), parts: getBakedAnimalParts(gltf, animal) });
    }
    if (inPlayAnimals.includes('Owl')) {
      for (let frame = 0; frame < OWL_WING_MODELS.length; frame++) {
        specs.push({ key: owlWingVariantKey(frame), parts: getBakedOwlWingParts(wingGltfs[frame], frame) });
      }
    }

    // Royal head accessories: one instanced variant per (animal, accessory node)
    // the model actually carries, so Kings/Queens can wear a team-colored
    // crown/tiara. Models without these nodes (Frog, Chicken) contribute none.
    for (const animal of inPlayAnimals) {
      const gltf = gltfByAnimal.get(animal);
      if (!gltf || !hasRoyalAccessories(gltf)) continue;
      for (const node of ROYAL_ACCESSORY_NODE_NAMES) {
        specs.push({
          key: royalAccessoryVariantKey(animal, node),
          parts: getBakedRoyalAccessoryParts(gltf, animal, node),
          capacity: ROYAL_ACCESSORY_CAPACITY,
        });
      }
    }

    // Owl royal accessories baked per wing frame so a flying owl's crown tracks
    // the same wing pose its body uses.
    if (inPlayAnimals.includes('Owl')) {
      for (let frame = 0; frame < OWL_WING_MODELS.length; frame++) {
        const wingGltf = wingGltfs[frame];
        if (!hasRoyalAccessories(wingGltf)) continue;
        for (const node of ROYAL_ACCESSORY_NODE_NAMES) {
          specs.push({
            key: owlWingRoyalAccessoryVariantKey(frame, node),
            parts: getBakedOwlWingRoyalAccessoryParts(wingGltf, frame, node),
            capacity: ROYAL_ACCESSORY_CAPACITY,
          });
        }
      }
    }

    return specs;
  }, [gltfs, inPlayAnimals]);

  // Dev-only handles mirroring the app's other __rts* hooks: expose the royal
  // accessory selection rule and the set of accessory variants actually baked and
  // mounted this match, so feature tests can assert the crown/tiara behavior
  // against the real store's units and the real baked variants (no mocked I/O).
  useEffect(() => {
    const mounted = variants.map((v) => v.key).filter((k) => k.startsWith('royal:'));
    (window as any).__rtsMountedAccessoryVariants = mounted;
    (window as any).__rtsRoyalAccessoryKeyForUnit = (unit: Unit, isOwnUnit: boolean) =>
      accessoryVariantKeyForUnit(unit, isOwnUnit);
  }, [variants]);

  // Imperative handles, populated by ref callbacks. Not React state — updated
  // directly each frame to avoid re-rendering the component tree.
  const meshRefs = useRef<Map<string, THREE.InstancedMesh[]>>(new Map());
  const ownRingRef = useRef<THREE.InstancedMesh>(null);
  const enemyRingRef = useRef<THREE.InstancedMesh>(null);
  const royalOwnerRingRef = useRef<THREE.InstancedMesh>(null);
  const selectionOuterRef = useRef<THREE.InstancedMesh>(null);
  const selectionInnerRef = useRef<THREE.InstancedMesh>(null);
  const royalSelectionOuterRef = useRef<THREE.InstancedMesh>(null);
  const royalSelectionInnerRef = useRef<THREE.InstancedMesh>(null);
  const auraActiveRef = useRef<THREE.InstancedMesh>(null);
  const auraUnitGlowRef = useRef<THREE.InstancedMesh>(null);
  const healthBarBgRef = useRef<THREE.InstancedMesh>(null);
  const healthBarFillRef = useRef<THREE.InstancedMesh>(null);
  // instanceId -> unitId per variant, rebuilt each frame for picking.
  const variantUnitIds = useRef<Map<string, string[]>>(new Map());

  // Per-unit motion tracking: last sampled position + the time it last moved, so
  // the renderer can tell a walking unit from an idle one (turtle walk cycle,
  // bear walk tilt).
  const unitMotion = useRef<Map<string, { x: number; z: number; lastMovedMs: number }>>(new Map());

  // Reusable scratch objects (no per-frame allocation).
  const scratch = useRef({
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    tiltQuaternion: new THREE.Quaternion(),
    identityQuaternion: new THREE.Quaternion(),
    scale: new THREE.Vector3(),
    one: new THREE.Vector3(1, 1, 1),
    matrix: new THREE.Matrix4(),
    projScreen: new THREE.Matrix4(),
    frustum: new THREE.Frustum(),
    cameraRight: new THREE.Vector3(),
    color: new THREE.Color(),
  });

  // Mark ring instance buffers as dynamic (updated every frame) for the GPU.
  useEffect(() => {
    [ownRingRef, enemyRingRef, royalOwnerRingRef, selectionOuterRef, selectionInnerRef, royalSelectionOuterRef, royalSelectionInnerRef, auraActiveRef, auraUnitGlowRef, healthBarBgRef, healthBarFillRef].forEach((ref) => {
      ref.current?.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    });
  }, []);

  // Detect whether a unit is currently walking by sampling its position each
  // frame. The motion record is mutated in place so a moving unit keeps its walk
  // animation for MOVE_HOLD_MS after the last detected step (bridging frames
  // where the fixed tick didn't advance). Call at most once per unit per frame.
  const isUnitMoving = (unit: Unit, nowMs: number): boolean => {
    const motion = unitMotion.current;
    const record = motion.get(unit.id);
    const { x, z } = unit.position;
    if (!record) {
      motion.set(unit.id, { x, z, lastMovedMs: Number.NEGATIVE_INFINITY });
      return false;
    }
    const dx = x - record.x;
    const dz = z - record.z;
    if (dx * dx + dz * dz > MOVE_EPSILON_SQ) {
      record.lastMovedMs = nowMs;
    }
    record.x = x;
    record.z = z;
    return nowMs - record.lastMovedMs < MOVE_HOLD_MS;
  };

  useFrame(({ clock }) => {
    const s = useGameStore.getState();
    const units = s.units;
    const localPlayerId = s.localPlayerId;
    const selected = s.selectedUnitIds;
    const selectedSet = selected.length > 0 ? new Set(selected) : null;
    const queenAuraRadius = s.config.regenRadius;
    const kingAuraRadius = s.config.kingAuraRadius;
    const healthBarsEnabled = s.healthBarsEnabled;

    const { position, quaternion, tiltQuaternion, identityQuaternion, scale, one, matrix, projScreen, frustum, cameraRight, color } = scratch.current;

    // Billboard orientation for health bars: camera's quaternion makes each bar
    // face the screen, and its world-space right axis anchors the fill's left edge.
    if (healthBarsEnabled) {
      cameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    }

    // Pulse drives the neon-green active ring glow + per-unit glow this frame.
    const pulse = 0.5 + 0.5 * Math.sin(clock.elapsedTime * 4);
    AURA_ACTIVE_MAT.emissiveIntensity = 2.5 + pulse * 3.0; // 2.5 .. 5.5 (neon)
    const activeAuraScale = 1 + pulse * 0.05;
    AURA_UNIT_GLOW_MAT.opacity = 0.3 + pulse * 0.45; // 0.3 .. 0.75
    const unitGlowScale = AURA_UNIT_GLOW_RADIUS * (0.85 + pulse * 0.4);

    // Active aura sources (auraActive Queens/Kings) — friendly units standing
    // inside any of these get the pulsing green glow pool. Few sources (<=12).
    const activeAuras: { x: number; z: number; r2: number; owner: string }[] = [];
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if ((u.kind === 'Queen' || u.kind === 'King') && u.auraActive) {
        const r = u.kind === 'Queen' ? queenAuraRadius : kingAuraRadius;
        activeAuras.push({ x: u.position.x, z: u.position.z, r2: r * r, owner: u.ownerId });
      }
    }

    // Build the camera frustum once per frame for cheap off-screen culling.
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    const maxDistanceSq = MAX_RENDER_DISTANCE * MAX_RENDER_DISTANCE;

    // Per-frame counters for each variant and each ring bucket.
    const counts = new Map<string, number>();
    for (const variant of variants) {
      counts.set(variant.key, 0);
      let ids = variantUnitIds.current.get(variant.key);
      if (!ids) {
        ids = [];
        variantUnitIds.current.set(variant.key, ids);
      }
    }
    let ownRingCount = 0;
    let enemyRingCount = 0;
    let royalOwnerRingCount = 0;
    let selectionOuterCount = 0;
    let selectionInnerCount = 0;
    let royalSelectionOuterCount = 0;
    let royalSelectionInnerCount = 0;
    let auraActiveCount = 0;
    let auraUnitGlowCount = 0;
    let healthBarCount = 0;

    const elapsedMs = clock.elapsedTime * 1000;
    // Attack timing is stamped with performance.now() in the game tick, so the
    // attack-exchange test must read the same clock (not the render clock above).
    const nowPerf = performance.now();

    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (unit.kind === 'Base') continue;

      const isMoving = isUnitMoving(unit, elapsedMs);
      const isAttacking = isUnitAttacking(unit, nowPerf);
      const key = variantKeyForUnit(unit, { elapsedMs, isMoving, isAttacking, nowMs: nowPerf });
      if (!counts.has(key)) continue; // not a currently-mounted variant
      const meshes = meshRefs.current.get(key);
      if (!meshes || meshes.length === 0) continue;

      const renderY = unit.position.y + verticalOffset(unit, elapsedMs);
      position.set(unit.position.x, renderY, unit.position.z);

      // Distance + frustum cull (units we can't see cost nothing).
      if (camera.position.distanceToSquared(position) > maxDistanceSq) continue;
      if (!frustum.containsPoint(position)) continue;

      const variantCount = counts.get(key)!;
      if (variantCount >= MAX_INSTANCES_PER_VARIANT) continue;

      // Compose the per-instance transform: position, yaw, kind-based scale.
      // Bears additionally rock on their local x-axis while walking (idle bears
      // and every other animal keep a level pose).
      quaternion.setFromAxisAngle(Y_AXIS, unit.rotation);
      const tiltPitch = bearTiltPitch(unit, elapsedMs, isMoving);
      if (tiltPitch !== 0) {
        tiltQuaternion.setFromAxisAngle(X_AXIS, tiltPitch);
        quaternion.multiply(tiltQuaternion); // yaw then local-x pitch
      }
      const target = getKindTargetScale(unit.animal, unit.kind);
      scale.set(target, target, target);
      matrix.compose(position, quaternion, scale);
      for (let p = 0; p < meshes.length; p++) {
        if (meshes[p]) meshes[p].setMatrixAt(variantCount, matrix);
      }
      variantUnitIds.current.get(key)![variantCount] = unit.id;
      counts.set(key, variantCount + 1);

      // Allegiance + rank drive both the royal head accessory and the owner/
      // selection ring styling below.
      const isOwnUnit = unit.ownerId === localPlayerId;
      const isRoyal = unit.kind === 'King' || unit.kind === 'Queen';

      // Royal head accessory (crown/tiara). The accessory is baked in the same
      // normalized frame as the body, so reusing the body's just-composed matrix
      // (position + yaw/tilt + kind scale) drops it onto the unit's head. Blue for
      // the local player, red for the enemy; Crown for Kings, Tiara for Queens.
      // Models without these nodes (Frog, Chicken) resolve no accessory mesh and
      // are skipped. `matrix` still holds the body transform here — the ring
      // blocks below recompose it afterward.
      if (isRoyal) {
        const accessoryKey = accessoryVariantKeyForUnit(unit, isOwnUnit);
        const accessoryMeshes = accessoryKey ? meshRefs.current.get(accessoryKey) : undefined;
        if (accessoryKey && accessoryMeshes && accessoryMeshes.length > 0) {
          const accessoryCount = counts.get(accessoryKey) ?? 0;
          if (accessoryCount < ROYAL_ACCESSORY_CAPACITY) {
            for (let p = 0; p < accessoryMeshes.length; p++) {
              if (accessoryMeshes[p]) accessoryMeshes[p].setMatrixAt(accessoryCount, matrix);
            }
            counts.set(accessoryKey, accessoryCount + 1);
          }
        }
      }

      // Owner ring sits on the ground beneath the unit (ignores flight lift). The local
      // player's kings/queens get a larger GOLD ring instead of the standard blue one so
      // royalty reads at a glance; enemy royals keep the red owner ring for friend/foe
      // clarity.
      if (isRoyal && isOwnUnit) {
        if (royalOwnerRingRef.current && royalOwnerRingCount < RING_CAPACITY) {
          const s = royalRingScale(unit);
          position.set(unit.position.x, unit.position.y + 0.02, unit.position.z);
          scale.set(s, s, s);
          matrix.compose(position, identityQuaternion, scale);
          royalOwnerRingRef.current.setMatrixAt(royalOwnerRingCount++, matrix);
        }
      } else {
        const ringMesh = isOwnUnit ? ownRingRef.current : enemyRingRef.current;
        if (ringMesh) {
          const ringIndex = isOwnUnit ? ownRingCount : enemyRingCount;
          if (ringIndex < RING_CAPACITY) {
            matrix.makeTranslation(unit.position.x, unit.position.y + 0.02, unit.position.z);
            ringMesh.setMatrixAt(ringIndex, matrix);
            if (isOwnUnit) ownRingCount++;
            else enemyRingCount++;
          }
        }
      }

      // Green glow pool beneath any unit standing inside an active friendly aura.
      if (activeAuras.length > 0 && auraUnitGlowRef.current && auraUnitGlowCount < AURA_GLOW_CAPACITY) {
        let inAura = false;
        for (const a of activeAuras) {
          if (a.owner !== unit.ownerId) continue;
          const dx = unit.position.x - a.x;
          const dz = unit.position.z - a.z;
          if (dx * dx + dz * dz <= a.r2) { inAura = true; break; }
        }
        if (inAura) {
          position.set(unit.position.x, unit.position.y + 0.05, unit.position.z);
          scale.set(unitGlowScale, unitGlowScale, unitGlowScale);
          matrix.compose(position, identityQuaternion, scale);
          auraUnitGlowRef.current.setMatrixAt(auraUnitGlowCount++, matrix);
        }
      }

      // Queen/King aura ring: a flat green annulus drawn at the aura's world
      // radius around the unit, ONLY while the aura is actively working —
      // unit.auraActive flips on when a Queen is healing a hurt unit in range
      // or a King is buffing a unit in combat in range. Hidden entirely
      // otherwise. Ground-placed so flight lift doesn't move it.
      if ((unit.kind === 'Queen' || unit.kind === 'King') && unit.auraActive) {
        const radius = unit.kind === 'Queen' ? queenAuraRadius : kingAuraRadius;
        const ringY = unit.position.y + AURA_RING_GROUND_LIFT;
        const ringMesh = auraActiveRef.current;
        if (ringMesh && auraActiveCount < AURA_CAPACITY) {
          const r = radius * activeAuraScale;
          position.set(unit.position.x, ringY, unit.position.z);
          scale.set(r, r, r);
          matrix.compose(position, identityQuaternion, scale);
          ringMesh.setMatrixAt(auraActiveCount++, matrix);
        }
      }

      // Floating health bar — drawn for any unit below full HP (and still alive),
      // persisting until it heals to full or dies, when the player has bars on.
      if (
        healthBarsEnabled &&
        unit.hp > 0 &&
        unit.hp < unit.maxHp &&
        healthBarCount < HEALTH_BAR_CAPACITY &&
        healthBarBgRef.current &&
        healthBarFillRef.current
      ) {
        const ratio = Math.max(0, Math.min(1, unit.hp / unit.maxHp));
        // Sit the bar just above the model's head; taller kinds need more lift.
        const barY = renderY + target * 0.55 + 0.9;

        // Backing bar: centered on the unit, facing the camera.
        position.set(unit.position.x, barY, unit.position.z);
        matrix.compose(position, camera.quaternion, one);
        healthBarBgRef.current.setMatrixAt(healthBarCount, matrix);

        // Fill: anchored at the bar's left edge, scaled in x by the HP ratio.
        position.set(
          unit.position.x - cameraRight.x * (HEALTH_BAR_WIDTH / 2),
          barY - cameraRight.y * (HEALTH_BAR_WIDTH / 2),
          unit.position.z - cameraRight.z * (HEALTH_BAR_WIDTH / 2)
        );
        scale.set(Math.max(ratio, 0.0001), 1, 1);
        matrix.compose(position, camera.quaternion, scale);
        healthBarFillRef.current.setMatrixAt(healthBarCount, matrix);

        // Fill color reflects remaining HP: red (low) -> yellow -> green (high).
        if (ratio > 0.5) {
          color.setRGB((1 - ratio) * 2, 1, 0.1);
        } else {
          color.setRGB(1, ratio * 2, 0.1);
        }
        healthBarFillRef.current.setColorAt(healthBarCount, color);
        healthBarCount++;
      }

      // Selection rings only for currently selected units. A selected king/queen gets the
      // larger GOLD selection rings (matching its gold owner ring) so its selected state is
      // unmistakable beneath the bigger royal model; regular units keep the blue rings.
      if (selectedSet && selectedSet.has(unit.id)) {
        if (isRoyal) {
          const s = royalRingScale(unit);
          if (royalSelectionOuterRef.current && royalSelectionOuterCount < RING_CAPACITY) {
            position.set(unit.position.x, unit.position.y + 0.04, unit.position.z);
            scale.set(s, s, s);
            matrix.compose(position, identityQuaternion, scale);
            royalSelectionOuterRef.current.setMatrixAt(royalSelectionOuterCount++, matrix);
          }
          if (royalSelectionInnerRef.current && royalSelectionInnerCount < RING_CAPACITY) {
            position.set(unit.position.x, unit.position.y + 0.25, unit.position.z);
            scale.set(s, s, s);
            matrix.compose(position, identityQuaternion, scale);
            royalSelectionInnerRef.current.setMatrixAt(royalSelectionInnerCount++, matrix);
          }
        } else {
          if (selectionOuterRef.current && selectionOuterCount < RING_CAPACITY) {
            matrix.makeTranslation(unit.position.x, unit.position.y + 0.04, unit.position.z);
            selectionOuterRef.current.setMatrixAt(selectionOuterCount++, matrix);
          }
          if (selectionInnerRef.current && selectionInnerCount < RING_CAPACITY) {
            matrix.makeTranslation(unit.position.x, unit.position.y + 0.25, unit.position.z);
            selectionInnerRef.current.setMatrixAt(selectionInnerCount++, matrix);
          }
        }
      }
    }

    // Flying egg projectiles (Chicken ability). These aren't units, so the unit
    // loop above never populates their variant — fill it here from the live
    // projectile list. Each egg tumbles as it flies toward its target.
    const eggMeshes = meshRefs.current.get(EGG_PROJECTILE_VARIANT_KEY);
    if (eggMeshes && eggMeshes.length > 0) {
      let eggCount = 0;
      for (const egg of s.projectiles) {
        if (eggCount >= MAX_INSTANCES_PER_VARIANT) break;
        position.set(egg.position.x, egg.position.y, egg.position.z);
        if (!frustum.containsPoint(position)) continue; // off-screen eggs cost nothing
        const spin = (elapsedMs * EGG_SPIN_RAD_PER_MS) % (Math.PI * 2);
        quaternion.setFromAxisAngle(X_AXIS, spin);
        scale.set(EGG_WORLD_SIZE, EGG_WORLD_SIZE, EGG_WORLD_SIZE);
        matrix.compose(position, quaternion, scale);
        for (let p = 0; p < eggMeshes.length; p++) {
          if (eggMeshes[p]) eggMeshes[p].setMatrixAt(eggCount, matrix);
        }
        eggCount++;
      }
      counts.set(EGG_PROJECTILE_VARIANT_KEY, eggCount);
    }

    // Frog tongue beams (Frog ability). For every frog with an active tongue, draw
    // the baked tongue stretched from the model's Tongue_Origin marker (the mouth)
    // out along the Origin->Tip axis to the current tip. The mouth point and axis
    // come from the frog's own model markers (frogTongueAnchors): they are scaled
    // by the unit's world scale, rotated by its yaw (the frog turns to face the
    // throw, so the model's forward aligns with the aim), and offset by its
    // position. The beam is centered at its midpoint, oriented so its local +Z
    // runs along that world axis, and scaled to TONGUE_BEAM_THICKNESS across by the
    // live extension length. A zero-length (just-fired / fully-reeled) tongue is
    // skipped. Without anchors (frog model missing the markers) no beam is drawn.
    const tongueMeshes = meshRefs.current.get(FROG_TONGUE_VARIANT_KEY);
    if (tongueMeshes && tongueMeshes.length > 0 && frogTongueAnchors) {
      let tongueCount = 0;
      for (const unit of s.units) {
        if (tongueCount >= MAX_INSTANCES_PER_VARIANT) break;
        const tongue = unit.tongue;
        if (!tongue || tongue.length <= 0.001) continue;

        const unitScale = getKindTargetScale(unit.animal, unit.kind);
        tongueYaw.setFromAxisAngle(Y_AXIS, unit.rotation);

        // World mouth point: the Tongue_Origin marker, scaled and yawed onto the
        // live frog. A frog mid-grab is pinned with no vertical offset, so the
        // body sits at unit.position — the same anchor the body render uses.
        tongueMouth
          .set(
            frogTongueAnchors.origin.x * unitScale,
            frogTongueAnchors.origin.y * unitScale,
            frogTongueAnchors.origin.z * unitScale
          )
          .applyQuaternion(tongueYaw);
        tongueMouth.x += unit.position.x;
        tongueMouth.y += unit.position.y;
        tongueMouth.z += unit.position.z;

        // World aim axis (unit length): the Origin->Tip direction rotated into the
        // frog's facing. The tip extends "straight outward" along this axis.
        tongueAxis
          .set(frogTongueAnchors.axis.x, frogTongueAnchors.axis.y, frogTongueAnchors.axis.z)
          .applyQuaternion(tongueYaw);

        const length = tongue.length;
        position.set(
          tongueMouth.x + tongueAxis.x * (length / 2),
          tongueMouth.y + tongueAxis.y * (length / 2),
          tongueMouth.z + tongueAxis.z * (length / 2)
        );
        if (!frustum.containsPoint(position)) continue; // off-screen tongues cost nothing

        quaternion.setFromUnitVectors(Z_AXIS, tongueAxis);
        scale.set(TONGUE_BEAM_THICKNESS, TONGUE_BEAM_THICKNESS, length);
        matrix.compose(position, quaternion, scale);
        for (let p = 0; p < tongueMeshes.length; p++) {
          if (tongueMeshes[p]) tongueMeshes[p].setMatrixAt(tongueCount, matrix);
        }
        tongueCount++;
      }
      counts.set(FROG_TONGUE_VARIANT_KEY, tongueCount);
    }

    // Flush instance counts + matrix updates to the GPU.
    for (const variant of variants) {
      const meshes = meshRefs.current.get(variant.key);
      if (!meshes) continue;
      const count = counts.get(variant.key)!;
      for (let p = 0; p < meshes.length; p++) {
        if (!meshes[p]) continue;
        meshes[p].count = count;
        meshes[p].instanceMatrix.needsUpdate = true;
      }
    }
    const flush = (mesh: THREE.InstancedMesh | null, count: number) => {
      if (!mesh) return;
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
    };
    flush(ownRingRef.current, ownRingCount);
    flush(enemyRingRef.current, enemyRingCount);
    flush(royalOwnerRingRef.current, royalOwnerRingCount);
    flush(selectionOuterRef.current, selectionOuterCount);
    flush(selectionInnerRef.current, selectionInnerCount);
    flush(royalSelectionOuterRef.current, royalSelectionOuterCount);
    flush(royalSelectionInnerRef.current, royalSelectionInnerCount);
    flush(auraActiveRef.current, auraActiveCount);
    flush(auraUnitGlowRef.current, auraUnitGlowCount);
    flush(healthBarBgRef.current, healthBarCount);
    flush(healthBarFillRef.current, healthBarCount);
    if (healthBarFillRef.current?.instanceColor) {
      healthBarFillRef.current.instanceColor.needsUpdate = true;
    }
  });

  // Only right-click attack-move onto an enemy unit is handled per-mesh here.
  // Left-click selection lives in MapInteraction's screen-space picking: the
  // instanced models are tiny and units cluster tightly, so per-mesh raycast
  // picking was unreliable for selecting an individual unit.
  const handlePointerDown = (variantKey: string, e: any) => {
    if (e.button !== 2) return;
    const id = variantUnitIds.current.get(variantKey)?.[e.instanceId];
    if (!id) return;

    const s = useGameStore.getState();
    const unit = s.units.find((u) => u.id === id);
    if (!unit || unit.ownerId === s.localPlayerId) return;

    e.stopPropagation();
    const selectedOwn = s.units.filter(
      (u) => s.selectedUnitIds.includes(u.id) && u.ownerId === s.localPlayerId
    );
    if (selectedOwn.length > 0) {
      s.attackTarget({ unitIds: selectedOwn.map((u) => u.id), targetId: unit.id });
    }
  };

  const registerPartRef = (variantKey: string, partIndex: number) => (mesh: THREE.InstancedMesh | null) => {
    if (!mesh) return;
    let meshes = meshRefs.current.get(variantKey);
    if (!meshes) {
      meshes = [];
      meshRefs.current.set(variantKey, meshes);
    }
    meshes[partIndex] = mesh;
    mesh.frustumCulled = false; // we cull per-instance ourselves
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = !isMobile;
    mesh.receiveShadow = !isMobile;
    mesh.count = 0;
  };

  return (
    <group>
      {variants.map((variant) =>
        variant.parts.map((part, partIndex) => (
          <instancedMesh
            key={`${variant.key}-${partIndex}`}
            ref={registerPartRef(variant.key, partIndex)}
            args={[part.geometry, part.material, variant.capacity ?? MAX_INSTANCES_PER_VARIANT]}
            onPointerDown={(e) => handlePointerDown(variant.key, e)}
          />
        ))
      )}

      {/* Owner rings — always visible, blue for the local player, red for AI. */}
      <instancedMesh
        ref={ownRingRef}
        args={[ownerRingGeometry, OWN_OWNER_RING_MAT, RING_CAPACITY]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={enemyRingRef}
        args={[ownerRingGeometry, ENEMY_OWNER_RING_MAT, RING_CAPACITY]}
        frustumCulled={false}
      />
      {/* Local player's King/Queen owner ring — gold, scaled per royal. */}
      <instancedMesh
        ref={royalOwnerRingRef}
        args={[ownerRingGeometry, ROYAL_OWNER_RING_MAT, RING_CAPACITY]}
        frustumCulled={false}
      />

      {/* Queen/King aura ring — flat green annulus drawn only while the aura
          is actively healing or buffing. Per-unit green glow pool sits under
          any unit standing in an active friendly aura. */}
      <instancedMesh
        ref={auraActiveRef}
        args={[auraRingGeometry, AURA_ACTIVE_MAT, AURA_CAPACITY]}
        frustumCulled={false}
      />
      <instancedMesh
        ref={auraUnitGlowRef}
        args={[auraUnitGlowGeometry, AURA_UNIT_GLOW_MAT, AURA_GLOW_CAPACITY]}
        frustumCulled={false}
        renderOrder={1}
      />

      {/* Floating health bars — backing + colored fill, billboarded toward the
          camera and drawn on top of the scene. Only populated for units that are
          currently taking damage or healing. */}
      <instancedMesh
        ref={healthBarBgRef}
        args={[healthBarBgGeometry, HEALTH_BAR_BG_MAT, HEALTH_BAR_CAPACITY]}
        frustumCulled={false}
        renderOrder={998}
      />
      <instancedMesh
        ref={healthBarFillRef}
        args={[healthBarFillGeometry, HEALTH_BAR_FILL_MAT, HEALTH_BAR_CAPACITY]}
        frustumCulled={false}
        renderOrder={999}
      />

      {/* Selection rings — only drawn for selected units. renderOrder pushes
          them past the per-unit aura glow (renderOrder=1) in the transparent
          queue so they always paint on top of the pulsing pool. */}
      <instancedMesh
        ref={selectionOuterRef}
        args={[selectionOuterGeometry, SELECTION_OUTER_MAT, RING_CAPACITY]}
        frustumCulled={false}
        renderOrder={2}
      />
      <instancedMesh
        ref={selectionInnerRef}
        args={[selectionInnerGeometry, SELECTION_INNER_MAT, RING_CAPACITY]}
        frustumCulled={false}
        renderOrder={3}
      />

      {/* King/Queen selection rings — gold, scaled per royal, drawn when a royal is
          selected. Render orders sit just above the regular selection rings. */}
      <instancedMesh
        ref={royalSelectionOuterRef}
        args={[selectionOuterGeometry, ROYAL_SELECTION_OUTER_MAT, RING_CAPACITY]}
        frustumCulled={false}
        renderOrder={4}
      />
      <instancedMesh
        ref={royalSelectionInnerRef}
        args={[selectionInnerGeometry, ROYAL_SELECTION_INNER_MAT, RING_CAPACITY]}
        frustumCulled={false}
        renderOrder={5}
      />
    </group>
  );
}

export function UnitsLayer() {
  return (
    <Suspense fallback={null}>
      <InstancedUnits />
      <Bases />
    </Suspense>
  );
}
