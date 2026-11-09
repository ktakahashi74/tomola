import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createMarkdownExecutor, withMarkdownScope, setMarkdownExecutorForTests } from "~/lib/markdown-budget.server";
import { renderEntryOrPlain, checkBodyBudget } from "~/lib/markdown.server";
import { HELD_MARKDOWN, SLOW_MARKDOWN, markdownFixture } from "./helpers/markdown-fixture";

const fixtures: ReturnType<typeof markdownFixture>[] = [];
const pools: ReturnType<typeof createMarkdownExecutor>[] = [];
const fixture = (control: Record<string, unknown> = {}) => { const f = markdownFixture(control); fixtures.push(f); return f; };
const pool = (f: ReturnType<typeof fixture>, options: Record<string, unknown> = {}) => { const p = f.executor(options); pools.push(p); return p; };
afterEach(async () => { fixtures.forEach(f => f.remove()); await Promise.all(pools.splice(0).map(p => p.stop())); fixtures.splice(0); });

it("calibrates separate document and translation inspection budgets", async () => {
  const f = fixture();
  const p = pool(f, { cpuMs: undefined });
  expect(await p.initialize()).toBe(1200);
  expect((p as unknown as { translationCpuMs: number }).translationCpuMs).toBe(2400);
});

it("does not classify or remember worker failure and wall stops as content", async () => {
  const crashFile = path.join(fixture().directory, "crash");
  const f = fixture({ crashFile }); const p = pool(f);
  fs.writeFileSync(crashFile, "crash");
  await expect(p.run("echo", ["Ordinary input"])).rejects.toMatchObject({ status: 503 });
  expect(await p.run("echo", ["Ordinary input"])).toBe("Ordinary input");
  const wallFile = path.join(f.directory, "wall");
  const w = fixture({ wallFile }); const wp = pool(w, { wallMs: 50 });
  fs.writeFileSync(wallFile, "wall");
  await expect(wp.run("echo", ["Ordinary delayed input"])).rejects.toMatchObject({ status: 503 });
  expect(await wp.run("echo", ["Ordinary delayed input"])).toBe("Ordinary delayed input");
});

it("does not poison a body when its worker file fails to load", async () => {
  const f = fixture(); const original = fs.readFileSync(f.workerFile, "utf8");
  const p = pool(f); fs.unlinkSync(f.workerFile);
  await expect(p.run("echo", ["A normal body after a load failure"])).rejects.toMatchObject({ status: 503 });
  fs.writeFileSync(f.workerFile, original);
  expect(await p.run("echo", ["A normal body after a load failure"])).toBe("A normal body after a load failure");
});

it("does not remember a worker startup watchdog as content", async () => {
  const startupDelayFile = path.join(fixture().directory, "startup-delay");
  const f = fixture({ startupDelayFile, startupDelayMs: 6000 }); const p = pool(f, { startupMs: 3000 });
  fs.writeFileSync(startupDelayFile, "delay");
  await expect(p.run("echo", ["A normal body after a startup delay"])).rejects.toMatchObject({ status: 503 });
  fs.rmSync(startupDelayFile, { force: true });
  expect(await p.run("echo", ["A normal body after a startup delay"])).toBe("A normal body after a startup delay");
}, 20_000);

it("does not save a shutdown grace timeout as a permanent rendering", async () => {
  const holdFile = fixture().marker("hold-render");
  const f = fixture({ holdFile }); const p = pool(f, { shutdownMs: 50 });
  await setMarkdownExecutorForTests(p);
  const rendering = renderEntryOrPlain(HELD_MARKDOWN); await f.started(HELD_MARKDOWN);
  await p.stop();
  expect(await rendering).toMatchObject({ cacheable: false });
});

it("does not save transient fallback as a successful rendering", async () => {
  const crashFile = path.join(fixture().directory, "crash");
  const f = fixture({ crashFile }); const p = pool(f); await setMarkdownExecutorForTests(p);
  fs.writeFileSync(crashFile, "crash");
  const rendered = await renderEntryOrPlain("Ordinary **input**.");
  expect(rendered.cacheable).toBe(false);
  expect((await renderEntryOrPlain("Ordinary **input**.")).html).toContain("<strong>input</strong>");
});

it("waits for accepted operations before shutdown instead of killing them", async () => {
  const f = fixture(); const p = pool(f, { shutdownMs: 1000 });
  const held = f.marker("shutdown");
  const running = p.run("hold", [held]); await f.started(held);
  const stopped = p.stop();
  f.release(held);
  expect(await running).toBe(held); await stopped;
});

