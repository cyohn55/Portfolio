// Multiplayer session controller.
//
// Single responsibility: own the lifecycle of a multiplayer session from the
// moment the player opens the multiplayer screen through matchmaking, the shared
// ready-up lobby, the start handshake, and teardown. It is the bridge between the
// networking modules (signaling, transport, lockstep) and the React UI: the UI
// reads this Zustand store to render, and calls its actions to host/join/pick/
// ready/leave.
//
// What lives where:
//   * Reactive, render-driving state (phase, room code, both players' picks +
//     ready flags) lives in the Zustand store below.
//   * Non-reactive plumbing (the RoomSession, the live transport, listener
//     detachers) lives in module refs — it never needs to trigger a re-render
//     and isn't serializable.

import { create } from 'zustand';
import type { AnimalId } from '../../../game/types';
import { useGameStore } from '../../../game/state';
import {
  createRoom,
  joinRoom,
  quickMatch,
  SignalingError,
  type RoomSession,
} from './signaling';
import { startNetMatch, stopNetMatch } from './netMatch';
import { parseNetMessage, type PlayerRole } from './netMessages';

/** Where the player is in the multiplayer flow. */
export type MultiplayerPhase =
  | 'idle' // on the multiplayer screen, not yet hosting/joining
  | 'connecting' // creating/joining a room, waiting for the peer
  | 'lobby' // connected; both players pick animals and ready up
  | 'starting' // both ready; building the match
  | 'in-match' // the lockstep match is running
  | 'error'; // matchmaking/connection failed

interface MultiplayerSessionState {
  phase: MultiplayerPhase;
  role: PlayerRole | null;
  roomCode: string | null;
  /** True while connecting via the public Quick Match queue (vs a shared code). */
  isQuickMatch: boolean;
  error: string | null;
  localAnimals: AnimalId[];
  localReady: boolean;
  remoteAnimals: AnimalId[];
  remoteReady: boolean;

  /** Host a new room and wait for an opponent to join. */
  hostRoom: () => Promise<void>;
  /** Join an existing room by its code. */
  joinByCode: (code: string) => Promise<void>;
  /** Auto-pair with any waiting player via the public matchmaking queue. */
  startQuickMatch: () => Promise<void>;
  /** Update the local player's animal picks (synced to the peer in the lobby). */
  setLocalAnimals: (animals: AnimalId[]) => void;
  /** Set the local player's ready state (synced; may trigger the match start). */
  setReady: (ready: boolean) => void;
  /** Leave the session: tear down networking and reset to idle. */
  leave: () => void;
}

// --- non-reactive plumbing -------------------------------------------------

let activeRoom: RoomSession | null = null;
const detachers: Array<() => void> = [];

function detachAll(): void {
  detachers.splice(0).forEach((detach) => detach());
}

// --- store -----------------------------------------------------------------

