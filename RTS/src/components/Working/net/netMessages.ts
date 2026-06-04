// Wire protocol for lockstep multiplayer.
//
// Single responsibility: define every message that crosses the data channel and
// provide a safe parser for inbound messages. Two concerns live here:
//
//   1. NetCommand — a serializable description of one player input (a right-click
//      move, an ability, a rally), mirroring the store's Command* payloads. These
//      are what lockstep exchanges instead of game state: both peers replay the
//      same ordered commands against the same deterministic simulation.
//   2. NetMessage — the envelope union actually sent: per-tick input frames,
//      desync checksums, and the lobby/start/resign control messages.
//
// Everything here must be plain JSON (no class instances, no functions): the
// transport serializes with JSON.stringify, so payloads have to survive a
// structuredClone-equivalent round-trip. The store's Command* interfaces already
// satisfy this (string ids + {x,y,z} points), which is why they can be reused
// verbatim as command payloads.

import type {
  AnimalId,
  CommandMoveUnits,
  CommandSetPatrol,
  CommandSetQueenRally,
  CommandAttackTarget,
  CommandThrowEggs,
  CommandFireTongues,
  CommandHiss,
  CommandSwarm,
  CommandOwlPickup,
  CommandOwlDeliver,
} from '../../../game/types';

/** The two fixed player roles. Host is always p0, guest always p1. */
export type PlayerRole = 'p0' | 'p1';

/**
 * A single player input, tagged by command type with its matching payload. The
 * issuing player is carried by the enclosing input frame (every command in a
 * frame belongs to that frame's player), so it is intentionally absent here.
 *
 * Monarch piloting is deliberately NOT represented: it is continuous, per-tick
 * manual control and is disabled in multiplayer v1 (see the routing seam in
 * state.ts). Adding it later means adding a per-tick pilot-input variant here.
 */
export type NetCommand =
  | { type: 'moveUnits'; payload: CommandMoveUnits }
  | { type: 'attackTarget'; payload: CommandAttackTarget }
  | { type: 'setPatrol'; payload: CommandSetPatrol }
  | { type: 'setQueenRally'; payload: CommandSetQueenRally }
  | { type: 'setMovementHold'; payload: { unitId: string | null } }
  | { type: 'throwEggs'; payload: CommandThrowEggs }
  | { type: 'fireTongues'; payload: CommandFireTongues }
  | { type: 'hiss'; payload: CommandHiss }
  | { type: 'swarm'; payload: CommandSwarm }
  | { type: 'pickup'; payload: CommandOwlPickup }
  | { type: 'deliverCargo'; payload: CommandOwlDeliver }
  | { type: 'toggleTurtleShell'; payload: { unitIds: string[] } };

/** Discriminator values for NetCommand — used by the store's routing seam. */
export type NetCommandType = NetCommand['type'];

/**
 * One player's inputs scheduled to execute on a specific simulation tick. Sent
 * every tick (with an empty `commands` array when the player did nothing) so the
 * receiver always knows a tick is accounted for and the lockstep engine can
 * advance — silence is indistinguishable from a dropped frame otherwise.
 */
export interface InputFrameMessage {
  kind: 'input';
  tick: number;
  playerId: PlayerRole;
  commands: NetCommand[];
}

/**
 * A periodic state fingerprint for desync detection. Each peer sends its hash for
 * tick N; when a peer holds both its own and the other's hash for N and they
 * differ, the simulations have diverged and the match must stop.
 */
export interface ChecksumMessage {
  kind: 'checksum';
  tick: number;
  playerId: PlayerRole;
  hash: string;
}

/**
 * The host's authoritative match-start handshake: the shared RNG seed and both
 * players' final animal lineups, so both peers build a byte-identical match.
 */
export interface StartMessage {
  kind: 'start';
  seed: number;
  lineups: Record<PlayerRole, AnimalId[]>;
}

/** A lobby update: a player's current animal selection and ready state. */
export interface LobbyMessage {
  kind: 'lobby';
  playerId: PlayerRole;
  animals: AnimalId[];
  ready: boolean;
}

/** A player conceding or leaving the match. */
export interface ResignMessage {
  kind: 'resign';
  playerId: PlayerRole;
}

/** Every message that can cross the data channel. */
export type NetMessage =
  | InputFrameMessage
  | ChecksumMessage
  | StartMessage
  | LobbyMessage
  | ResignMessage;

/** The set of valid command discriminators, for runtime validation. */
const VALID_COMMAND_TYPES: ReadonlySet<string> = new Set<NetCommandType>([
  'moveUnits',
  'attackTarget',
  'setPatrol',
  'setQueenRally',
  'setMovementHold',
  'throwEggs',
  'fireTongues',
  'hiss',
  'swarm',
  'pickup',
  'deliverCargo',
  'toggleTurtleShell',
]);

const VALID_ROLES: ReadonlySet<string> = new Set<PlayerRole>(['p0', 'p1']);

/**
 * Validate and narrow an untrusted inbound payload to a NetMessage, or return
 * null if it is malformed. The data channel decodes JSON for us, but a peer (or a
 * future protocol version) could still send something unexpected; the engine
 * treats null as "ignore this message" rather than trusting the shape blindly.
 */
export function parseNetMessage(raw: unknown): NetMessage | null {
  if (!isRecord(raw) || typeof raw.kind !== 'string') return null;

  switch (raw.kind) {
    case 'input':
      return isInputFrame(raw) ? (raw as unknown as InputFrameMessage) : null;
    case 'checksum':
      return isRole(raw.playerId) &&
        isFiniteNumber(raw.tick) &&
        typeof raw.hash === 'string'
        ? (raw as unknown as ChecksumMessage)
        : null;
    case 'start':
      return isFiniteNumber(raw.seed) && isLineups(raw.lineups)
        ? (raw as unknown as StartMessage)
        : null;
    case 'lobby':
      return isRole(raw.playerId) &&
        Array.isArray(raw.animals) &&
        typeof raw.ready === 'boolean'
        ? (raw as unknown as LobbyMessage)
        : null;
    case 'resign':
      return isRole(raw.playerId) ? (raw as unknown as ResignMessage) : null;
    default:
      return null;
  }
}

// --- narrowing helpers -----------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRole(value: unknown): value is PlayerRole {
  return typeof value === 'string' && VALID_ROLES.has(value);
}

function isLineups(value: unknown): value is Record<PlayerRole, AnimalId[]> {
  return (
    isRecord(value) && Array.isArray(value.p0) && Array.isArray(value.p1)
  );
}

function isInputFrame(raw: Record<string, unknown>): boolean {
  if (!isFiniteNumber(raw.tick) || !isRole(raw.playerId) || !Array.isArray(raw.commands)) {
    return false;
  }
  return raw.commands.every(
    (command) =>
      isRecord(command) &&
      typeof command.type === 'string' &&
      VALID_COMMAND_TYPES.has(command.type) &&
      'payload' in command
  );
}
