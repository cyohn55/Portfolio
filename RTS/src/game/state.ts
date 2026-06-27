import { create } from 'zustand';
import { produce, setAutoFreeze } from 'immer';
import { SpatialGrid } from '../utils/SpatialGrid';
import { SeededRng } from '../components/Working/net/prng';
import type { NetCommand, PlayerRole } from '../components/Working/net/netMessages';

// The per-frame `tick` mutates unit objects in place for performance (see the
// comment on `tick`). The other store actions still use Immer's produce(), whose
// default auto-freeze would deep-freeze the shared `units` objects and make the
// next tick's in-place mutation throw. Disabling auto-freeze keeps both paths
// compatible (and slightly speeds up the remaining produce() calls).
setAutoFreeze(false);
import { terrainValidator } from '../utils/TerrainValidator';
import { pathfinder } from '../components/Working/pathfinder';
import { BLOCKER_LOOKAHEAD, deflectAroundBlockers, type SteerBlocker } from '../components/Working/movementSteering';
import { slideAlongObstacle } from '../components/Working/terrainSlide';
import { clampToArena } from '../components/Working/arenaBoundary';
import { assignSlots, centroidOf, defaultSpacingFor, meanHeading } from '../components/Working/formations';
import { PLAYBOOK, classifyRole, rightAxisComponent } from '../components/Working/playbook';
import {
  type MonarchKind,
  MONARCH_FOLLOW_STOP_DISTANCE,
  MONARCH_FOLLOW_GAP,
  clampPlacementCount,
  findMonarch,
  followGapClearance,
  listFireTeamIds,
  nextFireTeamInCycle,
  nextPlacementStep,
  otherMonarchKind,
  pilotInput,
  selectFollowersForPlacement,
  selectionForMonarch,
  shouldChaseMonarch,
} from '../components/Working/monarchPilot';
import type { Position3D, AnimalId, CommandMoveUnits, CommandSetPatrol, CommandSetQueenRally, CommandAttackTarget, CommandSetBehavior, CommandSetFormation, CommandAdjustFormation, CommandCallPlay, CommandThrowEggs, CommandFireTongues, CommandHiss, CommandSwarm, CommandOwlPickup, CommandOwlDeliver, GameConfig, GameState, MatchStats, Player, Unit, PatrolRoute, Projectile } from './types';
import {
  behaviorOf,
  defaultBehaviorFor,
  distanceXZ,
  mergeBehavior,
  pickTargetByPriority,
  resolveFireMode,
  retreatDestination,
  RETURN_DEADBAND,
  shouldFleeLowHp,
  stanceParams,
} from '../components/Working/unitBehavior';
import { ANIMAL_MOVEMENT_TYPES } from './types';
import * as leaderboardModule from '../components/Working/leaderboard';
import * as leaderboardRemoteModule from '../components/Working/leaderboardRemote';
import {
  type ControlActionId,
  type ControlBindings,
  type ControlBindingModes,
  type InputDevice,
  applyBinding,
  applyBindingMode,
  getDefaultBindings,
  getDefaultModes,
  loadBindings,
  loadModes,
  saveBindings,
  saveModes,
} from '../components/Working/controlBindings';
import type { ActivationMode } from '../components/Working/gestureModes';

type BridgeAnimationState = 'up' | 'lowering' | 'down' | 'raising';
type BridgeFrame = 'Fully_Up' | 'Almost_Up' | 'Almost_Down' | 'Fully_Down';

interface BridgeAnimation {
  currentState: BridgeAnimationState;
  currentFrame: BridgeFrame;
  animationStartMs: number;
  frameStartMs: number;
  triggeredByPlayer: boolean;
}

interface BridgeState {
  rightBridge: BridgeAnimation;
  leftBridge: BridgeAnimation;
}


// Per-animal base stats across four combat axes: HP, per-hit damage, move speed,
// attack range, and attack cooldown (attack speed). Damage-per-second is
// dmg / (attackCooldownMs / 1000), so two animals with very different per-hit
// numbers can share a DPS while feeling completely different (a fast flurry of
// pecks vs a slow heavy slam).
//
// Every animal is tuned to the same overall power budget. Normalising attack
// speed to an "effective damage per 1.5s" lets us reuse one index:
//   effDmg      = dmg * 1500 / attackCooldownMs
//   speedFactor = 1 + speed / 40            (mobility is a modest premium)
//   rangeFactor = 1 + 0.085 * (range - 4)   (reach lets ranged units kite)
//   index       = sqrt(HP * effDmg) * speedFactor * rangeFactor  ~= 60 for all.
// Range and attack cooldown are real power, so they are paid for: ranged animals
// (Bee, Frog, Owl) trade away HP/DPS for reach, and fast attackers trade per-hit
// damage for cadence. Speed and range remain the identity axes; HP and per-hit
// damage are the levers used to settle the budget.
export const ANIMALS: Record<AnimalId, { baseHp: number; dmg: number; speed: number; range: number; attackCooldownMs: number }> = {
  Bee: { baseHp: 40, dmg: 11, speed: 20.4, range: 9, attackCooldownMs: 800 },      // Fastest: fragile flying ranged kiter, rapid stings
  Bear: { baseHp: 95, dmg: 36, speed: 8.16, range: 4, attackCooldownMs: 2050 },    // Slow heavy slammer, biggest single hit
  Bunny: { baseHp: 80, dmg: 14, speed: 18.36, range: 4, attackCooldownMs: 1000 },  // Fast evasive melee skirmisher
  Chicken: { baseHp: 70, dmg: 14, speed: 19.04, range: 4, attackCooldownMs: 900 }, // Fast melee harasser, quick pecks
  Cat: { baseHp: 65, dmg: 20, speed: 16.32, range: 4, attackCooldownMs: 1100 },    // Agile melee duelist, high DPS
  Dolphin: { baseHp: 105, dmg: 19, speed: 13.6, range: 4, attackCooldownMs: 1500 },// Tanky aquatic all-rounder
  Fox: { baseHp: 90, dmg: 19, speed: 14.28, range: 4, attackCooldownMs: 1300 },    // Balanced melee bruiser
  Frog: { baseHp: 60, dmg: 14, speed: 17.68, range: 8, attackCooldownMs: 1300 },   // Amphibious ranged skirmisher (tongue)
  Owl: { baseHp: 45, dmg: 15, speed: 14.96, range: 11, attackCooldownMs: 1400 },   // Longest-range flying sniper, fragile
  Pig: { baseHp: 120, dmg: 20, speed: 12.24, range: 4, attackCooldownMs: 1700 },   // Sturdy slow tank, heavy hits
  Turtle: { baseHp: 155, dmg: 23, speed: 6.8, range: 4, attackCooldownMs: 2000 },  // HP wall, slow weighty blows
  Yetti: { baseHp: 120, dmg: 27, speed: 7.48, range: 4, attackCooldownMs: 1900 },  // Slow juggernaut, high HP and damage
};

// Attack range below which an animal is treated as melee. Above it, the combat
// loop lets the unit attack from distance and back away from faster-closing melee
// threats (kiting) instead of walking into their swing.
const MELEE_RANGE = 5;

// A Base is a wide hexagonal structure, not a point target: its `position` is the
// center of a footprint rendered at BASE_TILE_SIZE * 0.9 ground radius (UnitsLayer).
// The player-activated strikes that are allowed to hit a base (egg, frog tongue,
// bee swarm) add this footprint to their reach so they connect on the base's
// surface instead of only near its exact center. Kept in sync with the render
// footprint by hand — see BASE_TILE_SIZE in UnitsLayer.tsx.
const BASE_FOOTPRINT_RADIUS = 9;

// Turtle "shell" ability tuning. Shelling pins the Turtle in place (it cannot move or
// attack and resists knockback) in exchange for absorbing most incoming damage — the
// shell's defensive payoff. A shelled Turtle still takes this fraction of every hit, so
// it is a tanky damage sponge that buys the army time, not an invulnerable wall.
const SHELL_DAMAGE_TAKEN_FRACTION = 0.35; // 65% damage mitigation while shelled

// Chicken egg-throw ability tuning. The chicken keeps its melee peck (the ANIMALS
// stats above) for normal combat; the egg is a separate, player-activated ranged
// strike fired by holding both mouse buttons while a friendly Chicken is selected.
const EGG_DAMAGE = 10;            // hp removed from the first enemy animal an egg hits
const EGG_SPEED = 45;            // world units per second the egg flies
const EGG_HIT_RADIUS = 2.5;      // an egg hits an enemy whose center passes within this
const EGG_HIT_RADIUS_SQ = EGG_HIT_RADIUS * EGG_HIT_RADIUS;
const EGG_MAX_RANGE = 60;        // an egg expires after flying this far without a hit
const EGG_COOLDOWN_MS = 700;     // minimum time between a chicken's egg throws
const EGG_THROW_POSE_MS = 600;   // how long the Chicken_F3 + Egg throw pose stays up
const EGG_SPAWN_HEIGHT = 1.5;    // height above the chicken's base the egg launches from
const EGG_SPAWN_BACK_OFFSET = 1.0; // how far toward the target (the chicken's rear) the egg spawns, so it leaves from behind

// Frog tongue-grab ability tuning. The frog keeps its melee tongue (the ANIMALS
// stats: range 8) for normal combat; this is a separate, player-activated grab
// fired by holding both mouse buttons while a friendly Frog is selected. The
// tongue extends from the frog's mouth to a single claimed enemy, latches on
// contact, deals the frog's attack damage once, then reels that enemy back to
// the frog. A missed throw simply retracts. See updateFrogTongues + fireTongues.
const TONGUE_RANGE = 20;             // reach of the grab + full extension length (beyond the frog's melee range of 8)
const TONGUE_RANGE_SQ = TONGUE_RANGE * TONGUE_RANGE;
const TONGUE_EXTEND_SPEED = 60;      // world units/sec the tongue tip reaches out
const TONGUE_RETRACT_SPEED = 35;     // world units/sec the tongue (and any catch) reels back
const TONGUE_HIT_RADIUS = 2.0;       // the tongue latches an enemy whose center is within this of the tip
const TONGUE_HIT_RADIUS_SQ = TONGUE_HIT_RADIUS * TONGUE_HIT_RADIUS;
const TONGUE_WINDUP_MS = 100;        // Frog_F2 mouth-open beat before the tongue shoots out
const TONGUE_COOLDOWN_MS = 1500;     // minimum time between a frog's tongue grabs
const TONGUE_DRAG_STOP_DIST = 2.5;   // a dragged enemy stops once this close to the frog's mouth

// Cat "Hiss" ability tuning. A player-activated burst fired by holding both mouse
// buttons while a friendly Cat is selected: the cat flashes its Kitty_F2 hiss pose
// and shoves every enemy within HISS_KNOCKBACK_RANGE radially outward — away from
// the cat's own position — by HISS_KNOCKBACK_DISTANCE. The shove plays out over
// HISS_KNOCKBACK_MS as a constant-velocity slide the tick integrates (see the
// knockback intercept in tick + the hiss action). A surrounded cat therefore pushes
// the whole encircling ring outward at once.
const HISS_POSE_MS = 1000;           // how long the Kitty_F2 hiss pose stays visible (cat is movement-locked this whole time)
const HISS_KNOCKBACK_RANGE = 20;     // enemies whose center is within this radius are knocked back
const HISS_KNOCKBACK_RANGE_SQ = HISS_KNOCKBACK_RANGE * HISS_KNOCKBACK_RANGE;
const HISS_KNOCKBACK_DISTANCE = 20;  // how far each affected enemy is shoved outward, in world units
const HISS_KNOCKBACK_MS = 200;       // duration of the shove slide; distance / time sets the speed
const HISS_KNOCKBACK_SPEED = HISS_KNOCKBACK_DISTANCE / (HISS_KNOCKBACK_MS / 1000); // world units/sec
const HISS_COOLDOWN_MS = 3000;       // minimum time between a cat's hisses

// Bee "Swarm" ability tuning. A player-activated, sacrificial dive fired by holding
// both mouse buttons while a friendly Bee is selected: every selected bee claims the
// nearest enemy no other swarming bee has taken and flies straight at it at
// SWARM_DIVE_SPEED. On reaching SWARM_STING_RANGE it stings once — a coin flip that
// either kills BOTH the bee and its target (SWARM_STING_KILL_CHANCE) or fizzles, after
// which the surviving bee disengages and resumes normal behavior. See swarm + updateBeeSwarms.
const SWARM_DIVE_SPEED = 60;          // world units/sec a swarming bee closes on its target (a fast dive)
const SWARM_STING_RANGE = 3.0;        // distance at which the bee reaches its target and stings
const SWARM_STING_RANGE_SQ = SWARM_STING_RANGE * SWARM_STING_RANGE;
const SWARM_STING_KILL_CHANCE = 0.5;  // probability a sting kills both the target and the bee (vs an animal)
const SWARM_BASE_STING_MULT = 3;      // a sacrificial dive into a Base deals this multiple of the bee's attack damage (a structure can't be coin-flip killed)
const SWARM_WING_FLAP_PER_SEC = 3;    // wing-flap cycles/sec kept advancing so the dive reads as active flight

// Owl "Pickup" ability tuning. A player-activated abduction fired by holding both mouse
// buttons over a unit while a friendly Owl is selected: each selected Owl claims the
// nearest unit matching the clicked unit's animal type AND owner that no other Owl has
// taken, swoops down to it (descending from flight height), grabs it, carries it back up
// to OWL_FLIGHT_HEIGHT and hovers for OWL_CARRY_DURATION_MS, then drops it. A dropped
// enemy takes OWL_FALL_DAMAGE; a dropped friendly lands unharmed (a repositioning/rescue).
// See pickup + updateOwlPickups.
const OWL_FLIGHT_HEIGHT = 10;          // world-unit render lift of a flying Owl (matches verticalOffset); the height it returns to
const OWL_SWOOP_SPEED = 40;            // world units/sec an Owl closes on its target on the XZ plane while diving
const OWL_DESCENT_SPEED = 22;          // world units/sec the Owl's lift drops as it swoops toward the ground
const OWL_ASCENT_SPEED = 16;           // world units/sec the Owl's lift rises as it carries its catch back up
const OWL_GRAB_RANGE = 3.0;            // XZ distance at which the Owl reaches its target and grabs it
const OWL_GRAB_RANGE_SQ = OWL_GRAB_RANGE * OWL_GRAB_RANGE;
const OWL_CARRY_HANG_OFFSET = 5;       // world units the carried unit dangles below the Owl so it never clips the model
const OWL_PLUCK_ALTITUDE = OWL_CARRY_HANG_OFFSET; // lift the Owl swoops down to (hovering above the target); a body-length up keeps it clear of the map while the catch still reaches the ground
const OWL_GRAB_LIFT = 1.5;             // tolerance above pluck altitude within which the talons close
const OWL_DELIVERY_ARRIVAL_RANGE = 8.0;   // XZ distance from the ordered drop-off at which a delivering Owl stops and sets its cargo down beneath itself
const OWL_DELIVERY_ARRIVAL_RANGE_SQ = OWL_DELIVERY_ARRIVAL_RANGE * OWL_DELIVERY_ARRIVAL_RANGE;
const OWL_CARRY_DURATION_MS = 2500;    // how long a grabbed unit is held aloft before being dropped
const OWL_FALL_DAMAGE = 25;            // hp removed from a dropped enemy on impact; friendlies take none
const OWL_WING_FLAP_PER_SEC = 4;       // wing-flap cycles/sec kept advancing so the swoop/carry reads as active flight

// Full roster of playable animals, derived from the stats table so it stays in
// sync automatically when animals are added or removed.
const ALL_ANIMALS = Object.keys(ANIMALS) as AnimalId[];

// ---------------------------------------------------------------------------
// Deterministic simulation primitives (lockstep multiplayer foundation).
//
// The per-frame `tick` and the command handlers it drives must be reproducible:
// given the same starting state, the same seed, and the same ordered command
// stream, both peers must reach byte-identical state every tick. Three sources
// of non-determinism are funneled through the module-level values below so that
// every site reads from the same deterministic source instead of wall-clock
// time, Math.random, or nanoid:
//
//   * simClockMs  — the simulation clock in milliseconds, derived purely from
//                   the tick counter (tick * fixed dt). Replaces performance.now
//                   / Date.now everywhere inside the simulation and the command
//                   handlers, so timers (cooldowns, poses, knockback windows)
//                   advance identically regardless of real wall-clock drift.
//   * simRng      — the active match's seeded PRNG. Repointed to the live store's
//                   `rng` at the top of every tick so module-level helpers (which
//                   have no access to the store draft) share the one instance
//                   that gets seeded at match start and checksummed for desync
//                   detection.
//   * entitySeq   — a monotonic counter for entity ids. Because spawn order is
//                   itself deterministic, ids like "Unit-42" line up across peers
//                   far more cheaply than random nanoids ever could.
//
// In single-player these values still apply (the sim simply runs with a random
// seed and applies commands immediately), so the same code path serves both
// modes and there is no determinism-only branch to drift out of sync.
// ---------------------------------------------------------------------------

/** Simulation clock in milliseconds; set at the top of each tick from the tick counter. */
let simClockMs = 0;

/**
 * Read the current simulation clock (milliseconds since match start). The sim
 * stamps every gameplay timestamp — `lastAttackAtMs`, `hissUntilMs`,
 * `eggThrowUntilMs`, … — in this tick-derived clock (NOT `performance.now()`),
 * so any consumer outside the tick (e.g. the renderer's pose selection) MUST
 * compare against this clock rather than wall time, or the comparison spans two
 * unrelated time bases and the gated pose never shows.
 */
export function getSimClockMs(): number {
  return simClockMs;
}

/** Active match RNG; repointed to the live store's `rng` each tick. Seeded at match start. */
let simRng: SeededRng = new SeededRng(1);

/** Monotonic entity-id counter; reset to 0 at the start of every match. */
let entitySeq = 0;

/**
 * Mint the next deterministic entity id. The single-letter prefix keeps ids
 * readable in logs ("U-3", "Q-1") while the shared counter guarantees global
 * uniqueness within a match. Spawn order is deterministic, so both peers mint
 * the same id for the same unit.
 */
function nextEntityId(prefix: string): string {
  return `${prefix}-${entitySeq++}`;
}

/**
 * Re-seed the deterministic primitives for a fresh match. Returns the new RNG so
 * the caller can store it on the game state (where it is advanced in place and
 * read by the desync checksum). Called by both single-player and multiplayer
 * match starts; multiplayer passes the seed agreed in the start handshake.
 */
function resetDeterministicState(seed: number): SeededRng {
  simClockMs = 0;
  entitySeq = 0;
  simRng = new SeededRng(seed);
  // Clear the module-level distance memo. It rounds positions (lossy), so a cached
  // value depends on which exact position pair first populated its rounded key — if
  // carried over from a prior match in the same process that makes a match's outcome
  // depend on what ran before it (a determinism leak: it desynced parallel-vs-serial
  // training runs, and could desync a multiplayer rematch). Clearing here makes every
  // match start from an empty memo, so the same seed always reproduces.
  distanceCache.clear();
  return simRng;
}

// ---------------------------------------------------------------------------
// Command routing seam (lockstep multiplayer).
//
// In single-player the public command actions (moveCommand, attackTarget, the
// abilities, …) mutate the store immediately. In multiplayer they must instead
// be scheduled by the lockstep engine and executed on an agreed future tick on
// BOTH peers, so the simulations stay identical. Rather than fork every action,
// one router seam intercepts them:
//
//   * setCommandRouter(fn) installs a sink (the engine's enqueue). While set,
//     each action hands its serialized command to the sink and returns without
//     mutating (routeCommand → true).
//   * The engine later replays every command — local AND remote — at its tick by
//     calling applyNetCommand, which sets `applyingNetCommand` so routeCommand
//     returns false and the SAME action falls through to its real mutation.
//   * actingPlayerIdOverride lets a replayed command act on its issuer's units
//     rather than the local player's, so a remote order moves remote units. It
//     defaults to the local player (single-player and local input), so the gate
//     logic is unchanged outside of replay.
// ---------------------------------------------------------------------------

let commandRouter: ((command: NetCommand) => void) | null = null;
let applyingNetCommand = false;
let actingPlayerIdOverride: string | null = null;

// Optional, observe-only recorder seam for replay capture (single-player). When
// installed it is called with every command that mutates the simulation — local
// human input (via routeCommand) and AI/issued commands (via applyNetCommand) —
// tagged with the issuing owner. It never affects routing or mutation; it only
// watches, so a full match can be re-simulated later from (seed, lineups, commands).
let commandRecorder: ((ownerId: string, command: NetCommand) => void) | null = null;

/** Install (or clear with null) the replay command recorder (single-player only). */
export function setCommandRecorder(
  recorder: ((ownerId: string, command: NetCommand) => void) | null,
): void {
  commandRecorder = recorder;
}

/** Install (or clear with null) the lockstep command sink. Set on match start/end. */
export function setCommandRouter(router: ((command: NetCommand) => void) | null): void {
  commandRouter = router;
  applyingNetCommand = false;
  actingPlayerIdOverride = null;
}

/** Hand a command to the router if one is installed and we are not mid-replay. */
function routeCommand(command: NetCommand): boolean {
  // Record genuine local input (never replayed commands re-entering through an
  // action — those are captured at applyNetCommand instead, avoiding a double count).
  if (commandRecorder && !applyingNetCommand) {
    const localId = useGameStore.getState().localPlayerId;
    if (localId) commandRecorder(localId, command);
  }
  if (commandRouter && !applyingNetCommand) {
    commandRouter(command);
    return true;
  }
  return false;
}

/** The owner a command currently acts on: the replay override, else the local player. */
function actingOwnerId(state: { localPlayerId: string | null }): string | null {
  return actingPlayerIdOverride ?? state.localPlayerId;
}

/**
 * The slice of store state the monarch-pilot helpers read and write. It
 * intentionally omits the class-typed fields (e.g. spatialGrid) so BOTH the live
 * store object the tick mutates directly (`const draft = get()`, typed Store) and
 * an Immer `WritableDraft<Store>` from a routed action's produce() satisfy it —
 * the same helper can run on either without a cast.
 */
type PilotMutableState = Pick<
  Store,
  | 'units'
  | 'unitOrders'
  | 'localPlayerId'
  | 'pilotedUnitId'
  | 'pilotedUnitIdByOwner'
  | 'pilotMoveByOwner'
  | 'unitPlacementCount'
  | 'unitPlacementCursor'
  | 'pilotedFireTeamId'
  | 'pilotedFireTeamByOwner'
  | 'selectedUnitIds'
>;

/**
 * Stop the given owner from piloting: clear its per-owner pilot slot and drive
 * vector. When the owner is the LOCAL player, also clear the UI mirror
 * (pilotedUnitId), cancel any in-progress placement hold, and reset the local
 * pilotInput singleton — those are local-only concerns and must never be touched
 * for a remote owner (whose pilotInput lives on the other machine). Safe to call
 * whether or not the owner was actually piloting.
 */
function stopOwnerPilot(draft: PilotMutableState, ownerId: string): void {
  // Pin a still-living released monarch where it stands so it holds instead of
  // marching back to a stale anchor (helper defined below; a dead monarch no-ops).
  const previouslyPiloted = draft.pilotedUnitIdByOwner[ownerId];
  if (previouslyPiloted) holdReleasedMonarch(draft, ownerId, previouslyPiloted);
  draft.pilotedUnitIdByOwner[ownerId] = null;
  draft.pilotedFireTeamByOwner[ownerId] = null;
  draft.pilotMoveByOwner[ownerId] = { x: 0, z: 0 };
  if (ownerId === draft.localPlayerId) {
    draft.pilotedUnitId = null;
    draft.pilotedFireTeamId = null;
    draft.unitPlacementCount = 0;
    draft.unitPlacementCursor = null;
    pilotInput.reset();
  }
}

/**
 * Fully release an owner's control of its army: stop piloting (see
 * stopOwnerPilot) and break any monarch rally so its followers drop their
 * synthetic follow orders and halt. The rally-break is the deselect behaviour
 * that used to live inline in clearSelection; it mutates simulation state
 * (followMonarchId / unitOrders) and so is filtered to the acting owner and only
 * applied through the deterministic command path in multiplayer.
 */
function releaseOwnerControl(draft: PilotMutableState, ownerId: string): void {
  stopOwnerPilot(draft, ownerId);
  for (const unit of draft.units) {
    if (unit.ownerId === ownerId && unit.followMonarchId !== undefined) {
      delete unit.followMonarchId;
      delete draft.unitOrders[unit.id];
    }
  }
}

/**
 * Re-home a just-released monarch's stance anchor onto where it currently stands
 * and drop any pending order, so it HOLDS that ground instead of being yanked
 * back to a stale anchor the instant it stops being piloted. While piloting, the
 * tick block drives the monarch with the stick/keys but never updates its anchor,
 * so the anchor still points at the destination of whatever move order preceded
 * piloting. A returns-to-anchor stance (Defensive/Skirmish/Guard) would then
 * leash the monarch straight back there the moment the player switches to another
 * King/Queen — the same stale-anchor snap-back already fixed for rallied
 * followers and deployed fire teams. Pure position-derived write, so both peers
 * apply it identically. No-op when the id doesn't resolve to one of this owner's
 * living units.
 */
function holdReleasedMonarch(draft: PilotMutableState, ownerId: string, monarchId: string): void {
  const monarch = draft.units.find((u) => u.id === monarchId);
  if (!monarch || monarch.ownerId !== ownerId || monarch.hp <= 0) return;
  monarch.anchor = { x: monarch.position.x, y: 0, z: monarch.position.z };
  delete draft.unitOrders[monarch.id];
}

/**
 * Set (or clear, when unitId is null) which monarch an owner is piloting in the
 * deterministic per-owner state, resetting that owner's drive vector so a freshly
 * grabbed monarch starts stationary. Mirrors the choice into the local UI fields
 * when the owner is the local player. Shared by the single-player gesture path
 * and the lockstep apply path so both produce identical simulation state.
 */
function applyPilotSelectionToDraft(draft: PilotMutableState, ownerId: string, unitId: string | null): void {
  // Switching (or stopping) piloting releases the monarch we were driving: pin it
  // where it stands so it doesn't march back to a stale anchor (see helper above).
  const previouslyPiloted = draft.pilotedUnitIdByOwner[ownerId];
  if (previouslyPiloted && previouslyPiloted !== unitId) {
    holdReleasedMonarch(draft, ownerId, previouslyPiloted);
  }

  draft.pilotedUnitIdByOwner[ownerId] = unitId;
  draft.pilotMoveByOwner[ownerId] = { x: 0, z: 0 };
  // Driving a monarch and driving a fire team are mutually exclusive — one drive
  // vector, one target — so grabbing a monarch releases any team this owner was
  // steering (and vice versa in applyPilotFireTeamToDraft).
  if (unitId !== null) draft.pilotedFireTeamByOwner[ownerId] = null;
  if (ownerId === draft.localPlayerId) {
    draft.pilotedUnitId = unitId;
    if (unitId !== null) draft.pilotedFireTeamId = null;
    if (unitId === null) {
      draft.unitPlacementCount = 0;
      draft.unitPlacementCursor = null;
    }
  }
}

/**
 * Hand an owner's drive control onto a deployed fire team (or release it when
 * teamId is null). The owner's pilot vector now steers every member of that team
 * at once; grabbing a team releases any monarch this owner was piloting (the
 * inverse of applyPilotSelectionToDraft) so there is always a single drive target.
 * For the local player it also mirrors the choice into the UI fields and selects
 * the team's members so the player sees who they are about to drive. Shared by the
 * single-player gesture path and the lockstep apply path so both peers steer the
 * same squad deterministically from the synced pilotMove vector.
 */
function applyPilotFireTeamToDraft(draft: PilotMutableState, ownerId: string, teamId: string | null): void {
  draft.pilotedFireTeamByOwner[ownerId] = teamId;
  draft.pilotMoveByOwner[ownerId] = { x: 0, z: 0 };
  // One drive target: taking a team releases this owner's piloted monarch. Pin
  // that released monarch where it stands so it holds instead of marching back to
  // a stale anchor (same fix as applyPilotSelectionToDraft).
  if (teamId !== null) {
    const previouslyPiloted = draft.pilotedUnitIdByOwner[ownerId];
    if (previouslyPiloted) holdReleasedMonarch(draft, ownerId, previouslyPiloted);
    draft.pilotedUnitIdByOwner[ownerId] = null;
  }

  if (ownerId === draft.localPlayerId) {
    draft.pilotedFireTeamId = teamId;
    if (teamId !== null) {
      draft.pilotedUnitId = null;
      draft.unitPlacementCount = 0;
      draft.unitPlacementCursor = null;
      pilotInput.reset();
      // Highlight the squad about to be driven so the player can also right-click
      // order it; an empty team (already wiped) just clears the selection.
      draft.selectedUnitIds = draft.units
        .filter((unit) => unit.ownerId === ownerId && unit.fireTeamId === teamId && unit.hp > 0)
        .map((unit) => unit.id);
    }
  }
}

/**
 * Rally a monarch's army for one owner: make every living same-animal Unit follow
 * it. Idempotent — repeating the rally re-pins the same followers rather than
 * toggling the follow back off, so a second press of the rally/select input never
 * drops the army (that is what the dedicated Deselect input is for). Following is
 * still released the moment a unit receives its own move/attack order (see the
 * follow-break in moveCommand) or the monarch dies. Pure simulation state
 * (followMonarchId) — selection is handled optimistically by the caller, so this
 * never touches it and is safe to replay identically on both peers. A monarch of
 * the wrong owner is ignored.
 */
function applyRallyToDraft(draft: PilotMutableState, ownerId: string, monarchId: string): void {
  const monarch = draft.units.find((u) => u.id === monarchId);
  if (!monarch || monarch.ownerId !== ownerId) return;

  const isFollower = (u: Unit) =>
    u.ownerId === ownerId && u.kind === 'Unit' && u.animal === monarch.animal;

  for (const unit of draft.units) {
    if (!isFollower(unit)) continue;
    unit.followMonarchId = monarch.id;
    // Rally recalls deployed squads: a unit re-pinned to the monarch leaves its
    // fire team, so the teams it absorbs dissolve back into the marching army.
    delete unit.fireTeamId;
  }

  // Any team this owner was driving has just been recalled into the army, so stop
  // steering it; the rally itself now carries those units back to the monarch.
  draft.pilotedFireTeamByOwner[ownerId] = null;
  if (ownerId === draft.localPlayerId) draft.pilotedFireTeamId = null;
}

/**
 * Execute a hold-to-place order for one owner: peel the `count` followers nearest
 * the monarch off the rally and pin them to the monarch's current position,
 * clearing the per-unit combat/blocking/path-cache carry-over (exactly as
 * moveCommand does) so they actually travel. Shared by the single-player path and
 * the lockstep apply path; the follower choice is position-deterministic so both
 * peers peel the same units.
 */
function applyPlaceRalliedToDraft(
  draft: PilotMutableState,
  ownerId: string,
  monarchId: string,
  count: number,
  target?: { x: number; z: number }
): void {
  if (count <= 0) return;
  const monarch = draft.units.find((u) => u.id === monarchId);
  if (!monarch || monarch.ownerId !== ownerId) return;

  const followers = draft.units.filter(
    (unit) =>
      unit.ownerId === ownerId &&
      unit.kind === 'Unit' &&
      unit.animal === monarch.animal &&
      unit.followMonarchId === monarch.id
  );

  // Default deploy drops the units on the monarch; a supplied target (the
  // controller's cursor-deploy) drops them at that chosen ground point instead.
  const destination = target
    ? { x: target.x, y: 0, z: target.z }
    : { x: monarch.position.x, y: 0, z: monarch.position.z };
  const chosen = selectFollowersForPlacement(followers, monarch.position, count);

  // Every unit dropped in this one deploy forms a fire team under a shared id. The
  // id is minted from the deterministic entity sequence so both lockstep peers
  // label the same squad identically (placeRallied is a routed command).
  const fireTeamId = chosen.length > 0 ? nextEntityId('FT') : null;

  for (const unit of chosen) {
    // Break off the rally and pin an explicit destination at the monarch.
    delete unit.followMonarchId;
    if (fireTeamId !== null) unit.fireTeamId = fireTeamId;
    draft.unitOrders[unit.id] = destination;
    unit.unitState = 'moving_to_order';
    delete unit.arrivedAtDestinationMs;

    // Re-home the stance anchor to the deploy point (as moveCommand does for a
    // move order): a deployed fire team's "home" is the ground it was sent to, so
    // a returns-to-anchor stance (Defensive/Skirmish/Guard) leashes and holds
    // there instead of wandering back to a stale anchor — e.g. the monarch's
    // position from when these units were still rallied to it. HoldGround already
    // ignores the anchor; this keeps every other posture honoring the deploy spot.
    unit.anchor = { x: destination.x, y: 0, z: destination.z };

    // Clear combat, blocking and landing carry-over so the new order wins.
    delete unit.lastCombatTargetId;
    delete unit.lastCombatEngagementMs;
    delete unit.priorityAttacker;
    unit.collisionAttempts = 0;
    delete unit.movementPausedUntilMs;
    delete unit.firstBlockedAtMs;
    delete unit.nearDestinationSinceMs;

    // Drop the cached A* path so the unit re-routes to the placement point
    // instead of steering toward its previous goal (see moveCommand).
    delete unit.pathWaypoints;
    delete unit.pathIndex;
    delete unit.pathDestX;
    delete unit.pathDestZ;
    delete unit.pathVersion;
    delete unit.pathStall;
    delete unit.pathProgressDist;
  }

  // Deployed units leave the monarch's command group: drop them from the local
  // selection so they aren't swept up by the next order. Selection is local-only
  // UI, so only touch it for the local player's own placement (never a remote
  // peer's), and it never feeds the determinism checksum.
  if (ownerId === draft.localPlayerId && chosen.length > 0) {
    const placedIds = new Set(chosen.map((unit) => unit.id));
    draft.selectedUnitIds = draft.selectedUnitIds.filter((id) => !placedIds.has(id));
  }
}

/**
 * Advance one unit by a normalized pilot drive vector for a single tick: face the
 * heading, step at moveSpeed scaled by the (clamped) analog magnitude, tick the
 * locomotion animation, and resolve the step against terrain and other units.
 * Shared by the monarch-pilot branch (one King/Queen) and the fire-team drive
 * branch (every member of a remotely driven squad) so both move with identical
 * physics from one place. The caller guarantees `inputMagnitude` > 0 and owns
 * clearing any stale order/patrol before calling.
 */