export const useMultiplayerSession = create<MultiplayerSessionState>((set, get) => {
  /** The peer's role, derived from ours. */
  const remoteRole = (): PlayerRole => (get().role === 'p0' ? 'p1' : 'p0');

  /** Broadcast our current lobby selection + ready state to the peer. */
  const broadcastLobby = (): void => {
    const state = get();
    if (!state.role) return;
    activeRoom?.transport.send({
      kind: 'lobby',
      playerId: state.role,
      animals: state.localAnimals,
      ready: state.localReady,
    });
  };

  /**
   * Begin the lockstep match from the agreed seed + lineups. Runs on BOTH peers
   * (the host right after it sends 'start', the guest when it receives 'start').
   */
  const beginMatch = (seed: number, lineups: Record<PlayerRole, AnimalId[]>): void => {
    const role = get().role;
    const transport = activeRoom?.transport;
    if (!role || !transport || get().phase === 'in-match') return;

    set({ phase: 'starting' });
    // Build the identical, seeded match on both peers, then attach the engine.
    useGameStore.getState().startMultiplayerMatch({ localRole: role, seed, lineups });
    startNetMatch({
      transport,
      localPlayerId: role,
      callbacks: {
        onDesync: () => {
          set({ phase: 'error', error: 'Connection desynced — the match ended.' });
        },
        onDisconnect: () => {
          set({ phase: 'error', error: 'The other player disconnected.' });
        },
      },
    });
    useGameStore.getState().transitionToScreen('playing');
    set({ phase: 'in-match' });
  };

  /**
   * Once both players are ready with full lineups, the HOST picks the seed and
   * broadcasts the start handshake, then both begin. Only the host initiates so
   * the seed has a single source of truth.
   */
  const maybeStart = (): void => {
    const state = get();
    if (state.phase !== 'lobby') return;
    if (!state.localReady || !state.remoteReady) return;
    if (state.localAnimals.length !== 3 || state.remoteAnimals.length !== 3) return;
    if (state.role !== 'p0') return; // only the host initiates the start

    const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    const lineups: Record<PlayerRole, AnimalId[]> = {
      p0: state.localAnimals,
      p1: state.remoteAnimals,
    };
    activeRoom?.transport.send({ kind: 'start', seed, lineups });
    beginMatch(seed, lineups);
  };

  /** Handle a control message from the peer (lobby/start/resign). */
  const handleMessage = (raw: unknown): void => {
    const message = parseNetMessage(raw);
    if (!message) return;
    switch (message.kind) {
      case 'lobby':
        if (message.playerId === remoteRole()) {
          set({ remoteAnimals: message.animals, remoteReady: message.ready });
          maybeStart();
        }
        break;
      case 'start':
        // Guest path: the host has locked in the seed + lineups.
        beginMatch(message.seed, message.lineups);
        break;
      case 'resign':
        if (get().phase !== 'in-match') {
          set({ phase: 'error', error: 'The other player left.' });
        }
        break;
      default:
        break; // input/checksum belong to the lockstep engine
    }
  };

  /** Wire transport listeners once connected. Shared by host and guest paths. */
  const attachTransport = (room: RoomSession): void => {
    activeRoom = room;
    detachers.push(room.transport.addMessageListener(handleMessage));
    detachers.push(
      room.transport.addStatusListener((status) => {
        if (
          (status === 'disconnected' || status === 'failed' || status === 'closed') &&
          get().phase !== 'in-match'
        ) {
          set({ phase: 'error', error: 'Lost connection to the other player.' });
        }
      })
    );
  };

  const reset = (): MultiplayerSessionState =>
    ({
      phase: 'idle',
      role: null,
      roomCode: null,
      isQuickMatch: false,
      error: null,
      localAnimals: [],
      localReady: false,
      remoteAnimals: [],
      remoteReady: false,
    } as MultiplayerSessionState);

  /**
   * Shared connect flow for all three matchmaking entry points. `connect`
   * performs the signaling handshake and resolves with a RoomSession (carrying
   * our assigned role); we then wait for the peer's channel to open and enter the
   * lobby. The room code is surfaced only for the room-code host (Quick Match's
   * ticket id is internal and not shareable).
   */
  const beginMatchmaking = async (
    mode: 'room' | 'quick',
    connect: () => Promise<RoomSession>,
    failureMessage: string
  ): Promise<void> => {
    set({ phase: 'connecting', error: null, isQuickMatch: mode === 'quick' });
    try {
      const room = await connect();
      attachTransport(room);
      set({ role: room.role, roomCode: mode === 'room' ? room.code : null });
      await room.connected;
      set({ phase: 'lobby' });
      broadcastLobby();
    } catch (error) {
      // Surface the real cause for diagnosis: a SignalingError already carries a
      // user-facing message, but anything else (a Firestore permission denial, a
      // WebRTC failure, an unexpected throw) would otherwise be reduced to the
      // generic failureMessage with no trace of what actually went wrong.
      const firebaseCode =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: string }).code
          : undefined;
      console.error(
        `[multiplayer] ${mode} matchmaking failed`,
        firebaseCode ? `(code: ${firebaseCode})` : '',
        error
      );
      set({
        phase: 'error',
        error: error instanceof SignalingError ? error.message : failureMessage,
      });
    }
  };

  return {
    ...reset(),

    hostRoom: () => beginMatchmaking('room', () => createRoom(), 'Could not create a room.'),

    joinByCode: (code: string) =>
      beginMatchmaking('room', () => joinRoom(code), 'Could not join that room.'),

    startQuickMatch: () =>
      beginMatchmaking('quick', () => quickMatch(), 'Quick Match is unavailable right now.'),

    setLocalAnimals: (animals: AnimalId[]) => {
      set({ localAnimals: animals.slice(0, 3) });
      if (get().phase === 'lobby') broadcastLobby();
    },

    setReady: (ready: boolean) => {
      set({ localReady: ready });
      if (get().phase === 'lobby') {
        broadcastLobby();
        maybeStart();
      }
    },

    leave: () => {
      // Tell the peer we're going if we were still in the lobby.
      if (get().phase === 'lobby' || get().phase === 'connecting') {
        const role = get().role;
        if (role) activeRoom?.transport.send({ kind: 'resign', playerId: role });
      }
      detachAll();
      stopNetMatch();
      void activeRoom?.cancel();
      activeRoom = null;
      // Return the game store to single-player so a subsequent solo match runs
      // the local accumulator loop (not the now-stopped lockstep engine).
      useGameStore.setState({ netMode: 'single' });
      set(reset());
    },
  };
});
