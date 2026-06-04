// Firestore-backed signaling + room registry for peer-to-peer matches.
//
// Single responsibility: broker exactly one WebRTC connection between two
// browsers by relaying their SDP offer/answer and ICE candidates through a
// short-lived Firestore document, and hand back a connected transport. It is the
// ONLY networking module that talks to Firebase; the transport (webrtcTransport)
// stays Firebase-agnostic and the lockstep engine stays transport-agnostic.
//
// Why Firestore: the leaderboard already stands up a Firestore handle
// (firebaseClient.getDb), it is free at this scale, and signaling traffic is a
// handful of small docs per match that exist only until the peers connect. No
// always-on signaling server is required.
//
// This file covers the ROOM-CODE flow (host creates a code, guest joins by code).
// Quick Match (auto-pairing queue) is layered on top in a later phase and reuses
// the same offer/answer/ICE mechanics.

import {
  collection,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  addDoc,
  onSnapshot,
  serverTimestamp,
  type Firestore,
  type DocumentData,
} from 'firebase/firestore';
import { getDb } from '../firebaseClient';
import {
  WebRtcTransport,
  type WebRtcTransportCallbacks,
  type SerializedIceCandidate,
} from './webrtcTransport';

// Top-level collection holding one document per open/active room.
const ROOMS_COLLECTION = 'rooms';
// Per-room subcollections carrying each side's trickled ICE candidates.
const HOST_CANDIDATES = 'hostCandidates';
const GUEST_CANDIDATES = 'guestCandidates';

// Room codes are short and human-shareable. The alphabet omits visually
// ambiguous characters (0/O, 1/I/L) so codes read aloud or retyped don't collide.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

// If a connection has not opened within this window, give up so the UI can show
// a clear failure instead of spinning forever (e.g. wrong code, peer left).
const CONNECTION_TIMEOUT_MS = 30_000;

/**
 * A live signaling session. `connected` resolves when the data channel opens (or
 * rejects on failure/timeout); `transport` is usable for sending once connected;
 * `cancel` tears everything down and removes the room document.
 */
export interface RoomSession {
  /** The room code players share to join this match. */
  code: string;
  /** The peer-to-peer transport, connected once `connected` resolves. */
  transport: WebRtcTransport;
  /** Resolves when the channel opens; rejects on failure or timeout. */
  connected: Promise<void>;
  /** Abort signaling, close the transport, and best-effort delete the room. */
  cancel: () => Promise<void>;
}

/** Thrown when signaling cannot proceed (backend down, bad code, room full). */
export class SignalingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalingError';
  }
}

/**
 * HOST a new room. Generates a unique code, publishes an SDP offer, and listens
 * for the guest's answer + ICE candidates. Returns immediately with a session
 * whose `connected` promise resolves once the guest joins and the channel opens.
 */
export async function createRoom(
  callbacks: WebRtcTransportCallbacks = {}
): Promise<RoomSession> {
  const db = requireDb();
  const code = await reserveUniqueCode(db);
  const roomRef = doc(db, ROOMS_COLLECTION, code);

  // Signaling owns ICE delivery; the caller's lifecycle/message callbacks are
  // preserved and merged with our candidate writer.
  const transport = new WebRtcTransport({
    ...callbacks,
    onLocalIceCandidate: (candidate) => {
      void addDoc(collection(roomRef, HOST_CANDIDATES), candidate as DocumentData);
    },
  });

  const offer = await transport.createOffer();
  await setDoc(roomRef, {
    offer: { type: offer.type, sdp: offer.sdp },
    status: 'open',
    createdAt: serverTimestamp(),
  });

  const unsubscribers: Array<() => void> = [];

  // Apply the guest's answer as soon as it appears.
  unsubscribers.push(
    onSnapshot(roomRef, (snapshot) => {
      const data = snapshot.data();
      if (data?.answer) {
        void transport.acceptAnswer(data.answer as RTCSessionDescriptionInit);
      }
    })
  );

  // Stream in the guest's ICE candidates as they are added.
  unsubscribers.push(subscribeToCandidates(roomRef, GUEST_CANDIDATES, transport));

  return buildSession(code, transport, unsubscribers, roomRef);
}

/**
 * JOIN an existing room by code. Reads the host's offer, answers it, and listens
 * for the host's ICE candidates. Rejects if the room is missing or already full.
 */
