import { test, expect } from '@playwright/test';
import {
  parseNetMessage,
  type NetCommand,
  type NetMessage,
} from '../src/components/Working/net/netMessages';

/**
 * Unit tests for the lockstep wire protocol's inbound validator.
 *
 * The data channel hands us already-decoded JSON, but a buggy or hostile peer
 * could still send something of the wrong shape; parseNetMessage must accept
 * every well-formed message and reject everything else so the engine can ignore
 * garbage instead of acting on it. These run purely in Node (no browser/page).
 *
 * Messages are validated by round-tripping the EXACT objects the engine sends
 * (JSON-stringified then parsed), not against hand-copied literals, so the tests
 * track the real protocol.
 */

/** Round-trip a value through the data-channel encoding (JSON) before parsing. */
function overTheWire(message: unknown): NetMessage | null {
  return parseNetMessage(JSON.parse(JSON.stringify(message)));
}

test.describe('parseNetMessage — well-formed messages survive the round-trip', () => {
  test('input frame with commands', () => {
    const command: NetCommand = {
      type: 'moveUnits',
      payload: { unitIds: ['U-1', 'U-2'], target: { x: 1.5, y: 0, z: -3.25 } },
    };
    const message: NetMessage = {
      kind: 'input',
      tick: 42,
      playerId: 'p0',
      commands: [command],
    };
    expect(overTheWire(message)).toEqual(message);
  });

  test('empty input frame (idle heartbeat)', () => {
    const message: NetMessage = { kind: 'input', tick: 7, playerId: 'p1', commands: [] };
    expect(overTheWire(message)).toEqual(message);
  });

  test('checksum message', () => {
    const message: NetMessage = { kind: 'checksum', tick: 60, playerId: 'p0', hash: 'abc123' };
    expect(overTheWire(message)).toEqual(message);
  });

  test('start handshake', () => {
    const message: NetMessage = {
      kind: 'start',
      seed: 123456,
      lineups: { p0: ['Bear', 'Fox', 'Bee'], p1: ['Cat', 'Pig', 'Owl'] },
    };
    expect(overTheWire(message)).toEqual(message);
  });

  test('lobby and resign messages', () => {
    const lobby: NetMessage = { kind: 'lobby', playerId: 'p1', animals: ['Wolf'], ready: true };
    const resign: NetMessage = { kind: 'resign', playerId: 'p0' };
    expect(overTheWire(lobby)).toEqual(lobby);
    expect(overTheWire(resign)).toEqual(resign);
  });

  test('every command type passes validation inside a frame', () => {
    const commands: NetCommand[] = [
      { type: 'moveUnits', payload: { unitIds: ['a'], target: { x: 0, y: 0, z: 0 } } },
      { type: 'attackTarget', payload: { unitIds: ['a'], targetId: 'b' } },
      { type: 'setPatrol', payload: { queenId: 'q', startPosition: { x: 0, y: 0, z: 0 }, endPosition: { x: 1, y: 0, z: 1 } } },
      { type: 'setMovementHold', payload: { unitId: 'u' } },
      { type: 'hiss', payload: { unitIds: ['c'] } },
      { type: 'swarm', payload: { unitIds: ['e'] } },
      { type: 'toggleTurtleShell', payload: { unitIds: ['t'] } },
    ];
    const message: NetMessage = { kind: 'input', tick: 1, playerId: 'p0', commands };
    expect(overTheWire(message)).toEqual(message);
  });
});

test.describe('parseNetMessage — malformed input is rejected', () => {
  test('rejects non-objects and missing kind', () => {
    expect(parseNetMessage(null)).toBeNull();
    expect(parseNetMessage(42)).toBeNull();
    expect(parseNetMessage('input')).toBeNull();
    expect(parseNetMessage({})).toBeNull();
    expect(parseNetMessage({ kind: 'unknown' })).toBeNull();
  });

  test('rejects an input frame with a bad player role', () => {
    expect(
      parseNetMessage({ kind: 'input', tick: 1, playerId: 'p9', commands: [] })
    ).toBeNull();
  });

  test('rejects an input frame whose tick is not a number', () => {
    expect(
      parseNetMessage({ kind: 'input', tick: 'soon', playerId: 'p0', commands: [] })
    ).toBeNull();
  });

  test('rejects an input frame containing an unknown command type', () => {
    expect(
      parseNetMessage({
        kind: 'input',
        tick: 1,
        playerId: 'p0',
        commands: [{ type: 'selfDestruct', payload: {} }],
      })
    ).toBeNull();
  });

  test('rejects a checksum missing its hash', () => {
    expect(parseNetMessage({ kind: 'checksum', tick: 60, playerId: 'p0' })).toBeNull();
  });

  test('rejects a start message with malformed lineups', () => {
    expect(parseNetMessage({ kind: 'start', seed: 1, lineups: { p0: 'Bear' } })).toBeNull();
  });
});
