// Peer-to-peer transport for multiplayer matches.
//
// Single responsibility: own one RTCPeerConnection and one reliable, ordered
// data channel between two browsers, and expose a small message-passing surface
// (send / onMessage / lifecycle events) plus the raw SDP + ICE primitives the
// signaling layer needs to broker the connection. It knows NOTHING about
// Firebase, rooms, matchmaking, or the lockstep protocol — signaling.ts wires
// those to the primitives here, and lockstep.ts speaks JSON over send/onMessage.
//
// Why reliable + ordered: lockstep exchanges input frames and checksums where a
// dropped or reordered frame would stall or desync the match. The classic
// "drop stale packets" argument for unreliable channels applies to state
// streaming, not to an input log that must arrive complete and in order, so the
// default reliable ordered channel is exactly right here.
//
// Why this is browser-only: RTCPeerConnection is a browser API. The module is
// imported only by client UI/engine code, never by the Node-side determinism
// harness.

/** A single ICE candidate in the plain shape we persist through signaling. */
export interface SerializedIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/** High-level connection lifecycle, surfaced to the UI for status display. */
export type TransportStatus =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

export interface WebRtcTransportCallbacks {
  /** A local ICE candidate was discovered and must be sent to the peer. */
  onLocalIceCandidate?: (candidate: SerializedIceCandidate) => void;
  /** The data channel opened — the peers can now exchange application messages. */
  onOpen?: () => void;
  /** A decoded application message arrived from the peer. */
  onMessage?: (message: unknown) => void;
  /** The connection's lifecycle status changed. */
  onStatusChange?: (status: TransportStatus) => void;
}

// Free public STUN servers for NAT traversal. STUN alone (no TURN relay) connects
// the large majority of home/mobile NATs directly; symmetric-NAT users who fail
// would need a TURN relay, which is noted as a future, non-free add-on rather
// than shipped here. Multiple servers add redundancy if one is unreachable.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// The single application data channel. A fixed label keeps both peers agreeing
// on which channel carries game traffic.
const GAME_CHANNEL_LABEL = 'game';

/**
 * One peer's side of a WebRTC connection. The HOST constructs the offer and
 * creates the data channel; the GUEST answers and receives the channel. Both
 * roles use the same class — `createOffer` vs `acceptOffer` selects the role.
 */
export class WebRtcTransport {
  private readonly connection: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private readonly callbacks: WebRtcTransportCallbacks;
  private status: TransportStatus = 'new';
  // Remote ICE candidates that arrived before the remote SDP was applied.
  // addIceCandidate throws if called with no remote description, which is a real
  // race for the host (its peer's candidates can land before the answer does), so
  // we buffer here and flush once the remote description is set.
  private pendingRemoteCandidates: SerializedIceCandidate[] = [];
  // Extra status subscribers beyond the constructor callback. Lets independent
  // consumers (signaling's connect-detection, the UI's status display, the
  // lockstep engine's disconnect handling) all observe status without fighting
  // over the single constructor callback slot.
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();

  constructor(callbacks: WebRtcTransportCallbacks = {}) {
    this.callbacks = callbacks;
    this.connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Trickle ICE: forward each discovered candidate to signaling as it appears,
    // rather than waiting for gathering to complete, so connection setup is fast.
    this.connection.onicecandidate = (event) => {
      if (event.candidate) {
        this.callbacks.onLocalIceCandidate?.(serializeCandidate(event.candidate));
      }
    };

    // Map the low-level connection state onto our coarse, UI-friendly status.
    this.connection.onconnectionstatechange = () => {
      switch (this.connection.connectionState) {
        case 'connecting':
          this.updateStatus('connecting');
          break;
        case 'connected':
          // Wait for the channel's `open` event before reporting 'connected' so
          // that callers may start sending only once delivery is actually possible.
          break;
        case 'disconnected':
          this.updateStatus('disconnected');
          break;
        case 'failed':
          this.updateStatus('failed');
          break;
        case 'closed':
          this.updateStatus('closed');
          break;
        default:
          break;
      }
    };

    // The guest receives the channel the host created; wire it up on arrival.
    this.connection.ondatachannel = (event) => {
      this.attachChannel(event.channel);
    };
  }

