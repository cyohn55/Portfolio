// Evaluation worker: scores one (genome, opponent) matchup on its own isolated
// simulation instance, so many such evaluations run in parallel across threads.
//
// Single responsibility: own one sim instance and turn task messages into mean
// scores. It imports the pre-built sim bundle (path in workerData) exactly once,
// giving this thread its private module registry — its `useGameStore` singleton is
// independent of every other worker's, which is what makes parallel matches safe.
// Everything it computes is deterministic (seeded per match), so a result never
// depends on which worker ran it or in what order.

import { parentPort, workerData } from 'node:worker_threads';
import { evaluate, resolveScorer } from './selfPlay.mjs';
import { makeCommanderPolicy } from './policies.mjs';
import { makeOpponentByName } from './opponents.mjs';
import { decodeGenome } from './commanderGenome.mjs';

if (!parentPort) throw new Error('evalWorker must be run as a worker thread');

// Import the already-bundled sim once; reused for every task this worker handles.
const api = await import(workerData.bundlePath);

parentPort.on('message', (task) => {
  try {
    const { meanScore } = evaluate({
      api,
      makeSubject: () => makeCommanderPolicy(decodeGenome(task.genome)),
      makeOpponent: () => makeOpponentByName(task.opponentName),
      seeds: task.seeds,
      maxTicks: task.maxTicks,
      scorer: resolveScorer(task.scoringMode ?? 'margin'),
    });
    parentPort.postMessage({ id: task.id, meanScore });
  } catch (error) {
    parentPort.postMessage({ id: task.id, error: error?.stack ?? String(error) });
  }
});

// Signal readiness only after the (async) bundle import resolves, so the pool
// never dispatches a task before this worker can serve it.
parentPort.postMessage({ ready: true });
