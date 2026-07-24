// regex-worker.mjs — worker thread for safe-regex.ts
// Usage: new Worker(new URL('./regex-worker.mjs', import.meta.url), { type: 'module' })

import { parentPort } from "node:worker_threads";

parentPort?.on("message", (msg) => {
  try {
    const re = new RegExp(msg.pattern);
    const result = re.test(msg.testString);
    parentPort?.postMessage({ id: msg.id, result, error: null });
  } catch (e) {
    parentPort?.postMessage({ id: msg.id, result: false, error: e.message });
  }
});
