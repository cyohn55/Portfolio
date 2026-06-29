import { test, expect, type Page } from '@playwright/test';

/**
 * The core guarantee of lockstep multiplayer, validated against the REAL game.
 *
 * Lockstep works only if the simulation is deterministic: given the same seed,
 * the same starting units, and the same ordered stream of commands, every tick
 * must reach byte-identical state. If it does not, two peers running the same
 * inputs silently drift apart and the match desyncs.
 *
 * This test drives the actual Zustand store on `window.__rtsStore` (the same
 * dev-only handle the other gameplay specs use), runs a seeded match twice with
 * an identical scripted command at an identical tick, and asserts the two runs
 * produce identical per-tick checksums. It does not re-implement any game logic
 * or hard-code expected positions — it compares the engine against itself, so it
 * stays valid as the simulation evolves and fails loudly the moment a new source
 * of non-determinism (wall-clock time, Math.random, a random id) sneaks into the
 * tick path.
 *
 * Run from the RTS project root:
 *   npx playwright test --config="Unit Tests/playwright.config.ts" lockstep-determinism
 */

// Sim cadence matches the game's fixed-timestep tick (60 Hz).
const SIM_DT_SEC = 1 / 60;

// Long enough to exercise spawning, movement, collision separation, and combat —
// the subsystems that previously read wall-clock time or Math.random.
const TICKS_PER_RUN = 600;

// The tick at which both runs issue an identical move command, proving that
// replayed commands resolve identically (deterministic unit ids + apply timing).
const COMMAND_TICK = 120;

// A fixed seed so the comparison is reproducible run-to-run of the test itself.
const MATCH_SEED = 0x1234abcd;

// Fixed lineups so the AI roster (normally Math.random in pickRandomAnimals) can
// never differ between the two in-page runs and confound the comparison.
const FIXED_LINEUP = ['Bear', 'Fox', 'Bee'] as const;

async function openGame(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () =>
      Boolean((window as any).__rtsStore) &&
      Boolean((window as any).__rtsTerrain?.isInitialized?.()),
    undefined,
    { timeout: 30_000 }
  );
}

test.describe('lockstep determinism', () => {
  test('two seeded runs with identical commands produce identical state every tick', async ({
    page,
  }) => {
    await openGame(page);

    // Run the whole experiment inside the page so we exercise the real store and
    // never pay a round-trip per tick. Returns the per-tick checksum list for
    // each of the two runs plus the final unit count for a sanity check.
    const result = await page.evaluate(
      ({ seed, ticks, commandTick, lineup, dtSec }) => {
        const store = (window as any).__rtsStore;

        // Deterministic, position-and-identity checksum of the live simulation.
        // Includes unit id/owner/kind/hp/position, the RNG state, and the tick
        // counter, sorted by id so iteration order can never affect the hash.
        function checksum(): string {
          const state = store.getState();
          const units = [...state.units].sort((a: any, b: any) =>
            a.id < b.id ? -1 : a.id > b.id ? 1 : 0
          );
          const unitPart = units
            .map(
              (u: any) =>
                `${u.id}|${u.ownerId}|${u.kind}|${u.hp.toFixed(3)}|` +
                `${u.position.x.toFixed(3)}|${u.position.z.toFixed(3)}`
            )
            .join(';');
          return `t${state.tickCounter}#rng${state.rng.getState()}#${unitPart}`;
        }

        // Start a fresh, fully-deterministic match: fixed lineups for both sides
        // and an explicit seed (the multiplayer start handshake will pass the
        // same seed to both peers this way).
        function startSeededMatch(): void {
          store.getState().initializeGame();
          const players = store.getState().players.map((p: any) => ({
            ...p,
            animals: [...lineup],
          }));
          store.setState({ players });
          // The local lineup + pause live on useUiStore since P1-1 / T2-B; startMatch
          // reads the lineup from there to build this peer's units.
          const ui = (window as any).__rtsUiStore;
          ui.getState().chooseAnimalsForLocal([...lineup]);
          store.getState().startMatch(true, seed);
          // startMatch leaves the match paused; unpause so the tick advances.
          ui.getState().unpauseGame();
        }

        function runOnce(): string[] {
          startSeededMatch();
          const perTick: string[] = [];
          for (let tick = 1; tick <= ticks; tick++) {
            // Inject an identical command at an identical tick in both runs.
            if (tick === commandTick) {
              const state = store.getState();
              const localUnits = state.units
                .filter((u: any) => u.ownerId === state.localPlayerId && u.kind !== 'Base')
                .map((u: any) => u.id);
              store.getState().moveCommand({
                unitIds: localUnits,
                target: { x: 0, y: 0.25, z: 0 },
              });
            }
            // nowMs is overridden internally by the deterministic sim clock, so
            // the value passed here is irrelevant — pass the wall clock to prove
            // it has no effect on the outcome.
            store.getState().tick(dtSec, performance.now());
            perTick.push(checksum());
          }
          return perTick;
        }

        const runA = runOnce();
        const runB = runOnce();
        return {
          runA,
          runB,
          finalUnitCount: store.getState().units.length,
        };
      },
      {
        seed: MATCH_SEED,
        ticks: TICKS_PER_RUN,
        commandTick: COMMAND_TICK,
        lineup: FIXED_LINEUP,
        dtSec: SIM_DT_SEC,
      }
    );

    // Sanity: the match actually simulated something (units spawned over 600 ticks).
    expect(result.finalUnitCount).toBeGreaterThan(0);
    expect(result.runA).toHaveLength(TICKS_PER_RUN);
    expect(result.runB).toHaveLength(TICKS_PER_RUN);

    // The heart of the test: report the FIRST tick that diverges (far more useful
    // than a bare array mismatch), then assert full equality.
    const firstDivergence = result.runA.findIndex(
      (hash, index) => hash !== result.runB[index]
    );
    expect(
      firstDivergence,
      firstDivergence === -1
        ? 'runs are identical'
        : `runs diverged at tick ${firstDivergence + 1}:\n  A=${result.runA[firstDivergence]}\n  B=${result.runB[firstDivergence]}`
    ).toBe(-1);

    expect(result.runB).toEqual(result.runA);
  });
});
