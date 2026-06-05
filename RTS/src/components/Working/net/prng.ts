// Deterministic, serializable pseudo-random number generator.
//
// Single responsibility: produce a reproducible stream of pseudo-random numbers
// from a numeric seed, with state that can be read and restored. This is the
// foundation of lockstep multiplayer: both peers seed an identical generator and
// advance it in identical order, so every "random" decision in the simulation
// (spawn jitter, knockback escape headings, swarm coin-flips, AI think offsets)
// resolves the same way on both machines without sending any of those results
// over the network.
//
// Why mulberry32: it is a tiny, fast, well-distributed 32-bit generator whose
// entire state is a single 32-bit integer. That makes it trivial to checksum and
// to include in a desync hash, and trivial to serialize in a "start match"
// handshake. It is NOT cryptographically secure — and must never be used for
// anything security-sensitive — but match RNG has no such requirement.

/**
 * A reproducible PRNG whose full state is one 32-bit unsigned integer.
 *
 * Determinism contract: two SeededRng instances constructed from the same seed
 * return byte-identical sequences from `next()` for as long as they are advanced
 * the same number of times. Callers MUST therefore advance every instance in the
 * same order across peers — this is the caller's responsibility, not the RNG's.
 */
export class SeededRng {
  // Held as an unsigned 32-bit integer at all times (every mutation re-coerces
  // with `>>> 0`) so getState()/setState() round-trip exactly and the desync
  // checksum sees a stable, platform-independent value.
  private internalState: number;

  constructor(seed: number) {
    this.internalState = seed >>> 0;
  }

  /**
   * Advance the generator and return the next value in the half-open range
   * [0, 1). This is the single primitive every other helper builds on, so
   * advancing it is what keeps two peers' streams aligned.
   */
  next(): number {
    this.internalState = (this.internalState + 0x6d2b79f5) | 0;
    let mixed = this.internalState;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  }

  /** Next value in [0, max). */
  nextFloat(max: number): number {
    return this.next() * max;
  }

  /** Next integer in [0, maxExclusive). Returns 0 when maxExclusive <= 0. */
  nextInt(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    return Math.floor(this.next() * maxExclusive);
  }

  /** Next angle in radians, uniformly distributed in [0, 2π). */
  nextAngle(): number {
    return this.next() * Math.PI * 2;
  }

  /**
   * Read the generator's full internal state. Used both to seed the desync
   * checksum and to snapshot the RNG for replays/resyncs.
   */
  getState(): number {
    return this.internalState >>> 0;
  }

  /** Restore a previously read state (e.g. when resyncing from a snapshot). */
  setState(state: number): void {
    this.internalState = state >>> 0;
  }
}

/**
 * Derive a 32-bit seed from an arbitrary string (e.g. a room code) using an
 * FNV-1a hash. Deterministic across machines so two peers that agree on a code
 * also agree on a starting seed without a separate exchange. Match start still
 * broadcasts an explicit numeric seed, but this is handy for tests and for
 * deriving secondary streams.
 */
export function seedFromString(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    // FNV prime multiply, kept in 32-bit range via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