function applyPilotDriveStep(
  unit: Unit,
  move: { x: number; z: number },
  inputMagnitude: number,
  dtSec: number,
  units: Unit[],
  movementPriorityIds: ReadonlySet<string>,
  playerControlledOwnerIds: ReadonlySet<string>,
  unitOrders: Record<string, Position3D>,
  spatialGrid: SpatialGrid | null
): void {
  // Normalize the steering direction but let an analog stick scale speed (clamped
  // so a digital key press, which reports magnitude 1, is full speed).
  const dirX = move.x / inputMagnitude;
  const dirZ = move.z / inputMagnitude;
  const moveDistance = unit.moveSpeed * dtSec * Math.min(inputMagnitude, 1);
  unit.rotation = Math.atan2(dirX, dirZ);

  // Locomotion animation flags, matching the rest of the movement code.
  if (unit.animal === 'Frog' || unit.animal === 'Bunny') {
    unit.isHopping = true;
    const hopSpeed = unit.moveSpeed / 5;
    unit.hopPhase = ((unit.hopPhase || 0) + hopSpeed * dtSec) % 1;
  }
  if (unit.animal === 'Owl') {
    unit.isFlying = true;
    const flapSpeed = 3;
    unit.wingPhase = ((unit.wingPhase || 0) + flapSpeed * dtSec) % 1;
  }

  const newPosition: Position3D = {
    x: unit.position.x + dirX * moveDistance,
    y: unit.position.y,
    z: unit.position.z + dirZ * moveDistance,
  };
  unit.position = checkCollision(newPosition, unit, units, 2.5, movementPriorityIds, playerControlledOwnerIds, unitOrders, spatialGrid);
}

/**
 * Begin (or stop, when monarchId is null) piloting a monarch the LOCAL player
 * just selected via a gesture (slot / cycle / toggle). Updates the local UI
 * (gold ring + selection) immediately for responsive feedback, then makes the
 * sim-authoritative pilot change: routed through lockstep in multiplayer (so both
 * peers switch on the same tick) or applied at once in single-player. Defined at
 * module scope so the three gesture actions share one code path.
 */
function beginLocalPilot(monarchId: string | null): void {
  const prev = useGameStore.getState();
  const localPlayerId = prev.localPlayerId;
  if (!localPlayerId) return;

  // The newly grabbed monarch starts from rest; drop any stale drive intent.
  pilotInput.reset();

  // Optimistic local UI: the ring and selection track the choice this frame,
  // before the (possibly delayed) simulation switch lands.
  useGameStore.setState({
    pilotedUnitId: monarchId,
    unitPlacementCount: monarchId === null ? 0 : prev.unitPlacementCount,
    unitPlacementCursor: monarchId === null ? null : prev.unitPlacementCursor,
    selectedUnitIds: monarchId
      ? selectionForMonarch(prev.units, monarchId)
      : prev.selectedUnitIds,
  });

  if (routeCommand({ type: 'setPilot', payload: { unitId: monarchId } })) return;
  useGameStore.setState((s) =>
    produce(s, (draft) => applyPilotSelectionToDraft(draft, localPlayerId, monarchId))
  );
}

/**
 * Returns `count` distinct animals chosen uniformly at random from the full
 * roster. Used to give the AI opponent a varied lineup each match instead of a
 * fixed set. Uses a partial Fisher-Yates shuffle so every animal has an equal
 * chance of being picked without repeats.
 *
 * Intentionally uses Math.random rather than the deterministic simRng: this runs
 * at single-player setup time (the AI lineup), before any match seed exists, and
 * is never part of the per-tick simulation. Multiplayer takes both lineups from
 * the shared lobby instead of calling this, so leaving it non-deterministic does
 * not affect lockstep sync.
 */
function pickRandomAnimals(count: number): AnimalId[] {
  const roster = [...ALL_ANIMALS];
  for (let i = roster.length - 1; i > 0; i--) {
    const swapIndex = Math.floor(Math.random() * (i + 1));
    [roster[i], roster[swapIndex]] = [roster[swapIndex], roster[i]];
  }
  return roster.slice(0, count);
}

// Fixed starting base positions per role. p0 holds the +z (south) edge, p1 the
// -z (north) edge. Shared by single-player setup (initializeGame) and the
// multiplayer match builder so both modes — and both peers — place bases at the
// exact same coordinates. Hoisted to module scope so the two call sites cannot
// drift apart.
const P0_BASE_POSITIONS: Position3D[] = [
  { x: 73.5, y: 0.25, z: 252 },
  { x: -2, y: 0.25, z: 252 },
  { x: -77, y: 0.25, z: 252 },
];
const P1_BASE_POSITIONS: Position3D[] = [
  { x: 76.5, y: 0.25, z: -248 },
  { x: 1, y: 0.25, z: -248 },
  { x: -74, y: 0.25, z: -248 },
];

const defaultConfig: GameConfig = {
  mapSize: 50,
  spawnIntervalMs: 5_000,
  regenPerSecondNearQueen: 5,
  regenRadius: 8,
  kingAuraRadius: 8,
  kingDamageMultiplier: 2,
};

// Zero-valued match scoring counters. Used as the starting point on every new
// match and re-exported as a factory so callers don't share a mutable reference.
function createEmptyMatchStats(): MatchStats {
  return {
    unitsGenerated: 0,
    enemyUnitsKilled: 0,
    enemyBasesDestroyed: 0,
    enemyKingsKilled: 0,
    enemyQueensKilled: 0,
    aiUnitsGenerated: 0,
    playerUnitsKilled: 0,
    playerBasesDestroyed: 0,
    playerKingsKilled: 0,
    playerQueensKilled: 0,
    matchDurationMs: 0,
    rightBridgeDownMs: 0,
    leftBridgeDownMs: 0,
    enemyRightBridgeDownMs: 0,
    enemyLeftBridgeDownMs: 0,
  };
}

type GameScreen = 'menu' | 'lobby' | 'multiplayer' | 'playing' | 'postgame' | 'leaderboard' | 'conquestLobby' | 'conquest';

type Store = GameState & {
  // Screen management
  currentScreen: GameScreen;
  transitionToScreen: (screen: GameScreen) => void;

  initializeGame: () => void;
  chooseAnimalsForLocal: (animals: AnimalId[]) => void;
  startMatch: (withAI?: boolean, seed?: number) => void;
  // Configure + start a 1v1 human-vs-human match from the agreed start handshake
  // (shared seed + both lineups), keyed to this peer's role. Sets up two non-AI
  // players, the local player id, netMode, and runs startMatch with the seed.
  startMultiplayerMatch: (params: { localRole: PlayerRole; seed: number; lineups: Record<PlayerRole, AnimalId[]> }) => void;
  tick: (dtSec: number, nowMs: number) => void;
  moveCommand: (cmd: CommandMoveUnits) => void;
  setPatrol: (cmd: CommandSetPatrol) => void;
  setQueenRally: (cmd: CommandSetQueenRally) => void;
  setMovementHold: (unitId: string | null) => void;
  attackTarget: (cmd: CommandAttackTarget) => void;
  setBehavior: (cmd: CommandSetBehavior) => void;
  // Put one of the acting owner's deployed fire teams into a formation shape: each
  // living member is sent to its slot around the squad's centroid, oriented to the
  // team's heading. The King's "play call". Routed so multiplayer peers shape the
  // same squad identically. See CommandSetFormation and formations.ts.
  setFormation: (cmd: CommandSetFormation) => void;
  // Mid-play "audible" on a formed team: pivot, expand/contract, or disband. Routed
  // so multiplayer peers adjust the same team identically. See CommandAdjustFormation.
  adjustFormation: (cmd: CommandAdjustFormation) => void;
  // Call a play from the King's playbook: re-shape + re-posture all of the acting
  // player's formed teams by their auto-classified positional role. Routed for MP.
  callPlay: (cmd: CommandCallPlay) => void;
  selectUnits: (unitIds: string[]) => void;
  addToSelection: (unitIds: string[]) => void;
  clearSelection: () => void;
  // Direct monarch piloting (A cycles monarchs, G toggles King/Queen, Space
  // rallies). See monarchPilot.ts and the pilot-movement block in tick().
  pilotMonarchBySlot: (slotIndex: number) => void;
  // Pilot a specific monarch by unit id (the on-screen King/Queen buttons).
  // Pressing the same monarch's button again unpilots it. Validates the unit is
  // one of the local player's living monarchs before grabbing control.
  pilotMonarchById: (unitId: string) => void;
  pilotCycleMonarch: () => void;
  togglePilotMonarchKind: () => void;
  rallyToMonarch: () => void;
  // Cycle the local player's drive control through their deployed fire teams
  // (squads dropped by the Deploy hold), then back to no team. While a team is
  // driven the ESDF/stick vector steers every member at once. See monarchPilot.ts
  // (listFireTeamIds / nextFireTeamInCycle) and the fire-team block in tick().
  cycleFireTeam: () => void;
  // Hold-to-place: while the rally key is held over a piloted monarch, the input
  // layer calls incrementUnitPlacement once per UNIT_PLACEMENT_INTERVAL_MS to
  // designate one more follower; on release placeRalliedUnits peels that many
  // followers off to the monarch's position; resetUnitPlacement clears a gesture
  // that ended without placing (a quick tap, a cancel, or the monarch dying).
  incrementUnitPlacement: () => number;
  // Place `count` followers. With no target they land on the monarch (the rally
  // key gesture); with a target ground point they land there (the controller's
  // hold-right-trigger cursor deploy).
  placeRalliedUnits: (count: number, target?: { x: number; z: number }) => void;
  resetUnitPlacement: () => void;
  // Set the ground point the teardrop indicator floats above (the cursor deploy),
  // or null to fall back to floating above the piloted monarch. Local UI only.
  setUnitPlacementCursor: (point: Position3D | null) => void;
  clearPilot: () => void;
  // Deterministic apply-side handlers for the piloting net commands. Invoked by
  // applyNetCommand with the issuing owner so a lockstep peer mutates the right
  // owner's per-owner pilot state. In single-player the gesture actions below
  // call into the same per-owner mutations directly (no routing).
  applyPilotSelection: (ownerId: string, unitId: string | null) => void;
  applyPilotMove: (ownerId: string, move: { x: number; z: number }) => void;
  applyRallyMonarch: (ownerId: string, monarchId: string) => void;
  applyPlaceRallied: (ownerId: string, monarchId: string, count: number, target?: { x: number; z: number }) => void;
  applyReleaseControl: (ownerId: string) => void;
  applyPilotFireTeam: (ownerId: string, teamId: string | null) => void;
  toggleTurtleShell: (unitIds: string[]) => void;
  throwEggs: (cmd: CommandThrowEggs) => void;
  fireTongues: (cmd: CommandFireTongues) => void;
  hiss: (cmd: CommandHiss) => void;
  swarm: (cmd: CommandSwarm) => void;
  pickup: (cmd: CommandOwlPickup) => void;
  deliverCargo: (cmd: CommandOwlDeliver) => void;
  toggleOptimization: (key: keyof Store['optimizations']) => void;
  // Bridge animation system
  bridgeState: BridgeState;
  updateBridgeAnimations: (nowMs: number) => void;
  // Performance optimization: cache for unit counts per player/animal
  unitCountCache: Record<string, Record<AnimalId, number>>;
  spatialGrid: SpatialGrid | null;
  // Regeneration throttling
  lastRegenCheckMs: number;
  tickCounter: number;
  debugTickCount?: number;
  // Deterministic match RNG (lockstep multiplayer). Seeded at match start, then
  // advanced in place by the simulation; both peers seed it identically so every
  // "random" outcome resolves the same way without crossing the network. Its
  // state also feeds the per-K-tick desync checksum. See resetDeterministicState.
  rng: SeededRng;
  // The numeric seed the current match's RNG was created from. In multiplayer
  // the host generates this and broadcasts it in the start handshake so both
  // peers reseed identically; in single-player it is a throwaway random value.
  matchSeed: number;
  // Networking mode for the current session. 'single' runs the legacy local
  // game (commands apply immediately); 'host'/'guest' route commands through the
  // lockstep engine instead. Drives the command-router seam in the store actions.
  netMode: 'single' | 'host' | 'guest';
  // AI thinking throttling
  aiThinkingOffset: Record<string, number>;
  // Movement caching
  movementDirectionCache: Record<string, Position3D>;
  // Target caching for AI units
  targetCache: Record<string, string>;
  // Win condition throttling
  lastWinCheckMs: number;
  // Dead units batch
  deadUnitsToRemove: string[];
  // Ultra-aggressive optimization toggle
  ultraPerformanceMode: boolean;
  // Optimization toggles for testing
  optimizations: {
    aiThrottling: boolean;
    combatBatching: boolean;
    movementCaching: boolean;
    regenThrottling: boolean;
    winCheckThrottling: boolean;
    deadUnitBatching: boolean;
    spawnOptimization: boolean;
  };
  // Game pause state
  isPaused: boolean;
  unpauseGame: () => void;
  togglePause: () => void;

  // Remappable controls. Keyboard/mouse and controller each carry a full binding
  // map (which input) plus a parallel activation-mode map (tap / double-tap / hold /
  // chord); see components/Working/controlBindings.ts. Setters persist to
  // localStorage so a player's layout survives reloads.
  keyboardBindings: ControlBindings;
  controllerBindings: ControlBindings;
  keyboardBindingModes: ControlBindingModes;
  controllerBindingModes: ControlBindingModes;
  setBinding: (device: InputDevice, actionId: ControlActionId, token: string) => void;
  setBindingMode: (device: InputDevice, actionId: ControlActionId, mode: ActivationMode) => void;
  resetBindings: (device: InputDevice) => void;
  // Lighting settings
  lightingSettings: {
    sunBrightness: number;
    moonBrightness: number;
    ambientLight: number;
    dayNightSpeed: number;
    // Renderer tone-mapping exposure (AgX). Higher = brighter overall; lets the player
    // pull highlights back from washing out or lift a too-dark scene without touching
    // individual lights. See SceneLighting.
    exposure: number;
    // Image-based-lighting (IBL) strength: drives material.envMapIntensity for the soft,
    // wrap-around fill from the baked studio environment. Higher = richer, more "rendered"
    // fill on the model's shadowed side. See SceneLighting.
    environmentIntensity: number;
    // Final-image color grade, applied as a CSS filter on the WebGL canvas (cheap, live, and
    // only affects the 3D, not the HUD). Neutral values are 1.0 (and 0° hue). See SceneLighting.
    saturation: number; // 1 = unchanged, >1 more vivid, 0 greyscale
    contrast: number;   // 1 = unchanged
    brightness: number; // 1 = unchanged (a post-grade lift, distinct from exposure)
    hue: number;        // degrees of hue rotation, 0 = unchanged
  };
  updateLightingSettings: (settings: Partial<Store['lightingSettings']>) => void;
  // Render quality
  shadowsEnabled: boolean;
  setShadowsEnabled: (enabled: boolean) => void;
  // Floating unit health bars (shown only while a unit is taking damage or healing)
  healthBarsEnabled: boolean;
  setHealthBarsEnabled: (enabled: boolean) => void;
  // Team-colored aura outline around each unit (blue = own, red = enemy) so units
  // read clearly against the terrain; persisted across sessions
  unitAurasEnabled: boolean;
  setUnitAurasEnabled: (enabled: boolean) => void;
  // Background music on/off (persisted across sessions)
  musicEnabled: boolean;
  setMusicEnabled: (enabled: boolean) => void;
  // Per-device input speed multipliers (1 = the tuned default). "scroll" scales the
  // camera zoom + pan rate; "cursor" scales the controller reticle (and the keyboard
  // edge-scroll, since the OS owns the actual mouse pointer). Persisted across sessions
  // and read each frame by CameraController and GamepadController.
  controlSpeeds: {
    keyboardScroll: number;
    keyboardCursor: number;
    controllerScroll: number;
    controllerCursor: number;
  };
  updateControlSpeeds: (settings: Partial<Store['controlSpeeds']>) => void;
};

