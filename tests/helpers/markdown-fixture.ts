import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMarkdownExecutor } from "~/lib/markdown-budget.server";

export const SLOW_MARKDOWN = "A document slowed by the test worker.";
export const HELD_MARKDOWN = "A document held by the test worker.";
export function markdownFixture(control: Record<string, unknown> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tomola-markdown-fixture-"));
  const workerFile = path.join(directory, "worker.mjs");
  const startedDirectory = path.join(directory, "started"); fs.mkdirSync(startedDirectory);
  fs.writeFileSync(workerFile, `globalThis.markdownFixtureControl=${JSON.stringify({ ...control, ...(control.holdFile === true ? { holdFile: path.join(directory, "hold") } : {}), startedDirectory })};\nawait import(${JSON.stringify(pathToFileURL(path.resolve("tests/helpers/markdown-worker.mjs")).href)});\n`);
  return {
    directory, workerFile,
    executor: (options: Record<string, unknown> = {}) => createMarkdownExecutor({ cpuMs: 1000, workerFile, ...options }),
    marker(name: string) { const file = path.join(directory, name); fs.writeFileSync(file, "hold"); return file; },
    release(file: string) { fs.rmSync(file, { force: true }); },
    executions() { return fs.readdirSync(startedDirectory).length; },
    async started(value: string, count = 1) {
      const prefix = value.replace(/[^a-z0-9_-]/gi, "_").slice(0, 100) + ".";
      const deadline = Date.now() + 15_000;
      while (fs.readdirSync(startedDirectory).filter(name => name.startsWith(prefix)).length < count) { if (Date.now() > deadline) throw new Error("Test worker did not start"); await new Promise(resolve => setTimeout(resolve, 10)); }
    },
    remove() { fs.rmSync(directory, { recursive: true, force: true }); },
  };
}
