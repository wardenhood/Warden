/**
 * Defense-in-depth regex safety — Layer 2: worker pool + hard timeout.
 */
import { Worker } from "node:worker_threads";

const TIMEOUT_MS = 300;
const POOL_SIZE = 2;

const WORKER_CODE = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (msg) => {
  try {
    const re = new RegExp(msg.pattern);
    parentPort.postMessage({ id: msg.id, result: re.test(msg.testString), error: null });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, result: false, error: e.message });
  }
});
`;

interface PoolWorker { worker: Worker; busy: boolean; }

const pool: PoolWorker[] = [];
const waitQueue: Array<(pw: PoolWorker) => void> = [];
let nextId = 0;

function spawnWorker(): Worker {
  return new Worker(WORKER_CODE, { eval: true });
}

/** Get a worker — returns from pool if idle, spawns new if under cap, otherwise queues. */
function getWorker(): Promise<PoolWorker> {
  return new Promise((resolve) => {
    const idle = pool.find(w => !w.busy);
    if (idle) { idle.busy = true; resolve(idle); return; }

    if (pool.length < POOL_SIZE) {
      const pw: PoolWorker = { worker: spawnWorker(), busy: true };
      pool.push(pw);
      resolve(pw);
      return;
    }

    // Pool full — queue and wait for a worker to free up
    waitQueue.push(resolve);
  });
}

function releaseWorker(pw: PoolWorker): void {
  if (waitQueue.length > 0) {
    // Hand off to next waiter immediately — no gap
    const next = waitQueue.shift()!;
    next(pw);
  } else {
    pw.busy = false;
  }
}

export function execRegex(pattern: string, testString: string): Promise<boolean> {
  return new Promise(async (resolve) => {
    const pw = await getWorker();
    const id = ++nextId;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
      pw.worker.terminate().then(() => {
        pw.worker = spawnWorker();
        releaseWorker(pw);
      });
    }, TIMEOUT_MS);

    pw.worker.once("message", (msg: { id: number; result: boolean; error: string | null }) => {
      if (msg.id !== id || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(msg.error ? false : msg.result);
      releaseWorker(pw);
    });
    pw.worker.postMessage({ id, pattern, testString });
  });
}

export async function prewarmRegexPool(): Promise<void> {
  const w: Promise<boolean>[] = [];
  for (let i = 0; i < POOL_SIZE; i++) w.push(execRegex("x", "x"));
  await Promise.all(w);
  console.log(`[safe-regex] pool warmed (${pool.length} workers, cap ${POOL_SIZE})`);
}

export async function closeRegexPool(): Promise<void> {
  await Promise.all(pool.map(p => p.worker.terminate()));
  pool.length = 0;
  waitQueue.length = 0;
}
