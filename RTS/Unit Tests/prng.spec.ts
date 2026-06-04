import { test, expect } from '@playwright/test';
import { SeededRng, seedFromString } from '../src/components/Working/net/prng';

/**
 * Unit tests for the deterministic PRNG that underpins lockstep multiplayer.
 *
 * These assertions run purely in the Playwright test process (Node) — they never
 * touch the browser `page`, because SeededRng has no DOM or three.js dependency.
 * They validate the determinism contract the netcode relies on: two peers that
 * seed identically and advance the generator in the same order must observe the
 * exact same sequence, and the generator's state must round-trip so a match can
 * be checksummed and resynced.
 *
 * The tests assert against the generator's actual behaviour (sequences it
 * produces, state it exposes), never hard-coded magic numbers copied from the
 * implementation, so they stay valid if the mixing constants are ever retuned.
 */

const SAMPLE_COUNT = 16;

/** Draw `count` values from a fresh generator seeded with `seed`. */
function drawSequence(seed: number, count: number): number[] {
  const generator = new SeededRng(seed);
  return Array.from({ length: count }, () => generator.next());
}

test.describe('SeededRng determinism', () => {
  test('identical seeds produce identical sequences', () => {
    const first = drawSequence(0xc0ffee, SAMPLE_COUNT);
    const second = drawSequence(0xc0ffee, SAMPLE_COUNT);
    expect(second).toEqual(first);
  });

  test('different seeds produce different sequences', () => {
    const fromSeedA = drawSequence(1, SAMPLE_COUNT);
    const fromSeedB = drawSequence(2, SAMPLE_COUNT);
    expect(fromSeedB).not.toEqual(fromSeedA);
  });

  test('next() values stay within the half-open range [0, 1)', () => {
    const generator = new SeededRng(42);
    for (let draw = 0; draw < 50_000; draw++) {
      const value = generator.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test('getState/setState round-trips so a stream can be resumed', () => {
    const original = new SeededRng(777);
    // Advance past the start so we are restoring a mid-stream state, not the seed.
    original.next();
    original.next();
    const checkpoint = original.getState();
    const continuation = [original.next(), original.next(), original.next()];

    const restored = new SeededRng(0);
    restored.setState(checkpoint);
    const replay = [restored.next(), restored.next(), restored.next()];

    expect(replay).toEqual(continuation);
  });

  test('getState returns a stable unsigned 32-bit integer', () => {
    const generator = new SeededRng(-1); // negative seed must still coerce to uint32
    const state = generator.getState();
    expect(Number.isInteger(state)).toBe(true);
    expect(state).toBeGreaterThanOrEqual(0);
    expect(state).toBeLessThanOrEqual(0xffffffff);
    expect(state >>> 0).toBe(state);
  });
});

test.describe('SeededRng helpers', () => {
  test('nextInt(max) stays in [0, max)', () => {
    const generator = new SeededRng(9);
    const max = 7;
    for (let draw = 0; draw < 20_000; draw++) {
      const value = generator.nextInt(max);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(max);
    }
  });

  test('nextInt covers the full range of buckets', () => {
    const generator = new SeededRng(11);
    const max = 4;
    const seen = new Set<number>();
    for (let draw = 0; draw < 1_000; draw++) {
      seen.add(generator.nextInt(max));
    }
    // Over a thousand draws every bucket should appear at least once.
    expect(seen.size).toBe(max);
  });

  test('nextInt returns 0 for non-positive bounds without consuming bias', () => {
    const generator = new SeededRng(5);
    expect(generator.nextInt(0)).toBe(0);
    expect(generator.nextInt(-3)).toBe(0);
  });

  test('nextAngle stays in [0, 2π)', () => {
    const generator = new SeededRng(13);
    for (let draw = 0; draw < 20_000; draw++) {
      const angle = generator.nextAngle();
      expect(angle).toBeGreaterThanOrEqual(0);
      expect(angle).toBeLessThan(Math.PI * 2);
    }
  });
});

test.describe('seedFromString', () => {
  test('is deterministic for the same input', () => {
    expect(seedFromString('ROOM-AB3F')).toBe(seedFromString('ROOM-AB3F'));
  });

  test('differs for different inputs', () => {
    expect(seedFromString('ROOM-AB3F')).not.toBe(seedFromString('ROOM-XY9Z'));
  });

  test('returns an unsigned 32-bit integer', () => {
    const seed = seedFromString('any room code');
    expect(seed >>> 0).toBe(seed);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
  });
});
