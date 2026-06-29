// Orchestrates a live multiplayer match: the glue between the game store and the
// lockstep engine.
//
// Single responsibility: stand up (and tear down) one LockstepEngine wired to the
// real simulation, and hold it as the active match so the render loop (HexGrid)
// can drive it and the UI can observe it. This is the one module that depends on
// BOTH the store and the engine; keeping that dependency here lets state.ts stay
// unaware of the engine and lockstep.ts stay unaware of the store.

import {
  useGameStore,
  applyNetCommand,
  computeStateChecksum,
  setCommandRouter,
} from '../../../game/state';
import {
  LockstepEngine,
  FIXED_DT_SEC,
  type LockstepSimAdapter,
  type LockstepCallbacks,
} from './lockstep';
import type { WebRtcTransport } from './webrtcTransport';
import type { PlayerRole, NetCommand } from './netMessages';
import type { AnimalId } from '../../../game/types';
import { pilotInput } from '../monarchPilot';
import {
  isWorkerFlagEnabled,
  requestNetMatchStart,
  runNetUpdate,
  stopNetMatchInWorker,
} from '../sim/simWorkerBridge';

/**
 * What the render loop needs from the active match: a per-frame `update`. Both the in-thread
 * LockstepEngine and the worker proxy satisfy it, so HexGrid drives either unchanged.
 */
export interface ActiveNetEngine {
  update(realDtMs: number): void;
}

// The currently-running match engine (or worker proxy), or null in single-player / menus. A
// module singleton because there is only ever one local match in flight, and both the render
// loop and the UI need to reach it without prop-drilling through the tree.
let activeEngine: ActiveNetEngine | null = null;
// True when the active match is driven by the worker (lockstep runs off-thread), so teardown
// routes to the worker bridge rather than a local engine.
let usingWorkerNet = false;

/**
 * Begin driving the store as a lockstep multiplayer match. The caller (the match-start flow)
 * must already have run startMultiplayerMatch with the shared seed so both peers' stores are
 * identical.
 *
 * Under the worker flip flag the lockstep engine runs INSIDE the worker (alongside the sim);
 * this latches the match for the bridge to adopt once terrain is ready and returns a proxy
 * whose `update` drives the worker engine. Otherwise it builds the in-thread engine as before.
 * Either way the render loop reaches the result via getActiveNetEngine.
 */
export function startNetMatch(options: {
  transport: WebRtcTransport;
  localPlayerId: PlayerRole;
  seed: number;
  lineups: Record<PlayerRole, AnimalId[]>;
  callbacks?: LockstepCallbacks;
}): ActiveNetEngine {
  if (isWorkerFlagEnabled()) {
    // Worker flip: the lockstep engine runs in the worker. Latch the match for the bridge to
    // adopt once terrain is ready; return a proxy whose update() drives the worker engine.
    requestNetMatchStart({
      role: options.localPlayerId,
      seed: options.seed,
      lineups: options.lineups,
      transport: options.transport,
      callbacks: options.callbacks ?? {},
    });
    usingWorkerNet = true;
    activeEngine = { update: (realDtMs: number) => runNetUpdate(realDtMs) };
    return activeEngine;
  }

  // The adapter is the engine's view of the simulation. runTick passes a wall
  // clock to store.tick, but the store overrides it with its deterministic
  // tick-derived clock, so the value is irrelevant to the outcome — it only
  // satisfies the signature.
  const adapter: LockstepSimAdapter = {
    applyCommand: (playerId: PlayerRole, command: NetCommand) =>
      applyNetCommand(playerId, command),
    runTick: () => useGameStore.getState().tick(FIXED_DT_SEC, performance.now()),
    checksum: () => computeStateChecksum(),
    // The local player's live monarch-drive vector. The input layer (camera/
    // keyboard/controller) writes pilotInput only while the local player is
    // piloting and zeroes it otherwise, so this is a no-op vector when idle.
    sampleLocalPilot: () => pilotInput.getMove(),
  };

  const engine = new LockstepEngine({
    transport: options.transport,
    adapter,
    localPlayerId: options.localPlayerId,
    callbacks: options.callbacks,
  });

  // From now until stopNetMatch, every routed store action feeds the engine
  // instead of mutating immediately.
  setCommandRouter((command) => engine.enqueueLocalCommand(command));
  usingWorkerNet = false;
  activeEngine = engine;
  engine.start();
  return engine;
}

/** The active match engine (or worker proxy), or null. The render loop drives this when present. */
export function getActiveNetEngine(): ActiveNetEngine | null {
  return activeEngine;
}

/** End the multiplayer match: stop the engine (in-thread or worker) and disarm command routing. */
export function stopNetMatch(): void {
  if (usingWorkerNet) {
    stopNetMatchInWorker();
  } else {
    (activeEngine as LockstepEngine | null)?.stop();
    setCommandRouter(null);
  }
  activeEngine = null;
  usingWorkerNet = false;
}
