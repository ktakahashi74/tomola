import { afterEach, expect, it, vi } from "vitest";
import * as budget from "~/lib/markdown-budget.server";
import { aiVisibleMarkdown } from "~/lib/ai-visible-text.server";
import { markdownFixture, SLOW_MARKDOWN } from "./helpers/markdown-fixture";

const fixtures: ReturnType<typeof markdownFixture>[] = [];
const pools: ReturnType<ReturnType<typeof markdownFixture>["executor"]>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(pools.splice(0).map(pool => pool.stop()));
  fixtures.splice(0).forEach(fixture => fixture.remove());
});

it("isolates costly evidence parsing, omits rejected reads and keeps the caller responsive", async () => {
  const fixture = markdownFixture(); fixtures.push(fixture);
  const pool = fixture.executor({ cpuMs: 250 }); pools.push(pool);
  vi.spyOn(budget, "markdownTask").mockImplementation((operation, args) => pool.run(operation, args));
  expect((await aiVisibleMarkdown("**Warm evidence**")).text).toBe("Warm evidence");
  for (const preserveMath of [false, true]) {
    const source = SLOW_MARKDOWN + String(preserveMath);
    const cpu = process.threadCpuUsage();
    const work = aiVisibleMarkdown(source, preserveMath);
    await fixture.started(source);
    await new Promise(resolve => setImmediate(resolve));
    const used = process.threadCpuUsage(cpu);
    expect((used.user + used.system) / 1000).toBeLessThan(500);
    expect(await work).toEqual({ text: "", html: "" });
    expect((await aiVisibleMarkdown("Available " + preserveMath)).text).toContain("Available");
  }
  await expect(budget.withMarkdownScope("write", "writer", () => aiVisibleMarkdown(SLOW_MARKDOWN + " write"))).rejects.toMatchObject({ code: "body_too_complex" });
}, 30_000);
