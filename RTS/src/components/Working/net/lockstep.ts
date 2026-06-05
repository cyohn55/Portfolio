// Lockstep simulation engine.
//
// Single responsibility: keep two peers' deterministic simulations advancing in
// perfect step by exchanging only inputs. It never touches the game store
// directly — all simulation effects go through an injected LockstepSimAdapter —
// and it never touches Firebase. That decoupling keeps the scheduling logic (the
// subtle part) unit-testable in pure Node with a fake transport + adapter.
//
// The model (classic deferred-input lockstep):
//   * Time is divided into fixed 60 Hz ticks. A command issued "now" does not
//     execute now; it is scheduled INPUT_DELAY ticks in the future and sent to
//     the peer. Both peers therefore execute every command on the same tick.
//   * A tick N may only execute once BOTH players' input frames for N have
//     arrived. Every player sends a frame for every tick (empty when idle), so a
//     missing frame means "still in flight" and the engine waits ("stalls")
//     rather than guessing — guessing is what desyncs lockstep.
//   * Periodically each peer hashes its simulation state and sends the hash; a
//     mismatch means the simulations diverged and the match is stopped loudly.
//
// The fixed INPUT_DELAY trades a small, constant input latency for the guarantee
// that inputs are almost always present by the time their tick comes up, so the
// match runs smoothly without prediction/rollback.

import type { WebRtcTransport } from './webrtcTransport';
import {
  parseNetMessage,
  type NetCommand,
  type NetMessage,
  type PlayerRole,
} from './netMessages';

/** Fixed simulation timestep, matching the game's 60 Hz tick. */
export const FIXED_DT_SEC = 1 / 60;
const FIXED_DT_MS = 1000 * FIXED_DT_SEC;

/** Ticks of input delay (≈83 ms at 60 Hz). Small enough to feel responsive. */
const DEFAULT_INPUT_DELAY_TICKS = 5;

/** Exchange a state checksum every this many ticks (≈1 s) for desync detection. */
const DEFAULT_CHECKSUM_INTERVAL_TICKS = 60;

// Cap how many ticks one update() call may execute, so that returning from a
// long stall (or a backgrounded tab) catches up gradually instead of freezing
// the frame with a huge burst — the classic "spiral of death" guard.
const MAX_TICKS_PER_UPDATE = 8;

/**
 * The simulation surface the engine drives. Provided by the state layer so the
 * engine stays free of any store/Three/React dependency (and testable in Node).
 */
export interface LockstepSimAdapter {
  /** Apply one command, attributing its effects to the given player. */
  applyCommand(playerId: PlayerRole, command: NetCommand): void;
  /** Advance the simulation by exactly one fixed timestep. */
  runTick(): void;
  /** Return a deterministic fingerprint of the current simulation state. */
  checksum(): string;
  /**
   * The local player's current monarch-pilot drive vector (world XZ), sampled
   * once per outgoing frame. Monarch piloting is continuous per-frame input, so
   * unlike the discrete gesture commands it cannot be enqueued on demand — the
   * engine pulls it here and ships it on every frame so both peers drive each
   * piloted monarch from an identical, tick-aligned vector. Optional so engines
   * without piloting (and the unit tests) need not provide it.
   */
  sampleLocalPilot?(): { x: number; z: number };
}

export interface LockstepCallbacks {
  /** The engine is waiting for the peer's input (true) or running again (false). */
  onStallChange?: (stalled: boolean) => void;
  /** The simulations diverged at the given tick — the match cannot continue. */
  onDesync?: (tick: number) => void;
  /** The peer disconnected mid-match. */
  onDisconnect?: () => void;
}

export interface LockstepOptions {
  transport: WebRtcTransport;
  adapter: LockstepSimAdapter;
  /** This peer's role. Host = p0, guest = p1. */
  localPlayerId: PlayerRole;
  callbacks?: LockstepCallbacks;
  inputDelayTicks?: number;
  checksumIntervalTicks?: number;
}

/** Per-tick frame storage: which players have submitted commands for a tick. */
type FrameStore = Map<number, Partial<Record<PlayerRole, NetCommand[]>>>;

