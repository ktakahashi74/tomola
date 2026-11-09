import { parentPort, threadId } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { markdownOperations, warmMarkdownWorker } from "../../server/markdown-operations.mjs";
const control = globalThis.markdownFixtureControl ?? {};
process.on("uncaughtException", error => { console.error("Test worker failed:", error.message); process.exit(1); });
const operations = { ...markdownOperations };
if (!control.realCalibration) operations.calibrate = () => Array(10).fill(100);
// Size synthetic replies independently of Markdown input and parsing work.
if (control.resultBytes !== undefined) operations.sizedResult = () => Buffer.alloc(control.resultBytes, "x").toString("ascii");
const sleeper = new Int32Array(new SharedArrayBuffer(4));
if (control.realCalibration) warmMarkdownWorker();
if (control.startupDelayFile && fs.existsSync(control.startupDelayFile)) {
  fs.unlinkSync(control.startupDelayFile);
  // Model a pending load without blocking ESM evaluation during termination.
  await new Promise(resolve => setTimeout(resolve, control.startupDelayMs ?? 300));
}
parentPort.postMessage({ phase: "ready" });
let execution = 0;
parentPort.on("message", message => {
  if (message.type === "shutdown") { if (!control.ignoreShutdown) parentPort.close(); return; }
  const { operation, args, env } = message;
  for (const name of ["BETTER_AUTH_URL", "NODE_ENV"]) {
    if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
  }
  const baseline = process.threadCpuUsage();
  parentPort.postMessage({ phase: "started", baseline });
  if (control.operationDelayMs) Atomics.wait(sleeper, 0, 0, control.operationDelayMs);
  if (control.startedDirectory) fs.writeFileSync(path.join(control.startedDirectory, (String(args[0]).replace(/[^a-z0-9_-]/gi, "_").slice(0, 100) || "empty") + `.${threadId}.${execution++}`), "started");
  if (control.crashFile && fs.existsSync(control.crashFile) && (!control.crashOperation || operation === control.crashOperation)) {
    fs.unlinkSync(control.crashFile); process.exit(1);
  }
  if (control.wallFile && fs.existsSync(control.wallFile)) { fs.unlinkSync(control.wallFile); Atomics.wait(sleeper, 0, 0, 300); }
  const hold = operation === "hold" ? args[0] : typeof args[0] === "string" && args[0].includes("A document held by the test worker.") ? control.holdFile : null;
  while (hold && fs.existsSync(hold)) Atomics.wait(sleeper, 0, 0, 10);
  const slow = operation === "costly" || args.some(arg => typeof arg === "string" && arg.includes("A document slowed by the test worker."));
  if (slow) {
    let usage;
    do { usage = process.threadCpuUsage(baseline); } while ((usage.user + usage.system) / 1000 < (control.slowCpuMs ?? 10_000));
  }
  try {
    const value = operation === "hold" || operation === "echo" || operation === "costly" ? args[0] : operations[operation](...args);
    const usage = process.threadCpuUsage(baseline);
    parentPort.postMessage({ value, cpuMs: (usage.user + usage.system) / 1000 });
  } catch {
    const usage = process.threadCpuUsage(baseline);
    parentPort.postMessage({ error: "worker", cpuMs: (usage.user + usage.system) / 1000 });
  }
});