it("leaves a blocked member waiting and wakes the next eligible member", async () => {
  const f = fixture(); const p = pool(f, { readWaitMs: 1500 });
  const one = f.marker("one"), two = f.marker("two");
  const a = withMarkdownScope("read", "M", () => p.run("hold", [one])); await f.started(one);
  const b = withMarkdownScope("read", "N", () => p.run("hold", [two])); await f.started(two);
  const blocked = withMarkdownScope("read", "M", () => p.run("echo", ["M next"])).then(value => ({ value }), error => ({ error }));
  const eligible = withMarkdownScope("read", "N", () => p.run("echo", ["N next"])).then(value => ({ value }), error => ({ error }));
  f.release(two); await b;
  expect(await eligible).toEqual({ value: "N next" });
  f.release(one); await a;
  expect(await blocked).toEqual({ value: "M next" });
});

it("lets a foreground write wait briefly for a free worker", async () => {
  const f = fixture(); const p = pool(f, { writeWaitMs: 1000 });
  const one = f.marker("one"), two = f.marker("two");
  const a = p.run("hold", [one]); await f.started(one);
  const b = p.run("hold", [two]); await f.started(two);
  const write = withMarkdownScope("write", "writer", () => p.run("echo", ["A post"])).then(value => ({ value }), error => ({ error }));
  setTimeout(() => f.release(one), 100);
  expect(await write).toEqual({ value: "A post" }); await a;
  f.release(two); await b;
});

it("background work waits beyond the read deadline without omitting mentions", async () => {
  const f = fixture(); const p = pool(f, { backgroundWaitMs: 2000 }); await setMarkdownExecutorForTests(p);
  const one = f.marker("one"), two = f.marker("two");
  const a = p.run("hold", [one]); await f.started(one);
  const b = p.run("hold", [two]); await f.started(two);
  const result = withMarkdownScope("background" as "read", undefined, async () => (await import("~/lib/mentions-md.server")).mentionSpellings("Hello @hana."));
  setTimeout(() => f.release(one), 400);
  expect(await result).toEqual(["@hana"]); await a;
  f.release(two); await b;
});

it("keeps persisted derivatives strict for transient worker failure", async () => {
  const crashFile = path.join(fixture().directory, "crash");
  const f = fixture({ crashFile }); const p = pool(f); await setMarkdownExecutorForTests(p);
  fs.writeFileSync(crashFile, "crash");
  const api = await import("~/lib/markdown-budget.server") as unknown as { withMarkdownRestore: <T>(work: () => T) => T };
  expect(typeof api.withMarkdownRestore).toBe("function");
  await expect(api.withMarkdownRestore(async () => (await import("~/lib/entry-references.server")).parseEntryReferences("A [discussion](/t/1)."))).rejects.toMatchObject({ status: 503 });
});

it("imports fixed site documents without creating a worker", async () => {
  vi.resetModules();
  const markdown = await import("~/lib/markdown.server");
  const spy = vi.spyOn(markdown, "renderMarkdown");
  try {
    await import("~/lib/why.server"); await import("~/lib/name.server"); await import("~/lib/principles.server");
    expect(spy).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});

it("does not depend on the caller's working directory to find its worker", async () => {
  const module = path.resolve("app/lib/markdown-budget.server.ts");
  const code = `const {createMarkdownExecutor}=await import(${JSON.stringify(module)}); const p=createMarkdownExecutor({cpuMs:1000}); console.log(await p.run('renderMarkdown',['Ordinary text.'])); await p.stop();`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e", code], { cwd: "/tmp", timeout: 20_000, env: { ...process.env, GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "" } });
  expect(stdout).toContain("Ordinary text.");
}, 25_000);

it("interprets mappings in the worker and refuses duplicate keys without saving a result", async () => {
  const f = fixture(), p = pool(f);
  expect(await p.run("parseMapping", ["lang: ja\nkind: topic"])).toEqual({ ok: true, data: { lang: "ja", kind: "topic" } });
  expect(await p.run("parseMapping", ["lang: ja\nlang: en"])).toEqual({ ok: false, error: "invalid_frontmatter" });
});

it("reports a bounded worker stop while preserving capacity for a later ordinary operation", async () => {
  const f = fixture({ slowCpuMs: 200 }), p = pool(f, { cpuMs: 50 });
  await expect(p.run("admitMarkdown", [SLOW_MARKDOWN])).rejects.toMatchObject({ code: "body_too_complex" });
  expect(await p.run("renderMarkdown", ["Ordinary text."])).toContain("Ordinary text.");
});