// Persisted render-quality toggle. Shadows default OFF: enabling them adds a
// full shadow-map render pass that hurts FPS most on the low-end / integrated
// GPUs a portfolio visitor may be on. Players opt in from the pause menu.
const SHADOWS_STORAGE_KEY = 'rts-shadows-enabled';
const loadShadowsEnabled = (): boolean => {
  try {
    return localStorage.getItem(SHADOWS_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

// Persisted lighting settings. Tuned for a bright, stylized ("Pixar"-leaning) look:
// soft IBL fill + AgX tone mapping keep colors vivid without the day/night sun washing
// out highlights or crushing the shadow side to black. The values are the player-facing
// knobs the Settings → Video tab exposes; defaults are the starting point, and any saved
// override is merged on top (so older saves that predate exposure/environmentIntensity
// transparently pick up sensible values for the new fields).
const LIGHTING_STORAGE_KEY = 'lightingSettings';
const DEFAULT_LIGHTING_SETTINGS = {
  sunBrightness: 9.5,
  moonBrightness: 15,
  ambientLight: 5,
  dayNightSpeed: 210,
  exposure: 0.4,
  environmentIntensity: 1.7,
  saturation: 1.5,
  contrast: 1.0,
  brightness: 0.95,
  hue: 0,
};
type LightingSettings = typeof DEFAULT_LIGHTING_SETTINGS;
const loadLightingSettings = (): LightingSettings => {
  try {
    const raw = localStorage.getItem(LIGHTING_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LIGHTING_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<LightingSettings>;
    // Merge over defaults so a missing/older key never yields NaN or undefined.
    return { ...DEFAULT_LIGHTING_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_LIGHTING_SETTINGS };
  }
};

// Persisted health-bar toggle. Defaults ON so players see damage/heal feedback;
// the video settings tab flips it and the choice survives page reloads. Stored
// as a string so the absence of the key (first visit) resolves to the default.
const HEALTH_BARS_STORAGE_KEY = 'rts-health-bars-enabled';
const loadHealthBarsEnabled = (): boolean => {
  try {
    const raw = localStorage.getItem(HEALTH_BARS_STORAGE_KEY);
    if (raw === null) return true; // default on
    return raw === 'true';
  } catch {
    return true;
  }
};

// Persisted unit-aura toggle. Defaults ON so the team-colored outline helps units
// stand out against the terrain; the video settings tab flips it and the choice
// survives page reloads. Stored as a string so the absence of the key (first
// visit) resolves to the default rather than a forced "off".
const UNIT_AURAS_STORAGE_KEY = 'rts-unit-auras-enabled';
const loadUnitAurasEnabled = (): boolean => {
  try {
    const raw = localStorage.getItem(UNIT_AURAS_STORAGE_KEY);
    if (raw === null) return true; // default on
    return raw === 'true';
  } catch {
    return true;
  }
};

// Persisted background-music toggle. Defaults ON so first-time visitors hear
// the soundtrack; the speaker icon in the HUD flips it and the choice survives
// page reloads. Stored as a string so the absence of the key (first visit)
// resolves to the default rather than a forced "off".
const MUSIC_STORAGE_KEY = 'rts-music-enabled';
const loadMusicEnabled = (): boolean => {
  try {
    const raw = localStorage.getItem(MUSIC_STORAGE_KEY);
    if (raw === null) return true; // default on
    return raw === 'true';
  } catch {
    return true;
  }
};

// Persisted per-device input speed multipliers. All default to 1.0 (the values the
// camera/reticle were originally tuned to), so an existing player notices no change
// until they move a slider. Stored as one JSON object and merged over the defaults so
// a save that predates a field still resolves to a sensible 1.0 rather than NaN.
const CONTROL_SPEEDS_STORAGE_KEY = 'rts-control-speeds';
const DEFAULT_CONTROL_SPEEDS = {
  keyboardScroll: 1,
  keyboardCursor: 1,
  controllerScroll: 1,
  controllerCursor: 1,
};
type ControlSpeeds = typeof DEFAULT_CONTROL_SPEEDS;
const loadControlSpeeds = (): ControlSpeeds => {
  try {
    const raw = localStorage.getItem(CONTROL_SPEEDS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONTROL_SPEEDS };
    const parsed = JSON.parse(raw) as Partial<ControlSpeeds>;
    return { ...DEFAULT_CONTROL_SPEEDS, ...parsed };
  } catch {
    return { ...DEFAULT_CONTROL_SPEEDS };
  }
};

// A formation member must drift more than this far from its assigned slot before
// the maintenance pass re-issues a move order to it. Larger than typical slot
// spacing so a unit that steps out to trade blows and returns via its stance leash
// isn't yanked back every tick; it only re-paths when the formation has genuinely
// relocated (or it has wandered well out of place).
const FORMATION_REFORM_DISTANCE = 8;

// On a re-slot (re-shape / re-face / membership change) a member already standing on
// its new slot is left in place rather than issued a fresh march order: re-ordering it
// would wipe its path cache and re-path it for no movement, and a whole squad re-shaped
// near its current footprint pays that for every member at once (the directing burst).
// Kept tight (well under FORMATION_REFORM_DISTANCE) so only genuinely-in-place members
// are skipped. Squared to compare against squared distance without a sqrt.
const FORMATION_IN_PLACE_DISTANCE_SQ = 1;

// Arrival radius for a formation member walking to its slot. A member clears its march
// order and goes idle once within this distance of its slot, instead of the tight 0.5 a
// free-roaming unit uses. Two members each occupy a ~2.5-radius footprint, so packed
// slots (a column, a box corner, a tight line) are physically unreachable to 0.5 — a
// member would crawl/jitter against its neighbours forever, never clearing the order,
// paying full movement + a blocker-deflection spatial scan every tick (the steady-state
// drag that holding a formation otherwise incurs). Settling ~one collision-diameter out
// lets the squad lock in: the stance leash (anchor pinned to the slot) still holds the
// shape, and the larger FORMATION_REFORM_DISTANCE re-forms anyone genuinely shoved off.
// Set to the collision floor (UNIT_MINIMUM_SPACING, declared later in this module) so a
// member settles as close as crowding physically allows — tight, but never unreachable.
const FORMATION_ARRIVAL_DISTANCE = 3.75;

// Audible step sizes. Re-facing pivots the formation 30° per press; expand/contract
// widen/tighten the slot spacing within sane bounds so a shape never collapses onto
// itself or scatters out of cohesion.
const FORMATION_ROTATE_STEP = Math.PI / 6;
const FORMATION_SPACING_STEP = 2;
const FORMATION_MIN_SPACING = 3;
const FORMATION_MAX_SPACING = 24;

// The slice of state the formation maintenance pass reads and writes. Mirrors the
// PilotMutableState pattern so the live tick draft (typed Store) satisfies it.
type FormationMutableState = Pick<Store, 'units' | 'unitOrders' | 'fireTeams'>;

// Drop a unit's cached A* route and arrival/blocking carry-over so its next tick
// re-paths cleanly to a freshly issued order (same fields moveCommand clears).
function clearMovementCarryOver(unit: Unit): void {
  delete unit.arrivedAtDestinationMs;
  delete unit.lastCombatTargetId;
  delete unit.lastCombatEngagementMs;
  delete unit.priorityAttacker;
  unit.collisionAttempts = 0;
  delete unit.movementPausedUntilMs;
  delete unit.firstBlockedAtMs;
  delete unit.nearDestinationSinceMs;
  delete unit.pathWaypoints;
  delete unit.pathIndex;
  delete unit.pathDestX;
  delete unit.pathDestZ;
  delete unit.pathVersion;
  delete unit.pathStall;
  delete unit.pathProgressDist;
}

// Slice of state the fire-team drive pre-pass reads/writes: it only nudges each
// driven shaped team's anchor, leaving the member slotting to maintainFormations.
type FireTeamDriveState = Pick<
  Store,
  'units' | 'fireTeams' | 'pilotedFireTeamByOwner' | 'pilotMoveByOwner'
>;

/**
 * Drive each shaped fire team a player is steering by moving its FORMATION ANCHOR,
 * not its individual members. Run once per tick before maintainFormations: for
 * every owner whose driven team holds a formation, advance the team's anchor along
 * the owner's drive vector at the squad's pace (the slowest member's speed, so no
 * one is permanently left behind), keeping the facing fixed so the shape only
 * translates. maintainFormations then flows the members toward the moved slots via
 * the normal order/pathfinding path — so the squad keeps its shape (and respects
 * walls) as it travels, instead of collapsing into a blob. Unshaped driven teams
 * are untouched here and handled by the per-unit drive block in the movement loop.
 * Deterministic: fixed owner-key order, drive vectors come from the synced
 * pilotMoveByOwner, and the pace is derived from the same member set on both peers.
 */
function applyFireTeamDrive(draft: FireTeamDriveState, dtSec: number): void {
  for (const ownerId of Object.keys(draft.pilotedFireTeamByOwner)) {
    const teamId = draft.pilotedFireTeamByOwner[ownerId];
    if (teamId === null) continue;
    const team = draft.fireTeams[teamId];
    if (!team) continue; // unshaped driven team — the per-unit drive block owns it

    const move = draft.pilotMoveByOwner[ownerId] ?? { x: 0, z: 0 };
    const magnitude = Math.hypot(move.x, move.z);
    if (magnitude <= 0.0001) continue; // not actively driving this frame

    // Pace the formation by its slowest living member so the shape doesn't tear.
    let slowest = Infinity;
    for (const unit of draft.units) {
      if (unit.fireTeamId === teamId && unit.kind === 'Unit' && unit.hp > 0) {
        if (unit.moveSpeed < slowest) slowest = unit.moveSpeed;
      }
    }
    if (!Number.isFinite(slowest)) continue; // no living members

    const clampedMagnitude = Math.min(magnitude, 1);
    const step = (slowest * clampedMagnitude * dtSec) / magnitude; // normalizes move
    team.anchor = {
      x: team.anchor.x + move.x * step,
      y: 0,
      z: team.anchor.z + move.z * step,
    };
    // No dirty flag: the anchor moved, so maintainFormations' stable branch re-homes
    // the slots and re-orders members as they drift, without a per-frame A* re-slot.
  }
}

/**
 * Keep every fire team in its formation. Run once per tick before the per-unit
 * movement loop. For each team that has a formation (a GameState.fireTeams entry):
 *   - collect its living member Units, sorted by id (lockstep-stable order),
 *   - drop the entry entirely when none remain,
 *   - and when the formation has changed (`dirty`) or its membership changed since
 *     the last slotting (`memberKey`), re-slot: pin each member's anchor to its slot
 *     and issue a move order toward it so it walks into place.
 * Between changes nothing is touched — the anchors set at the last slotting let each
 * member's stance leash hold the shape, and members that drift past
 * FORMATION_REFORM_DISTANCE from their slot are nudged back. All inputs are derived
 * deterministically (sorted ids, assignSlots sorts internally), so both lockstep
 * peers maintain identical formations.
 */
function maintainFormations(draft: FormationMutableState): void {
  const teamIds = Object.keys(draft.fireTeams);
  if (teamIds.length === 0) return;

  // Group living members by team in one pass.
  const membersByTeam = new Map<string, Unit[]>();
  for (const unit of draft.units) {
    const teamId = unit.fireTeamId;
    if (teamId === undefined || unit.kind !== 'Unit' || unit.hp <= 0) continue;
    if (!draft.fireTeams[teamId]) continue;
    const list = membersByTeam.get(teamId);
    if (list) list.push(unit);
    else membersByTeam.set(teamId, [unit]);
  }

  for (const teamId of teamIds) {
    const team = draft.fireTeams[teamId];
    const members = membersByTeam.get(teamId);

    // A team that has lost every member is disbanded so its slot/state can't linger.
    if (!members || members.length === 0) {
      delete draft.fireTeams[teamId];
      continue;
    }

    members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const memberKey = members.map((unit) => unit.id).join(',');
    const membershipChanged = memberKey !== team.memberKey;

    // Clear a focus-fire target that has died/left so it doesn't pin stale orders.
    if (team.focusTargetId !== undefined) {
      const target = draft.units.find((unit) => unit.id === team.focusTargetId);
      if (!target || target.hp <= 0) team.focusTargetId = undefined;
    }

    // A re-slot (`reslotAll`) re-shapes the squad and marches EVERY member to its new
    // slot — triggered only by an explicit change (a command set `dirty`) or a member
    // gained/lost. Otherwise the team is stable: its anchors still hold the shape and
    // only stragglers are nudged back. The slot GEOMETRY, though, must be recomputed
    // whenever any input that moves the slots changes — which includes the anchor
    // drifting under the drive pre-pass (it moves the anchor without setting `dirty`).
    const reslotAll = team.dirty || membershipChanged;
    const slotsInputsChanged =
      reslotAll ||
      team.slots === undefined ||
      team.slotShape !== team.shape ||
      team.slotAnchorX !== team.anchor.x ||
      team.slotAnchorZ !== team.anchor.z ||
      team.slotFacing !== team.facing ||
      team.slotSpacing !== team.spacing;

    // Recompute the slot assignment only when an input actually changed; otherwise reuse
    // the cached map. This skips the per-tick sort + per-member trig + allocations for
    // every formation that is simply holding station — the dominant steady-state cost.
    let slots: Record<string, Position3D>;
    if (slotsInputsChanged) {
      slots = assignSlots(members.map((u) => u.id), team.shape, team.anchor, team.facing, team.spacing);
      team.slots = slots;
      team.slotShape = team.shape;
      team.slotAnchorX = team.anchor.x;
      team.slotAnchorZ = team.anchor.z;
      team.slotFacing = team.facing;
      team.slotSpacing = team.spacing;
    } else {
      slots = team.slots!;
    }

    for (const unit of members) {
      const slot = slots[unit.id];
      unit.anchor = { x: slot.x, y: 0, z: slot.z };
      const dx = unit.position.x - slot.x;
      const dz = unit.position.z - slot.z;
      const distSq = dx * dx + dz * dz;
      if (reslotAll) {
        // Already on its new slot: leave it be rather than wiping its path cache and
        // re-pathing it for zero movement (the directing-burst saver).
        if (distSq <= FORMATION_IN_PLACE_DISTANCE_SQ) {
          delete draft.unitOrders[unit.id];
          unit.unitState = 'idle';
        } else {
          draft.unitOrders[unit.id] = { x: slot.x, y: 0, z: slot.z };
          unit.unitState = 'moving_to_order';
          clearMovementCarryOver(unit);
        }
      } else if (distSq > FORMATION_REFORM_DISTANCE * FORMATION_REFORM_DISTANCE) {
        // Stable: only a member that has wandered well out of place is nudged back.
        draft.unitOrders[unit.id] = { x: slot.x, y: 0, z: slot.z };
        unit.unitState = 'moving_to_order';
        clearMovementCarryOver(unit);
      }
    }

    if (reslotAll) {
      team.dirty = false;
      team.memberKey = memberKey;
    }
  }
}

export const useGameStore = create<Store>((set, get) => ({
  // Screen state
  currentScreen: 'menu',
  transitionToScreen: (screen) => set({ currentScreen: screen }),

  config: defaultConfig,
  players: [],
  units: [],
  lastSpawnAtMsByQueenId: {},
  lastRegenAtMsByUnitId: {},
  selectedAnimalPool: ['Bee', 'Bear', 'Fox'],
  localPlayerId: null,
  matchStarted: false,
  matchStartNonce: 0,
  gameOver: false,
  winner: null,
  selectedUnitIds: [],
  pilotedUnitId: null,
  pilotedUnitIdByOwner: { p0: null, p1: null },
  pilotMoveByOwner: { p0: { x: 0, z: 0 }, p1: { x: 0, z: 0 } },
  pilotedFireTeamId: null,
  pilotedFireTeamByOwner: { p0: null, p1: null },
  fireTeams: {},
  movementHeldUnitId: null,
  unitPlacementCount: 0,
  unitPlacementCursor: null,
  unitOrders: {},
  queenPatrols: {},
  queenRallyTargets: {},
  unitCountCache: {},
  spatialGrid: null,
  lastRegenCheckMs: 0,
  tickCounter: 0,
  rng: simRng,
  matchSeed: 0,
  netMode: 'single',
  aiThinkingOffset: {},
  movementDirectionCache: {},
  targetCache: {},
  lastWinCheckMs: 0,
  deadUnitsToRemove: [],
  matchStats: createEmptyMatchStats(),
  projectiles: [],
  ultraPerformanceMode: true, // Enable ultra mode by default
  optimizations: {
    aiThrottling: true,
    combatBatching: true,
    movementCaching: true,
    regenThrottling: true,
    winCheckThrottling: true,
    deadUnitBatching: true,
    spawnOptimization: true,
  },
  isPaused: false,
  unpauseGame: () => set({ isPaused: false }),
  togglePause: () => set((state) => ({ isPaused: !state.isPaused })),

  keyboardBindings: loadBindings('keyboard'),
  controllerBindings: loadBindings('controller'),
  keyboardBindingModes: loadModes('keyboard'),
  controllerBindingModes: loadModes('controller'),
  setBinding: (device, actionId, token) => set((state) => {
    const isKeyboard = device === 'keyboard';
    const bindings = isKeyboard ? state.keyboardBindings : state.controllerBindings;
    const modes = isKeyboard ? state.keyboardBindingModes : state.controllerBindingModes;
    // Pass the mode map so a transfer only unbinds another action sharing the same
    // (token, mode) pair — two actions may share one input under different modes.
    const updated = applyBinding(bindings, modes, actionId, token);
    saveBindings(device, updated);
    return isKeyboard ? { keyboardBindings: updated } : { controllerBindings: updated };
  }),
  setBindingMode: (device, actionId, mode) => set((state) => {
    const isKeyboard = device === 'keyboard';
    const bindings = isKeyboard ? state.keyboardBindings : state.controllerBindings;
    const modes = isKeyboard ? state.keyboardBindingModes : state.controllerBindingModes;
    const next = applyBindingMode(bindings, modes, actionId, mode);
    saveBindings(device, next.bindings);
    saveModes(device, next.modes);
    return isKeyboard
      ? { keyboardBindings: next.bindings, keyboardBindingModes: next.modes }
      : { controllerBindings: next.bindings, controllerBindingModes: next.modes };
  }),
  resetBindings: (device) => set(() => {
    const defaults = getDefaultBindings(device);
    const defaultModes = getDefaultModes(device);
    saveBindings(device, defaults);
    saveModes(device, defaultModes);
    return device === 'keyboard'
      ? { keyboardBindings: defaults, keyboardBindingModes: defaultModes }
      : { controllerBindings: defaults, controllerBindingModes: defaultModes };
  }),
  lightingSettings: loadLightingSettings(),
  updateLightingSettings: (settings) => set((state) => ({
    lightingSettings: { ...state.lightingSettings, ...settings }
  })),
  shadowsEnabled: loadShadowsEnabled(),
  setShadowsEnabled: (enabled) => {
    try {
      localStorage.setItem(SHADOWS_STORAGE_KEY, String(enabled));
    } catch {
      /* localStorage unavailable (private mode); setting still applies for the session */
    }
    set({ shadowsEnabled: enabled });
  },
  healthBarsEnabled: loadHealthBarsEnabled(),
  setHealthBarsEnabled: (enabled) => {
    try {
      localStorage.setItem(HEALTH_BARS_STORAGE_KEY, String(enabled));
    } catch {
      /* localStorage unavailable; setting still applies for the session */
    }
    set({ healthBarsEnabled: enabled });
  },
  unitAurasEnabled: loadUnitAurasEnabled(),
  setUnitAurasEnabled: (enabled) => {
    try {
      localStorage.setItem(UNIT_AURAS_STORAGE_KEY, String(enabled));
    } catch {
      /* localStorage unavailable; setting still applies for the session */
    }
    set({ unitAurasEnabled: enabled });
  },
  musicEnabled: loadMusicEnabled(),
  setMusicEnabled: (enabled) => {
    try {
      localStorage.setItem(MUSIC_STORAGE_KEY, String(enabled));
    } catch {
      /* localStorage unavailable; setting still applies for the session */
    }
    set({ musicEnabled: enabled });
  },
  controlSpeeds: loadControlSpeeds(),
  updateControlSpeeds: (settings) => set((state) => {
    const next = { ...state.controlSpeeds, ...settings };
    try {
      localStorage.setItem(CONTROL_SPEEDS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* localStorage unavailable; setting still applies for the session */
    }
    return { controlSpeeds: next };
  }),
  bridgeState: {
    rightBridge: {
      currentState: 'up',
      currentFrame: 'Fully_Up',
      animationStartMs: 0,
      frameStartMs: 0,
      triggeredByPlayer: false,
    },
    leftBridge: {
      currentState: 'up',
      currentFrame: 'Fully_Up',
      animationStartMs: 0,
      frameStartMs: 0,
      triggeredByPlayer: false,
    },
  },

  initializeGame: () => {
    // Prepare a local player and an AI opponent with placeholder base hexes.
    // Player ids are fixed roles ('p0' = local, 'p1' = opponent) rather than
    // random nanoids so that ownership ids are deterministic and identical to
    // the multiplayer convention (host = p0, guest = p1). Each client keys its
    // own `localPlayerId` to its role; the shared id space lets both peers agree
    // on which units belong to whom without exchanging an id map.
    // Defensive reset to single-player: initializeGame is the "fresh game" entry
    // point (app boot and Post-Game "Play Again"), so disarm any lingering
    // multiplayer command routing here. The active engine, if any, is also torn
    // down when the player returns to the menu (see App's teardown effect).
    setCommandRouter(null);

    const localId = 'p0';
    const aiId = 'p1';
    const players: Player[] = [
      {
        id: localId,
        name: 'You',
        isAI: false,
        animals: ['Bee', 'Bear', 'Fox'],
        basePositions: P0_BASE_POSITIONS,
      },
      {
        id: aiId,
        name: 'AI',
        isAI: true,
        // Randomized each match so the player faces a varied opponent lineup.
        animals: pickRandomAnimals(3),
        basePositions: P1_BASE_POSITIONS,
      },
    ];

    set({ players, localPlayerId: localId, netMode: 'single', units: [], matchStarted: false, gameOver: false, winner: null, selectedUnitIds: [], pilotedUnitId: null, pilotedUnitIdByOwner: { p0: null, p1: null }, pilotMoveByOwner: { p0: { x: 0, z: 0 }, p1: { x: 0, z: 0 } }, pilotedFireTeamId: null, pilotedFireTeamByOwner: { p0: null, p1: null }, fireTeams: {}, movementHeldUnitId: null, unitPlacementCount: 0, unitPlacementCursor: null, unitOrders: {}, lastSpawnAtMsByQueenId: {}, lastRegenAtMsByUnitId: {}, queenPatrols: {}, queenRallyTargets: {}, unitCountCache: {}, spatialGrid: null, lastRegenCheckMs: 0, tickCounter: 0, aiThinkingOffset: {}, movementDirectionCache: {}, targetCache: {}, lastWinCheckMs: 0, deadUnitsToRemove: [], matchStats: createEmptyMatchStats(), projectiles: [], optimizations: { aiThrottling: true, combatBatching: true, movementCaching: true, regenThrottling: true, winCheckThrottling: true, deadUnitBatching: true, spawnOptimization: true } });
  },

  chooseAnimalsForLocal: (animals) => set({ selectedAnimalPool: animals.slice(0, 3) }),

  startMatch: (withAI = true, seed?: number) => {
    const state = get();
    const units: Unit[] = [];

    // Seed the deterministic simulation primitives BEFORE creating any units:
    // createBase/createQueen/createKing mint ids from the entity counter, which
    // resetDeterministicState() zeroes. In multiplayer the caller passes the
    // seed agreed in the start handshake so both peers build an identical match;
    // in single-player we mint a throwaway seed so each match still varies.
    const matchSeed = seed ?? (Math.floor(Math.random() * 0xffffffff) >>> 0);
    const rng = resetDeterministicState(matchSeed);

    console.log('🎮 Starting match with players:', state.players);

    for (const player of state.players) {
      // The local human's lineup is the lobby selection (selectedAnimalPool);
      // every other player (the AI, or a remote human in multiplayer) carries its
      // own lineup in player.animals. Keying off localPlayerId rather than isAI
      // lets a second human player use its own lineup instead of the local pool.
      const chosenAnimals = player.id === state.localPlayerId ? state.selectedAnimalPool : player.animals;
      // Initial facing is role/side-based, NOT "is this the local player" — in
      // multiplayer each peer is the local player on its own machine, so an
      // is-local rotation would face p0/p1 opposite ways on the two peers and
      // desync. p0 holds the +z edge (faces -z = π); p1 faces +z = 0.
      const initialRotation = player.id === 'p0' ? Math.PI : 0;

      console.log(`👤 Player ${player.name} (${player.isAI ? 'AI' : 'Human'}) animals:`, chosenAnimals);

      // "Forward" is the direction toward the enemy edge: p0 holds the +z edge so
      // it advances along -z, p1 the reverse. Keyed off role (not is-local) so both
      // multiplayer peers compute identical spawn positions and stay deterministic.
      const forwardSign = player.id === 'p0' ? -1 : 1;

      for (let i = 0; i < 3; i++) {
        const animal = chosenAnimals[i];
        const basePos = player.basePositions[i];

        console.log(`  Creating ${animal} base at`, basePos);

        // Base entity (high HP, stationary)
        const base = createBase(player.id, animal, basePos, initialRotation);
        units.push(base);
        // The base footprint is now 5x larger, so the royals and their spawns are
        // pushed forward (toward the enemy) to clear the structure instead of
        // sitting buried inside it.
        const ROYAL_FORWARD_OFFSET = 16;
        // Queen spawns units; place forward and offset to one side of the base.
        const queenPos = {
          x: basePos.x + 4,
          y: basePos.y,
          z: basePos.z + forwardSign * ROYAL_FORWARD_OFFSET,
        };
        units.push(createQueen(player.id, animal, queenPos, initialRotation));
        // King forward and offset to the other side so the pair don't overlap.
        const kingPos = {
          x: basePos.x - 4,
          y: basePos.y,
          z: basePos.z + forwardSign * ROYAL_FORWARD_OFFSET,
        };
        units.push(createKing(player.id, animal, kingPos, initialRotation));
      }
    }

    console.log(`✅ Created ${units.length} total units:`, units.map(u => `${u.animal} ${u.kind}`));

    // Drop any stale pilot movement intent from a previous match.
    pilotInput.reset();

    set({
      units,
      matchStarted: true,
      // Deterministic RNG + seed for this match (lockstep). Stored so the desync
      // checksum can read the RNG state and so the seed is inspectable/replayable.
      rng,
      matchSeed,
      // Bump so views that persist across matches reset their per-match state.
      matchStartNonce: state.matchStartNonce + 1,
      isPaused: true,
      gameOver: false,
      winner: null,
      selectedUnitIds: [],
      pilotedUnitId: null,
      pilotedUnitIdByOwner: { p0: null, p1: null },
      pilotMoveByOwner: { p0: { x: 0, z: 0 }, p1: { x: 0, z: 0 } },
      pilotedFireTeamId: null,
      pilotedFireTeamByOwner: { p0: null, p1: null },
      fireTeams: {},
      movementHeldUnitId: null,
      unitPlacementCount: 0,
      unitPlacementCursor: null,
      unitOrders: {},
      queenRallyTargets: {},
      lastSpawnAtMsByQueenId: {},
      // These per-entity maps are keyed by entity id, and ids restart from the
      // same sequence every match (resetDeterministicState zeroes entitySeq), so
      // an entry left from a previous match in the same process silently applies
      // to a different unit/queen this match. lastRegenAtMsByUnitId in particular
      // suppresses a unit's first regen tick (its stale "last healed" timestamp
      // makes the 1s interval look unelapsed), so the same seed can produce a
      // different outcome run to run. initializeGame already clears both; clear
      // them here too so startMatch (single-player rematch and multiplayer) is
      // equally match-local. See also the self-play reproducibility harness.
      lastRegenAtMsByUnitId: {},
      queenPatrols: {},
      unitCountCache: {},
      spatialGrid: null,
      lastRegenCheckMs: 0,
      tickCounter: 0,
      aiThinkingOffset: {},
      movementDirectionCache: {},
      targetCache: {},
      lastWinCheckMs: 0,
      deadUnitsToRemove: [],
      matchStats: createEmptyMatchStats(),
      projectiles: [],
      bridgeState: {
        rightBridge: {
          currentState: 'up',
          currentFrame: 'Fully_Up',
          animationStartMs: 0,
          frameStartMs: 0,
          triggeredByPlayer: false,
        },
        leftBridge: {
          currentState: 'up',
          currentFrame: 'Fully_Up',
          animationStartMs: 0,
          frameStartMs: 0,
          triggeredByPlayer: false,
        },
      }
    });
  },

  startMultiplayerMatch: ({ localRole, seed, lineups }) => {
    // Two human players at the fixed role base positions. Both peers build the
    // identical players array (same ids, lineups, positions); only localPlayerId
    // and netMode differ per peer. selectedAnimalPool is set to the local lineup
    // so startMatch's local-player branch picks the right animals.
    const players: Player[] = [
      {
        id: 'p0',
        name: localRole === 'p0' ? 'You' : 'Opponent',
        isAI: false,
        animals: lineups.p0,
        basePositions: P0_BASE_POSITIONS,
      },
      {
        id: 'p1',
        name: localRole === 'p1' ? 'You' : 'Opponent',
        isAI: false,
        animals: lineups.p1,
        basePositions: P1_BASE_POSITIONS,
      },
    ];
    set({
      players,
      localPlayerId: localRole,
      selectedAnimalPool: lineups[localRole],
      netMode: localRole === 'p0' ? 'host' : 'guest',
    });
    // Build units + seed the deterministic sim identically on both peers.
    get().startMatch(true, seed);
    // startMatch leaves the match paused (single-player waits on the instructions
    // popup). In multiplayer the lockstep engine, not a popup, gates the start —
    // and the engine must never advance its tick while store.tick is a no-op from
    // being paused, or the engine tick and store tick desync. So unpause now; the
    // engine's input-delay buffer + stall mechanism still synchronizes the actual
    // first executed tick across the two peers.
    set({ isPaused: false });
  },

  // Per-frame simulation runs OUTSIDE Immer. At hundreds of units, produce()
  // clones the units array plus every mutated unit each tick, and that garbage
  // causes periodic GC pauses (frame-time spikes). Here we read the live state
  // via get(), mutate units/records in place, and republish a fresh `units`
  // array reference at the end so ref-equality selectors still update. Other
  // (infrequent, user-triggered) store actions keep using Immer.
  tick: (dtSec, nowMs) => {
      const draft = get();
      // Halt simulation once the match has been decided. Otherwise queens keep
      // spawning, surviving units keep landing kills, and bridge-down time
      // keeps ticking — all of which accumulate into matchStats and inflate
      // the post-game score while the player is staring at it. (PostGameScreen
      // subscribes to `units`, which still gets a fresh array reference from
      // the set() at the end of tick, so the screen re-renders every frame
      // and the numbers visibly climb.)
      if (!draft.matchStarted || draft.isPaused || draft.gameOver) return;

      // DEBUG: Initialize tick counter
      if (!draft.debugTickCount) {
        draft.debugTickCount = 0;
        console.log('🎮 GAME LOOP STARTED - Debug logging initialized');
      }
      draft.debugTickCount++;

      draft.tickCounter++;

      // Deterministic simulation clock + RNG (lockstep multiplayer foundation).
      // Derive the sim time purely from the tick counter so it is identical on
      // both peers regardless of wall-clock drift, then OVERRIDE the incoming
      // wall-clock `nowMs` with it. Every downstream timer in this tick reads
      // `nowMs`, so this single reassignment makes the entire simulation's notion
      // of time deterministic without touching its ~50 call sites. The module
      // globals `simClockMs`/`simRng` expose the same clock + this match's RNG to
      // the standalone helper functions (checkCollision, separateOverlappingUnits,
      // …) and the command handlers, which have no access to the store draft.
      nowMs = draft.tickCounter * (dtSec * 1000);
      simClockMs = nowMs;
      simRng = draft.rng;

      // Reset the pathfinder's per-tick A* compute budget so bursts of new cross-map
      // orders are spread over a few ticks instead of hitching a single frame.
      pathfinder.beginTick(draft.tickCounter);

      // Verbose AI/combat logging is gated behind a dev flag. Building these
      // strings and writing to the console for hundreds of units every frame is
      // itself a dominant cost — and the fixed-timestep catch-up loop multiplies
      // it when a tick runs long. Off by default; enable in a dev session with
      // `window.__rtsTickDebug = true`.
      const tickDebug =
        import.meta.env.DEV &&
        typeof window !== 'undefined' &&
        (window as any).__rtsTickDebug === true;

      // Debug: Log game is running (every 5 seconds)
      if (tickDebug && draft.tickCounter % 300 === 0) {
        console.log(`Game tick ${draft.tickCounter}, units: ${draft.units.length}, started: ${draft.matchStarted}`);
      }

      // Owner lookup built once per tick. Avoids a draft.players.find() scan per
      // unit (cheap when players are few, but it ran for every unit every tick).
      const isAiByOwnerId: Record<string, boolean> = {};
      for (const player of draft.players) {
        isAiByOwnerId[player.id] = player.isAI;
      }

      // Deterministic movement-priority inputs for the collision/separation passes.
      // These replace the per-peer `selectedUnitIds` + `localPlayerId` the passes used
      // to read directly — both of which differ between the two machines in a lockstep
      // match (each peer selects only its own units, selection is never networked, and
      // localPlayerId is p0 on the host but p1 on the guest). Feeding that local state
      // into the shared simulation made the two peers resolve collisions differently,
      // so unit positions drifted apart and the desync checksum stopped the match —
      // which surfaced to players as a frozen sim where units ignore move orders.
      //
      // Single-player keeps reading the live selection (one machine, no peer to match).
      // Lockstep derives priority from synced order state instead: a unit with an active
      // move order gets the same "push through idle teammates / royal make-way" treatment
      // selection grants solo, and `unitOrders` is identical on both peers because it is
      // mutated only by networked commands and deterministic tick logic. playerControlled
      // owners (the non-AI players) replace localPlayerId in the same passes: that set is
      // exactly { localPlayerId } solo and { p0, p1 } online, so the rules are unchanged
      // in single-player and symmetric across both humans in multiplayer.
      const isLockstepMatch = commandRouter !== null;
      const movementPriorityIds: ReadonlySet<string> = new Set(
        isLockstepMatch ? Object.keys(draft.unitOrders) : draft.selectedUnitIds
      );
      const playerControlledOwnerIds: ReadonlySet<string> = new Set(
        draft.players.filter((player) => !player.isAI).map((player) => player.id)
      );

      // Feed the local player's live monarch-drive vector into the per-owner map
      // ONLY in single-player. In a lockstep match the map is filled instead by
      // each peer's per-frame `pilotMove` command (applied before this tick runs),
      // so reading the local pilotInput here would inject un-synced, peer-specific
      // input into the shared simulation and desync it. The pilot tick block below
      // reads pilotMoveByOwner uniformly in both modes.
      if (!isLockstepMatch && draft.localPlayerId) {
        const localMove = pilotInput.getMove();
        draft.pilotMoveByOwner[draft.localPlayerId] = { x: localMove.x, z: localMove.z };
      }

      // Reuse spatial grid instead of rebuilding every tick (major optimization).
      // A small cell size keeps neighbor queries cheap even when hundreds of
      // units pile into the same area during dense melee — a large cell would
      // return nearly every unit and collapse back toward O(n^2).
      if (!draft.spatialGrid) {
        draft.spatialGrid = new SpatialGrid(1000, 16);
      }
      draft.spatialGrid.buildFromUnits(draft.units);

      // Optimized single-pass unit filtering and caching (major CPU optimization)
      const unitCategories = {
        queens: [] as Unit[],
        kings: [] as Unit[],
        unitsNeedingHealing: [] as Unit[],
        movableUnits: [] as Unit[],
        playerUnits: {} as Record<string, Unit[]>,
        aiUnits: {} as Record<string, Unit[]>
      };

      // Single pass through units for all categorization
      const newUnitCountCache: Record<string, Record<AnimalId, number>> = {};

      // id -> unit lookup, built once per tick so combat/targeting can resolve
      // references in O(1) instead of scanning draft.units (was O(n^2)).
      let unitById = new Map<string, Unit>();

      for (const unit of draft.units) {
        unitById.set(unit.id, unit);

        // Type-based categorization
        if (unit.kind === 'Queen') unitCategories.queens.push(unit);
        if (unit.kind === 'King') unitCategories.kings.push(unit);
        if (unit.hp < unit.maxHp) unitCategories.unitsNeedingHealing.push(unit);
        if (unit.kind !== 'Base') unitCategories.movableUnits.push(unit);

        // Owner-based categorization for later use
        if (unit.ownerId in isAiByOwnerId) {
          const category = isAiByOwnerId[unit.ownerId] ? 'aiUnits' : 'playerUnits';
          if (!unitCategories[category][unit.ownerId]) {
            unitCategories[category][unit.ownerId] = [];
          }
          unitCategories[category][unit.ownerId].push(unit);
        }

        // Update unit count cache in same pass
        if (unit.kind === 'Unit') {
          if (!newUnitCountCache[unit.ownerId]) {
            newUnitCountCache[unit.ownerId] = {} as Record<AnimalId, number>;
          }
          newUnitCountCache[unit.ownerId][unit.animal] = (newUnitCountCache[unit.ownerId][unit.animal] || 0) + 1;
        }
      }

      draft.unitCountCache = newUnitCountCache;
      const { queens, kings, unitsNeedingHealing, movableUnits } = unitCategories;

      // Aura pass (Queen heal + King damage). Computed once per tick off the
      // freshly built spatial grid so both gameplay (the King's damage buff) and
      // the on-ground ring visuals (auraActive) read the same proximity result.
      //
      // - Queen ring is "active" while a friendly army unit inside the radius is
      //   below max HP (i.e. it is actually being healed).
      // - King ring is "active" while a buffed army unit inside the radius is in
      //   recent combat. The King itself is never buffed (its base damage already
      //   one-shots most units); only Units/Queens around it get the multiplier.
      const RECENT_COMBAT_MS = 2000;
      const kingBuffedUnitIds = new Set<string>();
      {
        const grid = draft.spatialGrid!;
        for (const queen of queens) {
          const nearby = grid.getNearbyUnits(queen.position, draft.config.regenRadius);
          queen.auraActive = nearby.some(
            (u) => u.ownerId === queen.ownerId && u.kind === 'Unit' && u.hp < u.maxHp
          );
        }
        for (const king of kings) {
          const nearby = grid.getNearbyUnits(king.position, draft.config.kingAuraRadius);
          let active = false;
          for (const u of nearby) {
            if (u.ownerId !== king.ownerId || u.kind === 'Base' || u.kind === 'King') continue;
            kingBuffedUnitIds.add(u.id);
            if (!active && u.lastCombatEngagementMs && nowMs - u.lastCombatEngagementMs < RECENT_COMBAT_MS) {
              active = true;
            }
          }
          king.auraActive = active;
        }
      }

      // BALANCED: Moderate health regeneration throttling
      const REGEN_INTERVAL_MS = 1000; // 1 second (3x faster healing)
      const REGEN_AMOUNT = 1;
      const REGEN_CHECK_FREQUENCY = 3; // Restored to 3 ticks

      // Heal scaled by a unit's HP tier so larger pools top off quickly instead
      // of trickling for many minutes. Army Units heal at the base amount; the
      // bigger-pool kinds get a multiplier so they refill fast (Kings boosted to
      // 6x by request, not strict maxHp/baseHp).
      const REGEN_TIER_BY_KIND: Record<Unit['kind'], number> = {
        Unit: 1,
        Queen: 2,
        King: 6,
        Base: 8,
      };

      // A Queen heals a base from farther out than a regular unit: the enlarged
      // base footprint means a Queen standing at its edge is already well beyond
      // the unit regen radius, so a base uses an expanded reach measured from its
      // center. Tuned to roughly the base radius plus the standard regen radius.
      const BASE_HEAL_RADIUS = draft.config.regenRadius + 12;

      if (!draft.optimizations.regenThrottling || draft.tickCounter % REGEN_CHECK_FREQUENCY === 0) {
        // Damaged bases are always processed (they are few and their healing is a
        // requested capability); other units are still capped per frame for CPU.
        const damagedBases = unitsNeedingHealing.filter((u) => u.kind === 'Base');
        const otherDamaged = unitsNeedingHealing
          .filter((u) => u.kind !== 'Base')
          .slice(0, 30); // up to 30 non-base units per frame
        const healingUnitsToProcess = [...damagedBases, ...otherDamaged];
        for (const unit of healingUnitsToProcess) {
          // Skip dead units - they should not regenerate
          if (unit.hp <= 0) continue;

          const lastRegenTime = draft.lastRegenAtMsByUnitId[unit.id] ?? 0;
          if (nowMs - lastRegenTime < REGEN_INTERVAL_MS) continue;

          // Use spatial grid to find nearby queens (much faster than checking all queens)
          const healRadius = unit.kind === 'Base' ? BASE_HEAL_RADIUS : draft.config.regenRadius;
          const nearbyQueens = draft.spatialGrid!.findNearbyQueens(unit, healRadius);
          if (nearbyQueens.length > 0) {
            const healAmount = REGEN_AMOUNT * REGEN_TIER_BY_KIND[unit.kind];
            unit.hp = Math.min(unit.maxHp, unit.hp + healAmount);
            draft.lastRegenAtMsByUnitId[unit.id] = nowMs;
          }
        }
      }

      // AGGRESSIVE: Reduced spawn rate to limit unit count (major performance optimization)
      for (const q of queens) {
        const last = draft.lastSpawnAtMsByQueenId[q.id] ?? 0;
        if (nowMs - last >= draft.config.spawnIntervalMs) {
          // Use cached unit count instead of expensive filtering
          const existingCount = draft.unitCountCache[q.ownerId]?.[q.animal] || 0;

          // Cap of 50 units per animal, per team (150 per team across 3 animals)
          if (existingCount < 50) {
            // Pre-calculated spawn positions (much faster than random generation)
            const spawnIndex = existingCount % 8; // Cycle through 8 preset positions
            const presetAngles = [0, Math.PI/4, Math.PI/2, 3*Math.PI/4, Math.PI, 5*Math.PI/4, 3*Math.PI/2, 7*Math.PI/4];
            const angle = presetAngles[spawnIndex];
            const distance = 2.5; // Fixed distance for consistency
            const tentativeSpawnPos = {
              x: q.position.x + Math.cos(angle) * distance,
              y: 0,
              z: q.position.z + Math.sin(angle) * distance
            };

            // Create a temporary unit to check collision
            const ownerPlayer = draft.players.find(p => p.id === q.ownerId);
            // Facing is side-based (p0 holds the +z edge → faces -z = π; p1 faces 0),
            // NOT "is this the local player" — in lockstep each peer is local on its own
            // machine, so an is-local rotation would face a spawned unit opposite ways on
            // the two peers. Mirrors startMatch's initial-rotation rule for the same reason.
            const initialRotation = q.ownerId === 'p0' ? Math.PI : 0;
            const tempUnit = createUnit(q.ownerId, q.animal, tentativeSpawnPos, initialRotation);

            // Find a collision-free spawn position
            const finalSpawnPos = checkCollision(tentativeSpawnPos, tempUnit, draft.units, 2.5, movementPriorityIds, playerControlledOwnerIds, draft.unitOrders, draft.spatialGrid);
            tempUnit.position = finalSpawnPos;

            // Reinforcements adopt the spawning Queen's posture, so a player who
            // set their army to (say) Hold Ground gets newborns that hold too
            // instead of defaulting and milling forward. Inherit a copy so later
            // edits to either unit's behavior stay independent.
            if (q.behavior) tempUnit.behavior = { ...q.behavior };

            // Spawn rally target: if the player set one on this Queen, send the
            // newborn there instead of letting it idle by the Queen. A 'point' rally
            // marches it to a fixed spot; a 'follow' rally makes it fall in behind a
            // monarch (the follow branch in tick() then pins its order to the monarch
            // each tick). A fresh unit has no cached path or combat state, so seeding
            // the order / follow id plus moving_to_order is enough for movement.
            const rally = draft.queenRallyTargets[q.id];
            if (rally) {
              if (rally.mode === 'follow') {
                const monarch = unitById.get(rally.monarchId);
                if (monarch && monarch.hp > 0) {
                  tempUnit.followMonarchId = rally.monarchId;
                  tempUnit.unitState = 'moving_to_order';
                  // If the player currently has the followed monarch selected, fold
                  // the newborn into the selection too, so it joins the band the
                  // player is actively commanding the moment it spawns rather than
                  // appearing unselected behind the King. (tempUnit is pushed to
                  // draft.units just below, so the id resolves on the next read.)
                  if (draft.selectedUnitIds.includes(monarch.id)) {
                    draft.selectedUnitIds.push(tempUnit.id);
                  }
                } else {
                  // The designated monarch is gone — drop the now-stale follow rally.
                  delete draft.queenRallyTargets[q.id];
                }
              } else {
                draft.unitOrders[tempUnit.id] = { ...rally.position };
                tempUnit.unitState = 'moving_to_order';
                // The rally point is a positional intent, so it is also the
                // newborn's stance anchor — it will defend/return there.
                tempUnit.anchor = { x: rally.position.x, y: 0, z: rally.position.z };
              }
            }

            draft.units.push(tempUnit);

            // Scoring + post-game stats: count units generated per side. Only
            // the local player's unitsGenerated feeds the leaderboard score
            // (see computeScore); the AI mirror is for the side-by-side
            // comparison on the post-game screen.
            if (q.ownerId === draft.localPlayerId) {
              draft.matchStats.unitsGenerated++;
            } else {
              draft.matchStats.aiUnitsGenerated++;
            }
          }

          draft.lastSpawnAtMsByQueenId[q.id] = nowMs;
        }
      }

      // Drive any shaped fire team the player is steering by moving its formation
      // anchor (keeps the shape), then keep every fire team in its formation before
      // the movement loop runs: maintainFormations pins each member's anchor to its
      // slot and (re)issues a march order whenever the formation has changed, moved,
      // or lost a member, so the per-unit loop below carries each unit to its place
      // via the normal order/movement path.
      applyFireTeamDrive(draft, dtSec);
      maintainFormations(draft);

      // Batched combat processing for better performance
      const combatPairs: Array<{attacker: Unit, target: Unit, damage: number}> = [];

      // Track units under attack for immediate response
      const unitsUnderAttack = new Set<string>();

      // FIXED: Process all units but with smart optimizations for AI
      // Execute movement orders and combat (process all units for proper AI)
      for (const unit of movableUnits) {
        // Hiss knockback: while an enemy is mid-shove from a Cat's Hiss, slide it along
        // its stored knockback vector (radially away from the cat) and skip its own AI
        // this tick so the push reads as a clean recoil instead of fighting its pathing.
        // checkCollision keeps it on walkable terrain and inside the arena. The shove ends
        // when its window elapses, after which the unit resumes normal behavior next tick.
        if (unit.knockbackUntilMs !== undefined) {
          if (nowMs >= unit.knockbackUntilMs) {
            delete unit.knockbackUntilMs;
            delete unit.knockbackVelocityX;
            delete unit.knockbackVelocityZ;
          } else {
            const knockbackStep = {
              x: unit.position.x + (unit.knockbackVelocityX ?? 0) * dtSec,
              y: unit.position.y,
              z: unit.position.z + (unit.knockbackVelocityZ ?? 0) * dtSec,
            };
            unit.position = checkCollision(knockbackStep, unit, draft.units, 2.5, movementPriorityIds, playerControlledOwnerIds, draft.unitOrders, draft.spatialGrid);
            continue;
          }
        }

        // Bee Swarm dive: a bee mid-Swarm is driven entirely by updateBeeSwarms (it flies
        // straight at its claimed target and stings on contact), so skip its normal AI and
        // combat this tick — otherwise the two would fight over the bee's movement.
        if (unit.swarmTargetId !== undefined) {
          continue;
        }

        // Owl Pickup: an Owl mid-Pickup is driven entirely by updateOwlPickups (swoop ->
        // grab -> carry -> drop), and a unit being carried is held by its Owl. Both have
        // their normal AI/combat suppressed so the ability owns their movement this tick.
        if (unit.owlPickup !== undefined || unit.carriedByOwlId !== undefined) {
          continue;
        }

        // Chicken egg-throw pose: while the throw plays out the chicken plants itself
        // and keeps the backside-to-target rotation set in throwEggs, so the egg
        // launches cleanly from its tail rather than its face or wing. Freeze its
        // movement/rotation/combat for the pose window (like the ability guards above)
        // so a pending move order can't spin it back around mid-throw; it resumes
        // normal behavior the moment the pose expires.
        if (unit.animal === 'Chicken' && unit.eggThrowUntilMs !== undefined && nowMs < unit.eggThrowUntilMs) {
          continue;
        }

        // Frog tongue-grab: a frog mid-grab is pinned and driven entirely by
        // updateFrogTongues (windup -> extend -> grab/whiff -> reel), holding the aim
        // rotation set in fireTongues. Freeze its normal AI/combat for the grab — like
        // the guards above — so combat-facing can't spin it off the throw heading while
        // the tongue plays out.
        if (unit.tongue) {
          continue;
        }

        // Cat Hiss pose: while the Kitty_F2 pose plays the cat plants itself facing the
        // aim point set in hiss. Freeze its movement/rotation/combat for the pose window
        // (like the chicken egg-throw above) so combat-facing or a pending move order
        // can't spin it off its hiss heading mid-pose. It resumes the moment the pose
        // expires.
        if (unit.animal === 'Cat' && unit.hissUntilMs !== undefined && nowMs < unit.hissUntilMs) {
          continue;
        }

        // Direct piloting: the player is driving this King/Queen with the camera-movement
        // keys (z/x/c selected it). Its movement is purely the `pilotInput` vector — never
        // the AI or order system — and it never auto-attacks (fully manual). Any stale move
        // order is dropped so mouse orders and WASD don't fight, and we skip the rest of the
        // per-unit AI/combat for it this tick.
        if (draft.pilotedUnitIdByOwner[unit.ownerId] === unit.id) {
          const move = draft.pilotMoveByOwner[unit.ownerId] ?? { x: 0, z: 0 };
          const inputMagnitude = Math.hypot(move.x, move.z);

          // A Queen the player toggles/cycles piloting onto (G/A) keeps walking an
          // active patrol route — toggling control onto her is not a stop command.
          // With no drive input this frame, fall through to the normal player logic
          // so the patrol branch (Priority 1b) keeps driving her, rather than holding
          // her in place. The patrol ends only when she is actively driven (the clause
          // below cancels it) or given a new move/patrol order, matching moveCommand.
          const passivelyPatrolling =
            inputMagnitude <= 0.0001 && unit.kind === 'Queen' && draft.queenPatrols[unit.id] !== undefined;

          if (!passivelyPatrolling) {
            if (draft.unitOrders[unit.id]) delete draft.unitOrders[unit.id];

            if (inputMagnitude > 0.0001) {
              // Actively driving the unit takes manual control, so abandon any patrol
              // route — like issuing a move order (see moveCommand). Without this she
              // would snap back to the route the moment the drive key is released.
              if (draft.queenPatrols[unit.id]) delete draft.queenPatrols[unit.id];

              applyPilotDriveStep(unit, move, inputMagnitude, dtSec, draft.units, movementPriorityIds, playerControlledOwnerIds, draft.unitOrders, draft.spatialGrid);
            } else {
              // No input this frame: hold position and drop the moving animations.
              if (unit.animal === 'Frog' || unit.animal === 'Bunny') unit.isHopping = false;
              if (unit.animal === 'Owl') unit.isFlying = false;
            }

            unit.unitState = 'idle';
            continue;
          }
          // else: piloted Queen with a live patrol and no drive input — fall through
          // so the patrol branch below keeps her walking the route.
        }

        // Fire-team driving (UNSHAPED squads only): the player has handed this owner's
        // drive control onto a deployed fire team that holds no formation, so every
        // member moves by the shared pilot vector at once — the squad drives as one.
        // A SHAPED team is driven differently — applyFireTeamDrive moves its formation
        // anchor before the maintenance pass, which then flows the members to the
        // moving slots keeping the shape — so it is excluded here. Only overrides
        // movement while there is actual drive input this frame; with the keys
        // released the members fall through to their normal AI and defend the ground
        // they hold. Keyed on the synced per-owner map so a multiplayer peer steers
        // both players' teams identically. (A piloted monarch never carries a
        // fireTeamId, so this and the monarch branch above are mutually exclusive.)
        if (
          unit.fireTeamId !== undefined &&
          draft.pilotedFireTeamByOwner[unit.ownerId] === unit.fireTeamId &&
          !draft.fireTeams[unit.fireTeamId]
        ) {
          const move = draft.pilotMoveByOwner[unit.ownerId] ?? { x: 0, z: 0 };
          const inputMagnitude = Math.hypot(move.x, move.z);
          if (inputMagnitude > 0.0001) {
            if (draft.unitOrders[unit.id]) delete draft.unitOrders[unit.id];
            applyPilotDriveStep(unit, move, inputMagnitude, dtSec, draft.units, movementPriorityIds, playerControlledOwnerIds, draft.unitOrders, draft.spatialGrid);

            // Re-home the stance anchor onto the ground the squad is being driven
            // across, every frame it moves. Driving a fire team is the player
            // re-issuing its destination live, so wherever the player stops the
            // team becomes its new "home" — exactly as moveCommand/placeRallied
            // re-anchor on an explicit order. Without this the anchor still points
            // at the original deploy spot, and the instant the player releases the
            // keys a returns-to-anchor stance (Defensive/Skirmish/Guard) would
            // march the whole team back there. Updating it only while actually
            // driving leaves the leash intact once stopped: the team holds (and
            // returns to) the spot it was last driven to, not the deploy point.
            unit.anchor = { x: unit.position.x, y: 0, z: unit.position.z };

            unit.unitState = 'idle';
            continue;
          }
        }

        // Patrol-draw hold: while the player holds the secondary button to draw a
        // patrol route from this Queen, she stays pinned in place so the line's
        // origin (her gold ring) doesn't drift. Hold position and skip her AI,
        // orders, patrol, and combat movement for this tick. Released on button-up.
        if (draft.movementHeldUnitId !== null && unit.id === draft.movementHeldUnitId) {
          if (unit.animal === 'Frog' || unit.animal === 'Bunny') unit.isHopping = false;
          if (unit.animal === 'Owl') unit.isFlying = false;
          unit.unitState = 'idle';
          continue;
        }

        // AI thinking throttling - each unit thinks on different frames
        const isPlayerUnit = unit.ownerId in isAiByOwnerId && !isAiByOwnerId[unit.ownerId];
        const shouldThinkThisTick = isPlayerUnit || !draft.optimizations.aiThrottling || (draft.tickCounter + (draft.aiThinkingOffset[unit.id] || 0)) % 2 === 0; // Reduced to 2 for better AI responsiveness

        // Initialize AI thinking offset for new units
        if (!draft.aiThinkingOffset[unit.id]) {
          draft.aiThinkingOffset[unit.id] = simRng.nextInt(2); // Match new thinking interval
        }

        // Monarch rally: a follower keeps its move order pinned to the piloted
        // King/Queen it is trailing, so it chases the monarch as the player drives
        // it. Refreshed before the order is read below, so the standard Priority-1
        // movement (which also auto-engages enemies en route) carries it there.
        // Dropping the order inside the stop band lets it idle near the monarch
        // instead of jittering against it, and a dead/missing monarch ends the rally.
        if (isPlayerUnit && unit.followMonarchId) {
          const monarch = unitById.get(unit.followMonarchId);
          if (!monarch || monarch.hp <= 0) {
            delete unit.followMonarchId;
            delete draft.unitOrders[unit.id];
          } else if (shouldChaseMonarch(distance3D(unit.position, monarch.position), MONARCH_FOLLOW_STOP_DISTANCE)) {
            draft.unitOrders[unit.id] = { x: monarch.position.x, y: 0, z: monarch.position.z };
          } else {
            // Settled inside the stop band: drop the chase order so the follower
            // idles here rather than jittering against the monarch. Re-home its
            // stance anchor onto where it now stands so the idle/return-to-anchor
            // fallback (Priority 2/3) holds it in place — NOT back at the monarch,
            // and NOT at the destination of a prior move order (the stale anchor
            // moveCommand stamps on every order). That stale-anchor snap-back was
            // what yanked a rallied band away the instant the player switched to
            // piloting another King/Queen and this now-stationary army dropped
            // into its idle band. Holding in place lets the band simply keep doing
            // what it was — sitting where it ended up — and resume trailing only
            // if its monarch actually moves off again.
            if (draft.unitOrders[unit.id]) delete draft.unitOrders[unit.id];
            unit.anchor = { x: unit.position.x, y: 0, z: unit.position.z };
          }
        }

        const order = draft.unitOrders[unit.id];
        const patrol = draft.queenPatrols[unit.id];
        let target: Unit | null = null;

        // REVISED PLAYER PRIORITY SYSTEM - MOVEMENT ORDERS FIRST
        // Priority 1: Player movement orders (NEVER interrupted by combat)
        // Priority 2: Attack response when idle (defend when under attack)
        // Priority 3: Autonomous enemy detection when idle and not under attack
        if (isPlayerUnit) {
          // Debug: Check player unit detection
          if (tickDebug && unit.id.endsWith('0') && draft.tickCounter % 120 === 0) {
            console.log(`PLAYER unit ${unit.animal} (${unit.id}) - isPlayerUnit: ${isPlayerUnit}, currentAttackers: ${unit.currentAttackers?.length || 0}`);
          }

          // Initialize unit state if not set
          if (!unit.unitState) {
            unit.unitState = 'idle';
          }

          // PRIORITY 1: Execute player movement orders (HIGHEST PRIORITY - never interrupted)
          if (order) {
            unit.unitState = 'moving_to_order';
            const distanceToOrder = distance3D(unit.position, order);

            // A formation member's order is its slot; let it settle (and stop paying
            // movement + a blocker scan every tick) at a realistic radius rather than the
            // tight default a lone unit can actually reach. See FORMATION_ARRIVAL_DISTANCE.
            const inFormation = unit.fireTeamId !== undefined && draft.fireTeams[unit.fireTeamId] !== undefined;
            const arrivalThreshold = inFormation ? FORMATION_ARRIVAL_DISTANCE : 0.5;

            // Check if movement is paused due to collision attempts
            const isInRecentCombat = unit.lastCombatEngagementMs && nowMs - unit.lastCombatEngagementMs < 2000;
            const isMovementPaused = unit.movementPausedUntilMs && nowMs < unit.movementPausedUntilMs && !isInRecentCombat;

            // BLOCKING DETECTION: Track when unit gets blocked
            const isCurrentlyBlocked = isMovementPaused || (unit.collisionAttempts && unit.collisionAttempts >= 3);

            // On a bridge deck there is no good "give up here" position: dropping the
            // order leaves the unit idling on a narrow chokepoint where it will be
            // killed in place. Hold the order — the unwedge/pass-through logic in
            // checkCollision is what lets it actually complete the crossing.
            const onBridgeMidCrossing =
              ANIMAL_MOVEMENT_TYPES[unit.animal] === 'ground' &&
              terrainValidator.bridgeAt(unit.position).onBridge;

            if (isCurrentlyBlocked && !onBridgeMidCrossing) {
              // Start tracking block time if not already tracking
              if (!unit.firstBlockedAtMs) {
                unit.firstBlockedAtMs = nowMs;
              }

              // Check if blocked for more than 2 seconds (reduced from 5)
              const blockedDuration = nowMs - unit.firstBlockedAtMs;
              if (blockedDuration >= 2000) {
                // Unit is stuck - abandon current order and switch to idle
                delete draft.unitOrders[unit.id];
                delete unit.arrivedAtDestinationMs;
                unit.unitState = 'idle';

                // Reset blocking state
                unit.collisionAttempts = 0;
                delete unit.movementPausedUntilMs;
                delete unit.firstBlockedAtMs;

                if (tickDebug && unit.id.endsWith('0')) {
                  console.log(`PLAYER unit ${unit.animal} BLOCKED for ${(blockedDuration/1000).toFixed(1)}s - abandoning order and switching to IDLE state`);
                }
              }
            } else {
              // Unit is not blocked (or is mid-crossing) - clear block tracking
              delete unit.firstBlockedAtMs;
            }

            // Check for enemies near movement path (allow combat while moving)
            let nearbyEnemy: Unit | null = null;
            // Use spatial grid for O(1) nearby enemy lookup instead of O(n) filter
            if (draft.spatialGrid) {
              const nearbyEnemies = draft.spatialGrid.findEnemiesInRange(unit, 8);
              if (nearbyEnemies.length > 0) {
                nearbyEnemy = nearbyEnemies.reduce((closest, enemy) => {
                  const distToCurrent = distanceSquared3D(unit.position, closest.position);
                  const distToEnemy = distanceSquared3D(unit.position, enemy.position);
                  return distToEnemy < distToCurrent ? enemy : closest;
                });
              }
            }

            // Owl landing logic - land if within 15 units for more than 5 seconds
            if (unit.animal === 'Owl' && unit.isFlying && distanceToOrder <= 15) {
              if (!unit.nearDestinationSinceMs) {
                unit.nearDestinationSinceMs = nowMs;
              } else if (nowMs - unit.nearDestinationSinceMs >= 5000) {
                // Been near destination for 5+ seconds, land
                unit.isFlying = false;
                delete unit.nearDestinationSinceMs;
                if (tickDebug) console.log(`Owl ${unit.id} landing after hovering near destination`);
              }
            } else if (unit.animal === 'Owl' && distanceToOrder > 15) {
              // Reset timer if moved away from destination
              delete unit.nearDestinationSinceMs;
            }

            // Move toward ordered position (but allow combat interruption)
            if (distanceToOrder > arrivalThreshold && !isMovementPaused) {
              let direction = normalize3D(subtract3D(steeringTarget(unit, order), unit.position));

              // Bias the course around stationary friendly clumps so the unit commits to a way
              // around instead of ramming them head-on (see movementSteering). Only own,
              // currently-stationary teammates count as blockers: enemies are left to combat,
              // and teammates that are themselves moving (have an order) are excluded so a group
              // marching together doesn't deflect off one another. Restricted to army Units:
              // a King/Queen instead plows straight through its own army via the make-way shove
              // (clearPathForSelectedRoyals) and must not detour. Skipped on a bridge deck, where
              // steering sideways would push toward the water — there the pathfinder's deck
              // waypoints already track the centerline. Also skipped for a formation member: its
              // target is a deterministic slot whose geometry already spaces it from squadmates,
              // so deflecting it around friendly clumps fights the shape — and the per-tick
              // spatial scan it costs, paid by every marching member, is the dominant steady-state
              // drag of holding a formation (collision still resolves any real overlap).
              if (unit.kind === 'Unit' && ANIMAL_MOVEMENT_TYPES[unit.animal] === 'ground' && !onBridgeMidCrossing && !inFormation) {
                const scanRadius = BLOCKER_LOOKAHEAD + UNIT_MINIMUM_SPACING + YETI_SPACING_BONUS;
                const neighbors = draft.spatialGrid
                  ? draft.spatialGrid.getNearbyUnits(unit.position, scanRadius)
                  : draft.units;
                const blockers: SteerBlocker[] = [];
                for (const other of neighbors) {
                  if (other.id === unit.id || other.kind === 'Base') continue;
                  if (other.ownerId !== unit.ownerId) continue; // only own side; enemies are combat
                  if (draft.unitOrders[other.id] !== undefined) continue; // moving teammate, not a clump
                  blockers.push({ position: other.position, laneHalfWidth: minimumSpacingBetween(unit, other) });
                }
                direction = deflectAroundBlockers(unit.position, direction, blockers);
              }

              const moveDistance = unit.moveSpeed * dtSec;

              // Update rotation to face movement direction (unless in combat)
              if (!nearbyEnemy || distanceSquared3D(unit.position, nearbyEnemy.position) > 900) {
                unit.rotation = Math.atan2(direction.x, direction.z);
              }

              // Frog and Bunny hopping animation
              if (unit.animal === 'Frog' || unit.animal === 'Bunny') {
                unit.isHopping = true;
                // Update hop phase (cycles 0-1, speed based on movement speed)
                const hopSpeed = unit.moveSpeed / 5; // Hop frequency
                unit.hopPhase = ((unit.hopPhase || 0) + (hopSpeed * dtSec)) % 1;
              } else {
                unit.isHopping = false;
              }

              // Owl flying animation
              if (unit.animal === 'Owl') {
                unit.isFlying = true;
                // Update wing phase (cycles 0-1 for wing flapping)
                const flapSpeed = 3; // Flaps per second
                unit.wingPhase = ((unit.wingPhase || 0) + (flapSpeed * dtSec)) % 1;
              } else {
                unit.isFlying = false;
              }

              const newPosition = {
                x: unit.position.x + direction.x * moveDistance,
                y: unit.position.y,
                z: unit.position.z + direction.z * moveDistance
              };

              // Always apply collision detection for player-ordered movement (highest priority)
              unit.position = checkCollision(newPosition, unit, draft.units, 2.5, movementPriorityIds, playerControlledOwnerIds, draft.unitOrders, draft.spatialGrid);

              // Debug: Log movement for player units
              if (tickDebug && unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
                console.log(`PLAYER unit ${unit.animal} executing order: distance ${distanceToOrder.toFixed(1)}`);
              }
            }

            // Set target if enemy nearby (allow combat during movement)
            if (nearbyEnemy && distanceSquared3D(unit.position, nearbyEnemy.position) <= 64) {
              target = nearbyEnemy;
            }

            // Clear order and enter idle state when destination reached
            if (distanceToOrder <= arrivalThreshold) {
              delete draft.unitOrders[unit.id];
              delete unit.arrivedAtDestinationMs;
              unit.unitState = 'idle';
              // Owl landed when destination reached
              if (unit.animal === 'Owl') {
                unit.isFlying = false;
              }
              if (tickDebug) console.log(`PLAYER unit ${unit.animal} reached destination - entering IDLE state`);
            }
          }

          // PRIORITY 1b: A lone Queen with a patrol route walks back and forth
          // between her two patrol points until given a new order. This sits
          // between the explicit move order (Priority 1) and the idle/combat
          // fallback (Priority 2): an active patrol drives the Queen's movement,
          // while a Queen without one still falls through to defend herself.
          // Patrols only ever exist for the local player's Queen (see setPatrol),
          // so this branch must live inside the isPlayerUnit block to run at all.
          else if (patrol && unit.kind === 'Queen') {
            unit.unitState = 'moving_to_order';
            const targetPos = patrol.currentTarget === 'end' ? patrol.endPosition : patrol.startPosition;
            const dist = distance3D(unit.position, targetPos);

            // Owl landing logic - land if within 15 units for more than 5 seconds
            if (unit.animal === 'Owl' && unit.isFlying && dist <= 15) {
              if (!unit.nearDestinationSinceMs) {
                unit.nearDestinationSinceMs = nowMs;
              } else if (nowMs - unit.nearDestinationSinceMs >= 5000) {
                // Been near destination for 5+ seconds, land
                unit.isFlying = false;
                delete unit.nearDestinationSinceMs;
              }
            } else if (unit.animal === 'Owl' && dist > 15) {
              // Reset timer if moved away from destination
              delete unit.nearDestinationSinceMs;
            }

            if (dist > 1) {
              // Move toward the current patrol target
              const direction = normalize3D(subtract3D(steeringTarget(unit, targetPos), unit.position));
              const moveDistance = unit.moveSpeed * dtSec;

              // Update rotation to face movement direction
              unit.rotation = Math.atan2(direction.x, direction.z);

              // Locomotion animation flags. A patrolling Queen walks like any other
              // moving unit, so drive the same per-animal cycle the order/piloting
              // movers use — without this the renderer holds a single pose and the
              // Queen appears to slide (e.g. a Frog stuck on Frog_F0 instead of hopping).
              if (unit.animal === 'Frog' || unit.animal === 'Bunny') {
                unit.isHopping = true;
                const hopSpeed = unit.moveSpeed / 5; // Hop frequency
                unit.hopPhase = ((unit.hopPhase || 0) + (hopSpeed * dtSec)) % 1;
              }
              if (unit.animal === 'Owl') {
                unit.isFlying = true;
                const flapSpeed = 3; // Flaps per second
                unit.wingPhase = ((unit.wingPhase || 0) + (flapSpeed * dtSec)) % 1;
              }

              const newPosition = {
                x: unit.position.x + direction.x * moveDistance,
                y: unit.position.y,
                z: unit.position.z + direction.z * moveDistance
              };

              // Apply collision detection
              unit.position = checkCollision(newPosition, unit, draft.units, 2.5, movementPriorityIds, playerControlledOwnerIds, draft.unitOrders, draft.spatialGrid);
            } else {
              // Reached this patrol point, turn around toward the other end
              draft.queenPatrols[unit.id].currentTarget = patrol.currentTarget === 'end' ? 'start' : 'end';
              // Drop the moving-locomotion flags during the momentary pause at the
              // turnaround so the pose settles to idle before the next leg.
              if (unit.animal === 'Frog' || unit.animal === 'Bunny') unit.isHopping = false;
              if (unit.animal === 'Owl') unit.isFlying = false;
            }
          }

          // PRIORITY 2: Idle (no movement order, no patrol) — resolve the unit's
          // combat posture (stance + fire mode + target priority). This replaces
          // the former hard-coded "engage within 10u, never return home" logic with
          // the stance engine in unitBehavior.ts. The default Defensive stance on a
          // unit that has no anchor reproduces that original engage-where-you-stand
          // feel, so unmanaged armies behave exactly as before.
          else {
            const behavior = behaviorOf(unit);
            const effectiveFire = resolveFireMode(behavior); // patrol ⇒ weapons-free

            // Guard/escort: the anchor tracks the protected entity each tick. If
            // that entity dies, drop the link and hold the spot where it fell — the
            // anchor keeps its last value (the locked "guard the death spot" rule).
            if (behavior.stance === 'guard' || behavior.stance === 'escort') {
              if (unit.guardTargetId) {
                const guarded = unitById.get(unit.guardTargetId);
                if (guarded && guarded.hp > 0) {
                  unit.anchor = { x: guarded.position.x, y: 0, z: guarded.position.z };
                } else {
                  delete unit.guardTargetId;
                }
              }
            }

            const params = stanceParams(behavior.stance, unit);
            const fleeing = behavior.stance === 'flee' || shouldFleeLowHp(unit);

            if (fleeing) {
              // Flee stance or the low-HP survival reflex: never engage. Head to the
              // anchor, or directly away from the nearest threat when there is no
              // home to fall back to. The retreat is a normal move order that the
              // order branch carries next tick (so it still defends if cornered).
              delete unit.priorityAttacker;
              let nearestEnemyPos: Position3D | null = null;
              if (draft.spatialGrid) {
                const threat = draft.spatialGrid.findClosestEnemy(unit, 50);
                if (threat) nearestEnemyPos = threat.position;
              }
              const retreat = retreatDestination(unit, unit.anchor, nearestEnemyPos);
              if (retreat) {
                draft.unitOrders[unit.id] = retreat;
                unit.unitState = 'moving_to_order';
              } else {
                unit.unitState = 'idle';
              }
            } else {
              // Pursuit is measured from the anchor ("home"), falling back to the
              // unit's current position when it has never been commanded — that
              // keeps an uncommanded unit's engagement short and local.
              const anchorRef = unit.anchor ?? unit.position;
              const chaseRadiusSq = params.chaseRadius * params.chaseRadius;
              const withinChase = (candidate: Unit) =>
                distanceSquared3D(anchorRef, candidate.position) <= chaseRadiusSq;

              // ATTACK RESPONSE (gated by fire mode): fight back at attackers we are
              // allowed to and willing to reach, keeping focus-fire on the current
              // priority attacker while it stays in range.
              if (effectiveFire === 'free' && params.engages &&
                  unit.currentAttackers && unit.currentAttackers.length > 0) {
                let chosen: Unit | null = null;
                if (unit.priorityAttacker && unit.currentAttackers.includes(unit.priorityAttacker)) {
                  const current = unitById.get(unit.priorityAttacker);
                  if (current && current.hp > 0 && withinChase(current)) chosen = current;
                }
                if (!chosen) {
                  const attackers = unit.currentAttackers
                    .map(id => unitById.get(id))
                    .filter((u): u is Unit => !!u && u.hp > 0 && withinChase(u));
                  chosen = pickTargetByPriority(unit, attackers, behavior.priority);
                }
                if (chosen) {
                  unit.priorityAttacker = chosen.id;
                  unit.unitState = 'pursuing_enemy';
                  target = chosen;
                }
              } else if (unit.priorityAttacker) {
                delete unit.priorityAttacker;
              }

              // AUTONOMOUS ACQUISITION when nothing has us engaged. Sticks with a
              // recent combat target if still in reach (focus-fire persistence),
              // otherwise picks from everything in detection range — filtered to the
              // stance's chase radius from the anchor so it never over-extends — by
              // the unit's target priority.
              if (!target && effectiveFire === 'free' && params.engages && draft.spatialGrid) {
                // FOCUS-FIRE (formation audible): a formed team can be ordered to
                // concentrate on one enemy. While that target lives and is reachable
                // (within detection + the stance's chase leash), every member prefers
                // it over its normal persistence/priority pick.
                if (unit.fireTeamId !== undefined) {
                  const team = draft.fireTeams[unit.fireTeamId];
                  if (team && team.focusTargetId) {
                    const focus = unitById.get(team.focusTargetId);
                    if (focus && focus.ownerId !== unit.ownerId && focus.hp > 0 &&
                        distanceSquared3D(unit.position, focus.position) <= params.detectionRadius * params.detectionRadius &&
                        withinChase(focus)) {
                      target = focus;
                    }
                  }
                }
                if (!target && unit.lastCombatTargetId && unit.lastCombatEngagementMs &&
                    nowMs - unit.lastCombatEngagementMs < 3000) {
                  const last = unitById.get(unit.lastCombatTargetId);
                  if (last && last.ownerId !== unit.ownerId && last.hp > 0 &&
                      distanceSquared3D(unit.position, last.position) <= params.detectionRadius * params.detectionRadius &&
                      withinChase(last)) {
                    target = last;
                  }
                }
                if (!target) {
                  const candidates = draft.spatialGrid
                    .findEnemiesInRange(unit, params.detectionRadius)
                    .filter((enemy) => enemy.hp > 0 && withinChase(enemy));
                  target = pickTargetByPriority(unit, candidates, behavior.priority);
                }
                if (target) unit.unitState = 'pursuing_enemy';
              }

              // RETURN TO ANCHOR: nothing to fight and we have drifted from home, so
              // walk back (issues a normal move order the order branch carries next
              // tick). HoldGround and uncommanded (anchorless) units simply idle.
              if (!target) {
                if (params.returnsToAnchor && unit.anchor &&
                    distanceXZ(unit.position, unit.anchor) > RETURN_DEADBAND) {
                  draft.unitOrders[unit.id] = { x: unit.anchor.x, y: 0, z: unit.anchor.z };
                  unit.unitState = 'moving_to_order';
                } else {
                  unit.unitState = 'idle';
                }
              }
            }
          }
        }

        // AI UNITS: Keep existing behavior for non-player units
        else if (!isPlayerUnit && order) {
          const distanceToOrder = distance3D(unit.position, order);

          // Check if movement is paused due to collision attempts
          const isInRecentCombat = unit.lastCombatEngagementMs && nowMs - unit.lastCombatEngagementMs < 2000;
          const isMovementPaused = unit.movementPausedUntilMs && nowMs < unit.movementPausedUntilMs && !isInRecentCombat;

          // Owl landing logic - land if within 15 units for more than 5 seconds
          if (unit.animal === 'Owl' && unit.isFlying && distanceToOrder <= 15) {
            if (!unit.nearDestinationSinceMs) {
              unit.nearDestinationSinceMs = nowMs;
            } else if (nowMs - unit.nearDestinationSinceMs >= 5000) {
              // Been near destination for 5+ seconds, land
              unit.isFlying = false;
              delete unit.nearDestinationSinceMs;
            }
          } else if (unit.animal === 'Owl' && distanceToOrder > 15) {
            // Reset timer if moved away from destination
            delete unit.nearDestinationSinceMs;
          }

          // Move toward ordered position
          if (distanceToOrder > 0.5 && !isMovementPaused) {
            const direction = normalize3D(subtract3D(steeringTarget(unit, order), unit.position));
            const moveDistance = unit.moveSpeed * dtSec;
            unit.rotation = Math.atan2(direction.x, direction.z);

            // Owl flying animation (AI units with orders)
            if (unit.animal === 'Owl') {
              unit.isFlying = true;
              const flapSpeed = 3; // Flaps per second
              unit.wingPhase = ((unit.wingPhase || 0) + (flapSpeed * dtSec)) % 1;
            } else {
              unit.isFlying = false;
            }

            const newPosition = {
              x: unit.position.x + direction.x * moveDistance,
              y: unit.position.y,
              z: unit.position.z + direction.z * moveDistance
            };

            unit.position = checkCollision(newPosition, unit, draft.units, 2.5, movementPriorityIds, playerControlledOwnerIds, draft.unitOrders, draft.spatialGrid);
          } else if (unit.animal === 'Owl') {
            // Owl landed when destination reached
            unit.isFlying = false;
          }

          // Clear order when destination reached
          if (distanceToOrder <= 0.5) {
            delete draft.unitOrders[unit.id];
            delete unit.arrivedAtDestinationMs;
          }
        }

        // AI ENEMY DETECTION: Only for AI units when they don't have orders
        else if (!order && !patrol) {
          // PLAYER UNIT FIX: Only search for enemies if they're very close or if AI unit
          if (isPlayerUnit) {
            // COMBAT PERSISTENCE: First try to re-engage last combat target if still valid
            if (unit.lastCombatTargetId && unit.lastCombatEngagementMs &&
                nowMs - unit.lastCombatEngagementMs < 3000) { // 3 second combat persistence
              const lastTarget = unitById.get(unit.lastCombatTargetId);
              if (lastTarget && lastTarget.ownerId !== unit.ownerId && lastTarget.hp > 0) {
                const distToLastTarget = distanceSquared3D(unit.position, lastTarget.position);
                if (distToLastTarget <= 100) { // 10 units - closer re-engagement range
                  target = lastTarget;
                }
              }
            }

            // If no combat target found, react defensively to very close enemies (within 8 units)
            if (!target && draft.spatialGrid) {
              const nearbyEnemies = draft.spatialGrid.findEnemiesInRange(unit, 8);
              if (nearbyEnemies.length > 0) {
                // Find closest nearby enemy
                target = nearbyEnemies.reduce((closest, enemy) => {
                  const distToCurrent = distanceSquared3D(unit.position, closest.position);
                  const distToEnemy = distanceSquared3D(unit.position, enemy.position);
                  return distToEnemy < distToCurrent ? enemy : closest;
                });
              }
            }
          } else if (shouldThinkThisTick) {
            // AI FOCUS-FIRE: First check if current target is still valid
            let currentTarget: Unit | null = null;

            // Check if we have a current focus target that's still alive and reachable
            if (unit.lastCombatTargetId) {
              const focusTarget = unitById.get(unit.lastCombatTargetId);
              if (focusTarget && focusTarget.ownerId !== unit.ownerId && focusTarget.hp > 0) {
                const distanceToFocus = Math.sqrt(distanceSquared3D(unit.position, focusTarget.position));
                // Stick with current target if it's within reasonable range (50 units)
                if (distanceToFocus <= 50) {
                  currentTarget = focusTarget;
                  if (tickDebug && unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
                    console.log(`AI unit ${unit.animal} FOCUS-FIRE: sticking with ${focusTarget.animal}, distance: ${distanceToFocus.toFixed(1)}`);
                  }
                }
              }
            }

            // Only find new target if current focus target is dead/invalid
            if (!currentTarget) {
              currentTarget = findClosestEnemy(unit, draft.spatialGrid, draft.units);
              if (currentTarget) {
                // Log new target acquisition
                const distance = Math.sqrt(distanceSquared3D(unit.position, currentTarget.position));
                if (tickDebug && unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
                  console.log(`AI unit ${unit.animal} NEW TARGET: ${currentTarget.animal}, distance: ${distance.toFixed(1)} units`);
                }
              } else {
                // Log when no enemies found (should be rare)
                if (tickDebug && unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
                  console.log(`AI unit ${unit.animal} found no enemies on map`);
                }
              }
            }

            target = currentTarget;

            // Cache the target for AI units with extended persistence
            if (target) {
              const cacheKey = `${unit.id}-target`;
              draft.targetCache[cacheKey] = target.id;
              // PERSISTENCE FIX: Cache for longer to prevent target switching during collision
              const persistenceKey = `${unit.id}-target-persistence`;
              draft.targetCache[persistenceKey] = target.id;
            } else {
              // AGGRESSIVE AI FIX: If no target found anywhere on map, log this unusual situation
              if (tickDebug) console.log(`AI unit ${unit.animal} (${unit.id}) found no enemies anywhere on map`);
            }
          } else if (!isPlayerUnit) {
            // COMBAT PERSISTENCE: First try to re-engage last combat target if still valid
            if (unit.lastCombatTargetId && unit.lastCombatEngagementMs &&
                nowMs - unit.lastCombatEngagementMs < 3000) { // 3 second combat persistence
              const lastTarget = unitById.get(unit.lastCombatTargetId);
              if (lastTarget && lastTarget.ownerId !== unit.ownerId && lastTarget.hp > 0) {
                const distToLastTarget = distanceSquared3D(unit.position, lastTarget.position);
                if (distToLastTarget <= 100) { // 10 units - closer re-engagement range
                  target = lastTarget;
                }
              }
            }

            // If no combat target found, use cached target for AI units on non-thinking frames
            // FOCUS-FIRE: Prioritize last combat target to maintain focus
            if (!target) {
              // First try to stick with last combat target (focus-fire)
              if (unit.lastCombatTargetId) {
                const focusTarget = unitById.get(unit.lastCombatTargetId);
                if (focusTarget && focusTarget.ownerId !== unit.ownerId && focusTarget.hp > 0) {
                  const distanceToFocus = Math.sqrt(distanceSquared3D(unit.position, focusTarget.position));
                  // Stick with focus target if within range
                  if (distanceToFocus <= 50) {
                    target = focusTarget;
                  }
                }
              }

              // Fall back to cached target if no focus target
              if (!target) {
                const cacheKey = `${unit.id}-target`;
                const cachedTargetId = draft.targetCache[cacheKey];
                if (cachedTargetId) {
                  const cached = unitById.get(cachedTargetId);
                  target = cached && cached.hp > 0 ? cached : null;
                  // Clear invalid cached targets
                  if (!target) {
                    delete draft.targetCache[cacheKey];
                  }
                }
              }
            }
          }
        }

        // COMBAT EXECUTION SECTION: Handle all units with targets (both player and AI)
        // This section processes combat for units that have targets from any source:
        // - Player units: targets from attack response (Priority 2)
        // - AI units: targets from enemy detection above
        if (target) {
          // Process combat logic here (moved from below)
          // OPTIMIZED: Reduced distance calculations
          const distSquared = distanceSquared3D(unit.position, target.position);
          const attackRangeSq = unit.attackRange * unit.attackRange;
          const isRangedUnit = unit.attackRange > MELEE_RANGE;

          // Debug: Log target acquisition and movement (throttled to avoid spam)
          if (tickDebug && unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
            const playerType = isPlayerUnit ? 'PLAYER' : 'AI';
            console.log(`${playerType} ${unit.animal} found target: ${target.animal}, distance: ${Math.sqrt(distSquared).toFixed(1)}`);
          }

          // Always face the enemy when in combat
          const direction = normalize3D(subtract3D(target.position, unit.position));
          unit.rotation = Math.atan2(direction.x, direction.z);

          // Debug: Check if player units are reaching combat logic
          if (tickDebug && isPlayerUnit && unit.id.endsWith('0') && draft.tickCounter % 60 === 0) {
            console.log(`PLAYER unit ${unit.animal} has TARGET: ${target.animal}, distance: ${Math.sqrt(distSquared).toFixed(1)}, attack range: ${unit.attackRange}`);
          }

          if (distSquared <= attackRangeSq) { // Within this animal's attack range
            // Within attack range - attack AND continue moving closer for more aggressive behavior
            if (nowMs - unit.lastAttackAtMs >= unit.attackCooldownMs) {
              // Add to combat batch instead of immediate damage. Army units
              // standing inside a friendly King's aura deal multiplied damage.
              const buffedDamage = kingBuffedUnitIds.has(unit.id)
                ? unit.attackDamage * draft.config.kingDamageMultiplier
                : unit.attackDamage;
              combatPairs.push({ attacker: unit, target, damage: buffedDamage });
              unit.lastAttackAtMs = nowMs;

              // COMBAT PERSISTENCE: Track combat engagement
              unit.lastCombatTargetId = target.id;
              unit.lastCombatEngagementMs = nowMs;

              // Track units under attack for immediate response
              unitsUnderAttack.add(target.id);

              // IMMEDIATE: Track this attack for the target unit to enable instant response
              if (!target.currentAttackers) {
                target.currentAttackers = [];
              }
              target.currentAttackers.push(unit.id);

              // DEBUG: Verify attacker tracking is working
              if (tickDebug && target.ownerId === draft.localPlayerId) {
                console.log(`ATTACKER TRACKED: ${unit.animal} (${unit.ownerId}) -> ${target.animal} (PLAYER). Target now has ${target.currentAttackers.length} attackers: [${target.currentAttackers.map(id => draft.units.find(u => u.id === id)?.animal || id).join(', ')}]`);
              }
              if (tickDebug) console.log(`Combat queued: ${unit.animal} vs ${target.animal}, distance: ${Math.sqrt(distSquared).toFixed(1)}`);
            }

            // Owl should keep flying even while attacking
            if (unit.animal === 'Owl') {
              unit.isFlying = true;
              const flapSpeed = 3; // Flaps per second
              unit.wingPhase = ((unit.wingPhase || 0) + (flapSpeed * dtSec)) % 1;
            }
          }

          // Combat movement: close the gap when out of range, or — for a ranged
          // unit that a faster melee threat has closed in on — back away to keep
          // shooting from distance (kiting). Player move orders stay authoritative,
          // so neither advance-to-engage nor kiting kicks in while an order is set:
          // without this guard the order step (south toward dest) and the engage step
          // (north toward target) cancel out and the unit freezes mid-bridge.
          let combatMoveDir: Position3D | null = null;
          if (distSquared > attackRangeSq && !order) {
            // Out of range: advance toward the target (ground units route via bridges).
            combatMoveDir = normalize3D(subtract3D(steeringTarget(unit, target.position), unit.position));
          } else if (isRangedUnit && !order && target.kind !== 'Base' &&
                     unit.moveSpeed > target.moveSpeed) {
            // In range but a mobile threat is too close: retreat to the standoff
            // band (~85% of max range) so we keep firing without being meleed.
            const standoff = unit.attackRange * 0.85;
            if (distSquared < standoff * standoff) {
              combatMoveDir = normalize3D(subtract3D(unit.position, target.position));
            }
          }

          if (combatMoveDir) {
            const moveDistance = unit.moveSpeed * dtSec;

            const newPosition = {
              x: unit.position.x + combatMoveDir.x * moveDistance,
              y: unit.position.y,
              z: unit.position.z + combatMoveDir.z * moveDistance
            };

            // Apply collision detection with more lenient collision for combat units.
            // Ground animals are also kept out of water here (see checkCollision).
            unit.position = checkCollision(newPosition, unit, draft.units, 2.5, movementPriorityIds, playerControlledOwnerIds, draft.unitOrders, draft.spatialGrid);

            // Frog and Bunny hopping animation (AI units)
            if (unit.animal === 'Frog' || unit.animal === 'Bunny') {
              unit.isHopping = true;
              const hopSpeed = unit.moveSpeed / 5;
              unit.hopPhase = ((unit.hopPhase || 0) + (hopSpeed * dtSec)) % 1;
            } else {
              unit.isHopping = false;
            }

            // Owl flying animation (AI units)
            if (unit.animal === 'Owl') {
              unit.isFlying = true;
              const flapSpeed = 3; // Flaps per second
              unit.wingPhase = ((unit.wingPhase || 0) + (flapSpeed * dtSec)) % 1;
            } else {
              unit.isFlying = false;
            }
          }
        }

        // ALWAYS update owl wing animation if they're flying (even when idle/hovering)
        if (unit.animal === 'Owl' && unit.isFlying) {
          const flapSpeed = 3; // Flaps per second
          unit.wingPhase = ((unit.wingPhase || 0) + (flapSpeed * dtSec)) % 1;
        }

        // After all XZ movement/collision/combat for this unit is settled, snap Y to
        // the terrain so a ground unit on an arched bridge walks on top of the deck
        // instead of clipping through its walls at water level.
        applyDeckElevation(unit, dtSec);
      }

      // Note: Attacker tracking will be cleared at the end of the tick after all processing

      // Debug: Log combat pairs processing
      if (tickDebug && combatPairs.length > 0 && draft.tickCounter % 60 === 0) {
        console.log(`Processing ${combatPairs.length} combat pairs this tick`);
      }

      // Process combat pairs
      for (const { attacker, target, damage } of combatPairs) {

        // Debug: Log when player units are being attacked
        if (tickDebug && !isAiByOwnerId[target.ownerId]) {
          console.log(`COMBAT: ${attacker.animal} (${attacker.ownerId}) attacking PLAYER ${target.animal} (${target.id})`);
        }

        target.hp -= mitigatedDamage(target, damage);
        if (target.hp <= 0) {
          if (tickDebug) console.log(`Unit ${target.animal} (${target.ownerId}) killed by ${attacker.animal} (${attacker.ownerId})`);
          draft.deadUnitsToRemove.push(target.id);
          creditKill(draft, attacker.ownerId, target);
        }

        // Apply knockback effect (but not to Bases - they should stay stationary)
        const knockbackDistance = 0.8; // Small knockback distance
        const direction = normalize3D(subtract3D(target.position, attacker.position));

        // Only apply knockback if target is still alive, not a Base, and direction is valid
        if (target.hp > 0 && target.kind !== 'Base' && (direction.x !== 0 || direction.z !== 0)) {
          const newPosition = {
            x: target.position.x + direction.x * knockbackDistance,
            y: target.position.y,
            z: target.position.z + direction.z * knockbackDistance
          };

          // Apply collision detection to the knockback position
          target.position = checkCollision(newPosition, target, draft.units, 2.5, movementPriorityIds, playerControlledOwnerIds, draft.unitOrders, draft.spatialGrid);
        }
      }

      // Debug: Log dead unit removal
      if (tickDebug && draft.deadUnitsToRemove.length > 0) {
        console.log(`Removing ${draft.deadUnitsToRemove.length} dead units`);
      }

      // Advance in-flight egg projectiles and resolve their hits. Runs before the
      // dead-unit cleanup below so an animal an egg kills this tick is removed in
      // the same pass as melee-combat deaths.
      updateProjectiles(draft, dtSec);

      // Advance every active Frog tongue grab (extend -> latch/damage -> drag/
      // retract). Also runs before dead-unit cleanup so an enemy the grab kills is
      // removed this same pass.
      updateFrogTongues(draft, dtSec, nowMs);

      // Advance every Bee mid-Swarm (dive toward its claimed enemy -> sting on contact).
      // Also runs before dead-unit cleanup so the bee and target a sting kills are both
      // removed in this same pass.
      updateBeeSwarms(draft, dtSec, nowMs);

      // Advance every Owl mid-Pickup (swoop down -> grab -> carry up -> drop). Runs before
      // dead-unit cleanup so an enemy a fatal drop kills is removed in this same pass.
      updateOwlPickups(draft, dtSec, nowMs);

      // Clear a lane for any selected King/Queen by shoving its blocking friendlies aside,
      // BEFORE the relaxation pass so separation can tidy the freshly opened formation and
      // (per its own rule) won't pull the shoved units back toward the selected royal.
      clearPathForSelectedRoyals(draft, movementPriorityIds, playerControlledOwnerIds);

      // Hold rallying followers off their piloted monarch (>= MONARCH_FOLLOW_GAP), BEFORE the
      // relaxation pass so it tidies the formation and won't pull followers back onto the
      // monarch (the monarch is skipped by that pass, so the gap it sets is preserved).
      enforceMonarchFollowGap(draft, unitById);

      // Relax any unit pile-ups now that all movement, combat, and Owl drops have settled this
      // tick. Idle/arrived/just-delivered units don't go through the moving-unit collision, so
      // without this pass their models would stack and clip on a single point.
      separateOverlappingUnits(draft, movementPriorityIds);

      // Final positional word: pull any ground unit a chain of shoves stranded on forbidden
      // water back toward the nearest shore so it self-recovers instead of freezing offshore
      // and ignoring orders. Runs after every push pass so nothing can re-strand it this tick.
      rescueStrandedGroundUnits(draft);

      // Immediate dead unit removal to prevent regeneration of dead units
      if (draft.deadUnitsToRemove.length > 0) {
        // Set-based membership test turns the cleanup from O(dead * units) into
        // a single O(units) pass.
        const deadSet = new Set(draft.deadUnitsToRemove);

        // Clean up references to dead units in one pass.
        for (const unit of draft.units) {
          // Clear priority attacker reference if it died.
          if (unit.priorityAttacker && deadSet.has(unit.priorityAttacker)) {
            delete unit.priorityAttacker;
          }
          // FOCUS-FIRE: Clear last combat target if it died (prevents AI from getting stuck)
          if (unit.lastCombatTargetId && deadSet.has(unit.lastCombatTargetId)) {
            delete unit.lastCombatTargetId;
            delete unit.lastCombatEngagementMs;
          }
          // Remove dead attackers from current attackers list.
          if (unit.currentAttackers) {
            unit.currentAttackers = unit.currentAttackers.filter(id => !deadSet.has(id));
          }
          // End a rally whose monarch just died so followers stop chasing a ghost.
          if (unit.followMonarchId && deadSet.has(unit.followMonarchId)) {
            delete unit.followMonarchId;
          }
        }

        // Stop piloting for any owner whose piloted King/Queen just died (and, for
        // the local player, cancel the placement hold so the teardrop doesn't linger
        // over a ghost). Checked per owner so a dead monarch ends only its own
        // owner's pilot — identically on both peers since deaths are deterministic.
        for (const ownerId in draft.pilotedUnitIdByOwner) {
          const pilotedId = draft.pilotedUnitIdByOwner[ownerId];
          if (pilotedId && deadSet.has(pilotedId)) {
            stopOwnerPilot(draft, ownerId);
          }
        }

        // Release a driven fire team once its last living member is gone, so the
        // drive vector stops steering a ghost squad. Deterministic: team membership
        // and deaths are identical on both peers.
        for (const ownerId in draft.pilotedFireTeamByOwner) {
          const teamId = draft.pilotedFireTeamByOwner[ownerId];
          if (
            teamId &&
            !draft.units.some(
              (u) => u.ownerId === ownerId && u.fireTeamId === teamId && u.hp > 0 && !deadSet.has(u.id)
            )
          ) {
            draft.pilotedFireTeamByOwner[ownerId] = null;
            if (ownerId === draft.localPlayerId) draft.pilotedFireTeamId = null;
          }
        }

        // Clear dead units from the target cache in one pass.
        for (const cacheKey in draft.targetCache) {
          if (deadSet.has(draft.targetCache[cacheKey])) {
            delete draft.targetCache[cacheKey];
          }
        }

        draft.units = draft.units.filter((u) => u.hp > 0 && !deadSet.has(u.id));
        draft.deadUnitsToRemove = [];

        // Rebuild the id lookup so post-removal cleanup uses live units only.
        unitById = new Map(draft.units.map((u) => [u.id, u]));

        // Rebuild spatial grid after removing dead units (important for next tick)
        if (draft.spatialGrid) {
          draft.spatialGrid.buildFromUnits(draft.units);
        }
      }

      // DEBUG: Log game state after all processing (every 60 ticks to reduce spam)
      if (tickDebug && draft.debugTickCount % 60 === 0) {
        const playerUnits = draft.units.filter(u => u.ownerId === draft.localPlayerId);
        const aiUnits = draft.units.filter(u => u.ownerId !== draft.localPlayerId);
        const playerUnitsUnderAttack = draft.units.filter(u => u.ownerId === draft.localPlayerId && u.currentAttackers && u.currentAttackers.length > 0);
        console.log(`🎮 GAME TICK #${draft.debugTickCount} - Total Units: ${draft.units.length} (Player: ${playerUnits.length}, AI: ${aiUnits.length}), Combat Pairs: ${combatPairs.length}`);
        if (playerUnitsUnderAttack.length > 0) {
          console.log(`Player units under attack: ${playerUnitsUnderAttack.map(u => `${u.animal}(${u.currentAttackers?.length || 0} attackers)`).join(', ')}`);
        }
      }

      // FINAL: Clean up invalid attackers (dead or too far away) but preserve valid ones
      // This allows persistent attack tracking for proper response
      for (const unit of draft.units) {
        if (unit.currentAttackers && unit.currentAttackers.length > 0) {
          // Remove dead attackers and attackers that are too far away
          unit.currentAttackers = unit.currentAttackers.filter(attackerId => {
            const attacker = unitById.get(attackerId);
            if (!attacker || attacker.hp <= 0) return false; // Dead attacker
            const distance = Math.sqrt(distanceSquared3D(unit.position, attacker.position));
            return distance <= 50; // Remove if attacker is more than 50 units away
          });
          // Clean up empty arrays
          if (unit.currentAttackers.length === 0) {
            delete unit.currentAttackers;
          }
        }
      }


      // Update bridge animations and capture who's currently holding each
      // trigger so we can credit Fully_Down time per side.
      const bridgePresence = updateBridgeAnimations(draft, nowMs);

      // Bridge time is scored independently per side. Sampled by dtSec so it
      // reflects real elapsed seconds independent of frame rate; scored in
      // 5-second slices in computeScore(). When both sides have a K/Q in the
      // zone simultaneously (contested), both sides accrue time — neither is
      // "stealing" credit from the other, and the leaderboard score still
      // rewards being there.
      const dtMs = dtSec * 1000;

      // Wall-clock match duration. The tick() function early-returns at the
      // top of the function when gameOver is true (see line ~384), so this
      // counter naturally freezes the instant the match is decided — exactly
      // what we want for the post-game "Match Time" stat and the leaderboard
      // tie-break.
      draft.matchStats.matchDurationMs += dtMs;
      if (draft.bridgeState.rightBridge.currentFrame === 'Fully_Down') {
        if (bridgePresence.playerInRightZone) draft.matchStats.rightBridgeDownMs       += dtMs;
        if (bridgePresence.enemyInRightZone)  draft.matchStats.enemyRightBridgeDownMs  += dtMs;
      }
      if (draft.bridgeState.leftBridge.currentFrame === 'Fully_Down') {
        if (bridgePresence.playerInLeftZone)  draft.matchStats.leftBridgeDownMs        += dtMs;
        if (bridgePresence.enemyInLeftZone)   draft.matchStats.enemyLeftBridgeDownMs   += dtMs;
      }

      // Throttled win condition checks (every 5 seconds instead of every tick)
      const WIN_CHECK_INTERVAL = 5000; // 5 seconds
      if (!draft.gameOver && (!draft.optimizations.winCheckThrottling || nowMs - draft.lastWinCheckMs >= WIN_CHECK_INTERVAL)) {
        checkWinConditions(draft);
        if (draft.optimizations.winCheckThrottling) {
          draft.lastWinCheckMs = nowMs;
        }
      }

      // Publish a fresh `units` array reference so ref-equality selectors (minimap,
      // HUD, interaction/keyboard layers) re-render this tick; every other field
      // was mutated in place on the live state and is carried through unchanged.
      set({ units: draft.units.slice() });
  },

  // In multiplayer, routeCommand hands this to the lockstep engine (returning
  // undefined here) instead of mutating now; the engine replays it on its
  // scheduled tick via applyNetCommand. In single-player routeCommand is a no-op
  // and the set() runs immediately. Same pattern on every routed action below.
  moveCommand: (cmd) => routeCommand({ type: 'moveUnits', payload: cmd }) ? undefined : set((prev) =>
    produce(prev, (draft) => {
      const ownerId = actingOwnerId(draft);

      // Formation-aware move (drag-to-direct): members of a formed fire team are
      // redirected as ONE unit — move the team's anchor to the target and turn it to
      // face the direction of travel — instead of scattering them with individual
      // orders the maintenance pass would just overwrite. The members then flow to
      // their new slots and arrive holding the shape, oriented toward the destination.
      const formedTeamIds = new Set<string>();
      for (const id of cmd.unitIds) {
        const u = draft.units.find((x) => x.id === id);
        if (!u || u.ownerId !== ownerId) continue;
        if (u.fireTeamId !== undefined && draft.fireTeams[u.fireTeamId]) formedTeamIds.add(u.fireTeamId);
      }
      for (const teamId of formedTeamIds) {
        const team = draft.fireTeams[teamId];
        const dx = cmd.target.x - team.anchor.x;
        const dz = cmd.target.z - team.anchor.z;
        // Face the direction of travel; a negligible move keeps the current facing.
        // (worldSlot's forward axis is (sin f, cos f), so a heading toward (dx,dz) is
        // atan2(dx, dz).)
        if (Math.hypot(dx, dz) > 0.01) team.facing = Math.atan2(dx, dz);
        team.anchor = { x: cmd.target.x, y: 0, z: cmd.target.z };
        team.dirty = true;
      }

      for (const id of cmd.unitIds) {
        const u = draft.units.find((x) => x.id === id);
        if (!u || u.ownerId !== ownerId) continue; // Only allow moving the acting player's units

        // Formed-team members are moved via their team anchor above; skip the
        // individual-order path so the maintenance pass keeps them in formation.
        if (u.fireTeamId !== undefined && draft.fireTeams[u.fireTeamId]) continue;

        // A mouse move order takes manual control back from a piloted King/Queen: stop
        // piloting it so the order actually takes effect. The pilot tick block drives the
        // unit purely from the owner's drive vector and deletes any move order each frame,
        // so a selected-but-piloted monarch would otherwise ignore the right-click. Keyed
        // on the unit's owner so a remote player's routed move releases its own pilot.
        if (draft.pilotedUnitIdByOwner[u.ownerId] === id) {
          stopOwnerPilot(draft, u.ownerId);
        }

        // Validate the destination tile only — whether the unit can actually
        // reach it is the pathfinder's job (grid A* routes around water/bridges),
        // not a per-unit straight-line raster precheck.
        //
        // The old straight-line `isPathValid(u.animal, u.position, cmd.target)`
        // precheck silently dropped this unit's order whenever the line from its
        // current position to the click happened to cross water — even though
        // A* would have routed it around. Because the verdict depended on each
        // unit's own position, units in the same selection got different answers
        // once they had spread out across the map: members on one side of a
        // river would ignore an order across it while members on the other side
        // accepted it. To the player: "some clusters listen, others don't,
        // especially after they reach their destination" (because that's when
        // the group is spread out enough for the straight lines to diverge).
        // The destination check below is shared by every unit in the command,
        // so it can't cause that asymmetry.
        try {
          if (!terrainValidator.canAnimalMoveTo(u.animal, cmd.target)) {
            console.log(`❌ ${u.animal} cannot move to target position (blocked by water/terrain)`);
            continue; // Skip this unit
          }
        } catch (error) {
          // Validator not initialized yet — allow movement (graceful degradation).
          console.warn(`⚠️ Terrain validator not ready, allowing movement for ${u.animal}`);
        }

        // Set new movement order
        draft.unitOrders[id] = cmd.target;

        // Re-home the stance anchor to the destination: a move order is a
        // positional intent, so a Defensive/Skirmish/Guard unit now leashes and
        // returns around where it was sent, not where it started. This is the one
        // place a move updates the anchor (see UnitBehavior.anchor).
        u.anchor = { x: cmd.target.x, y: 0, z: cmd.target.z };

        // Cancel any patrol route: an explicit move order replaces the patrol, so
        // the Queen must NOT resume walking the route once she reaches the order's
        // destination. Without this the order's arrival deletes only unitOrders and
        // the still-present patrol immediately recaptures her. A patrol resumes only
        // when the player draws a new one. See the Queen patrol branch in tick().
        delete draft.queenPatrols[id];

        // Break any monarch rally: an explicit destination means the player wants
        // this unit *here*, not pinned to the King/Queen. Without this the tick's
        // follow logic re-pins the order to the monarch every frame, so a rallied
        // unit could never be redirected.
        delete u.followMonarchId;

        // Reset unit state to prioritize new player order
        u.unitState = 'moving_to_order';
        delete u.arrivedAtDestinationMs;

        // Clear any combat state when new order given (override attack response)
        delete u.lastCombatTargetId;
        delete u.lastCombatEngagementMs;
        delete u.priorityAttacker;

        // Clear blocking state when new order given
        u.collisionAttempts = 0;
        delete u.movementPausedUntilMs;
        delete u.firstBlockedAtMs;

        // Clear owl landing timer
        delete u.nearDestinationSinceMs;

        // Drop any cached A* path. hasUsablePath() reuses a stored path whose goal is
        // within ~12 units of the new destination, so a unit that just finished its
        // previous order at A and is then ordered to a nearby B would keep steering
        // toward A — its current position — and not move until the stall detector
        // eventually re-paths (~0.75s). Looks to the player like the order was ignored.
        delete u.pathWaypoints;
        delete u.pathIndex;
        delete u.pathDestX;
        delete u.pathDestZ;
        delete u.pathVersion;
        delete u.pathStall;
        delete u.pathProgressDist;

        console.log(`✅ PLAYER issued new order to ${u.animal} - switching to MOVING_TO_ORDER state`);
      }
    })
  ),

  setPatrol: (cmd) => routeCommand({ type: 'setPatrol', payload: cmd }) ? undefined : set((prev) =>
    produce(prev, (draft) => {
      const queen = draft.units.find(u => u.id === cmd.queenId);
      if (!queen || queen.ownerId !== actingOwnerId(draft) || queen.kind !== 'Queen') return;

      // Set patrol route for the queen
      draft.queenPatrols[cmd.queenId] = {
        startPosition: cmd.startPosition,
        endPosition: cmd.endPosition,
        currentTarget: 'end' // Start by moving toward end position
      };

      // Clear any existing unit orders for this queen
      delete draft.unitOrders[cmd.queenId];

      // Drawing a patrol takes manual control back from a piloted Queen, exactly
      // as moveCommand/attackTarget do: stop piloting her so the patrol actually
      // takes effect. The pilot tick block (see the pilotedUnitId branch in tick())
      // runs BEFORE the patrol branch, drives the unit purely from ESDF/pilotInput,
      // drops any order, and continues past the rest of the per-unit logic — so a
      // still-piloted Queen would hold the route but never walk it until a separate
      // move order released piloting. This is the A→G (select King, toggle to Queen)
      // case, where the Queen is left as the piloted unit when the patrol is drawn.
      if (draft.pilotedUnitIdByOwner[queen.ownerId] === cmd.queenId) {
        stopOwnerPilot(draft, queen.ownerId);
      }

      // Committing a patrol means the patrol-draw hold is over, so lift the
      // movement freeze on this queen here rather than relying solely on the
      // gesture handler's separate setMovementHold(null). Otherwise a missed or
      // out-of-order release would leave her pinned (the tick's freeze block
      // skips all order/patrol movement), so she'd hold the route but never walk it.
      if (draft.movementHeldUnitId === cmd.queenId) {
        draft.movementHeldUnitId = null;
      }

      // Drop the queen's cached A* path and movement-blocking state, exactly as
      // moveCommand/attackTarget do. The patrol tick steers a ground queen via
      // steeringTarget -> pathfinder.nextWaypoint, which reuses a cached path
      // whose goal is within ~12 units of the new one (hasUsablePath). A queen
      // that previously moved and stopped would otherwise keep steering toward
      // her old cached goal — her current position — yielding a (0,0,0)
      // direction, so she'd sit still and never start patrolling. See the
      // stale-path-cache fix in moveCommand and the move-command-stale-path test.
      delete queen.pathWaypoints;
      delete queen.pathIndex;
      delete queen.pathDestX;
      delete queen.pathDestZ;
      delete queen.pathVersion;
      delete queen.pathStall;
      delete queen.pathProgressDist;

      // Reset blocking/stall bookkeeping so a stale "paused" window can't carry
      // over and stall the first leg of the patrol.
      queen.collisionAttempts = 0;
      delete queen.movementPausedUntilMs;
      delete queen.firstBlockedAtMs;
      delete queen.nearDestinationSinceMs;
    })
  ),

  // Set a Queen's spawn rally target (the two-tap 'R' gesture). Validated to the
  // local player's Queens so a stray id can't redirect an enemy's spawns. From
  // here on, every Unit this Queen spawns is sent to the target in the spawn loop:
  // a 'point' marches them to a fixed staging spot; a 'follow' makes them fall in
  // behind a friendly monarch. A 'follow' target is itself validated to a living
  // friendly monarch so the rally never points at a dead or enemy unit.
  setQueenRally: (cmd) => routeCommand({ type: 'setQueenRally', payload: cmd }) ? undefined : set((prev) =>
    produce(prev, (draft) => {
      const queen = draft.units.find(u => u.id === cmd.queenId);
      if (!queen || queen.ownerId !== actingOwnerId(draft) || queen.kind !== 'Queen') return;

      const target = cmd.target; // capture so the narrowing survives the find() closure
      if (target.mode === 'follow') {
        // Validate the follow target is a living friendly monarch (King/Queen) so the
        // rally never points at a dead or enemy unit.
        const monarch = draft.units.find(u => u.id === target.monarchId);
        if (!monarch || monarch.ownerId !== actingOwnerId(draft) || monarch.hp <= 0 ||
            (monarch.kind !== 'King' && monarch.kind !== 'Queen')) return;
        draft.queenRallyTargets[cmd.queenId] = { mode: 'follow', monarchId: monarch.id };
      } else {
        const { position } = target;
        draft.queenRallyTargets[cmd.queenId] = {
          mode: 'point',
          position: { x: position.x, y: 0, z: position.z },
        };
      }
    })
  ),

  // Freeze (unitId) or release (null) a unit's movement for the duration of the
  // secondary-button patrol-draw hold. Validated to the local player so a held
  // id can only ever pin one of their own units. The tick honors this by holding
  // the unit's position and skipping its AI/order/patrol movement that tick.
  setMovementHold: (unitId) => routeCommand({ type: 'setMovementHold', payload: { unitId } }) ? undefined : set((prev) => {
    if (unitId === null) return { movementHeldUnitId: null };
    const unit = prev.units.find(u => u.id === unitId);
    if (!unit || unit.ownerId !== actingOwnerId(prev)) return {};
    return { movementHeldUnitId: unitId };
  }),

  attackTarget: (cmd) => routeCommand({ type: 'attackTarget', payload: cmd }) ? undefined : set((prev) =>
    produce(prev, (draft) => {
      const target = draft.units.find(u => u.id === cmd.targetId);
      if (!target) return;
      const ownerId = actingOwnerId(draft);

      // Formation-aware attack (focus-fire audible): a formed fire team concentrates
      // its fire on the target and advances on it as ONE unit — set the team's
      // focus-fire target, march its anchor onto the enemy, and turn it to face the
      // enemy — rather than scattering individual attack orders the maintenance pass
      // would overwrite. The focus-fire hook in the engage block then makes every
      // member prefer that enemy.
      const formedTeamIds = new Set<string>();
      for (const id of cmd.unitIds) {
        const u = draft.units.find(x => x.id === id);
        if (!u || u.ownerId !== ownerId) continue;
        if (u.fireTeamId !== undefined && draft.fireTeams[u.fireTeamId]) formedTeamIds.add(u.fireTeamId);
      }
      for (const teamId of formedTeamIds) {
        const team = draft.fireTeams[teamId];
        team.focusTargetId = cmd.targetId;
        const dx = target.position.x - team.anchor.x;
        const dz = target.position.z - team.anchor.z;
        if (Math.hypot(dx, dz) > 0.01) team.facing = Math.atan2(dx, dz);
        team.anchor = { x: target.position.x, y: 0, z: target.position.z };
        team.dirty = true;
      }

      for (const id of cmd.unitIds) {
        const unit = draft.units.find(u => u.id === id);
        if (!unit || unit.ownerId !== ownerId) continue;

        // Formed-team members focus-fire via their team above; skip the individual
        // attack-order path so the maintenance pass keeps them in formation.
        if (unit.fireTeamId !== undefined && draft.fireTeams[unit.fireTeamId]) continue;

        // A mouse attack order takes manual control back from a piloted King/Queen (see
        // moveCommand): stop piloting it so the order isn't dropped by the pilot tick block.
        if (draft.pilotedUnitIdByOwner[unit.ownerId] === id) {
          stopOwnerPilot(draft, unit.ownerId);
        }

        // Set movement target to enemy position
        draft.unitOrders[id] = { x: target.position.x, y: 0, z: target.position.z };

        // Cancel any patrol route (see moveCommand): an explicit attack order
        // replaces the patrol so the Queen won't snap back to her route after the
        // engagement instead of staying on the new command.
        delete draft.queenPatrols[id];

        // Break any monarch rally (see moveCommand): an explicit attack order
        // takes the unit off "follow the King/Queen" so it isn't re-pinned to
        // the monarch by the follow logic each tick.
        delete unit.followMonarchId;

        // Reset unit state to prioritize attack order
        unit.unitState = 'pursuing_enemy';
        delete unit.arrivedAtDestinationMs;

        // Clear blocking state
        unit.collisionAttempts = 0;
        delete unit.movementPausedUntilMs;
        delete unit.firstBlockedAtMs;

        // Clear owl landing timer
        delete unit.nearDestinationSinceMs;

        // Drop any cached A* path (see moveCommand for why — same stale-route trap
        // applies when right-click attack picks a target near the unit's last goal).
        delete unit.pathWaypoints;
        delete unit.pathIndex;
        delete unit.pathDestX;
        delete unit.pathDestZ;
        delete unit.pathVersion;
        delete unit.pathStall;
        delete unit.pathProgressDist;

        console.log(`Unit ${unit.animal} targeting enemy ${cmd.targetId}`);
      }
    })
  ),

  // Set the combat posture on the acting player's units. Routed through the
  // lockstep engine like every other command so both peers mutate identically;
  // `behavior` is merged axis-by-axis (the radial sets one axis at a time). When a
  // unit first receives a stance it has no anchor, we seed one at its current
  // position so "defend/skirmish here" has a home to leash and return to.
  setBehavior: (cmd) => routeCommand({ type: 'setBehavior', payload: cmd }) ? undefined : set((prev) =>
    produce(prev, (draft) => {
      for (const id of cmd.unitIds) {
        const unit = draft.units.find((u) => u.id === id);
        if (!unit || unit.ownerId !== actingOwnerId(draft)) continue;

        unit.behavior = mergeBehavior(behaviorOf(unit), cmd.behavior);

        // Assigning a stance is a positional intent: anchor here if not already
        // anchored, so the unit holds this ground rather than wandering.
        if (!unit.anchor) {
          unit.anchor = { x: unit.position.x, y: 0, z: unit.position.z };
        }

        // Guard/escort target wiring: a present id sets the protected entity, an
        // explicit null clears it.
        if (cmd.guardTargetId === null) {
          delete unit.guardTargetId;
        } else if (cmd.guardTargetId !== undefined) {
          unit.guardTargetId = cmd.guardTargetId;
        }
      }
    })
  ),

  setFormation: (cmd) => routeCommand({ type: 'setFormation', payload: cmd }) ? undefined : set((prev) =>
    produce(prev, (draft) => {
      const ownerId = actingOwnerId(draft);
      if (!ownerId) return;

      // Living movable units the acting player asked to form up, ordered by id so
      // the team-id choice, the centroid sum, the heading average, and the slot
      // assignment are all identical on both lockstep peers regardless of array
      // order. Bases/monarchs are excluded — only army Units hold a formation.
      const requested = new Set(cmd.unitIds);
      const members = draft.units
        .filter(
          (unit) =>
            requested.has(unit.id) &&
            unit.ownerId === ownerId &&
            unit.kind === 'Unit' &&
            unit.hp > 0
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (members.length === 0) return;

      // Group the members under one fire team: reuse the id if they already all
      // share one (re-shaping an existing squad), otherwise mint a fresh
      // deterministic id and stamp it on every member, so loose units selected
      // together become a fire team the instant they are shaped. nextEntityId keeps
      // both lockstep peers minting the same id (same as the deploy path).
      const firstTeamId = members[0].fireTeamId;
      const sharedTeamId =
        firstTeamId !== undefined && members.every((unit) => unit.fireTeamId === firstTeamId)
          ? firstTeamId
          : null;
      const teamId = sharedTeamId ?? nextEntityId('FT');
      if (sharedTeamId === null) {
        for (const unit of members) unit.fireTeamId = teamId;
      }

      // Set the PERSISTENT formation intent; the maintenance pass (maintainFormations)
      // does the actual slotting each tick. The shape centers on the squad's current
      // centroid. Heading priority: an explicit command facing, else the team's
      // existing facing (re-shaping in place keeps its orientation), else the way the
      // members currently look. `dirty` makes the next tick re-slot every member.
      const existing = draft.fireTeams[teamId];
      const anchor = centroidOf(members.map((unit) => unit.position));
      const facing =
        cmd.facing ?? existing?.facing ?? meanHeading(members.map((unit) => unit.rotation));

      draft.fireTeams[teamId] = {
        shape: cmd.shape,
        anchor,
        facing,
        spacing: defaultSpacingFor(cmd.shape),
        role: cmd.role ?? existing?.role,
        focusTargetId: existing?.focusTargetId,
        dirty: true,
        memberKey: '',
      };
    })
  ),

  adjustFormation: (cmd) => routeCommand({ type: 'adjustFormation', payload: cmd }) ? undefined : set((prev) =>
    produce(prev, (draft) => {
      const ownerId = actingOwnerId(draft);
      if (!ownerId) return;

      // The formed teams represented in the selection (deduped, owner-gated).
      const teamIds = new Set<string>();
      for (const id of cmd.unitIds) {
        const unit = draft.units.find((u) => u.id === id);
        if (!unit || unit.ownerId !== ownerId) continue;
        if (unit.fireTeamId !== undefined && draft.fireTeams[unit.fireTeamId]) teamIds.add(unit.fireTeamId);
      }

      for (const teamId of teamIds) {
        const team = draft.fireTeams[teamId];
        switch (cmd.op) {
          case 'rotateLeft':
            team.facing -= FORMATION_ROTATE_STEP;
            team.dirty = true;
            break;
          case 'rotateRight':
            team.facing += FORMATION_ROTATE_STEP;
            team.dirty = true;
            break;
          case 'expand':
            team.spacing = Math.min(FORMATION_MAX_SPACING, team.spacing + FORMATION_SPACING_STEP);
            team.dirty = true;
            break;
          case 'contract':
            team.spacing = Math.max(FORMATION_MIN_SPACING, team.spacing - FORMATION_SPACING_STEP);
            team.dirty = true;
            break;
          case 'disband':
            // Break the formation: drop the state and free its members (they keep no
            // fireTeamId, so they revert to ordinary selectable units).
            delete draft.fireTeams[teamId];
            for (const unit of draft.units) {
              if (unit.fireTeamId === teamId) delete unit.fireTeamId;
            }
            break;
        }
      }
    })
  ),

  callPlay: (cmd) => routeCommand({ type: 'callPlay', payload: cmd }) ? undefined : set((prev) =>
    produce(prev, (draft) => {
      const ownerId = actingOwnerId(draft);
      if (!ownerId) return;
      const play = PLAYBOOK[cmd.play];
      if (!play) return;

      // Group the acting player's living formed members by team in ONE pass, instead of
      // re-scanning every unit once per team (which was O(teams x units)). The map then
      // serves both the "which teams have members" filter and the per-team posture loop.
      const membersByTeam = new Map<string, Unit[]>();
      for (const unit of draft.units) {
        const teamId = unit.fireTeamId;
        if (teamId === undefined || unit.ownerId !== ownerId || unit.kind !== 'Unit' || unit.hp <= 0) continue;
        if (!draft.fireTeams[teamId]) continue;
        const list = membersByTeam.get(teamId);
        if (list) list.push(unit);
        else membersByTeam.set(teamId, [unit]);
      }

      // The acting player's formed teams with living members, ordered by id so the
      // centroid sum and classification are lockstep-identical.
      const teamIds = [...membersByTeam.keys()].sort();
      if (teamIds.length === 0) return;

      // Army centroid + a representative facing, to measure each team's sideways
      // (right-axis) offset for role classification.
      const armyCentroid = centroidOf(teamIds.map((teamId) => draft.fireTeams[teamId].anchor));
      const armyFacing = meanHeading(teamIds.map((teamId) => draft.fireTeams[teamId].facing));
      const rightOffsets = teamIds.map((teamId) => {
        const anchor = draft.fireTeams[teamId].anchor;
        return rightAxisComponent(anchor.x - armyCentroid.x, anchor.z - armyCentroid.z, armyFacing);
      });
      // Band scales with how spread the army is, with a floor so a tight cluster
      // still resolves cleanly into a single center role rather than jittering.
      const maxAbsRight = rightOffsets.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
      const band = Math.max(6, maxAbsRight * 0.34);

      teamIds.forEach((teamId, index) => {
        const role = classifyRole(rightOffsets[index], band);
        const rolePlay = play[role];
        const team = draft.fireTeams[teamId];
        team.shape = rolePlay.shape;
        team.spacing = defaultSpacingFor(rolePlay.shape);
        team.role = role;
        team.dirty = true;
        // Posture every member of the team for the play (from the prebuilt group).
        for (const unit of membersByTeam.get(teamId)!) {
          unit.behavior = mergeBehavior(behaviorOf(unit), { stance: rolePlay.stance });
        }
      });
    })
  ),

  selectUnits: (unitIds) => set({ selectedUnitIds: unitIds }),

  addToSelection: (unitIds) => set((prev) => ({
    selectedUnitIds: Array.from(new Set([...prev.selectedUnitIds, ...unitIds]))
  })),
  
  // Deselecting fully releases control of the player's units, not just the selection
  // highlight: it stops piloting the monarch (so ESDF/stick no longer drives it) and breaks
  // any rally (followers drop their follow order and stop trailing). Without this a deselect
  // only emptied selectedUnitIds while pilotedUnitId and followMonarchId persisted, leaving
  // the King/Queen and its army still under the player's control after they had let go.
  clearSelection: () => {
    const prev = get();
    // Local UI release is immediate in both modes: empty the selection, drop the
    // gold ring, and cancel any placement hold so the controls feel responsive.
    pilotInput.reset();
    set({ selectedUnitIds: [], pilotedUnitId: null, unitPlacementCount: 0, unitPlacementCursor: null });

    // The simulation-affecting part (stop piloting + break this owner's rally,
    // which mutates followMonarchId / unitOrders) must go through the
    // deterministic command path, or a local deselect would desync multiplayer.
    if (routeCommand({ type: 'releaseControl', payload: {} })) return;
    const localPlayerId = prev.localPlayerId;
    if (!localPlayerId) return;
    set((s) => produce(s, (draft) => releaseOwnerControl(draft, localPlayerId)));
  },

  // --- Direct monarch piloting -------------------------------------------------
  // Start piloting the King of the local player's animal in `slotIndex`
  // (0/1/2 -> z/x/c). Defaults to the King; the player can swap to the Queen
  // with togglePilotMonarchKind. Selecting it also makes it the current
  // selection so the existing ring/HUD highlight the piloted unit, and the
  // camera (which follows the selection) eases onto it. Re-pressing the slot of
  // the unit already being piloted stops piloting.
  pilotMonarchBySlot: (slotIndex) => {
    const prev = get();
    if (!prev.localPlayerId) return;
    const animal = prev.selectedAnimalPool[slotIndex];
    if (!animal) return;

    // If already piloting this animal's monarch, the same key unpilots it.
    const current = prev.pilotedUnitId
      ? prev.units.find((u) => u.id === prev.pilotedUnitId)
      : null;
    if (current && current.animal === animal) {
      beginLocalPilot(null);
      return;
    }

    // Prefer the King; fall back to the Queen if the King is already dead.
    const monarch =
      findMonarch(prev.units, prev.localPlayerId, animal, 'King') ??
      findMonarch(prev.units, prev.localPlayerId, animal, 'Queen');
    if (!monarch) return;

    beginLocalPilot(monarch.id);
  },

  // Pilot the monarch identified by `unitId` (the on-screen King/Queen selection
  // buttons). Re-pressing the monarch already being piloted releases it, matching
  // pilotMonarchBySlot's toggle. Ignores units that are not one of the local
  // player's living King/Queen so a stale button id can't grab a bad target.
  pilotMonarchById: (unitId) => {
    const prev = get();
    if (!prev.localPlayerId) return;

    if (prev.pilotedUnitId === unitId) {
      beginLocalPilot(null);
      return;
    }

    const monarch = prev.units.find((u) => u.id === unitId);
    if (
      !monarch ||
      monarch.ownerId !== prev.localPlayerId ||
      (monarch.kind !== 'King' && monarch.kind !== 'Queen')
    ) {
      return;
    }

    beginLocalPilot(monarch.id);
  },

  // Cycle the piloted monarch through the local player's animal pool (the "A"
  // key). When not piloting, this starts on the first animal's monarch; while
  // piloting, it advances to the next animal that still has a living monarch
  // (wrapping around). Each step prefers the King, falling back to the Queen.
  // Returns to no-pilot is handled by re-pressing nothing — there is always a
  // monarch to land on as long as one animal still has one alive.
  pilotCycleMonarch: () => {
    const prev = get();
    if (!prev.localPlayerId) return;
    const pool = prev.selectedAnimalPool;
    if (pool.length === 0) return;

    // Resolve the pool slot of the animal we are currently piloting, so the
    // next press advances from there; default just before slot 0 otherwise.
    const current = prev.pilotedUnitId
      ? prev.units.find((u) => u.id === prev.pilotedUnitId)
      : null;
    const currentSlot = current ? pool.indexOf(current.animal) : -1;

    // Walk forward through the pool (wrapping) until we find an animal with a
    // living monarch, so dead-monarch animals are skipped rather than stalling.
    for (let step = 1; step <= pool.length; step++) {
      const slot = (currentSlot + step) % pool.length;
      const animal = pool[slot];
      if (!animal) continue;
      const monarch =
        findMonarch(prev.units, prev.localPlayerId, animal, 'King') ??
        findMonarch(prev.units, prev.localPlayerId, animal, 'Queen');
      if (monarch) {
        beginLocalPilot(monarch.id);
        return;
      }
    }
  },

  // Swap the piloted unit between the King and Queen of the same animal (G).
  // No-op when not piloting or when the sibling monarch is dead.
  togglePilotMonarchKind: () => {
    const prev = get();
    if (!prev.localPlayerId || !prev.pilotedUnitId) return;
    const current = prev.units.find((u) => u.id === prev.pilotedUnitId);
    if (!current || (current.kind !== 'King' && current.kind !== 'Queen')) return;

    const sibling = findMonarch(
      prev.units,
      prev.localPlayerId,
      current.animal,
      otherMonarchKind(current.kind as MonarchKind)
    );
    if (!sibling) return;

    beginLocalPilot(sibling.id);
  },

  // "Rally" the piloted monarch (Space / controller) and select that animal's army.
  // Every living army Unit of the same animal and owner trails the monarch (the
  // tick keeps their move order pinned to its position). The rally is idempotent —
  // pressing again simply re-rallies and never drops the army or the selection, so
  // the input can't accidentally deselect (clearing is the dedicated Deselect
  // input's job). The army is left selected so the player can immediately redirect
  // it with a right-click — and issuing that move order breaks the unit off the
  // monarch (see moveCommand).
  rallyToMonarch: () => {
    const prev = get();
    const localPlayerId = prev.localPlayerId;
    if (!localPlayerId || !prev.pilotedUnitId) return;
    const monarch = prev.units.find((u) => u.id === prev.pilotedUnitId);
    if (!monarch) return;

    // Select the piloted monarch alongside its army immediately (local-only, so it
    // is fine outside the deterministic path) so a right-click can redirect the
    // army this frame while the gold ring stays on the monarch. The monarch leads
    // the id list; its same-animal followers trail it.
    const followerIds = prev.units
      .filter(
        (u) => u.ownerId === localPlayerId && u.kind === 'Unit' && u.animal === monarch.animal
      )
      .map((u) => u.id);
    set({ selectedUnitIds: [monarch.id, ...followerIds] });

    // The follow state itself is simulation state: routed in multiplayer,
    // immediate in single-player. Both peers resolve the rally the same way at
    // apply time from the synced followMonarchId state.
    if (routeCommand({ type: 'rallyMonarch', payload: { monarchId: monarch.id } })) return;
    set((s) => produce(s, (draft) => applyRallyToDraft(draft, localPlayerId, monarch.id)));
  },

  // Cycle the local player's drive control through their deployed fire teams, then
  // off again. The next team is chosen locally from the player's own view, then the
  // concrete team id is routed so both lockstep peers steer the same squad from the
  // synced pilotMove vector (deterministic like setPilot). A no-op with no teams.
  cycleFireTeam: () => {
    const prev = get();
    const localPlayerId = prev.localPlayerId;
    if (!localPlayerId) return;

    const teamIds = listFireTeamIds(prev.units, localPlayerId);
    if (teamIds.length === 0) return;
    const nextTeamId = nextFireTeamInCycle(teamIds, prev.pilotedFireTeamId);

    // Switching drive targets ends any in-progress placement hold; reset it so a
    // stale teardrop never lingers from the monarch the player just stepped off.
    pilotInput.reset();

    if (routeCommand({ type: 'setPilotFireTeam', payload: { teamId: nextTeamId } })) return;
    set((s) => produce(s, (draft) => applyPilotFireTeamToDraft(draft, localPlayerId, nextTeamId)));
  },

  // Designate one more follower for a placement order while the rally key is held
  // (called once per UNIT_PLACEMENT_INTERVAL_MS by the input layer). The count is
  // capped at the number of followers currently trailing the piloted monarch, so
  // the teardrop indicator stops climbing once the whole rally has been claimed.
  // Returns the resulting count so the caller knows whether a hold (>= 1) or a
  // quick tap (0) occurred on release.
  incrementUnitPlacement: () => {
    const prev = get();
    // Purely a local UI counter for the teardrop indicator (the actual order is
    // issued by placeRalliedUnits on release), so it stays local in multiplayer.
    if (!prev.localPlayerId || !prev.pilotedUnitId) return prev.unitPlacementCount;

    const monarch = prev.units.find((u) => u.id === prev.pilotedUnitId);
    if (!monarch) return prev.unitPlacementCount;

    const followerCount = prev.units.reduce(
      (count, unit) =>
        unit.ownerId === prev.localPlayerId &&
        unit.kind === 'Unit' &&
        unit.animal === monarch.animal &&
        unit.followMonarchId === monarch.id
          ? count + 1
          : count,
      0
    );

    // Climb the deployment ladder (1, 5, 10, 15, 25, …) rather than one unit per
    // interval, so a held Deploy designates a meaningful batch quickly. Always
    // clamped to the followers actually trailing the monarch.
    const next = clampPlacementCount(nextPlacementStep(prev.unitPlacementCount), followerCount);
    if (next !== prev.unitPlacementCount) set({ unitPlacementCount: next });
    return next;
  },

  // Execute a placement hold: peel the `count` followers nearest the piloted
  // monarch off the rally and send them to its current position, leaving the rest
  // trailing it. Mirrors moveCommand's per-unit order reset (clears combat,
  // blocking and the stale A* path cache) so the placed units actually travel.
  placeRalliedUnits: (count, target) => {
    const prev = get();
    const localPlayerId = prev.localPlayerId;
    // The gesture is consumed regardless of outcome: clear the local teardrop now.
    if (prev.unitPlacementCount !== 0) set({ unitPlacementCount: 0 });
    if (prev.unitPlacementCursor !== null) set({ unitPlacementCursor: null });
    if (count <= 0 || !localPlayerId || !prev.pilotedUnitId) return;
    const monarchId = prev.pilotedUnitId;

    // The placement issues real move orders (simulation state), so route it in
    // multiplayer; apply at once in single-player. The follower choice is
    // position-deterministic, so both peers peel the same units off the rally.
    if (routeCommand({ type: 'placeRallied', payload: { monarchId, count, target } })) return;
    set((s) => produce(s, (draft) => applyPlaceRalliedToDraft(draft, localPlayerId, monarchId, count, target)));
  },

  // Cancel a placement hold without issuing an order (a quick tap, a deselect, or
  // the monarch dying) so the teardrop indicator disappears.
  resetUnitPlacement: () => {
    if (get().unitPlacementCount !== 0) set({ unitPlacementCount: 0 });
    if (get().unitPlacementCursor !== null) set({ unitPlacementCursor: null });
  },

  // Point the teardrop at a chosen ground spot (cursor deploy) or back at the
  // monarch (null). Purely local UI; never routed.
  setUnitPlacementCursor: (point) => {
    set({ unitPlacementCursor: point });
  },

  // Stop piloting entirely (used on death / match end / explicit cancel). Clears
  // the local UI immediately and routes the per-owner simulation release so a
  // multiplayer peer's pilot state is cleared in lockstep.
  clearPilot: () => {
    const prev = get();
    pilotInput.reset();
    set({ pilotedUnitId: null, unitPlacementCount: 0, unitPlacementCursor: null });
    const localPlayerId = prev.localPlayerId;
    if (!localPlayerId) return;
    if (routeCommand({ type: 'setPilot', payload: { unitId: null } })) return;
    set((s) => produce(s, (draft) => applyPilotSelectionToDraft(draft, localPlayerId, null)));
  },

  // --- Lockstep apply handlers for the piloting commands -----------------------
  // Invoked only by applyNetCommand, with the issuing owner, so each peer mutates
  // the correct owner's per-owner pilot state deterministically. They never route
  // (applyNetCommand runs them with the router suppressed) and never touch local-
  // only UI for a remote owner.
  applyPilotSelection: (ownerId, unitId) =>
    set((prev) => produce(prev, (draft) => applyPilotSelectionToDraft(draft, ownerId, unitId))),

  applyPilotMove: (ownerId, move) => {
    const prev = get();
    // Replace just this owner's drive slot. Runs up to ~120x/sec (both peers,
    // every tick), so it avoids immer and only swaps the small record.
    set({ pilotMoveByOwner: { ...prev.pilotMoveByOwner, [ownerId]: { x: move.x, z: move.z } } });
  },

  applyRallyMonarch: (ownerId, monarchId) =>
    set((prev) => produce(prev, (draft) => applyRallyToDraft(draft, ownerId, monarchId))),

  applyPlaceRallied: (ownerId, monarchId, count, target) =>
    set((prev) => produce(prev, (draft) => applyPlaceRalliedToDraft(draft, ownerId, monarchId, count, target))),

  applyReleaseControl: (ownerId) =>
    set((prev) => produce(prev, (draft) => releaseOwnerControl(draft, ownerId))),

  applyPilotFireTeam: (ownerId, teamId) =>
    set((prev) => produce(prev, (draft) => applyPilotFireTeamToDraft(draft, ownerId, teamId))),

  // Toggle the "shell" lock on the local player's Turtle units in the given
  // selection. Shelling pins the unit in place (see checkCollision) and the
  // renderer swaps it to the F0 shell pose; toggling again releases it.
  toggleTurtleShell: (unitIds) => routeCommand({ type: 'toggleTurtleShell', payload: { unitIds } }) ? undefined : set((prev) =>
    produce(prev, (draft) => {
      for (const id of unitIds) {
        const unit = draft.units.find((candidate) => candidate.id === id);
        if (!unit || unit.animal !== 'Turtle' || unit.ownerId !== actingOwnerId(draft)) continue;
        unit.isShelled = !unit.isShelled;
        if (unit.isShelled) {
          // Shelling means "hold here": drop any pending move order and go idle
          // so the turtle doesn't resume a stale path when later released.
          delete draft.unitOrders[id];
          unit.unitState = 'idle';
        }
      }
    })
  ),

  // Chicken egg-throw ability. Each selected friendly Chicken that is off its
  // egg cooldown turns to face the targeted point, shows the throw pose for a
  // short window, and launches one egg projectile toward it (resolved in tick).
  throwEggs: (cmd) => routeCommand({ type: 'throwEggs', payload: cmd }) ? undefined : set((prev) =>
    produce(prev, (draft) => {
      const now = simClockMs;
      for (const id of cmd.unitIds) {
        const unit = draft.units.find((candidate) => candidate.id === id);
        if (!unit || unit.animal !== 'Chicken' || unit.ownerId !== actingOwnerId(draft)) continue;
        if (unit.hp <= 0) continue;
        if (unit.lastEggAtMs !== undefined && now - unit.lastEggAtMs < EGG_COOLDOWN_MS) continue;

        const direction = normalize3D(subtract3D(cmd.target, unit.position));
        if (direction.x === 0 && direction.z === 0) continue; // target on top of the chicken

        // A chicken lays its egg from the rear, so turn the chicken's BACKSIDE to
        // the target (face away, the opposite of a movement heading). The egg then
        // launches toward the target out of the chicken's tail end instead of its
        // face or wing. The throw-pose window holds this rotation by freezing the
        // chicken's movement for its duration (see the egg-throw guard in tick).
        unit.rotation = Math.atan2(-direction.x, -direction.z);
        unit.lastEggAtMs = now;
        unit.eggThrowUntilMs = now + EGG_THROW_POSE_MS;

        const distanceToTarget = Math.sqrt(distanceSquared3D(unit.position, cmd.target));
        draft.projectiles.push({
          id: nextEntityId(`egg-${id}`),
          ownerId: unit.ownerId,
          // Spawn at the chicken's tail (a step toward the target, the side its
          // backside now faces) so the egg visibly emerges from behind it.
          position: {
            x: unit.position.x + direction.x * EGG_SPAWN_BACK_OFFSET,
            y: unit.position.y + EGG_SPAWN_HEIGHT,
            z: unit.position.z + direction.z * EGG_SPAWN_BACK_OFFSET,
          },
          velocity: { x: direction.x * EGG_SPEED, y: 0, z: direction.z * EGG_SPEED },
          traveled: 0,
          maxRange: Math.min(Math.max(distanceToTarget, EGG_HIT_RADIUS), EGG_MAX_RANGE),
          damage: EGG_DAMAGE,
        });
      }
    })
  ),

  // Frog tongue-grab ability. Each selected friendly Frog that is off cooldown and
  // not already mid-grab claims one eligible enemy — the enemy within TONGUE_RANGE
  // that is nearest the cursor — turns to face it, and begins the windup. The grab
  // then animates entirely in the tick (see updateFrogTongues). Targeting respects
  // two rules: a frog grabs exactly one enemy, and no two frogs may claim the same
  // enemy at once (so a cluster of frogs spreads its grabs across the enemy front).
  fireTongues: (cmd) => routeCommand({ type: 'fireTongues', payload: cmd }) ? undefined : set((prev) =>
    produce(prev, (draft) => {
      const now = simClockMs;

      // Enemies already claimed by another friendly frog's active tongue this
      // instant — excluded so two frogs never grab the same target.
      const claimedTargetIds = new Set<string>();
      for (const candidate of draft.units) {
        if (candidate.tongue) claimedTargetIds.add(candidate.tongue.targetId);
      }

      for (const id of cmd.unitIds) {
        const unit = draft.units.find((candidate) => candidate.id === id);
        if (!unit || unit.animal !== 'Frog' || unit.ownerId !== actingOwnerId(draft)) continue;
        if (unit.hp <= 0) continue;
        if (unit.tongue) continue; // already mid-grab
        if (unit.lastTongueAtMs !== undefined && now - unit.lastTongueAtMs < TONGUE_COOLDOWN_MS) continue;

        // Among enemies within tongue range of THIS frog (and not already claimed),
        // pick the one closest to the cursor so the player can aim the grab while
        // out-of-aim frogs still snap up whatever enemy is nearest them.
        let target: Unit | null = null;
        let bestCursorDistSq = Infinity;
        for (const candidate of draft.units) {
          if (candidate.ownerId === unit.ownerId) continue; // enemies only
          if (candidate.hp <= 0) continue;
          const isBase = candidate.kind === 'Base';
          // One frog per enemy animal so a cluster spreads its grabs; a Base is a
          // wide structure many frogs can lash at once, so it is never reserved.
          if (!isBase && claimedTargetIds.has(candidate.id)) continue;
          // Measure reach to a Base's footprint, not its center point.
          const reach = isBase ? TONGUE_RANGE + BASE_FOOTPRINT_RADIUS : TONGUE_RANGE;
          if (distanceSquared3D(unit.position, candidate.position) > reach * reach) continue;
          const cursorDistSq = distanceSquared3D(cmd.cursor, candidate.position);
          if (cursorDistSq < bestCursorDistSq) {
            bestCursorDistSq = cursorDistSq;
            target = candidate;
          }
        }
        // Every selected frog fires a tongue: if it claimed an enemy it aims the
        // grab at that enemy; otherwise it whiffs — shooting the tongue straight
        // out toward the cursor (or its current facing if the cursor is on top of
        // it) to full length and reeling back empty-handed.
        let targetId = '';
        let direction: Position3D;
        if (target) {
          // Reserve an animal so a later frog in this batch can't reuse it; a Base
          // stays unreserved so a whole line of frogs can lash the same structure.
          if (target.kind !== 'Base') claimedTargetIds.add(target.id);
          targetId = target.id;
          direction = normalize3D(subtract3D(target.position, unit.position));
        } else {
          direction = normalize3D(subtract3D(cmd.cursor, unit.position));
        }
        if (direction.x === 0 && direction.z === 0) {
          // Degenerate aim (target/cursor on top of the frog): shoot out along the
          // frog's current facing so the whiff still plays.
          direction = { x: Math.sin(unit.rotation), y: 0, z: Math.cos(unit.rotation) };
        }

        unit.rotation = Math.atan2(direction.x, direction.z); // face the throw
        unit.lastTongueAtMs = now;
        unit.tongue = {
          phase: 'windup',
          targetId,
          // Horizontal anchor for the grab's hit/drag math (the frog is pinned for
          // the whole grab, so this stays put). The beam's visible mouth point and
          // upward aim are derived from the model's Tongue_Origin / Tongue_Tip
          // markers at render time (see UnitsLayer), not from this y.
          origin: { x: unit.position.x, y: unit.position.y, z: unit.position.z },
          direction,
          length: 0,
          maxLength: TONGUE_RANGE,
          grabbed: false,
          phaseUntilMs: now + TONGUE_WINDUP_MS,
          damageDealt: false,
        };
      }
    })
  ),

  // Cat "Hiss" ability. Each selected friendly Cat that is off its hiss cooldown
  // flashes the Kitty_F2 hiss pose (for HISS_POSE_MS) and shoves every living enemy
  // within HISS_KNOCKBACK_RANGE radially outward from its own position. The shove is
  // a constant-velocity slide the tick integrates over HISS_KNOCKBACK_MS (see the
  // knockback intercept in tick), so a cat surrounded on all sides pushes the entire
  // encircling ring outward at once. Bases are immovable structures and are skipped.
  hiss: (cmd) => routeCommand({ type: 'hiss', payload: cmd }) ? undefined : set((prev) =>
    produce(prev, (draft) => {
      const now = simClockMs;
      for (const id of cmd.unitIds) {
        const cat = draft.units.find((candidate) => candidate.id === id);
        if (!cat || cat.animal !== 'Cat' || cat.ownerId !== actingOwnerId(draft)) continue;
        if (cat.hp <= 0) continue;
        if (cat.lastHissAtMs !== undefined && now - cat.lastHissAtMs < HISS_COOLDOWN_MS) continue;

        cat.lastHissAtMs = now;
        cat.hissUntilMs = now + HISS_POSE_MS;

        // Turn the cat to face the point the player clicked, so the hiss pose reads
        // as aimed where they pressed. The shove below stays radial; this is purely
        // facing. A degenerate aim (cursor on top of the cat) is left as-is so we
        // never snap it to a meaningless heading. The hiss-pose guard in tick then
        // holds this rotation for the whole pose window.
        if (cmd.cursor) {
          const aimX = cmd.cursor.x - cat.position.x;
          const aimZ = cmd.cursor.z - cat.position.z;
          if (aimX !== 0 || aimZ !== 0) cat.rotation = Math.atan2(aimX, aimZ);
        }

        for (const enemy of draft.units) {
          if (enemy.ownerId === cat.ownerId) continue; // only enemies are knocked back
          if (enemy.kind === 'Base') continue;          // immovable structure
          if (enemy.hp <= 0) continue;

          const dx = enemy.position.x - cat.position.x;
          const dz = enemy.position.z - cat.position.z;
          const distanceSquared = dx * dx + dz * dz;
          if (distanceSquared > HISS_KNOCKBACK_RANGE_SQ) continue;

          // Push direction is radially outward from the cat. If an enemy is sitting
          // exactly on the cat, pick a random outward heading so it still gets shoved.
          let pushDirectionX: number;
          let pushDirectionZ: number;
          if (distanceSquared < 0.0001) {
            const randomAngle = simRng.nextAngle();
            pushDirectionX = Math.cos(randomAngle);
            pushDirectionZ = Math.sin(randomAngle);
          } else {
            const invDistance = 1 / Math.sqrt(distanceSquared);
            pushDirectionX = dx * invDistance;
            pushDirectionZ = dz * invDistance;
          }

          enemy.knockbackVelocityX = pushDirectionX * HISS_KNOCKBACK_SPEED;
          enemy.knockbackVelocityZ = pushDirectionZ * HISS_KNOCKBACK_SPEED;
          enemy.knockbackUntilMs = now + HISS_KNOCKBACK_MS;
        }
      }
    })
  ),

  // Bee "Swarm" ability. Each selected friendly Bee that is not already swarming
  // claims the closest living enemy no other bee has taken and commits to a dive at
  // it (the dive + sting then plays out entirely in the tick — see updateBeeSwarms).
  // Targeting spreads animal stings across distinct targets: a bee dives at exactly
  // one enemy and no two bees may claim the same enemy ANIMAL at once. An enemy Base
  // is the exception — it is a wide structure a whole cloud can dive at once, so it
  // is never reserved and a bee that reaches one sacrifices itself to chip it.
  swarm: (cmd) => routeCommand({ type: 'swarm', payload: cmd }) ? undefined : set((prev) =>
    produce(prev, (draft) => {
      // Enemies already claimed by another bee mid-Swarm — excluded so no two bees
      // dive at the same target.
      const claimedTargetIds = new Set<string>();
      for (const candidate of draft.units) {
        if (candidate.swarmTargetId !== undefined) claimedTargetIds.add(candidate.swarmTargetId);
      }

      for (const id of cmd.unitIds) {
        const bee = draft.units.find((candidate) => candidate.id === id);
        if (!bee || bee.animal !== 'Bee' || bee.ownerId !== actingOwnerId(draft)) continue;
        if (bee.kind !== 'Unit') continue; // sacrificial dive — never risk a Bee King/Queen
        if (bee.hp <= 0) continue;
        if (bee.swarmTargetId !== undefined) continue; // already diving

        // Claim the closest living enemy not already claimed — an enemy animal, or
        // an enemy Base when one is the nearest target (a bee will dive a structure).
        let target: Unit | null = null;
        let bestDistSq = Infinity;
        for (const candidate of draft.units) {
          if (candidate.ownerId === bee.ownerId) continue; // enemies only
          if (candidate.hp <= 0) continue;
          // One bee per enemy animal so the cloud spreads its stings; a Base is a
          // wide structure many bees can dive at once, so it is never reserved.
          if (candidate.kind !== 'Base' && claimedTargetIds.has(candidate.id)) continue;
          const distSq = distanceSquared3D(bee.position, candidate.position);
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            target = candidate;
          }
        }
        if (!target) continue; // no unclaimed enemy left for this bee — it sits this swarm out

        if (target.kind !== 'Base') claimedTargetIds.add(target.id); // reserve animals so a later bee in this batch can't reuse them
        bee.swarmTargetId = target.id;
        // Drop any pending move order so the dive isn't fighting a stale destination.
        delete draft.unitOrders[bee.id];
      }
    })
  ),

  // Owl "Pickup" ability. Each selected friendly Owl that is not already mid-Pickup claims
  // the closest living unit that matches the clicked unit's animal type AND owner and that no
  // other Owl has taken, then commits to a swoop at it (the dive, grab, carry and drop all
  // play out in the tick — see updateOwlPickups). Targeting respects two rules mirroring the
  // Bee Swarm: an Owl grabs exactly one unit, and no two Owls may claim the same unit, so a
  // flight of Owls spreads its catches across distinct targets rather than piling onto one.
  pickup: (cmd) => routeCommand({ type: 'pickup', payload: cmd }) ? undefined : set((prev) =>
    produce(prev, (draft) => {
      // Units already claimed by an Owl mid-Pickup (its swoop target) or already in another
      // Owl's talons — excluded so no two Owls grab the same unit.
      const claimedTargetIds = new Set<string>();
      for (const candidate of draft.units) {
        if (candidate.owlPickup !== undefined) claimedTargetIds.add(candidate.owlPickup.targetId);
        if (candidate.carriedByOwlId !== undefined) claimedTargetIds.add(candidate.id);
      }

      for (const id of cmd.unitIds) {
        const owl = draft.units.find((candidate) => candidate.id === id);
        if (!owl || owl.animal !== 'Owl' || owl.ownerId !== actingOwnerId(draft)) continue;
        if (owl.kind !== 'Unit') continue; // protect a royal Owl from swooping into danger
        if (owl.hp <= 0) continue;
        if (owl.owlPickup !== undefined) continue; // already swooping

        // Claim the closest living unit matching the clicked unit's type AND owner, never a
        // Base, that is not already claimed and is not itself a busy/carried unit.
        let target: Unit | null = null;
        let bestDistSq = Infinity;
        for (const candidate of draft.units) {
          if (candidate.animal !== cmd.targetAnimal) continue;   // same animal type as the clicked unit
          if (candidate.ownerId !== cmd.targetOwnerId) continue; // same side as the clicked unit
          if (candidate.kind === 'Base') continue;               // animals only, never structures
          if (ANIMAL_MOVEMENT_TYPES[candidate.animal] === 'air') continue; // can't pluck flying units (Owls/Bees) out of the air
          if (candidate.hp <= 0) continue;
          if (candidate.id === owl.id) continue;                 // an Owl can't grab itself
          if (candidate.owlPickup !== undefined) continue;       // never grab another mid-Pickup Owl
          if (claimedTargetIds.has(candidate.id)) continue;      // one Owl per target
          const distSq = distanceSquared3D(owl.position, candidate.position);
          if (distSq < bestDistSq) {
            bestDistSq = distSq;
            target = candidate;
          }
        }
        if (!target) continue; // no unclaimed match left for this Owl — it sits this pickup out

        claimedTargetIds.add(target.id); // reserve so a later Owl in this batch can't reuse it
        owl.owlPickup = { phase: 'swooping', targetId: target.id, grabbed: false, carryUntilMs: 0 };
        owl.isFlying = true;                                     // keep wings animating through the swoop
        owl.flightLift = OWL_FLIGHT_HEIGHT;                      // start the descent from cruising altitude
        // Drop any pending move order so the swoop isn't fighting a stale destination.
        delete draft.unitOrders[owl.id];
      }
    })
  ),

  // Owl cargo delivery. The second half of the friendly-Pickup flow: each selected Owl that is
  // hovering with friendly cargo ('holding') is sent to the cursor drop-off point, flying there
  // at flight height. Rather than converging on the exact point (which stacked the dropped models),
  // each Owl stops once it is within OWL_DELIVERY_ARRIVAL_RANGE of the destination and sets its
  // cargo down directly beneath itself — so Owls arriving from different directions spread their
  // cargo around the drop-off (see the 'delivering' phase in updateOwlPickups). Owls mid-swoop,
  // carrying an enemy, or already delivering are ignored, so only cargo awaiting orders responds.
  deliverCargo: (cmd) => routeCommand({ type: 'deliverCargo', payload: cmd }) ? undefined : set((prev) =>
    produce(prev, (draft) => {
      for (const id of cmd.unitIds) {
        const owl = draft.units.find((candidate) => candidate.id === id);
        if (!owl || owl.owlPickup === undefined) continue;
        if (owl.owlPickup.phase !== 'holding') continue; // only cargo awaiting a delivery order
        owl.owlPickup.deliverTo = { x: cmd.target.x, y: cmd.target.y, z: cmd.target.z };
        owl.owlPickup.phase = 'delivering';
      }
    })
  ),

  toggleOptimization: (key) => set((prev) => ({
    optimizations: {
      ...prev.optimizations,
      [key]: !prev.optimizations[key]
    }
  })),

  updateBridgeAnimations: (nowMs) => set((prev) =>
    produce(prev, (draft) => {
      updateBridgeAnimations(draft, nowMs);
    })
  ),
}));

// ---------------------------------------------------------------------------
// Lockstep glue (multiplayer). These functions are the simulation surface the
// lockstep engine drives — see LockstepSimAdapter. They are thin wrappers over
// the store so the engine module never imports the store directly.
// ---------------------------------------------------------------------------

/**
 * Execute one scheduled command on behalf of `playerId`. Replays through the
 * very same store action a local input would, but with the routing seam disarmed
 * (so it mutates instead of re-routing) and the acting owner overridden to the
 * issuing player (so a remote player's command moves the remote player's units).
 */
export function applyNetCommand(playerId: string, command: NetCommand): void {
  const store = useGameStore.getState();
  applyingNetCommand = true;
  actingPlayerIdOverride = playerId;
  try {
    // Capture issued commands (the AI, or a replay) for replay recording, tagged
    // with their real issuer — the routeCommand tap only sees local human input.
    if (commandRecorder) commandRecorder(playerId, command);
    switch (command.type) {
      case 'moveUnits': store.moveCommand(command.payload); break;
      case 'attackTarget': store.attackTarget(command.payload); break;
      case 'setBehavior': store.setBehavior(command.payload); break;
      case 'setFormation': store.setFormation(command.payload); break;
      case 'adjustFormation': store.adjustFormation(command.payload); break;
      case 'callPlay': store.callPlay(command.payload); break;
      case 'setPatrol': store.setPatrol(command.payload); break;
      case 'setQueenRally': store.setQueenRally(command.payload); break;
      case 'setMovementHold': store.setMovementHold(command.payload.unitId); break;
      case 'toggleTurtleShell': store.toggleTurtleShell(command.payload.unitIds); break;
      case 'throwEggs': store.throwEggs(command.payload); break;
      case 'fireTongues': store.fireTongues(command.payload); break;
      case 'hiss': store.hiss(command.payload); break;
      case 'swarm': store.swarm(command.payload); break;
      case 'pickup': store.pickup(command.payload); break;
      case 'deliverCargo': store.deliverCargo(command.payload); break;
      case 'setPilot': store.applyPilotSelection(playerId, command.payload.unitId); break;
      case 'pilotMove': store.applyPilotMove(playerId, command.payload); break;
      case 'rallyMonarch': store.applyRallyMonarch(playerId, command.payload.monarchId); break;
      case 'placeRallied': store.applyPlaceRallied(playerId, command.payload.monarchId, command.payload.count, command.payload.target); break;
      case 'setPilotFireTeam': store.applyPilotFireTeam(playerId, command.payload.teamId); break;
      case 'releaseControl': store.applyReleaseControl(playerId); break;
    }
  } finally {
    applyingNetCommand = false;
    actingPlayerIdOverride = null;
  }
}

/**
 * A deterministic fingerprint of the current simulation, used by lockstep to
 * detect desync. Includes every unit's identity/health/position, the RNG state,
 * and the tick counter, sorted by id so iteration order can never affect it. Two
 * peers in sync produce the same string; any divergence changes it.
 */
export function computeStateChecksum(): string {
  const state = useGameStore.getState();
  const units = [...state.units].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  const unitPart = units
    .map(
      (u) =>
        `${u.id}|${u.ownerId}|${u.kind}|${u.hp.toFixed(3)}|` +
        `${u.position.x.toFixed(3)}|${u.position.z.toFixed(3)}`
    )
    .join(';');
  return `t${state.tickCounter}#rng${state.rng.getState()}#${unitPart}`;
}

// Dev-only debug handle for performance testing (stripped from production
// builds, where import.meta.env.DEV is false). Lets tooling inspect/inject
// game state to exercise high unit counts. Also exposes the raw stats table and
// melee threshold so automated balance tests can assert against the real data
// instead of duplicating the numbers.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as any).__rtsStore = useGameStore;
  (window as any).__rtsAnimals = ANIMALS;
  (window as any).__rtsMeleeRange = MELEE_RANGE;
  // Expose leaderboard utilities so the spec in Unit Tests/ can exercise the
  // real scoring / profanity-filter / persistence code rather than a copy.
  (window as any).__rtsLeaderboard = leaderboardModule;
  // Remote (Firestore-backed) leaderboard layer, exposed so the spec in
  // Unit Tests/ can exercise the real fetch/submit-with-cache-fallback code.
  (window as any).__rtsLeaderboardRemote = leaderboardRemoteModule;
}

function baseStats(animal: AnimalId) {
  return ANIMALS[animal];
}

function createBase(ownerId: string, animal: AnimalId, position: Position3D, rotation: number = 0): Unit {
  const stats = baseStats(animal);
  return {
    id: nextEntityId('B'),
    ownerId,
    animal,
    kind: 'Base',
    position,
    hp: stats.baseHp * 8,
    maxHp: stats.baseHp * 8,
    attackDamage: 0,
    moveSpeed: 0,
    attackRange: stats.range,
    attackCooldownMs: stats.attackCooldownMs,
    lastAttackAtMs: 0,
    rotation,
  };
}

function createQueen(ownerId: string, animal: AnimalId, position: Position3D, rotation: number = 0): Unit {
  const stats = baseStats(animal);
  return {
    id: nextEntityId('Q'),
    ownerId,
    animal,
    kind: 'Queen',
    position,
    hp: stats.baseHp * 2,
    maxHp: stats.baseHp * 2,
    attackDamage: stats.dmg,
    moveSpeed: stats.speed * 1.53,
    attackRange: stats.range,
    attackCooldownMs: stats.attackCooldownMs,
    lastAttackAtMs: 0,
    rotation,
    behavior: defaultBehaviorFor(animal, 'Queen'),
  };
}

function createKing(ownerId: string, animal: AnimalId, position: Position3D, rotation: number = 0): Unit {
  const stats = baseStats(animal);
  return {
    id: nextEntityId('K'),
    ownerId,
    animal,
    kind: 'King',
    position,
    hp: stats.baseHp * 3,
    maxHp: stats.baseHp * 3,
    attackDamage: stats.dmg * 3, // one-shot most standard units
    moveSpeed: stats.speed * 0.85,
    attackRange: stats.range,
    attackCooldownMs: stats.attackCooldownMs,
    lastAttackAtMs: 0,
    rotation,
    behavior: defaultBehaviorFor(animal, 'King'),
  };
}

function createUnit(ownerId: string, animal: AnimalId, position: Position3D, rotation: number = 0): Unit {
  const stats = baseStats(animal);
  return {
    id: nextEntityId('U'),
    ownerId,
    animal,
    kind: 'Unit',
    position,
    hp: stats.baseHp,
    maxHp: stats.baseHp,
    attackDamage: stats.dmg,
    moveSpeed: stats.speed,
    attackRange: stats.range,
    attackCooldownMs: stats.attackCooldownMs,
    lastAttackAtMs: 0,
    rotation,
    behavior: defaultBehaviorFor(animal, 'Unit'),
  };
}

// Radii (world units) probed in order by the expanding-ring search below.
// Tuned so dense melee resolves on the first ring while the early-game approach
// phase still finds distant enemies. The widest ring spans the full battlefield
// (bases sit ~500 units apart on the z axis).
const ENEMY_SEARCH_RADII = [30, 80, 200, 600];

// Finds the nearest enemy using the spatial grid. An expanding-ring search keeps
// the common case (enemies already nearby) to a handful of cell lookups instead
// of scanning every unit, which previously made this O(n^2) across the tick. The
// full-scan fallback guarantees correctness if no enemy falls inside the widest
// ring (e.g. the two armies are still further apart than expected).
function findClosestEnemy(unit: Unit, grid: SpatialGrid | null, all: Unit[]): Unit | null {
  if (grid) {
    for (const radius of ENEMY_SEARCH_RADII) {
      const enemy = grid.findClosestEnemy(unit, radius);
      if (enemy) return enemy;
    }
  }

  let best: Unit | null = null;
  let bestDistSq = Infinity;
  for (const other of all) {
    if (other.ownerId === unit.ownerId) continue;
    const dSq = distanceSquared3D(unit.position, other.position);
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      best = other;
    }
  }
  return best;
}

// Performance-optimized collision detection function
// Ticks a ground unit may be wedged (essentially motionless while trying to move) before
// it is allowed to pass through friendly units to free itself. At 60 Hz this is ~1s.
const UNWEDGE_STUCK_TICKS = 60;

// Stranded-unit rescue (rescueStrandedGroundUnits). Crowd shoves and ability knockback resolve
// each ground unit's step against terrain, but a chain of pushes in a single tick — or a bridge
// raised out from under a unit — can still leave one standing on forbidden water, where every
// move it tries is rejected (slideAlongObstacle finds no walkable heading from a water origin)
// and it sits frozen ignoring orders. This is the user-visible "shoved off the map and can't
// move" bug. Each tick we detect any ground unit on non-walkable terrain and march it back
// toward the nearest dry cell so it self-recovers within ~1s instead of stalling forever.
const RESCUE_SEARCH_RADIUS_CELLS = 32; // how far (in 1-unit cells) to scan outward for dry land
const RESCUE_STEP_DISTANCE = 1.5;      // world units pulled toward shore per tick while stranded

// Minimum XZ distance enforced between any two units so massed crowds spread out instead of
// bunching on a point. Shared by the moving-unit collision push (checkCollision) and the
// idle separation pass (separateOverlappingUnits) so a unit's personal space is the same
// whether it is walking or standing still.
const UNIT_MINIMUM_SPACING = 3.75;
// Extra spacing when a Yetti is involved on either side — its model is larger than the rest.
const YETI_SPACING_BONUS = 1.5;

// "Living wall" block distance: how close an enemy may press to a shelled Turtle before the
// turtle stops it cold. Deliberately tighter than UNIT_MINIMUM_SPACING so the attacker ends up
// flush against the shell — comfortably inside its own melee reach (every melee animal has
// range 4), which keeps the wall destructible — yet wide enough that a turtle line at the
// normal ~3.75-unit separation leaves no gap an enemy can thread (one shell seals a swath
// 2 * radius wide). See the enemy branch of checkCollision.
const SHELL_BLOCK_RADIUS = 2.75;

// Minimum spacing required between currentUnit and other, accounting for the Yetti size bonus.
function minimumSpacingBetween(currentUnit: Unit, other: Unit): number {
  const yetiBonus = (currentUnit.animal === 'Yetti' || other.animal === 'Yetti') ? YETI_SPACING_BONUS : 0;
  return UNIT_MINIMUM_SPACING + yetiBonus;
}

// A unit is "airborne" — occupying the air layer above the battlefield rather than standing on
// it — when its animal is an air type (Bee, Owl) or it is mid-flight/lift (an Owl with wings
// out, a unit being carried aloft). Airborne units fly OVER friendly ground/water crowds, so the
// spacing and separation passes must never let a grounded teammate block one. Pure and
// deterministic (a lookup plus two flags), so both lockstep peers classify a unit identically.
function isAirborneUnit(unit: Unit): boolean {
  return ANIMAL_MOVEMENT_TYPES[unit.animal] === 'air' ||
         unit.isFlying === true ||
         (unit.flightLift ?? 0) > 0;
}

// Shared empty set so the collision/separation passes can default their priority
// inputs without allocating, and so a missing argument can never reintroduce the
// per-peer local state these parameters were created to keep OUT of the sim.
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

// `priorityUnitIds` and `playerOwnedIds` are the deterministic, identical-on-both-
// peers substitutes for the old `selectedUnitIds` + `localPlayerId` arguments (see
// where they are computed at the top of tick). priorityUnitIds is the set of units
// that get movement priority (the local selection solo, the actively-ordered units
// in lockstep); playerOwnedIds is the set of player-controlled (non-AI) owners.
function checkCollision(newPosition: Position3D, currentUnit: Unit, allUnits: Unit[], collisionRadius: number = 2.5, priorityUnitIds: ReadonlySet<string> = EMPTY_ID_SET, playerOwnedIds: ReadonlySet<string> = EMPTY_ID_SET, unitOrders: Record<string, any> = {}, spatialGrid: SpatialGrid | null = null): Position3D {
  // A shelled turtle, a frog mid tongue-grab, or a cat mid-Hiss is locked in place:
  // every movement branch funnels its proposed position through here, so refusing the
  // move keeps the unit pinned while still letting combat (which never touches
  // checkCollision) run. The frog must hold position so its tongue's origin stays
  // anchored at the mouth for the whole extend/retract animation; the cat holds while
  // its Kitty_F2 hiss pose plays. The hiss window is stamped in the sim clock
  // (same clock `hissUntilMs` is set from and `simClockMs` exposes), and the &&
  // short-circuits so the clock read only happens for cats that have actually hissed.
  const hissLocked = currentUnit.hissUntilMs !== undefined && simClockMs < currentUnit.hissUntilMs;
  if (currentUnit.isShelled || currentUnit.tongue || hissLocked) {
    return { x: currentUnit.position.x, y: currentUnit.position.y, z: currentUnit.position.z };
  }

  let adjustedPosition = { ...newPosition };
  let hasCollision = false;

  // Pre-calculate squared collision radius for faster distance checks
  const collisionRadiusSquared = collisionRadius * collisionRadius;

  // Pre-calculate unit classification to avoid repeated lookups
  const isCurrentUnitSelected = priorityUnitIds.has(currentUnit.id);
  // Player-controlled (non-AI) owners. Identical to "ownerId === localPlayerId" in
  // single-player (the lone human) but symmetric across both humans in multiplayer,
  // so the push-through/make-way rules resolve the same on both peers.
  const isCurrentUnitPlayer = playerOwnedIds.has(currentUnit.ownerId);
  // A selected local King/Queen plows straight through its own army rather than detouring
  // around it: its "make way" shove (clearPathForSelectedRoyals) knocks blocking friendlies
  // aside each tick, so the royal itself ignores friendly collision below. Enemy collision
  // and terrain are still enforced.
  const isSelectedOwnRoyal = isCurrentUnitSelected && isCurrentUnitPlayer &&
                             (currentUnit.kind === 'King' || currentUnit.kind === 'Queen');

  // A flying mover (Bee, Owl in flight) occupies the air layer, so friendly units standing on
  // the ground are simply flown over — they must never block or push it. Computed once per call.
  const isCurrentUnitAirborne = isAirborneUnit(currentUnit);

  // Precompute the bridge pass-through predicate ONCE per call — it depends only on
  // currentUnit.position (constant for this checkCollision pass), not on `other`. The
  // raycast-backed bridgeAt() is now cached per grid cell, but the cheap preconditions
  // here also let us skip even the hashmap lookup for the common case (non-ground unit
  // without an order, or any non-Unit kind). Without this hoist, N units crowded on a
  // bridge paid an O(N) per-neighbor query each — the perf cliff users see on crossings.
  const canPassThroughEnemyOnBridge =
    currentUnit.kind === 'Unit' &&
    ANIMAL_MOVEMENT_TYPES[currentUnit.animal] === 'ground' &&
    unitOrders[currentUnit.id] !== undefined &&
    terrainValidator.bridgeAt(currentUnit.position).onBridge;

  // Use spatial grid if available for faster nearby unit lookup
  let nearbyUnits: Unit[];
  const checkRadius = collisionRadius * 3; // Check slightly larger area
  if (spatialGrid && allUnits.length > 50) {
    // Spatial broad-phase: only the handful of units near the target position,
    // instead of scanning every unit (was O(n) per call -> O(n^2) per tick).
    nearbyUnits = spatialGrid
      .getNearbyUnits(adjustedPosition, checkRadius)
      .filter(other => other.id !== currentUnit.id && other.kind !== 'Base');
  } else if (allUnits.length > 50) {
    // Fallback broad-phase when no grid is available.
    nearbyUnits = allUnits.filter(other => {
      if (other.id === currentUnit.id || other.kind === 'Base') return false;
      const dx = other.position.x - adjustedPosition.x;
      const dz = other.position.z - adjustedPosition.z;
      return (dx * dx + dz * dz) <= (checkRadius * checkRadius);
    });
  } else {
    nearbyUnits = allUnits.filter(other => other.id !== currentUnit.id && other.kind !== 'Base');
  }

  for (const other of nearbyUnits) {
    // PLAYER MOVEMENT FIX: Allow selected units to gently push through unselected friendly units
    const isOtherUnitPlayer = playerOwnedIds.has(other.ownerId);
    const isOtherUnitSelected = priorityUnitIds.has(other.id);

    // Special handling for selected player units moving through unselected friendly units
    const shouldReduceCollision = isCurrentUnitSelected && isCurrentUnitPlayer &&
                                 isOtherUnitPlayer && !isOtherUnitSelected;

    // Use squared distance for faster comparison (avoid Math.sqrt)
    const dx = adjustedPosition.x - other.position.x;
    const dz = adjustedPosition.z - other.position.z;
    const distanceSquared = dx * dx + dz * dz;

    // Skip collision with enemies when very close (allow units to get within melee range)
    const isEnemy = currentUnit.ownerId !== other.ownerId;
    const isFriendly = currentUnit.ownerId === other.ownerId;

    // A shelled enemy Turtle is a deliberate "living wall": it forfeits BOTH the melee-range
    // skip here and the bridge pass-through below, so a tightly grouped, shelled turtle line
    // physically seals a lane (e.g. the Center_Bridge chokepoint) instead of letting enemies
    // slip through the 2-unit combat gap. The wall stays destructible — the enemy is held at
    // SHELL_BLOCK_RADIUS, which is inside its melee reach, so it can still attack the shell
    // down. Only turtles ever carry isShelled (see toggleTurtleShell), so this is turtle-only.
    const isOtherShelledTurtle = other.isShelled === true;

    if (isEnemy && distanceSquared <= 4 && !isOtherShelledTurtle) { // Within 2 units, allow very close combat
      continue;
    }

    // A selected royal ignores friendly collision entirely — it does not detour around its
    // own army; the make-way shove relocates those friendlies instead (see above).
    if (isFriendly && isSelectedOwnRoyal) {
      continue;
    }

    // Unwedge: a unit that has been physically stuck for a while (crowd-pinned against
    // terrain at a chokepoint, even after the pathfinder re-routes it) temporarily ignores
    // friendly units so it can squeeze along its valid path and escape. Water is still
    // enforced below, so it never ghosts into the moat — it just passes through teammates.
    if (isFriendly && (currentUnit.pathStuckTicks ?? 0) > UNWEDGE_STUCK_TICKS) {
      continue;
    }

    // Bridge pass-through: a ground unit with an active move order that is currently on
    // a bridge deck ignores enemy *collision push* (combat damage is still applied below
    // by the combat phase). Without this, an enemy parked on the narrow Center_Bridge
    // shoves the player unit sideways off the deck centerline until every adjacent step
    // hits water and the unit is terrain-trapped at the chokepoint — the user-visible
    // "frozen on the deck" symptom. Letting it slip past the enemy lets it complete the
    // crossing and re-engage on open ground. Scoped to bridge + ordered ground units so
    // open-field combat positioning is unaffected. The bridge predicate is hoisted to
    // canPassThroughEnemyOnBridge above so this loop body stays O(1) per neighbor.
    if (isEnemy && canPassThroughEnemyOnBridge && !isOtherShelledTurtle) {
      continue;
    }

    // Layer separation: a flying unit and a ground/water unit never share the same space — the
    // flyer glides over whatever is below and the grounded unit passes underneath — so the pair
    // never pushes each other, friendly OR enemy. This is symmetric: it fires whether the flyer
    // or the grounded unit is the one moving, so a ground crowd no longer parts around a Bee
    // overhead and a Bee no longer hems in (or is hemmed in by) the units beneath it. Air-vs-air
    // and ground-vs-ground spacing still applies (flyers don't stack), and combat is unaffected
    // because the combat phase applies damage without ever running through checkCollision.
    if (isCurrentUnitAirborne !== isAirborneUnit(other)) {
      continue;
    }

    // UNIT SPACING: enforce each unit's personal space so massed crowds spread out without
    // bunching on a point. The same spacing is reused by the idle separation pass. An enemy
    // pressing a shelled turtle is instead held at the tighter SHELL_BLOCK_RADIUS so it stops
    // flush against the wall — close enough to attack the shell, but unable to push past it.
    const minimumDistance = (isEnemy && isOtherShelledTurtle)
      ? SHELL_BLOCK_RADIUS
      : minimumSpacingBetween(currentUnit, other);
    const minimumDistanceSquared = minimumDistance * minimumDistance;

    if (distanceSquared < minimumDistanceSquared) {
      const distance = Math.sqrt(distanceSquared); // Only calculate when needed

      // Calculate push-away direction (optimized)
      let pushDirectionX, pushDirectionZ;

      if (distance < 0.001) {
        // Units at same position - use cached random direction
        const randomAngle = simRng.nextAngle();
        pushDirectionX = Math.cos(randomAngle);
        pushDirectionZ = Math.sin(randomAngle);
      } else {
        // Normalize direction vector
        const invDistance = 1.0 / distance;
        pushDirectionX = dx * invDistance;
        pushDirectionZ = dz * invDistance;
      }

      // SPACING FIX: Different behavior for friendly vs enemy units
      if (isFriendly) {
        // A selected player unit must travel AROUND its unselected teammates, never
        // bulldoze through them. When the mover overlaps an unselected friendly we fully
        // eject the *mover* to the edge of that unit's personal space (strength 1.0)
        // instead of letting it penetrate. Only the mover is repositioned here (the idle
        // unit's position is never touched in checkCollision), and because the ejection is
        // radial the mover's residual forward order carries it tangentially around the
        // obstacle. Together with the separation pass holding idle units in place against
        // selected neighbors, this is what stops a moving selection from shoving idle
        // friendlies across the map. Two friendlies that are both idle, both selected, or
        // both AI instead share the spacing softly (0.5) so neither snaps. Ability
        // knockback such as the Cat's Hiss is applied elsewhere and intentionally bypasses
        // this rule.
        const pushStrength = shouldReduceCollision ? 1.0 : 0.5;
        const pushDistance = (minimumDistance - distance) * pushStrength;
        adjustedPosition.x += pushDirectionX * pushDistance;
        adjustedPosition.z += pushDirectionZ * pushDistance;
        // Don't set hasCollision = true for friendly units (no movement pause)
      } else {
        // Enemy units: Full push to maintain 2.5 unit spacing + strong collision
        hasCollision = true;
        const pushDistance = minimumDistance - distance + 0.2; // Slightly larger buffer for enemies
        adjustedPosition.x += pushDirectionX * pushDistance;
        adjustedPosition.z += pushDirectionZ * pushDistance;
      }
    }
  }

  // Track collision attempts (only for enemy collisions now)
  if (hasCollision) {
    currentUnit.collisionAttempts = (currentUnit.collisionAttempts || 0) + 1;

    // PLAYER MOVEMENT FIX: Be more lenient with movement pauses for player units with active orders
    const hasActiveOrder = unitOrders[currentUnit.id] !== undefined;
    const isPlayerWithOrder = isCurrentUnitPlayer && hasActiveOrder;

    // Higher threshold for player units with movement orders
    const pauseThreshold = isPlayerWithOrder ? 8 : 5; // 8 attempts for ordered units, 5 for others
    const pauseDuration = isPlayerWithOrder ? 100 : 200; // 0.1s for ordered units, 0.2s for others

    if (currentUnit.collisionAttempts >= pauseThreshold) {
      currentUnit.movementPausedUntilMs = simClockMs + pauseDuration;
      currentUnit.collisionAttempts = 0; // Reset counter
    }
  } else {
    // Reset collision attempts when movement is successful
    currentUnit.collisionAttempts = 0;
  }

  // Arena boundary: confine the resolved step to the Arena slab so no unit, Queen, or King
  // can walk off the outermost edge of the map. Applied after collision pushes (which can
  // nudge a unit outward near the rim) and before the terrain slide below, so every return
  // path downstream — slide, hold, or the resolved position — stays inside the arena.
  clampToArena(adjustedPosition);

  // Movement-type terrain rule: the only animals ever blocked are GROUND animals
  // trying to enter water without a lowered bridge. Air and water animals are
  // never blocked, so we skip the (raycast-backed) terrain query for them to keep
  // the per-tick cost down at high unit counts.
  if (ANIMAL_MOVEMENT_TYPES[currentUnit.animal] === 'ground' &&
      !terrainValidator.canAnimalMoveTo(currentUnit.animal, adjustedPosition)) {
    // The resolved step lands on forbidden water — usually because a friendly push shoved
    // the unit toward the bank, or it met the diagonally-running shoreline head-on. Rather
    // than dead-stall (which jams crowds at the chokepoint, with units pinned against the
    // water's edge), slide along the bank: deflect the step by the smallest angle that keeps
    // the unit on walkable ground so it keeps flowing even where the shore runs at an angle.
    // Returns the unit's current position when boxed in on every probed heading (hold).
    return slideAlongObstacle(
      currentUnit.position,
      adjustedPosition,
      (candidate) => terrainValidator.canAnimalMoveTo(currentUnit.animal, candidate),
    );
  }

  return adjustedPosition;
}

// Idle units never pass through checkCollision — only the active movement branches do — so units
// that have arrived at an order, been set down by an Owl, or are simply standing still would
// overlap and clip into one another (intersecting geometry piled on a single point). This
// relaxation pass runs once per tick over every settled ground unit and nudges any pair closer
// than their minimum spacing apart, so stacks resolve into a spread-out formation. Pushes are
// gentle (a fraction of the overlap) and applied across the whole crowd, so a pile eases apart
// over a few ticks rather than snapping. It reuses the same spacing and terrain rules as the
// moving-unit collision, so a unit's personal space is identical whether it is walking or at rest.
const SEPARATION_RELAX_FACTOR = 0.5;            // fraction of the overlap a unit backs off per tick
const SEPARATION_MELEE_TOLERANCE_SQ = 4;        // enemies within this (2 units) are left close for combat
const SEPARATION_QUERY_RADIUS = UNIT_MINIMUM_SPACING + YETI_SPACING_BONUS; // widest spacing any pair can demand

// Extra clearance, beyond normal spacing, that a selected King/Queen carves out of its own
// army — the "2 unit knockback" that keeps friendlies from blocking the royal's path.
const ROYAL_CLEARANCE_BONUS = 2.0;

// Selected kings/queens get a privileged make-way shove: every friendly unit blocking a
// selected royal is knocked radially outward to a ROYAL_CLEARANCE_BONUS-wider gap than
// normal spacing, so the royal is never hemmed in by its own units. This is the deliberate
// exception to the rule that selected units travel AROUND (never push) their teammates —
// only royalty may shove, and only its own side (enemies are resolved by combat). Only the
// blocking unit is moved (the royal holds its course), and the shove settles once the lane
// is clear, so it reads as a brief knockback rather than a constant force. Ground units are
// kept off forbidden water and inside the arena, mirroring separateOverlappingUnits.
function clearPathForSelectedRoyals(draft: Store, priorityUnitIds: ReadonlySet<string>, playerOwnedIds: ReadonlySet<string>): void {
  if (priorityUnitIds.size === 0) return;
  const selectedIds = priorityUnitIds;
  const grid = draft.spatialGrid;
  const queryRadius = SEPARATION_QUERY_RADIUS + ROYAL_CLEARANCE_BONUS;

  for (const royal of draft.units) {
    if (royal.kind !== 'King' && royal.kind !== 'Queen') continue;
    if (!playerOwnedIds.has(royal.ownerId)) continue;
    if (!selectedIds.has(royal.id)) continue;

    // A royal carves its make-way clearance only out of teammates on its OWN layer: a flying
    // King/Queen (Bee/Owl) shoves other flyers aside but glides over grounded units, while a
    // grounded royal shoves ground units but cannot push a teammate flying above it.
    const royalIsAirborne = isAirborneUnit(royal);

    const neighbors = grid ? grid.getNearbyUnits(royal.position, queryRadius) : draft.units;

    for (const other of neighbors) {
      if (other.id === royal.id || other.kind === 'Base') continue;
      if (other.ownerId !== royal.ownerId) continue; // friendly only — enemies are combat, not cargo
      // Carried teammates are positioned by the carry system; don't fight them. Otherwise only
      // shove teammates sharing the royal's layer — a grounded royal skips flyers above it and a
      // flying royal skips the ground crowd below, but a flying royal still clears other flyers.
      if (other.carriedByOwlId !== undefined) continue;
      if (isAirborneUnit(other) !== royalIsAirborne) continue;
      // Only shove UNSELECTED teammates: a selected unit (including another royal) is moving
      // under the player's own control and clears itself, so bulldozing it would fight that.
      if (selectedIds.has(other.id)) continue;

      const dx = other.position.x - royal.position.x;
      const dz = other.position.z - royal.position.z;
      const distanceSquared = dx * dx + dz * dz;
      const clearance = minimumSpacingBetween(royal, other) + ROYAL_CLEARANCE_BONUS;
      if (distanceSquared >= clearance * clearance) continue; // already outside the royal's bubble

      let pushX: number;
      let pushZ: number;
      let distance: number;
      if (distanceSquared < 0.000001) {
        // Coincident with the royal: pick a random escape heading.
        const angle = simRng.nextAngle();
        pushX = Math.cos(angle);
        pushZ = Math.sin(angle);
        distance = 0;
      } else {
        distance = Math.sqrt(distanceSquared);
        const invDistance = 1 / distance;
        pushX = dx * invDistance;
        pushZ = dz * invDistance;
      }

      const shove = clearance - distance; // distance out to the edge of the royal's bubble
      const resolved: Position3D = {
        x: other.position.x + pushX * shove,
        y: other.position.y,
        z: other.position.z + pushZ * shove,
      };
      clampToArena(resolved);

      if (ANIMAL_MOVEMENT_TYPES[other.animal] === 'ground' &&
          !terrainValidator.canAnimalMoveTo(other.animal, resolved)) {
        // Shoved toward water — slide the shove along the bank instead of forcing the unit
        // in. Holds in place (no move) when boxed in on every probed heading.
        const slid = slideAlongObstacle(
          other.position,
          resolved,
          (candidate) => terrainValidator.canAnimalMoveTo(other.animal, candidate),
        );
        other.position.x = slid.x;
        other.position.z = slid.z;
        continue;
      }

      other.position.x = resolved.x;
      other.position.z = resolved.z;
    }
  }
}

// Keep every rallying follower at least MONARCH_FOLLOW_GAP from the monarch it is trailing.
// The piloted monarch is player-driven and immovable by the spacing passes, so this pushes
// ONLY the follower radially outward to the gap — the monarch holds its driven position and
// is never shoved by its own army crowding in. The gap is widened to the pair's normal
// spacing when that is larger (e.g. a Yetti follower) so big models still don't overlap the
// monarch. Ground followers pushed onto forbidden water slide along whichever axis stays
// walkable, mirroring clearPathForSelectedRoyals/separateOverlappingUnits. Runs after the
// royal make-way shove and before the relaxation pass so the formation is then tidied.
function enforceMonarchFollowGap(draft: Store, unitById: Map<string, Unit>): void {
  for (const follower of draft.units) {
    if (follower.followMonarchId === undefined) continue;
    const monarch = unitById.get(follower.followMonarchId);
    if (!monarch || monarch.hp <= 0) continue;

    const gap = Math.max(MONARCH_FOLLOW_GAP, minimumSpacingBetween(monarch, follower));
    const resolved = followGapClearance(follower.position, monarch.position, gap);
    if (!resolved) continue; // already outside the gap

    const target: Position3D = { x: resolved.x, y: follower.position.y, z: resolved.z };
    clampToArena(target);

    if (ANIMAL_MOVEMENT_TYPES[follower.animal] === 'ground' &&
        !terrainValidator.canAnimalMoveTo(follower.animal, target)) {
      // Follow-gap push would land on water — slide it along the bank so a follower kept
      // off its monarch near the shore traces the coastline instead of freezing against it.
      const slid = slideAlongObstacle(
        follower.position,
        target,
        (candidate) => terrainValidator.canAnimalMoveTo(follower.animal, candidate),
      );
      follower.position.x = slid.x;
      follower.position.z = slid.z;
      continue;
    }

    follower.position.x = target.x;
    follower.position.z = target.z;
  }
}

function separateOverlappingUnits(draft: Store, priorityUnitIds: ReadonlySet<string>): void {
  const grid = draft.spatialGrid;
  const nowMs = simClockMs;
  // The deterministic movement-priority set (local selection solo, ordered units in
  // lockstep); already a Set for O(1) membership in the asymmetric friendly rule below.
  const selectedIds = priorityUnitIds;

  for (const unit of draft.units) {
    // Bases are immovable. Units being carried, in flight, or locked in place (shelled turtle,
    // frog mid tongue-grab, hissing cat) are positioned by their own systems — their spacing is
    // not ours to manage, and nudging them would fight those systems.
    if (unit.kind === 'Base') continue;
    if (unit.carriedByOwlId !== undefined) continue;
    // Airborne units (Bee, Owl in flight) and units being lifted are positioned in the air layer —
    // their spacing is not the ground crowd's to manage, so they are never nudged here.
    if (isAirborneUnit(unit) || unit.owlPickup !== undefined) continue;
    if (unit.isShelled || unit.tongue) continue;
    if (unit.hissUntilMs !== undefined && nowMs < unit.hissUntilMs) continue;
    // The piloted monarch's position is owned by the player's pilot input — like carried or
    // flying units above, it is not ours to nudge. Skipping it here is what stops rallying
    // followers (now selected alongside it) from shoving the King/Queen as they crowd in;
    // the followers' own spacing and the follow-gap pass keep them off it instead. Keyed on
    // the per-owner pilot map (not the local-only pilotedUnitId mirror) so a multiplayer peer
    // skips BOTH players' piloted monarchs identically — reading the mirror here would skip
    // only the local peer's monarch and desync the two simulations.
    if (draft.pilotedUnitIdByOwner[unit.ownerId] === unit.id) continue;

    const neighbors = grid
      ? grid.getNearbyUnits(unit.position, SEPARATION_QUERY_RADIUS)
      : draft.units;

    let pushX = 0;
    let pushZ = 0;
    let overlapped = false;

    for (const other of neighbors) {
      if (other.id === unit.id || other.kind === 'Base') continue;
      // Skip airborne/carried neighbors, for the same reason we skip them as `unit`.
      if (other.carriedByOwlId !== undefined || isAirborneUnit(other)) continue;

      // Selected units travel AROUND their idle teammates rather than pushing them: an
      // unselected friendly holds its ground against a selected friendly neighbor, so a
      // moving selection can never carry idle units across the map. The selected unit is
      // the one that yields — when it is the unit being processed this guard is false, so
      // it still separates away from the idle other. Ability knockback (e.g. the Cat's
      // Hiss) moves units through a separate system and is unaffected.
      if (unit.ownerId === other.ownerId && selectedIds.has(other.id) && !selectedIds.has(unit.id)) {
        continue;
      }

      const dx = unit.position.x - other.position.x;
      const dz = unit.position.z - other.position.z;
      const distanceSquared = dx * dx + dz * dz;

      // Enemies are allowed to close to melee range without being shoved apart, matching the
      // moving-unit collision rule — otherwise separation would fight combat positioning.
      if (unit.ownerId !== other.ownerId && distanceSquared <= SEPARATION_MELEE_TOLERANCE_SQ) continue;

      const minimumDistance = minimumSpacingBetween(unit, other);
      if (distanceSquared >= minimumDistance * minimumDistance) continue; // already well spaced

      overlapped = true;
      if (distanceSquared < 0.000001) {
        // Exactly coincident (e.g. two units set down on one spot): pick a random escape heading
        // and back off half the full spacing along it.
        const randomAngle = simRng.nextAngle();
        const overlap = minimumDistance * SEPARATION_RELAX_FACTOR;
        pushX += Math.cos(randomAngle) * overlap;
        pushZ += Math.sin(randomAngle) * overlap;
      } else {
        const distance = Math.sqrt(distanceSquared);
        const invDistance = 1 / distance;
        const overlap = (minimumDistance - distance) * SEPARATION_RELAX_FACTOR;
        pushX += dx * invDistance * overlap;
        pushZ += dz * invDistance * overlap;
      }
    }

    if (!overlapped) continue;

    const resolved: Position3D = {
      x: unit.position.x + pushX,
      y: unit.position.y,
      z: unit.position.z + pushZ,
    };

    // Keep the nudge inside the arena and off forbidden water (a push can shove a unit toward
    // either). Ground units that would land on water slide along whichever axis stays walkable,
    // mirroring checkCollision; if both axes are blocked the unit holds rather than clip in.
    clampToArena(resolved);
    if (ANIMAL_MOVEMENT_TYPES[unit.animal] === 'ground' &&
        !terrainValidator.canAnimalMoveTo(unit.animal, resolved)) {
      // Separation nudge would land on water — slide it along the bank so a unit relaxing
      // out of a pile near the shore follows the coastline instead of freezing against it.
      // Holds in place when boxed in on every probed heading.
      const slid = slideAlongObstacle(
        unit.position,
        resolved,
        (candidate) => terrainValidator.canAnimalMoveTo(unit.animal, candidate),
      );
      unit.position.x = slid.x;
      unit.position.z = slid.z;
      continue;
    }

    unit.position.x = resolved.x;
    unit.position.z = resolved.z;
  }
}

// Rescue any ground unit that has ended up on forbidden water (shoved off the bank by a chain
// of crowd/knockback pushes, or left behind when a bridge raised). Such a unit is otherwise
// frozen: every step it attempts is rejected because slideAlongObstacle can find no walkable
// heading when its own origin is already in the water, so it ignores move orders indefinitely.
// Each tick we march it RESCUE_STEP_DISTANCE toward the nearest walkable cell — snapping on
// once within a step — and clear its stale path so it re-routes from solid ground toward its
// order. Runs last, after every push pass has settled, so it has the final say on position.
//
// Determinism: no RNG, no wall-clock, and a deterministic nearest-cell search, so the two
// lockstep peers rescue identically. Mirrors the air/carry skips used by the spacing passes so
// it never fights a unit some other system is positioning.
function rescueStrandedGroundUnits(draft: Store): void {
  for (const unit of draft.units) {
    if (unit.kind === 'Base') continue;
    if (ANIMAL_MOVEMENT_TYPES[unit.animal] !== 'ground') continue; // only ground units can be water-blocked
    // Positioned by their own systems — not ours to relocate (matches separateOverlappingUnits).
    if (unit.carriedByOwlId !== undefined) continue;
    if (unit.isFlying || (unit.flightLift ?? 0) > 0 || unit.owlPickup !== undefined) continue;

    // On walkable ground already — nothing to rescue.
    if (terrainValidator.canAnimalMoveTo(unit.animal, unit.position)) continue;

    const shore = terrainValidator.nearestTraversable(unit.animal, unit.position, RESCUE_SEARCH_RADIUS_CELLS);
    if (shore === null) continue; // no dry land within range — leave it rather than guess

    const dx = shore.x - unit.position.x;
    const dz = shore.z - unit.position.z;
    const distance = Math.sqrt(dx * dx + dz * dz);

    if (distance <= RESCUE_STEP_DISTANCE || distance < 0.001) {
      // Close enough to finish the rescue this tick — land squarely on the walkable cell.
      unit.position.x = shore.x;
      unit.position.z = shore.z;
    } else {
      // Still out over the water — step toward the shore; subsequent ticks continue the march.
      const invDistance = 1 / distance;
      unit.position.x += dx * invDistance * RESCUE_STEP_DISTANCE;
      unit.position.z += dz * invDistance * RESCUE_STEP_DISTANCE;
    }

    // The unit has been relocated, so any cached A* route and stuck/collision bookkeeping no
    // longer match where it stands — clear them so it re-paths cleanly toward its order.
    unit.pathWaypoints = undefined;
    unit.pathStuckTicks = 0;
    unit.collisionAttempts = 0;
    unit.movementPausedUntilMs = 0;
  }
}

// Credit a kill to the match-stats cards based on who landed the killing blow.
// Attribution keys off the killing attacker's owner so allied chip damage never
// double-counts. Player→enemy kills feed the leaderboard score and the Your
// Forces card; AI→player kills are non-scoring but populate the Enemy Forces
// card. Shared by melee combat and the Chicken's egg projectile.
function creditKill(draft: Store, attackerOwnerId: string, target: Unit): void {
  const isPlayerKillingEnemy =
    attackerOwnerId === draft.localPlayerId && target.ownerId !== draft.localPlayerId;
  const isAiKillingPlayer =
    attackerOwnerId !== draft.localPlayerId && target.ownerId === draft.localPlayerId;
  if (isPlayerKillingEnemy) {
    switch (target.kind) {
      case 'Base':  draft.matchStats.enemyBasesDestroyed++; break;
      case 'King':  draft.matchStats.enemyKingsKilled++;    break;
      case 'Queen': draft.matchStats.enemyQueensKilled++;   break;
      case 'Unit':  draft.matchStats.enemyUnitsKilled++;    break;
    }
  } else if (isAiKillingPlayer) {
    switch (target.kind) {
      case 'Base':  draft.matchStats.playerBasesDestroyed++; break;
      case 'King':  draft.matchStats.playerKingsKilled++;    break;
      case 'Queen': draft.matchStats.playerQueensKilled++;   break;
      case 'Unit':  draft.matchStats.playerUnitsKilled++;    break;
    }
  }
}

// Advance every in-flight egg one tick: move it along its flight vector, then
// resolve the first enemy it passes within range of — an animal near the egg's
// center, or an enemy Base whose footprint the egg has reached. A hit removes
// EGG_DAMAGE hp (crediting the kill and queuing removal through the shared
// dead-unit path) and consumes the egg. Eggs that fly past EGG_MAX_RANGE without
// a hit simply expire. Mutates draft.projectiles in place.
function updateProjectiles(draft: Store, dtSec: number): void {
  if (!draft.projectiles || draft.projectiles.length === 0) return;

  const survivors: Projectile[] = [];
  for (const egg of draft.projectiles) {
    const stepX = egg.velocity.x * dtSec;
    const stepZ = egg.velocity.z * dtSec;
    egg.position.x += stepX;
    egg.position.z += stepZ;
    egg.traveled += Math.sqrt(stepX * stepX + stepZ * stepZ);

    // Resolve the closest enemy the egg overlaps this tick — an animal near the
    // egg's center, or an enemy Base whose wide footprint the egg has reached.
    let hitTarget: Unit | null = null;
    let closestSq = Infinity;
    for (const candidate of draft.units) {
      if (candidate.ownerId === egg.ownerId) continue; // enemies only
      if (candidate.hp <= 0) continue;
      const dx = candidate.position.x - egg.position.x;
      const dz = candidate.position.z - egg.position.z;
      const distSq = dx * dx + dz * dz; // XZ plane; the egg flies at a fixed height
      // A Base is a structure: the egg connects anywhere within its footprint,
      // not just near the center point that an animal is hit at.
      const hitRadius = candidate.kind === 'Base' ? EGG_HIT_RADIUS + BASE_FOOTPRINT_RADIUS : EGG_HIT_RADIUS;
      if (distSq <= hitRadius * hitRadius && distSq < closestSq) {
        closestSq = distSq;
        hitTarget = candidate;
      }
    }

    if (hitTarget) {
      hitTarget.hp -= mitigatedDamage(hitTarget, egg.damage);
      if (hitTarget.hp <= 0) {
        draft.deadUnitsToRemove.push(hitTarget.id);
        creditKill(draft, egg.ownerId, hitTarget);
      }
      continue; // egg is consumed on impact
    }

    if (egg.traveled < egg.maxRange) survivors.push(egg); // else expired in flight
  }
  draft.projectiles = survivors;
}

// Advance every Frog whose tongue is currently out, one tick. The grab is a small
// state machine stored on the unit (unit.tongue). A tongue is either a grab
// attempt (targetId set to a claimed enemy) or a whiff (no targetId — fired when
// the frog had no eligible target, so it just shoots out and reels back):
//   windup     — Frog_F2 mouth-open beat; transitions to `extending` after
//                TONGUE_WINDUP_MS. A grab attempt fizzles here if its claimed
//                target died or left reach; a whiff always proceeds.
//   extending  — the tip reaches out along the aim direction at TONGUE_EXTEND_SPEED.
//                A grab attempt tracks its (possibly moving) target and, on
//                contact, latches: deals the frog's attack damage once and flips
//                to `retracting`. A whiff (and a grab that never connects) extends
//                straight to its apex (maxLength) and then flips to `retracting`.
//   retracting — the tip reels back at TONGUE_RETRACT_SPEED; a latched, still-living
//                target is dragged along to just in front of the frog. Once fully
//                reeled in the tongue is cleared and the frog is free again.
// The frog holds position the whole time (the movement passes skip units with an
// active tongue), so `origin` stays put and the geometry reads cleanly.
function updateFrogTongues(draft: Store, dtSec: number, nowMs: number): void {
  for (const frog of draft.units) {
    const tongue = frog.tongue;
    if (!tongue) continue;

    // A frog that died mid-grab just drops the tongue (handled by the dead-unit
    // cleanup removing the unit; guard here in case it is still in the list).
    if (frog.hp <= 0) { frog.tongue = undefined; continue; }

    const target = draft.units.find((candidate) => candidate.id === tongue.targetId);
    const targetAlive = !!target && target.hp > 0;
    // A Base is a wide structure: it is reached and latched on its footprint, not
    // its center point, and it is damaged-in-place rather than dragged.
    const targetIsBase = !!target && target.kind === 'Base';
    const tongueReachSq = targetIsBase ? (TONGUE_RANGE + BASE_FOOTPRINT_RADIUS) ** 2 : TONGUE_RANGE_SQ;
    const tongueHitSq = targetIsBase ? (TONGUE_HIT_RADIUS + BASE_FOOTPRINT_RADIUS) ** 2 : TONGUE_HIT_RADIUS_SQ;

    if (tongue.phase === 'windup') {
      if (nowMs < tongue.phaseUntilMs) continue; // hold the Frog_F2 beat
      // A grab attempt (targetId set) only shoots if its claimed enemy is still
      // alive and in reach — otherwise it fizzles. A whiff (no targetId) always
      // shoots out along its fixed cursor-facing direction.
      if (tongue.targetId) {
        if (!targetAlive || distanceSquared3D(frog.position, target!.position) > tongueReachSq) {
          frog.tongue = undefined; // fizzle — cooldown still applies (lastTongueAtMs set at fire)
          continue;
        }
        tongue.direction = normalize3D(subtract3D(target!.position, frog.position));
      }
      tongue.phase = 'extending';
      continue;
    }

    if (tongue.phase === 'extending') {
      tongue.length = Math.min(tongue.length + TONGUE_EXTEND_SPEED * dtSec, tongue.maxLength);

      // Re-aim at the live target so a moving enemy is still tracked, then test
      // whether the tip has reached it.
      if (targetAlive) {
        tongue.direction = normalize3D(subtract3D(target!.position, frog.position));
        const tipX = tongue.origin.x + tongue.direction.x * tongue.length;
        const tipZ = tongue.origin.z + tongue.direction.z * tongue.length;
        const dx = target!.position.x - tipX;
        const dz = target!.position.z - tipZ;
        if (dx * dx + dz * dz <= tongueHitSq) {
          tongue.grabbed = true;
          if (!tongue.damageDealt) {
            tongue.damageDealt = true;
            target!.hp -= mitigatedDamage(target!, frog.attackDamage);
            frog.lastAttackAtMs = nowMs; // count the grab as a swing for combat/pose timing
            if (target!.hp <= 0) {
              draft.deadUnitsToRemove.push(target!.id);
              creditKill(draft, frog.ownerId, target!);
            }
          }
          tongue.phase = 'retracting';
          continue;
        }
      }

      if (tongue.length >= tongue.maxLength) tongue.phase = 'retracting'; // apex reached: a miss
      continue;
    }

    // retracting — reel the tongue back; drag a living catch along with the tip.
    tongue.length = Math.max(tongue.length - TONGUE_RETRACT_SPEED * dtSec, 0);

    if (tongue.grabbed && targetAlive && !targetIsBase) {
      const tipX = tongue.origin.x + tongue.direction.x * tongue.length;
      const tipZ = tongue.origin.z + tongue.direction.z * tongue.length;
      // Stop dragging once the catch is right in front of the frog so it doesn't
      // get yanked onto/through it.
      const toFrogX = frog.position.x - target!.position.x;
      const toFrogZ = frog.position.z - target!.position.z;
      if (toFrogX * toFrogX + toFrogZ * toFrogZ > TONGUE_DRAG_STOP_DIST * TONGUE_DRAG_STOP_DIST) {
        target!.position.x = tipX;
        target!.position.z = tipZ;
        // A dragged enemy's stale A* path no longer matches where it now is.
        target!.pathWaypoints = undefined;
      }
    }

    if (tongue.length <= 0) frog.tongue = undefined; // fully reeled in — frog is free
  }
}

// Advance every Bee that is mid-Swarm, one tick. A swarming bee flies straight at its
// claimed enemy at SWARM_DIVE_SPEED (its normal AI is suppressed by the swarm intercept
// in tick). On reaching sting range it stings once. Against an enemy ANIMAL the sting
// is a coin flip: with probability SWARM_STING_KILL_CHANCE both the bee and the target
// die, otherwise it glances off harmlessly. Against an enemy BASE — a structure that
// can't be coin-flip killed — the bee always sacrifices itself, chipping the base for
// SWARM_BASE_STING_MULT times its sting. Either way the surviving bee (animal-miss only)
// disengages and resumes normal behavior; a bee whose target dies or vanishes before
// contact breaks off. Bees are air units, so the dive ignores terrain and unit collision.
function updateBeeSwarms(draft: Store, dtSec: number, nowMs: number): void {
  for (const bee of draft.units) {
    if (bee.swarmTargetId === undefined) continue;

    // A bee killed mid-dive just drops the swarm (the dead-unit cleanup removes it).
    if (bee.hp <= 0) { bee.swarmTargetId = undefined; continue; }

    const target = draft.units.find((candidate) => candidate.id === bee.swarmTargetId);
    if (!target || target.hp <= 0) {
      bee.swarmTargetId = undefined; // target gone — break off and resume normal behavior
      continue;
    }

    // Track the live target on the XZ plane so a moving enemy is still chased.
    const toTargetX = target.position.x - bee.position.x;
    const toTargetZ = target.position.z - bee.position.z;
    const distSq = toTargetX * toTargetX + toTargetZ * toTargetZ;

    // A Base is reached on its footprint, not its center point.
    const targetIsBase = target.kind === 'Base';
    const stingRangeSq = targetIsBase ? (SWARM_STING_RANGE + BASE_FOOTPRINT_RADIUS) ** 2 : SWARM_STING_RANGE_SQ;

    if (distSq <= stingRangeSq) {
      // Contact: the bee stings once and the dive ends.
      bee.lastAttackAtMs = nowMs; // count the sting as a swing for pose/combat timing
      if (targetIsBase) {
        // A structure can't be coin-flip killed: the bee sacrifices itself to chip
        // the base for a multiple of its sting, then always dies on impact.
        target.hp -= mitigatedDamage(target, bee.attackDamage * SWARM_BASE_STING_MULT);
        if (target.hp <= 0) {
          target.hp = 0;
          draft.deadUnitsToRemove.push(target.id);
          creditKill(draft, bee.ownerId, target);
        }
        bee.hp = 0;
        draft.deadUnitsToRemove.push(bee.id);
        creditKill(draft, target.ownerId, bee);        // the base's owner is credited for the bee
      } else if (simRng.next() < SWARM_STING_KILL_CHANCE) {
        // Against an animal a coin flip kills both the bee and its target, or neither.
        target.hp = 0;
        draft.deadUnitsToRemove.push(target.id);
        creditKill(draft, bee.ownerId, target);      // the bee's owner killed the target

        bee.hp = 0;
        draft.deadUnitsToRemove.push(bee.id);
        creditKill(draft, target.ownerId, bee);       // the bee dies with the sting
      }
      bee.swarmTargetId = undefined; // sting resolved — a surviving bee disengages
      continue;
    }

    // Dive straight at the target. distSq > range here, so the vector is non-zero.
    const invDist = 1 / Math.sqrt(distSq);
    const dirX = toTargetX * invDist;
    const dirZ = toTargetZ * invDist;
    bee.rotation = Math.atan2(dirX, dirZ);
    bee.isFlying = true;
    bee.wingPhase = ((bee.wingPhase || 0) + dtSec * SWARM_WING_FLAP_PER_SEC) % 1;

    const step = SWARM_DIVE_SPEED * dtSec;
    bee.position.x += dirX * step;
    bee.position.z += dirZ * step;
    bee.pathWaypoints = undefined; // a dive overrides any prior A* route
  }
}

// Move a unit's render lift toward a goal at `speed` world units/sec, returning the new lift
// clamped so it never overshoots. Used to animate an Owl (and its catch) down into a swoop
// and back up to flight height.
function approachLift(currentLift: number, goalLift: number, speed: number, dtSec: number): number {
  const delta = goalLift - currentLift;
  const step = speed * dtSec;
  if (Math.abs(delta) <= step) return goalLift;
  return currentLift + Math.sign(delta) * step;
}

// Glue the carried unit to a position OWL_CARRY_HANG_OFFSET below the Owl, matching its XZ and
// facing, so it dangles beneath the talons clear of the model. Called every carry/hold/deliver
// tick so a moving Owl tows its catch along.
function carryUnitBeneath(owl: Unit, carried: Unit): void {
  carried.position.x = owl.position.x;
  carried.position.z = owl.position.z;
  carried.position.y = owl.position.y; // share the Owl's ground reference so the hang stays exact
  carried.rotation = owl.rotation;
  carried.pathWaypoints = undefined;
  carried.flightLift = Math.max(0, (owl.flightLift ?? 0) - OWL_CARRY_HANG_OFFSET);
}

// Set a carried unit down at its current XZ: ground it on the surface below, clear the carry
// render lift, and (for an enemy, when fallDamage > 0) apply impact damage — a fatal drop is
// credited to the Owl's owner. Friendlies, or any delivery (fallDamage 0), land unharmed.
function dropCarriedUnit(draft: Store, owl: Unit, carried: Unit, fallDamage: number): void {
  carried.carriedByOwlId = undefined;
  carried.position.y = terrainValidator.getBridgeSurfaceY(carried.position) ?? 0; // land on the ground it is over
  carried.flightLift = undefined;
  delete draft.unitOrders[carried.id];

  if (fallDamage > 0 && carried.ownerId !== owl.ownerId) {
    carried.hp -= mitigatedDamage(carried, fallDamage);
    if (carried.hp <= 0) {
      carried.hp = 0;
      draft.deadUnitsToRemove.push(carried.id);
      creditKill(draft, owl.ownerId, carried); // the drop killed the enemy
    }
  }
}

// Detach the unit an Owl is carrying without harming it (used when the Owl dies or its catch
// is lost mid-carry). The unit drops straight down to the ground it is currently over and
// resumes normal behavior next tick.
function releaseCarriedUnit(draft: Store, owl: Unit): void {
  const carried = draft.units.find((candidate) => candidate.carriedByOwlId === owl.id);
  if (!carried) return;
  dropCarriedUnit(draft, owl, carried, 0);
}

// Advance every Owl that is mid-Pickup, one tick. The ability runs as a state machine driven
// entirely here (the Owl's normal AI is suppressed by the pickup intercept in tick):
//   'swooping'   — the Owl flies toward its claimed target on the XZ plane at OWL_SWOOP_SPEED
//     while descending to pluck altitude. Once over the target it grabs it and switches to
//     'carrying'.
//   'carrying'   — the Owl rises back to OWL_FLIGHT_HEIGHT with the unit glued beneath it. An
//     ENEMY catch is then dropped once OWL_CARRY_DURATION_MS has elapsed, taking OWL_FALL_DAMAGE.
//     A FRIENDLY catch is instead held: on reaching flight height the Owl switches to 'holding'.
//   'holding'    — (friendly only) the Owl hovers indefinitely with its cargo, awaiting a
//     delivery order. A second both-buttons press (deliverCargo) sets deliverTo and moves it to
//     'delivering'.
//   'delivering' — (friendly only) the Owl flies to deliverTo at flight height, descends to
//     pluck altitude over the spot, and sets the unit down unharmed.
// An Owl whose target dies or vanishes before the grab simply breaks off and flies home. Owls
// are air units, so the swoop ignores terrain and unit collision.
function updateOwlPickups(draft: Store, dtSec: number, nowMs: number): void {
  for (const owl of draft.units) {
    const pickup = owl.owlPickup;
    if (pickup === undefined) continue;

    // An Owl killed mid-Pickup releases its catch unharmed and drops the ability (the
    // dead-unit cleanup removes the Owl).
    if (owl.hp <= 0) {
      releaseCarriedUnit(draft, owl);
      owl.owlPickup = undefined;
      owl.flightLift = undefined;
      continue;
    }

    const target = draft.units.find((candidate) => candidate.id === pickup.targetId);

    // Target gone (died or removed) — break off. Anything the Owl was carrying is already
    // dead, so just end the ability and let the Owl fly home (flight render restored).
    if (!target || target.hp <= 0) {
      owl.owlPickup = undefined;
      owl.flightLift = undefined;
      continue;
    }

    owl.isFlying = true; // keep the wing-flap animation running through both phases
    owl.wingPhase = ((owl.wingPhase || 0) + dtSec * OWL_WING_FLAP_PER_SEC) % 1;

    const carriedIsFriendly = target.ownerId === owl.ownerId;

    if (pickup.phase === 'carrying') {
      // Rise back to cruising altitude with the catch dangling well below the talons.
      owl.flightLift = approachLift(owl.flightLift ?? 0, OWL_FLIGHT_HEIGHT, OWL_ASCENT_SPEED, dtSec);
      carryUnitBeneath(owl, target);

      const reachedFlightHeight = (owl.flightLift ?? 0) >= OWL_FLIGHT_HEIGHT - 0.01;

      // A friendly catch is carried until the player orders a delivery: once the Owl is back at
      // flight height it switches to hovering ('holding') with its cargo instead of dropping.
      if (carriedIsFriendly) {
        if (reachedFlightHeight) pickup.phase = 'holding';
        continue;
      }

      // An enemy catch is dropped once the carry timer elapses AND the Owl has returned to its
      // original flight height, so it always "returns to its flying height" before dropping.
      if (nowMs >= pickup.carryUntilMs && reachedFlightHeight) {
        dropCarriedUnit(draft, owl, target, OWL_FALL_DAMAGE); // enemies hit the ground hard
        owl.owlPickup = undefined;
        owl.flightLift = undefined; // back to normal flight behavior next tick
      }
      continue;
    }

    if (pickup.phase === 'holding') {
      // Friendly cargo: hover in place at flight height, towing the unit beneath, until the
      // player issues a delivery order (deliverCargo sets deliverTo and flips to 'delivering').
      owl.flightLift = approachLift(owl.flightLift ?? 0, OWL_FLIGHT_HEIGHT, OWL_ASCENT_SPEED, dtSec);
      carryUnitBeneath(owl, target);
      continue;
    }

    if (pickup.phase === 'delivering' && pickup.deliverTo !== undefined) {
      // Friendly cargo: fly to the drop-off point at flight height until within the arrival range,
      // then descend to pluck altitude where it stopped and set the unit down beneath itself. The
      // arrival range (wider than the grab range) lets Owls converging from different directions
      // settle around the drop-off rather than stacking their cargo on the exact point.
      const toDropX = pickup.deliverTo.x - owl.position.x;
      const toDropZ = pickup.deliverTo.z - owl.position.z;
      const dropDistSq = toDropX * toDropX + toDropZ * toDropZ;

      if (dropDistSq > OWL_DELIVERY_ARRIVAL_RANGE_SQ) {
        // Still en route: cruise toward the drop-off at flight height.
        owl.flightLift = approachLift(owl.flightLift ?? 0, OWL_FLIGHT_HEIGHT, OWL_ASCENT_SPEED, dtSec);
        const invDist = 1 / Math.sqrt(dropDistSq);
        const dirX = toDropX * invDist;
        const dirZ = toDropZ * invDist;
        owl.rotation = Math.atan2(dirX, dirZ);
        const step = Math.min(OWL_SWOOP_SPEED * dtSec, Math.sqrt(dropDistSq));
        owl.position.x += dirX * step;
        owl.position.z += dirZ * step;
        owl.pathWaypoints = undefined;
        carryUnitBeneath(owl, target);
        continue;
      }

      // Arrived near the drop-off: descend in place to pluck altitude, then set the friendly down
      // unharmed directly beneath the Owl.
      owl.flightLift = approachLift(owl.flightLift ?? OWL_FLIGHT_HEIGHT, OWL_PLUCK_ALTITUDE, OWL_DESCENT_SPEED, dtSec);
      carryUnitBeneath(owl, target);
      if ((owl.flightLift ?? 0) <= OWL_PLUCK_ALTITUDE + OWL_GRAB_LIFT) {
        dropCarriedUnit(draft, owl, target, 0); // delivered safely — no fall damage
        owl.owlPickup = undefined;
        owl.flightLift = undefined; // back to normal flight behavior next tick
      }
      continue;
    }

    // phase === 'swooping': dive toward the target on the XZ plane while descending.
    const toTargetX = target.position.x - owl.position.x;
    const toTargetZ = target.position.z - owl.position.z;
    const distSq = toTargetX * toTargetX + toTargetZ * toTargetZ;

    // Swoop only down to pluck altitude — the Owl hovers a body-length above the target so
    // its own model never sinks into the map; the catch (hung OWL_CARRY_HANG_OFFSET below)
    // still reaches the ground from there.
    owl.flightLift = approachLift(owl.flightLift ?? OWL_FLIGHT_HEIGHT, OWL_PLUCK_ALTITUDE, OWL_DESCENT_SPEED, dtSec);

    // Grab once the Owl is both over the target and has settled to pluck altitude.
    if (distSq <= OWL_GRAB_RANGE_SQ && (owl.flightLift ?? 0) <= OWL_PLUCK_ALTITUDE + OWL_GRAB_LIFT) {
      target.carriedByOwlId = owl.id;
      delete draft.unitOrders[target.id];
      carryUnitBeneath(owl, target);

      pickup.phase = 'carrying';
      pickup.grabbed = true;
      pickup.carryUntilMs = nowMs + OWL_CARRY_DURATION_MS;
      continue;
    }

    // Still closing: steer straight at the target (distSq may be ~0 if already overhead but
    // still too high to grab, in which case the Owl just keeps descending in place).
    if (distSq > 1e-6) {
      const invDist = 1 / Math.sqrt(distSq);
      const dirX = toTargetX * invDist;
      const dirZ = toTargetZ * invDist;
      owl.rotation = Math.atan2(dirX, dirZ);
      const step = Math.min(OWL_SWOOP_SPEED * dtSec, Math.sqrt(distSq));
      owl.position.x += dirX * step;
      owl.position.z += dirZ * step;
    }
    owl.pathWaypoints = undefined; // a swoop overrides any prior A* route
  }
}

function checkWinConditions(draft: GameState): void {
  const playerIds = draft.players.map(p => p.id);

  for (const playerId of playerIds) {
    const enemyIds = playerIds.filter(id => id !== playerId);

    // Check if all enemies are eliminated
    let allEnemiesDefeated = true;

    for (const enemyId of enemyIds) {
      // Count enemy's remaining bases, kings, and queens
      const enemyBases = draft.units.filter(u => u.ownerId === enemyId && u.kind === 'Base');
      const enemyKings = draft.units.filter(u => u.ownerId === enemyId && u.kind === 'King');
      const enemyQueens = draft.units.filter(u => u.ownerId === enemyId && u.kind === 'Queen');

      // Enemy must lose all 3 bases AND all 6 king/queens (3 kings + 3 queens)
      if (enemyBases.length > 0 || enemyKings.length > 0 || enemyQueens.length > 0) {
        allEnemiesDefeated = false;
        break;
      }
    }

    if (allEnemiesDefeated) {
      draft.gameOver = true;
      draft.winner = playerId;
      break;
    }
  }
}

// Memoized distance calculations to avoid expensive sqrt operations
const distanceCache = new Map<string, number>();
const CACHE_SIZE_LIMIT = 1000; // Prevent unlimited growth

function getCacheKey(a: Position3D, b: Position3D): string {
  // Round positions to reduce cache misses for very close positions
  const ax = Math.round(a.x * 10) / 10;
  const ay = Math.round(a.y * 10) / 10;
  const az = Math.round(a.z * 10) / 10;
  const bx = Math.round(b.x * 10) / 10;
  const by = Math.round(b.y * 10) / 10;
  const bz = Math.round(b.z * 10) / 10;
  return `${ax},${ay},${az}:${bx},${by},${bz}`;
}

// 3D utility functions with memoization
function distance3D(a: Position3D, b: Position3D): number {
  const cacheKey = getCacheKey(a, b);

  if (distanceCache.has(cacheKey)) {
    return distanceCache.get(cacheKey)!;
  }

  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // Manage cache size
  if (distanceCache.size >= CACHE_SIZE_LIMIT) {
    distanceCache.clear();
  }

  distanceCache.set(cacheKey, distance);
  return distance;
}

// Faster squared distance - avoids expensive sqrt calculation when comparing distances
function distanceSquared3D(a: Position3D, b: Position3D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}


// Resolve the point a unit should actually steer toward to reach `destination`. For
// ground units the A* pathfinder returns the next waypoint of a route around the water
// moat (a straight beeline when the way is clear), so they cross on a bridge and reach
// the destination instead of stalling at the water's edge. Air/water units (which ignore
// water) and an un-built pathfinder fall through to the destination, so callers can wrap
// any "advance toward" target unconditionally.
function steeringTarget(unit: Unit, destination: Position3D): Position3D {
  if (ANIMAL_MOVEMENT_TYPES[unit.animal] !== 'ground' || !pathfinder.isReady()) {
    return destination;
  }
  return pathfinder.nextWaypoint(unit, destination);
}

// Vertical speed (world units per second) at which a ground unit's Y closes toward the
// terrain target Y. Fast enough that crossing onto the deck reads as stepping up rather
// than levitating, slow enough that one frame of sampling a slightly-higher rail edge
// doesn't pop the unit. ~30 covers the right/left bridge's ~5u deck rise in a sixth of
// a second.
const DECK_LIFT_RATE = 30;

// Snap-distance below which the unit's Y is set directly to the target rather than
// lerped — avoids residual floating-point chatter once basically at deck height.
const DECK_LIFT_SNAP = 0.02;

// Match a surface-traversing unit's Y to the terrain it's standing on so an arched
// bridge's deck (Right_Bridge_Fully_Down sits ~5u above the water with a tall arch
// above) is walked across on top rather than clipped through at water level. Off-bridge
// positions return to base ground (y=0). Smooths the transition so stepping onto/off
// the deck reads as a brief ramp instead of an instant jump.
//
// Applies to ground AND water units: ground units must use bridges to cross the moat,
// and water units — which beeline straight through the moat — would otherwise swim
// through bridge pillars/rails/decks at y=0 whenever their path passes under a span.
// Lifting them onto the deck while their XZ is over a (traversable) deck cell makes
// them walk across the bridge surface for that span and drop back into the water on
// the far side, so they never clip the bridge geometry. Air units are excluded because
// they manage their own flight Y via the render-time vertical offset (Owl's +10 lift).
function applyDeckElevation(unit: Unit, dtSec: number): void {
  if (ANIMAL_MOVEMENT_TYPES[unit.animal] === 'air') return;
  const targetY = terrainValidator.getBridgeSurfaceY(unit.position) ?? 0;
  const currentY = unit.position.y;
  const delta = targetY - currentY;
  if (Math.abs(delta) < DECK_LIFT_SNAP) {
    unit.position.y = targetY;
    return;
  }
  const maxStep = DECK_LIFT_RATE * dtSec;
  unit.position.y = currentY + Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
}

function subtract3D(a: Position3D, b: Position3D): Position3D {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z
  };
}

/**
 * Incoming combat damage after the target's active defenses. A shelled Turtle hunkers
 * down and absorbs most of every hit (see SHELL_DAMAGE_TAKEN_FRACTION); all other units
 * take the raw amount. Centralizing this keeps every damage source — melee, eggs,
 * tongues, owl drops — consistently subject to the shell.
 */
function mitigatedDamage(target: Unit, rawDamage: number): number {
  return target.isShelled ? rawDamage * SHELL_DAMAGE_TAKEN_FRACTION : rawDamage;
}

function normalize3D(vec: Position3D): Position3D {
  const length = Math.sqrt(vec.x * vec.x + vec.y * vec.y + vec.z * vec.z);
  if (length === 0) return { x: 0, y: 0, z: 0 };
  return {
    x: vec.x / length,
    y: vec.y / length,
    z: vec.z / length
  };
}

/**
 * Snapshot of which side's King/Queen is inside each bridge trigger zone on
 * this tick. Used by the tick loop to (a) drive the bridge open/close state
 * (it lowers if either side is in the zone) and (b) credit Fully_Down time
 * to whichever side is currently holding the trigger.
 */
interface BridgeZonePresence {
  playerInRightZone: boolean;
  playerInLeftZone: boolean;
  enemyInRightZone: boolean;
  enemyInLeftZone: boolean;
}

/**
 * Bridge trigger zones (center-right and center-left of the map) and the capture
 * radius around each. A King/Queen within this radius of a zone holds that bridge
 * down. Exported so the renderer can reflect occupation (flag color/height) from the
 * same geometry the sim uses, rather than duplicating the coordinates.
 */
export const RIGHT_TRIGGER_ZONE = { x: 15, z: 0 } as const;
export const LEFT_TRIGGER_ZONE = { x: -15, z: 0 } as const;
export const TRIGGER_RADIUS = 10; // world units; a K/Q within this of a zone holds the bridge

/**
 * Whether a unit of the given owner is inside a trigger zone. Pure helper shared by
 * the sim (presence/scoring) and the renderer (flag visuals). `radiusSq` is the
 * squared {@link TRIGGER_RADIUS} so the hot path avoids a sqrt.
 */
function kqHoldsZone(
  units: ReadonlyArray<Unit>,
  zone: { x: number; z: number },
  ownerMatches: (unit: Unit) => boolean,
): boolean {
  const radiusSq = TRIGGER_RADIUS * TRIGGER_RADIUS;
  for (const unit of units) {
    if (unit.kind !== 'King' && unit.kind !== 'Queen') continue;
    if (!ownerMatches(unit)) continue;
    const dx = unit.position.x - zone.x;
    const dz = unit.position.z - zone.z;
    if (dx * dx + dz * dz <= radiusSq) return true;
  }
  return false;
}

/** Per-side trigger-zone occupancy split by friend/foe from the local viewer's seat. */
export interface BridgeOccupancy {
  rightFriendly: boolean;
  rightEnemy: boolean;
  leftFriendly: boolean;
  leftEnemy: boolean;
}

/**
 * Which team holds each bridge trigger, from the perspective of `localPlayerId`.
 * Drives the purely-visual bridge flags (team color + raised height) in the renderer.
 * Kept out of the sim/`bridgeState` because "friendly vs enemy" is viewer-relative —
 * each peer maps its own owner id to the blue (own) team — so it must not enter the
 * deterministic, shared simulation state.
 */
export function computeBridgeOccupancy(
  units: ReadonlyArray<Unit>,
  localPlayerId: string | null,
): BridgeOccupancy {
  const isFriendly = (unit: Unit) => unit.ownerId === localPlayerId;
  const isEnemy = (unit: Unit) => unit.ownerId !== localPlayerId;
  return {
    rightFriendly: kqHoldsZone(units, RIGHT_TRIGGER_ZONE, isFriendly),
    rightEnemy:    kqHoldsZone(units, RIGHT_TRIGGER_ZONE, isEnemy),
    leftFriendly:  kqHoldsZone(units, LEFT_TRIGGER_ZONE,  isFriendly),
    leftEnemy:     kqHoldsZone(units, LEFT_TRIGGER_ZONE,  isEnemy),
  };
}

// Bridge animation system
function updateBridgeAnimations(
  draft: GameState & { bridgeState: BridgeState },
  nowMs: number,
): BridgeZonePresence {
  // Either side captures a bridge by putting a K/Q in its trigger zone; the bridge
  // stays down as long as anyone holds it. "player" = the local player here.
  const isPlayer = (unit: Unit) => unit.ownerId === draft.localPlayerId;
  const isEnemy = (unit: Unit) => unit.ownerId !== draft.localPlayerId;

  const presence: BridgeZonePresence = {
    playerInRightZone: kqHoldsZone(draft.units, RIGHT_TRIGGER_ZONE, isPlayer),
    playerInLeftZone:  kqHoldsZone(draft.units, LEFT_TRIGGER_ZONE,  isPlayer),
    enemyInRightZone:  kqHoldsZone(draft.units, RIGHT_TRIGGER_ZONE, isEnemy),
    enemyInLeftZone:   kqHoldsZone(draft.units, LEFT_TRIGGER_ZONE,  isEnemy),
  };

  // The bridge animation only needs to know whether anyone is in the zone —
  // attribution for scoring happens at the caller.
  updateSingleBridgeAnimation(
    draft.bridgeState.rightBridge,
    presence.playerInRightZone || presence.enemyInRightZone,
    nowMs,
    'right',
  );
  updateSingleBridgeAnimation(
    draft.bridgeState.leftBridge,
    presence.playerInLeftZone || presence.enemyInLeftZone,
    nowMs,
    'left',
  );

  return presence;
}

function updateSingleBridgeAnimation(
  bridge: BridgeAnimation,
  isPlayerInZone: boolean,
  nowMs: number,
  bridgeName: string
): void {
  const FRAME_DURATION = 1000; // 1 second per frame

  // State machine for bridge animation
  switch (bridge.currentState) {
    case 'up':
      if (isPlayerInZone && !bridge.triggeredByPlayer) {
        // Start lowering animation
        bridge.currentState = 'lowering';
        bridge.animationStartMs = nowMs;
        bridge.frameStartMs = nowMs;
        bridge.triggeredByPlayer = true;
        console.log(`${bridgeName} bridge: Starting lowering animation`);
      }
      break;

    case 'lowering':
      const loweringElapsed = nowMs - bridge.frameStartMs;
      if (loweringElapsed >= FRAME_DURATION) {
        // Advance to next frame
        switch (bridge.currentFrame) {
          case 'Fully_Up':
            bridge.currentFrame = 'Almost_Up';
            bridge.frameStartMs = nowMs;
            console.log(`${bridgeName} bridge: Frame Almost_Up`);
            break;
          case 'Almost_Up':
            bridge.currentFrame = 'Almost_Down';
            bridge.frameStartMs = nowMs;
            console.log(`${bridgeName} bridge: Frame Almost_Down`);
            break;
          case 'Almost_Down':
            bridge.currentFrame = 'Fully_Down';
            bridge.frameStartMs = nowMs;
            bridge.currentState = 'down';
            console.log(`${bridgeName} bridge: Frame Fully_Down - Animation complete`);
            break;
        }
      }
      break;

    case 'down':
      if (!isPlayerInZone) {
        // Start raising animation
        bridge.currentState = 'raising';
        bridge.animationStartMs = nowMs;
        bridge.frameStartMs = nowMs;
        bridge.triggeredByPlayer = false;
        console.log(`${bridgeName} bridge: Starting raising animation`);
      }
      break;

    case 'raising':
      const raisingElapsed = nowMs - bridge.frameStartMs;
      if (raisingElapsed >= FRAME_DURATION) {
        // Advance to next frame (reverse order)
        switch (bridge.currentFrame) {
          case 'Fully_Down':
            bridge.currentFrame = 'Almost_Down';
            bridge.frameStartMs = nowMs;
            console.log(`${bridgeName} bridge: Frame Almost_Down (raising)`);
            break;
          case 'Almost_Down':
            bridge.currentFrame = 'Almost_Up';
            bridge.frameStartMs = nowMs;
            console.log(`${bridgeName} bridge: Frame Almost_Up (raising)`);
            break;
          case 'Almost_Up':
            bridge.currentFrame = 'Fully_Up';
            bridge.frameStartMs = nowMs;
            bridge.currentState = 'up';
            console.log(`${bridgeName} bridge: Frame Fully_Up - Animation complete`);
            break;
        }
      }
      break;
  }
}