/**
 * Drives a lockstep match. Construct it once both peers are connected, register
 * the local command sink, then call update(realDtMs) every animation frame.
 */
export class LockstepEngine {
  private readonly transport: WebRtcTransport;
  private readonly adapter: LockstepSimAdapter;
  private readonly localPlayerId: PlayerRole;
  private readonly remotePlayerId: PlayerRole;
  private readonly callbacks: LockstepCallbacks;
  private readonly inputDelayTicks: number;
  private readonly checksumIntervalTicks: number;

  // The next tick to execute. Tick 0 is the initial post-start state; the first
  // executed tick is 1, matching the store's tickCounter convention.
  private currentTick = 1;
  private accumulatorMs = 0;

  private readonly frames: FrameStore = new Map();
  private localCommandBuffer: NetCommand[] = [];
  private readonly localChecksums = new Map<number, string>();
  private readonly remoteChecksums = new Map<number, string>();

  private stalled = false;
  private running = false;
  private readonly detachers: Array<() => void> = [];

  constructor(options: LockstepOptions) {
    this.transport = options.transport;
    this.adapter = options.adapter;
    this.localPlayerId = options.localPlayerId;
    this.remotePlayerId = options.localPlayerId === 'p0' ? 'p1' : 'p0';
    this.callbacks = options.callbacks ?? {};
    this.inputDelayTicks = options.inputDelayTicks ?? DEFAULT_INPUT_DELAY_TICKS;
    this.checksumIntervalTicks =
      options.checksumIntervalTicks ?? DEFAULT_CHECKSUM_INTERVAL_TICKS;

    // Subscribe at construction (not start) so no early frame from the peer is
    // ever missed in the window before the loop begins.
    this.detachers.push(this.transport.addMessageListener((raw) => this.receive(raw)));
    this.detachers.push(
      this.transport.addStatusListener((status) => {
        if (status === 'disconnected' || status === 'failed' || status === 'closed') {
          this.handleDisconnect();
        }
      })
    );
  }

  /**
   * Begin the match. Pre-sends the local input frames for ticks 1..INPUT_DELAY
   * (empty — no commands exist yet) so those early ticks can become ready as soon
   * as the peer's matching frames arrive, rather than stalling from tick one.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (let tick = this.currentTick; tick < this.currentTick + this.inputDelayTicks; tick++) {
      this.sendFrameFor(tick);
    }
  }

  /** Queue a local command for the next outgoing frame. Called by the store seam. */
  enqueueLocalCommand(command: NetCommand): void {
    if (!this.running) return;
    this.localCommandBuffer.push(command);
  }

  /**
   * Advance the simulation by however many fixed ticks `realDtMs` of wall time
   * allows, gated by input availability. Call once per animation frame.
   */
  update(realDtMs: number): void {
    if (!this.running) return;

    // Bound the backlog so a long pause can't demand a giant catch-up burst.
    this.accumulatorMs = Math.min(
      this.accumulatorMs + realDtMs,
      MAX_TICKS_PER_UPDATE * FIXED_DT_MS
    );

    let executed = 0;
    while (this.accumulatorMs >= FIXED_DT_MS && executed < MAX_TICKS_PER_UPDATE) {
      if (!this.isTickReady(this.currentTick)) {
        // Peer input for this tick has not arrived — wait rather than guess.
        this.setStalled(true);
        return;
      }
      this.setStalled(false);

      // Send our input for the tick INPUT_DELAY ahead, draining commands buffered
      // since the previous send, before executing the current tick.
      this.sendFrameFor(this.currentTick + this.inputDelayTicks);
      this.executeTick(this.currentTick);

      this.currentTick++;
      this.accumulatorMs -= FIXED_DT_MS;
      executed++;
    }
  }

  /** Tick the engine is currently waiting on, or about to run. Exposed for tests/UI. */
  getCurrentTick(): number {
    return this.currentTick;
  }

  /** Whether the engine is currently waiting for the peer's input. */
  isStalled(): boolean {
    return this.stalled;
  }

  /** Stop the engine and detach all listeners. Idempotent. */
  stop(): void {
    this.running = false;
    this.detachers.splice(0).forEach((detach) => detach());
  }

