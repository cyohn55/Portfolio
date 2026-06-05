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
import { pilotInput } from '../monarchPilot';

// The currently-running match engine, or null in single-player / menus. A module
// singleton because there is only ever one local match in flight, and both the
// render loop and the UI need to reach it without prop-drilling through the tree.
let activeEngine: LockstepEngine | null = null;

/**
 * Begin driving the store as a lockstep multiplayer match. Installs the command
 * router (so player inputs are scheduled, not applied immediately), builds the
 * engine, and starts it. The caller (the match-start flow) must already have run
 * startMatch with the shared seed so both peers' stores are identical.
 *
 * Returns the engine so the caller can keep it for status display; the render
 * loop reaches it via getActiveNetEngine.
 */
export function startNetMatch(options: {
  transport: WebRtcTransport;
  localPlayerId: PlayerRole;
  callbacks?: LockstepCallbacks;
}): LockstepEngine {
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
  activeEngine = engine;
  engine.start();
  return engine;
}

/** The active match engine, or null. The render loop drives this when present. */
export function getActiveNetEngine(): LockstepEngine | null {
  return activeEngine;
}

/** End the multiplayer match: stop the engine and disarm the command router. */
export function stopNetMatch(): void {
  if (activeEngine) {
    activeEngine.stop();
    activeEngine = null;
  }
  setCommandRouter(null);
}