  /** Current high-level connection status. */
  getStatus(): TransportStatus {
    return this.status;
  }

  /**
   * Subscribe to status changes in addition to the constructor callback. Returns
   * an unsubscribe function. Used by signaling (to detect connect/fail) and the
   * lockstep engine (to detect mid-match disconnects) independently.
   */
  addStatusListener(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * HOST role. Create the data channel and an SDP offer to publish via signaling.
   * Returns the local description to hand to the peer.
   */
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.attachChannel(this.connection.createDataChannel(GAME_CHANNEL_LABEL, { ordered: true }));
    const offer = await this.connection.createOffer();
    await this.connection.setLocalDescription(offer);
    this.updateStatus('connecting');
    return offer;
  }

  /**
   * GUEST role. Accept the host's offer and produce an SDP answer to publish
   * back via signaling. The data channel arrives later via `ondatachannel`.
   */
  async acceptOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.connection.setRemoteDescription(offer);
    const answer = await this.connection.createAnswer();
    await this.connection.setLocalDescription(answer);
    this.updateStatus('connecting');
    await this.flushPendingRemoteCandidates();
    return answer;
  }

  /** HOST role. Apply the guest's SDP answer to complete the negotiation. */
  async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    // Guard against a duplicate answer from a re-fired snapshot listener.
    if (this.connection.currentRemoteDescription) return;
    await this.connection.setRemoteDescription(answer);
    await this.flushPendingRemoteCandidates();
  }

  /** Add a remote ICE candidate received via signaling. Safe to call repeatedly. */
  async addRemoteIceCandidate(candidate: SerializedIceCandidate): Promise<void> {
    // Until the remote description exists, addIceCandidate would throw — buffer
    // and flush later (see flushPendingRemoteCandidates).
    if (!this.connection.remoteDescription) {
      this.pendingRemoteCandidates.push(candidate);
      return;
    }
    try {
      await this.connection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      // A rejected candidate is not fatal — other candidates may still connect.
      // Log once so genuinely failing setups remain diagnosable.
      console.warn('[net] failed to add remote ICE candidate', error);
    }
  }

  /** Apply any candidates that were buffered before the remote description arrived. */
  private async flushPendingRemoteCandidates(): Promise<void> {
    const buffered = this.pendingRemoteCandidates;
    this.pendingRemoteCandidates = [];
    for (const candidate of buffered) {
      await this.addRemoteIceCandidate(candidate);
    }
  }

  /**
   * Send an application message to the peer. Serialized as JSON. Returns false
   * if the channel is not open yet (caller may buffer or drop accordingly).
   */
  send(message: unknown): boolean {
    if (!this.channel || this.channel.readyState !== 'open') return false;
    this.channel.send(JSON.stringify(message));
    return true;
  }

  /** Tear down the channel and connection. Idempotent. */
  close(): void {
    if (this.channel) {
      this.channel.onopen = null;
      this.channel.onclose = null;
      this.channel.onmessage = null;
      this.channel.close();
      this.channel = null;
    }
    this.connection.close();
    this.updateStatus('closed');
  }

  /** Attach lifecycle + message handlers to the one game data channel. */
  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.onopen = () => this.updateStatus('connected');
    channel.onclose = () => this.updateStatus('closed');
    channel.onmessage = (event) => {
      const decoded = decodeMessage(event.data);
      if (decoded !== undefined) this.callbacks.onMessage?.(decoded);
    };
  }

  private updateStatus(next: TransportStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.callbacks.onStatusChange?.(next);
    this.statusListeners.forEach((listener) => listener(next));
    if (next === 'connected') this.callbacks.onOpen?.();
  }
}

/** Convert a browser ICE candidate to the plain shape persisted by signaling. */
function serializeCandidate(candidate: RTCIceCandidate): SerializedIceCandidate {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
  };
}

/** Decode a channel payload back into an object, tolerating malformed input. */
function decodeMessage(data: unknown): unknown {
  if (typeof data !== 'string') return undefined;
  try {
    return JSON.parse(data);
  } catch {
    console.warn('[net] dropping non-JSON message from peer');
    return undefined;
  }
}
