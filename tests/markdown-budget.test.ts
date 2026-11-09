import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { createMarkdownExecutor, MARKDOWN_LIMITS, withMarkdownScope } from "~/lib/markdown-budget.server";
import { markdownSpecimen } from "~/lib/markdown-specimen";
import { denseMarkdown } from "./helpers/markdown-dense";
import { markdownFixture, HELD_MARKDOWN, SLOW_MARKDOWN } from "./helpers/markdown-fixture";

type Executor = ReturnType<typeof createMarkdownExecutor>;
const pools: Executor[] = [];
const fixtures: ReturnType<typeof markdownFixture>[] = [];
const pool = (options: Parameters<typeof createMarkdownExecutor>[0] = { cpuMs: 250 }) => {
  const created = createMarkdownExecutor(options); pools.push(created); return created;
};
const controlled = (options: Record<string, unknown> = { cpuMs: 250 }, control: Record<string, unknown> = {}) => {
  const f = markdownFixture(control); fixtures.push(f);
  return { f, executor: pool({ ...options, workerFile: f.workerFile }) };
};
afterEach(async () => {
  fixtures.forEach(f => f.remove());
  await Promise.all(pools.splice(0).map(item => item.stop())); fixtures.splice(0);
});

describe("isolated Markdown processing", () => {
  it("counts concurrent same-key completions once and evicts only when actual cached bytes exceed the limit", async () => {
    const resultBytes = 3 * 1024 * 1024;
    const { f, executor } = controlled({ cpuMs: 1000 }, { holdFile: true, resultBytes });
    const hold = f.marker("hold");
    const text = HELD_MARKDOWN;
    const first = executor.run<string>("sizedResult", [text]);
    const second = executor.run<string>("sizedResult", [text]);
    await f.started(text, 2);
    f.release(hold);
    const [rendered, duplicate] = await Promise.all([first, second]);
    expect(rendered).toHaveLength(resultBytes);
    expect(duplicate).toBe(rendered);
    const other = "Another cached result.";
    expect(await executor.run("sizedResult", [other])).toBe(rendered);
    const completed = f.executions();
    expect(await executor.run("sizedResult", [text])).toBe(rendered);
    expect(await executor.run("sizedResult", [other])).toBe(rendered);
    expect(f.executions()).toBe(completed);
    const third = "A third cached result.";
    await executor.run("sizedResult", [third]);
    const afterEviction = f.executions();
    await executor.run("sizedResult", [other]);
    expect(f.executions()).toBe(afterEviction);
    await executor.run("sizedResult", [text]);
    expect(f.executions()).toBe(afterEviction + 1);
  }, 30_000);

  it("keeps the entry limit and does not retain an oversized single result", async () => {
    const { f, executor } = controlled({ cpuMs: 250 }, { resultBytes: MARKDOWN_LIMITS.cacheBytes + 1 });
    for (let i = 0; i <= MARKDOWN_LIMITS.cacheEntries; i++) await executor.run("echo", [`entry-${i}`]);
    const filled = f.executions();
    await executor.run("echo", ["entry-1"]);
    expect(f.executions()).toBe(filled);
    await executor.run("echo", ["entry-0"]);
    expect(f.executions()).toBe(filled + 1);
    const oversized = "An oversized result.";
    expect(await executor.run("sizedResult", [oversized])).toHaveLength(MARKDOWN_LIMITS.cacheBytes + 1);
    await executor.run("sizedResult", [oversized]);
    expect(f.executions()).toBe(filled + 3);
  }, 30_000);

  it("keeps completion CPU accounting without parent CPU sampling", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, "cpuUsage")!;
    Object.defineProperty(Worker.prototype, "cpuUsage", { ...descriptor, value: undefined });
    try {
      const { executor } = controlled({ cpuMs: 50 }, { slowCpuMs: 100 });
      expect(await executor.run("echo", ["Ordinary text."])).toBe("Ordinary text.");
      await expect(executor.run("costly", ["Simulated costly work"])).rejects.toMatchObject({ code: "body_too_complex" });
      expect(await executor.run("echo", ["After recovery."])).toBe("After recovery.");
    } finally { Object.defineProperty(Worker.prototype, "cpuUsage", descriptor); }
  }, 20_000);

  it("rejects controlled CPU-heavy operations and keeps the caller responsive", async () => {
    const { executor } = controlled();
    for (const name of ["first rejection", "repeated rejection"]) {
      const cpu = process.threadCpuUsage();
      const costly = expect(executor.run("renderMarkdown", [SLOW_MARKDOWN + " " + name])).rejects.toMatchObject({ code: "body_too_complex" });
      await new Promise(resolve => setImmediate(resolve));
      const used = process.threadCpuUsage(cpu);
      expect((used.user + used.system) / 1000).toBeLessThan(500);
      await costly;
      expect(await executor.run("renderMarkdown", ["A short post."])).toContain("A short post.");
    }
  }, 30_000);

  it("accepts maximum ordinary specimens and preserves rendering with a cached parse", async () => {
    const executor = pool({ cpuMs: 1000 });
    for (const lang of ["en", "ja"] as const) {
      const source = markdownSpecimen(lang);
      expect(source.length).toBe(50_000);
      const options = { lang, idPrefix: "p-7-", headingIdPrefix: "p-7-" };
      const original = await executor.run("renderUncachedMarkdown", [source, options]);
      expect(await executor.run("renderMarkdown", [source, options])).toBe(original);
    }
    const source = "> @hana quoted\n\n**「根拠」** [link](https://example.org) @hana \x60@hana\x60\n\n$x^2$\n\nNote[^n]\n\n[^n]: Text\n";
    const options = { lang: "ja", idPrefix: "p-9-", mentions: new Map([["hana", { handle: "hana", userId: "member", publicId: "testmember01" }]]) };
    const original = await executor.run("renderUncachedMarkdown", [source, options]);
    expect(await executor.run("renderMarkdown", [source, options])).toBe(original);
  }, 20_000);

  it("calibrates from the workload and clamps both budgets", async () => {
    const executor = pool({});
    const calibrated = await executor.initialize();
    expect(calibrated).toBeGreaterThanOrEqual(MARKDOWN_LIMITS.minCpuMs);
    expect(calibrated).toBeLessThanOrEqual(MARKDOWN_LIMITS.maxCpuMs);
    expect(executor.translationCpuMs).toBeGreaterThanOrEqual(MARKDOWN_LIMITS.minTranslationCpuMs);
    expect(executor.translationCpuMs).toBeLessThanOrEqual(MARKDOWN_LIMITS.maxTranslationCpuMs);
    const ordinary = await Promise.all((["en", "ja"] as const).map(lang =>
      withMarkdownScope("write", "ordinary-" + lang, () => executor.run("admitMarkdown", [markdownSpecimen(lang)]))));
    expect(ordinary).toEqual([null, null]);
    for (const lang of ["en", "ja"] as const) expect(await executor.run("admitMarkdown", [denseMarkdown(lang)])).toBeNull();
    const inspected = await executor.run<{ flags: string[] }>("inspectTranslation", [{ text: denseMarkdown("en"), from: "en", to: "ja", glossary: [] }, denseMarkdown("ja"), "fake"]);
    expect(inspected.flags).not.toContain("body_too_complex");
  }, 60_000);

  it("bounds concurrent work per member while another member can run", async () => {
    const { f, executor } = controlled({ cpuMs: 250, writeWaitMs: 50 });
    const held = f.marker("member");
    const first = withMarkdownScope("write", "member-a", () => executor.run("hold", [held]));
    await f.started(held);
    await expect(withMarkdownScope("write", "member-a", () => executor.run("echo", ["Second request."]))).rejects.toMatchObject({ status: 503 });
    expect(await withMarkdownScope("write", "member-b", () => executor.run("echo", ["Other member."]))).toBe("Other member.");
    f.release(held); await first;
  }, 20_000);

  it("bounds the read queue and caches CPU-rejected anonymous reads", async () => {
    const { executor } = controlled();
    await expect(executor.run("renderMarkdown", [SLOW_MARKDOWN])).rejects.toMatchObject({ code: "body_too_complex" });
    await Promise.all(Array.from({ length: MARKDOWN_LIMITS.readQueue + 5 }, () => expect(executor.run("renderMarkdown", [SLOW_MARKDOWN])).rejects.toMatchObject({ code: "body_too_complex" })));
    const flood = await Promise.all(Array.from({ length: MARKDOWN_LIMITS.readQueue + MARKDOWN_LIMITS.workers + 5 }, (_, i) =>
      executor.run("renderMarkdown", [SLOW_MARKDOWN + " " + i]).then(() => null, error => error)));
    expect(flood.some(error => error?.status === 503)).toBe(true);
    expect(await executor.run("renderMarkdown", ["Still available."])).toContain("Still available.");
  }, 20_000);
});
