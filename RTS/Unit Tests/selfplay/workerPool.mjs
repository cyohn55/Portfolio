// A small fixed-size pool of evaluation workers.
//
// Single responsibility: keep N long-lived `evalWorker` threads warm (each holds
// its own sim instance) and stream a batch of independent tasks across whichever
// worker is idle, returning the results in the SAME order the tasks were given.
// It knows nothing about genomes or scoring — a task is an opaque message and a
// result is whatever the worker posts back. The pool is created once and reused
// across generations so the one-time bundle import per worker is paid only once.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = resolve(HERE, 'evalWorker.mjs');

/**
 * Spawn a pool of `size` workers, each importing the pre-built sim at `bundlePath`.
 * Resolves once every worker has reported ready (its bundle import has resolved),
 * so the first dispatched task is never dropped.
 *
 * @returns {Promise<{ runTasks: (tasks: object[]) => Promise<object[]>, close: () => Promise<void> }>}
 */
export async function createWorkerPool({ bundlePath, size }) {
  const workers = [];
  const idle = [];
  const queue = []; // pending { task, resolve, reject }
  let nextTaskId = 0;
  const inflight = new Map(); // taskId -> { resolve, reject, worker }

  function dispatch() {
    while (idle.length > 0 && queue.length > 0) {
      const worker = idle.pop();
      const job = queue.shift();
      const id = nextTaskId++;
      inflight.set(id, { ...job, worker });
      worker.postMessage({ ...job.task, id });
    }
  }

  function onResult(worker, message) {
    if (message.ready) return; // readiness handled during spawn
    const job = inflight.get(message.id);
    if (!job) return;
    inflight.delete(message.id);
    idle.push(worker);
    if (message.error) job.reject(new Error(`Worker task failed:\n${message.error}`));
    else job.resolve(message.result ?? message);
    dispatch();
  }

  await Promise.all(
    Array.from({ length: size }, () =>
      new Promise((resolveReady, rejectReady) => {
        const worker = new Worker(WORKER_ENTRY, { workerData: { bundlePath } });
        let ready = false;
        worker.on('message', (message) => {
          if (!ready && message.ready) {
            ready = true;
            workers.push(worker);
            idle.push(worker);
            resolveReady();
            return;
          }
          onResult(worker, message);
        });
        // A worker that dies fails every task it was holding and any waiting to
        // start, rather than hanging the batch forever.
        worker.on('error', (error) => {
          if (!ready) rejectReady(error);
          for (const [id, job] of inflight) {
            if (job.worker === worker) {
              job.reject(error);
              inflight.delete(id);
            }
          }
          while (queue.length > 0) queue.shift().reject(error);
        });
      }),
    ),
  );

  return {
    /** Run `tasks` in parallel; resolves to results aligned to the input order. */
    runTasks(tasks) {
      return Promise.all(
        tasks.map(
          (task) =>
            new Promise((resolveTask, rejectTask) => {
              queue.push({ task, resolve: resolveTask, reject: rejectTask });
              dispatch();
            }),
        ),
      );
    },
    async close() {
      await Promise.all(workers.map((worker) => worker.terminate()));
    },
  };
}
