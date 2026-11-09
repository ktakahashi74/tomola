import { fork } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createMarkdownExecutor } from "~/lib/markdown-budget.server";
import { markdownFixture } from "./helpers/markdown-fixture";

it("lets both idle Markdown workers exit normally without termination", async () => {
  const pool = createMarkdownExecutor({ cpuMs: 1000 });
  const messages = vi.spyOn(Worker.prototype, "postMessage");
  const terminate = vi.spyOn(Worker.prototype, "terminate");
  try {
    await Promise.all([
      pool.run("renderMarkdown", ["First **ordinary** document."]),
      pool.run("renderMarkdown", ["Second **ordinary** document."]),
    ]);
    const workers = [...new Set(messages.mock.contexts)] as Worker[];
    expect(workers).toHaveLength(2);
    const exits = workers.map(worker => once(worker, "exit").then(([code]) => code));
    // Worker exit events are real; the fallback deadline cannot decide this test.
    vi.useFakeTimers();
    const stopped = pool.stop();
    expect(pool.stop()).toBe(stopped);
    await stopped;
    expect(await Promise.all(exits)).toEqual([0, 0]);
    expect(workers.every(worker => worker.threadId === -1)).toBe(true);
    expect(terminate).not.toHaveBeenCalled();
    expect(messages.mock.calls.filter(([message]) => message.type === "shutdown")).toHaveLength(2);
    await expect(pool.run("renderMarkdown", ["After shutdown."])).rejects.toMatchObject({ reason: "shutdown" });
  } finally {
    vi.useRealTimers();
    messages.mockRestore(); terminate.mockRestore();
    await pool.stop();
  }
}, 20_000);

it("only forces an unresponsive shutdown after the exit grace expires", async () => {
  const fixture = markdownFixture({ ignoreShutdown: true });
  const pool = fixture.executor();
  const terminate = vi.spyOn(Worker.prototype, "terminate");
  try {
    expect(await pool.run("echo", ["Ordinary input."])).toBe("Ordinary input.");
    vi.useFakeTimers();
    const stopped = pool.stop();
    await vi.advanceTimersByTimeAsync(1999);
    expect(terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(terminate).toHaveBeenCalledTimes(1);
  } finally {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();
    terminate.mockRestore();
    await pool.stop(); fixture.remove();
  }
}, 20_000);

it("drains Markdown workers on SIGTERM and lets the server process exit normally", async () => {
  const child = fork(path.resolve("tests/helpers/markdown-shutdown.mjs"), {
    execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")],
    silent: true, timeout: 20_000,
    env: { ...process.env, GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "" },
  });
  const messages: unknown[] = [];
  let stderr = "";
  child.stderr?.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Shutdown fixture exited before readiness: " + stderr)));
      child.on("message", message => {
        messages.push(message);
        if ((message as { phase?: string }).phase === "ready") resolve();
      });
    });
    expect(child.kill("SIGTERM")).toBe(true);
    expect(await exited, stderr).toEqual({ code: 0, signal: null });
    expect(messages).toContainEqual({ phase: "stopped", workers: 2, exits: [0, 0], terminations: 0 });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}, 25_000);
