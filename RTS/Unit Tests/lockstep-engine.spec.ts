import { test, expect } from '@playwright/test';
import { LockstepEngine } from '../src/components/Working/net/lockstep';
import type { NetCommand, PlayerRole } from '../src/components/Working/net/netMessages';

/**
 * Unit tests for the lockstep engine's scheduling, gating, and desync detection,
 * with the two halves of a match wired together by an in-memory transport pair.
 *
 * The engine only `import type`s the real transport, so a duck-typed fake fully
 * exercises it in Node (no browser, no WebRTC). A MockSim stands in for the game
 * store: it records which commands were applied on which tick, so two in-sync
 * engines must produce identical application logs and checksums. These tests
 * assert the engine's observable behaviour (ticks advanced, commands applied in
 * order, desync fired) rather than its internals.
 */

const FRAME_MS = 1000 / 60;

/**
 * A pair of these relays messages between two engines with one frame of latency:
 * `send` drops into the peer's inbox, and `flush` (called once per simulated
 * frame) delivers what was queued the previous frame. That latency is what the
 * engine's input-delay buffer is designed to absorb.
 */
class FakeTransport {
  peer!: FakeTransport;
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly statusListeners = new Set<(status: string) => void>();
  private inbox: unknown[] = [];

  send(message: unknown): void {
    // Clone so the receiver can't observe a shared mutable reference (mirrors
    // JSON serialization over a real channel).
    this.peer.inbox.push(JSON.parse(JSON.stringify(message)));
  }

  addMessageListener(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  addStatusListener(listener: (status: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Deliver everything queued since the last flush. */
  flush(): void {
    const batch = this.inbox;
    this.inbox = [];
    for (const message of batch) {
      this.messageListeners.forEach((listener) => listener(message));
    }
  }

  /** Simulate a transport-level drop, e.g. the peer closing the tab. */
  fireStatus(status: string): void {
    this.statusListeners.forEach((listener) => listener(status));
  }
}

/** A minimal deterministic stand-in for the game simulation. */
class MockSim {
  tick = 0;
  readonly applied: string[] = [];
  // When set, this sim diverges on the given tick to force a desync.
  divergeOnTick: number | null = null;

  applyCommand(playerId: PlayerRole, command: NetCommand): void {
    this.applied.push(`${this.tick}:${playerId}:${command.type}`);
  }

  runTick(): void {
    this.tick++;
  }

  checksum(): string {
    const drift = this.divergeOnTick !== null && this.tick >= this.divergeOnTick ? 'X' : '';
    return `${this.tick}#${this.applied.join(',')}${drift}`;
  }
}

/** Build two engines (p0/p1) linked by a transport pair, with shared callbacks. */
function buildMatch(callbacks: {
  onDesync?: (tick: number) => void;
  onDisconnect?: () => void;
}) {
  const transportA = new FakeTransport();
  const transportB = new FakeTransport();
  transportA.peer = transportB;
  transportB.peer = transportA;
  const simA = new MockSim();
  const simB = new MockSim();
  const engineA = new LockstepEngine({
    transport: transportA as never,
    adapter: simA,
    localPlayerId: 'p0',
    callbacks,
  });
  const engineB = new LockstepEngine({
    transport: transportB as never,
    adapter: simB,
    localPlayerId: 'p1',
    callbacks,
  });
  return { transportA, transportB, simA, simB, engineA, engineB };
}

test('two engines advance in lockstep and apply commands identically', () => {
  const { transportA, transportB, simA, simB, engineA, engineB } = buildMatch({});
  engineA.start();
  engineB.start();

  let stalledFrames = 0;
  for (let frame = 0; frame < 400; frame++) {
    transportA.flush();
    transportB.flush();
    if (frame === 30) {
      engineA.enqueueLocalCommand({
        type: 'moveUnits',
        payload: { unitIds: ['x'], target: { x: 0, y: 0, z: 0 } },
      });
    }
    if (frame === 80) {
      engineB.enqueueLocalCommand({ type: 'hiss', payload: { unitIds: ['y'] } });
    }
    engineA.update(FRAME_MS);
    engineB.update(FRAME_MS);
    if (engineA.isStalled() || engineB.isStalled()) stalledFrames++;
  }
  // Trailing flush so the last checksums exchange and compare.
  for (let i = 0; i < 10; i++) {
    transportA.flush();
    transportB.flush();
    engineA.update(FRAME_MS);
    engineB.update(FRAME_MS);
  }

  // Both sims executed the same number of ticks (within one in-flight tick).
  expect(simA.tick).toBeGreaterThan(300);
  expect(Math.abs(simA.tick - simB.tick)).toBeLessThanOrEqual(1);

  // Both applied exactly the two issued commands, in the same order, same ticks.
  expect(simA.applied).toEqual(simB.applied);
  expect(simA.applied).toHaveLength(2);
  expect(simA.applied.some((entry) => entry.includes('p0:moveUnits'))).toBe(true);
  expect(simA.applied.some((entry) => entry.includes('p1:hiss'))).toBe(true);

  // One frame of latency is fully absorbed by the input-delay buffer.
  expect(stalledFrames).toBe(0);
});

test('a divergence is caught by the checksum exchange', () => {
  let desyncTick = -1;
  const { transportA, transportB, simA, simB, engineA, engineB } = buildMatch({
    onDesync: (tick) => {
      desyncTick = tick;
    },
  });
  // Make p1's simulation silently diverge partway through.
  simB.divergeOnTick = 75;
  engineA.start();
  engineB.start();

  for (let frame = 0; frame < 300 && desyncTick === -1; frame++) {
    transportA.flush();
    transportB.flush();
    engineA.update(FRAME_MS);
    engineB.update(FRAME_MS);
  }

  // The checksum interval is 60 ticks; divergence at tick 75 must be caught at
  // the first checksum boundary on/after it.
  expect(desyncTick).toBeGreaterThanOrEqual(120);
});

test('a transport drop surfaces as a disconnect and halts the engine', () => {
  let disconnected = false;
  const { transportA, transportB, engineA, engineB, simA } = buildMatch({
    onDisconnect: () => {
      disconnected = true;
    },
  });
  engineA.start();
  engineB.start();

  for (let frame = 0; frame < 50; frame++) {
    transportA.flush();
    transportB.flush();
    engineA.update(FRAME_MS);
    engineB.update(FRAME_MS);
  }
  const tickAtDrop = simA.tick;
  transportA.fireStatus('closed');

  // After a disconnect the engine stops advancing even if frames keep arriving.
  for (let frame = 0; frame < 50; frame++) {
    transportA.flush();
    transportB.flush();
    engineA.update(FRAME_MS);
  }

  expect(disconnected).toBe(true);
  expect(simA.tick).toBe(tickAtDrop);
});