export async function joinRoom(
  rawCode: string,
  callbacks: WebRtcTransportCallbacks = {}
): Promise<RoomSession> {
  const db = requireDb();
  const code = normalizeCode(rawCode);
  const roomRef = doc(db, ROOMS_COLLECTION, code);

  const snapshot = await getDoc(roomRef);
  if (!snapshot.exists()) {
    throw new SignalingError(`Room "${code}" was not found.`);
  }
  const data = snapshot.data();
  if (data.status !== 'open' || !data.offer) {
    throw new SignalingError(`Room "${code}" is no longer accepting players.`);
  }

  const transport = new WebRtcTransport({
    ...callbacks,
    onLocalIceCandidate: (candidate) => {
      void addDoc(collection(roomRef, GUEST_CANDIDATES), candidate as DocumentData);
    },
  });

  const answer = await transport.acceptOffer(data.offer as RTCSessionDescriptionInit);
  await updateDoc(roomRef, {
    answer: { type: answer.type, sdp: answer.sdp },
    status: 'joined',
  });

  // Stream in the host's ICE candidates as they are added.
  const unsubscribers = [subscribeToCandidates(roomRef, HOST_CANDIDATES, transport)];

  return buildSession(code, transport, unsubscribers, roomRef);
}

// --- internals -------------------------------------------------------------

/** Get the Firestore handle or fail loudly — signaling cannot degrade offline. */
function requireDb(): Firestore {
  const db = getDb();
  if (!db) {
    throw new SignalingError(
      'Multiplayer is unavailable: could not reach the matchmaking backend.'
    );
  }
  return db;
}

/** Generate a random room code from the unambiguous alphabet. */
function generateCode(): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

/** Normalize user-entered codes (trim, uppercase) for lookup. */
function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Find a code not currently in use. Collisions are vanishingly unlikely at this
 * scale, but a few retries make accidental reuse of a live room impossible.
 */
async function reserveUniqueCode(db: Firestore): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCode();
    const existing = await getDoc(doc(db, ROOMS_COLLECTION, candidate));
    if (!existing.exists()) return candidate;
  }
  throw new SignalingError('Could not allocate a room code; please try again.');
}

/**
 * Subscribe to one candidate subcollection and forward every newly-added
 * candidate to the transport. Returns the unsubscribe function.
 */
function subscribeToCandidates(
  roomRef: ReturnType<typeof doc>,
  subcollection: string,
  transport: WebRtcTransport
): () => void {
  return onSnapshot(collection(roomRef, subcollection), (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === 'added') {
        void transport.addRemoteIceCandidate(change.doc.data() as SerializedIceCandidate);
      }
    }
  });
}

/**
 * Assemble the RoomSession: a `connected` promise wired to the transport's open
 * /failure status, and a `cancel` that detaches listeners, closes the transport,
 * and removes the room document so it cannot be joined again.
 */
function buildSession(
  code: string,
  transport: WebRtcTransport,
  unsubscribers: Array<() => void>,
  roomRef: ReturnType<typeof doc>
): RoomSession {
  let settled = false;
  const detach = () => unsubscribers.splice(0).forEach((off) => off());

  const connected = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new SignalingError('Timed out waiting for the other player to connect.'));
    }, CONNECTION_TIMEOUT_MS);

    transport.addStatusListener((status) => {
      if (settled) return;
      if (status === 'connected') {
        settled = true;
        clearTimeout(timeout);
        // Once both peers hold the live channel the signaling docs are dead
        // weight; drop our listeners (the channel carries all further traffic).
        detach();
        resolve();
      } else if (status === 'failed' || status === 'closed') {
        settled = true;
        clearTimeout(timeout);
        reject(new SignalingError('The connection to the other player failed.'));
      }
    });
  });

  const cancel = async () => {
    settled = true;
    detach();
    transport.close();
    await deleteRoom(roomRef);
  };

  return { code, transport, connected, cancel };
}

/** Best-effort removal of a room document and its candidate subcollections. */
async function deleteRoom(roomRef: ReturnType<typeof doc>): Promise<void> {
  try {
    for (const subcollection of [HOST_CANDIDATES, GUEST_CANDIDATES]) {
      const candidates = await getDocs(collection(roomRef, subcollection));
      await Promise.all(candidates.docs.map((candidate) => deleteDoc(candidate.ref)));
    }
    await deleteDoc(roomRef);
  } catch {
    // Cleanup is best-effort; orphaned rooms expire via security-rule TTL.
  }
}
