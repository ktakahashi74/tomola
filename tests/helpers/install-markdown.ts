import { beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { createMarkdownExecutor, setMarkdownExecutorForTests, stopMarkdown } from "~/lib/markdown-budget.server";

// The CPU budget is deterministic in unit tests; production calibrates at startup.
beforeAll(() => setMarkdownExecutorForTests(createMarkdownExecutor({ cpuMs: 1000, workerFile: fileURLToPath(new URL("./markdown-worker.mjs", import.meta.url)) })));
afterAll(() => stopMarkdown());
