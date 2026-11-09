import { parentPort } from "node:worker_threads";
import { serialize } from "node:v8";
import { markdownOperations as operations, warmMarkdownWorker } from "./markdown-operations-core.mjs";
warmMarkdownWorker();
parentPort.postMessage({ phase: "ready" });
parentPort.on("message", message => {
  if (message.type === "shutdown") { parentPort.close(); return; }
  const { operation, args, env } = message;
  for (const name of ["BETTER_AUTH_URL", "NODE_ENV"]) {
    if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
  }
  const baseline = process.threadCpuUsage();
  parentPort.postMessage({ phase: "started", baseline });
  try {
    const value = operations[operation](...args);
    if (serialize(value).length > 4 * 1024 * 1024) throw new Error("Output exceeds worker transfer budget");
    const cpu = process.threadCpuUsage(baseline);
    parentPort.postMessage({ value, cpuMs: (cpu.user + cpu.system) / 1000 });
  } catch {
    const cpu = process.threadCpuUsage(baseline);
    parentPort.postMessage({ error: "worker", cpuMs: (cpu.user + cpu.system) / 1000 });
  }
});
