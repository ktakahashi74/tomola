import { createServer } from "node:http";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { createMarkdownExecutor } from "../../app/lib/markdown-budget.server.ts";
import { createShutdown } from "../../server/shutdown.ts";

const workers = new Set(), exits = [];
let terminations = 0;
const postMessage = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (...args) {
  if (!workers.has(this)) {
    workers.add(this);
    this.once("exit", code => exits.push(code));
  }
  return postMessage.apply(this, args);
};
const terminate = Worker.prototype.terminate;
Worker.prototype.terminate = function (...args) {
  terminations++;
  return terminate.apply(this, args);
};

const pool = createMarkdownExecutor({ cpuMs: 1000 });
await Promise.all([
  pool.run("renderMarkdown", ["First **ordinary** document."]),
  pool.run("renderMarkdown", ["Second **ordinary** document."]),
]);
const server = createServer();
server.listen(0, "127.0.0.1"); await once(server, "listening");
const shutdown = createShutdown({
  server, stopWorker: null, stopParsing: () => pool.stop(),
  httpGraceMs: 10_000, forceExitMs: 30_000, log: () => {},
  exit: code => {
    process.exitCode = code;
    process.send({ phase: "stopped", workers: workers.size, exits, terminations }, () => process.disconnect());
  },
});
process.once("SIGTERM", () => shutdown.handle("SIGTERM"));
process.send({ phase: "ready" });