  // --- internals -----------------------------------------------------------

  /** Build and send the local frame for `tick`, recording it locally too. */
  private sendFrameFor(tick: number): void {
    const commands = this.localCommandBuffer;
    this.localCommandBuffer = [];

    // Append this frame's monarch-pilot drive vector last, so it applies AFTER
    // any discrete gesture in the same frame (e.g. a setPilot that starts piloting
    // takes effect before the vector that should drive the newly piloted monarch).
    // It rides every frame — including idle ones — so the receiver's pilot vector
    // for each owner is always fresh and a released drive key stops the monarch on
    // the very next tick rather than coasting on a stale vector.
    if (this.adapter.sampleLocalPilot) {
      const move = this.adapter.sampleLocalPilot();
      commands.push({ type: 'pilotMove', payload: { x: move.x, z: move.z } });
    }

    this.recordFrame(tick, this.localPlayerId, commands);
    this.transport.send({
      kind: 'input',
      tick,
      playerId: this.localPlayerId,
      commands,
    });
  }

  /** True once both players' frames for `tick` are present. */
  private isTickReady(tick: number): boolean {
    const frame = this.frames.get(tick);
    return Boolean(frame && frame.p0 !== undefined && frame.p1 !== undefined);
  }

  /**
   * Execute one tick: apply both players' commands in a fixed order (p0 then p1),
   * advance the sim, and emit/compare a checksum on the interval boundary.
   */
  private executeTick(tick: number): void {
    const frame = this.frames.get(tick);
    // Deterministic apply order across peers: always p0's commands, then p1's.
    for (const command of frame?.p0 ?? []) {
      this.adapter.applyCommand('p0', command);
    }
    for (const command of frame?.p1 ?? []) {
      this.adapter.applyCommand('p1', command);
    }

    this.adapter.runTick();

    if (tick % this.checksumIntervalTicks === 0) {
      const hash = this.adapter.checksum();
      this.localChecksums.set(tick, hash);
      this.transport.send({ kind: 'checksum', tick, playerId: this.localPlayerId, hash });
      this.compareChecksum(tick);
    }

    // The frame and any stale checksum are no longer needed once executed.
    this.frames.delete(tick);
  }

  /** Store a frame's commands for a player on a tick. */
  private recordFrame(tick: number, playerId: PlayerRole, commands: NetCommand[]): void {
    const frame = this.frames.get(tick) ?? {};
    frame[playerId] = commands;
    this.frames.set(tick, frame);
  }

  /** Handle a decoded inbound message from the peer. */
  private receive(raw: unknown): void {
    const message = parseNetMessage(raw);
    if (!message) return;
    this.dispatch(message);
  }

  private dispatch(message: NetMessage): void {
    switch (message.kind) {
      case 'input':
        // Only the remote player's frames arrive here; our own are recorded
        // locally in sendFrameFor. Ignore any echo of our own role defensively.
        if (message.playerId === this.remotePlayerId) {
          this.recordFrame(message.tick, message.playerId, message.commands);
        }
        break;
      case 'checksum':
        if (message.playerId === this.remotePlayerId) {
          this.remoteChecksums.set(message.tick, message.hash);
          this.compareChecksum(message.tick);
        }
        break;
      default:
        // start/lobby/resign are handled by the match/lobby layer, not the engine.
        break;
    }
  }

  /** Compare local vs remote checksums for a tick once both are known. */
  private compareChecksum(tick: number): void {
    const local = this.localChecksums.get(tick);
    const remote = this.remoteChecksums.get(tick);
    if (local === undefined || remote === undefined) return;

    if (local !== remote) {
      this.callbacks.onDesync?.(tick);
      this.stop();
      return;
    }
    // Matched — both hashes can be discarded.
    this.localChecksums.delete(tick);
    this.remoteChecksums.delete(tick);
  }

  private setStalled(stalled: boolean): void {
    if (this.stalled === stalled) return;
    this.stalled = stalled;
    this.callbacks.onStallChange?.(stalled);
  }

  private handleDisconnect(): void {
    if (!this.running) return;
    this.stop();
    this.callbacks.onDisconnect?.();
  }
}
