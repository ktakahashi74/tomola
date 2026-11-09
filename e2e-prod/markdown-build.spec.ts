import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { expect, test } from "@playwright/test";

test("compiled Markdown worker renders without source modules or runtime transpilation", async () => {
  const entry = pathToFileURL(path.resolve("server/markdown-worker.mjs")).href;
  const worker = new Worker(new URL("data:text/javascript," + encodeURIComponent(`
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      if (/tsx|esbuild|\\.tsx?(?:$|\\?)/.test(specifier)) throw new Error("Runtime source loading: " + specifier);
      return next(specifier, context);
    } });
    await import(${JSON.stringify(entry)});
  `)), { execArgv: [], env: { ...process.env, NODE_ENV: "production" } });
  const exit = new Promise<number>(resolve => worker.once("exit", resolve));
  try {
    expect((await once(worker, "message"))[0]).toEqual({ phase: "ready" });
    async function run(operation: string, args: unknown[]) {
      return new Promise<unknown>((resolve, reject) => {
        const fail = (error: Error) => { worker.off("message", reply); reject(error); };
        const reply = (value: { phase?: string; error?: string; cpuMs?: number; value?: unknown }) => {
          if (value.phase) return;
          worker.off("message", reply); worker.off("error", fail);
          if (value.error) reject(new Error(value.error));
          else { expect(value.cpuMs).toBeGreaterThanOrEqual(0); resolve(value.value); }
        };
        worker.on("message", reply); worker.once("error", fail);
        worker.postMessage({ operation, args, env: { NODE_ENV: "production", BETTER_AUTH_URL: "https://localhost" } });
      });
    }
    const image = `/media/${"a".repeat(64)}-320x180.webp`;
    const source = `# A title\n\n**Body** $x$[^1].\n\n![Diagram](${image})\n\n[^1]: A note.`;
    const html = await run("renderMarkdown", [source, { lang: "en" }]);
    expect(html).toContain("A title</h1>");
    expect(html).toContain("<strong>Body</strong>");
    expect(html).toContain('class="katex"');
    expect(html).toContain("data-footnotes");
    expect(html).toContain(image);
    expect(await run("headlineFromBody", ["**A title**\n\nBody"])).toBe("A title");
    const markdown = await run("offlineMarkdown", [source, { page: "index.md", lang: "en", extension: "md", origin: "https://localhost", posts: new Map(), documents: new Set(), media: new Map([["a".repeat(64), "media/diagram.webp"]]) }]);
    expect(markdown).toContain("**Body** $x$");
    expect(markdown).toContain("media/diagram.webp");
    const calibration = await run("calibrate", []);
    expect(calibration).toHaveLength(10);
    expect((calibration as number[]).every(value => Number.isFinite(value) && value >= 0)).toBe(true);
    worker.postMessage({ type: "shutdown" });
    expect(await exit).toBe(0);
  } finally {
    if (worker.threadId !== -1) await worker.terminate();
  }
});
