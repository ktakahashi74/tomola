import { afterEach, expect, it } from "vitest";
import { withMarkdownRead, withMarkdownScope } from "~/lib/markdown-budget.server";
import { markdownFixture } from "./helpers/markdown-fixture";

const fixtures: ReturnType<typeof markdownFixture>[] = [];
const pools: ReturnType<ReturnType<typeof markdownFixture>["executor"]>[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.stop()));
  fixtures.splice(0).forEach(fixture => fixture.remove());
});
function setup() {
  const fixture = markdownFixture({ operationDelayMs: 10 }); fixtures.push(fixture);
  const pool = fixture.executor({ readWaitMs: 25 }); pools.push(pool);
  return { fixture, pool };
}

it("keeps a page's parallel row and reply operations outside its own admission deadline", async () => {
  const { pool } = setup(); await pool.run("echo", ["Warm"]);
  for (const count of [30, 60]) {
    const inputs = Array.from({ length: count }, (_, i) => `**Page ${count}, item ${i}**.`);
    const result = await withMarkdownScope("read", "reader", () => Promise.all(inputs.map(value =>
      withMarkdownRead(() => pool.run<string>(count === 30 ? "renderMarkdown" : "headlineFromBody", [value])))));
    if (count === 30) result.forEach((html, i) => expect(html).toContain(`<strong>Page ${count}, item ${i}</strong>`));
    else expect(result).toEqual(inputs.map((_, i) => `Page ${count}, item ${i}.`));
  }
});

it("still bounds a separate request from the same member and serves another member", async () => {
  const { fixture, pool } = setup(); await pool.run("echo", ["Warm"]);
  const held = fixture.marker("request");
  const active = withMarkdownScope("read", "reader", () => pool.run("hold", [held])); await fixture.started(held);
  await expect(withMarkdownScope("read", "reader", () => pool.run("echo", ["Separate request"]))).rejects.toMatchObject({ status: 503 });
  expect(await withMarkdownScope("read", "another", () => pool.run("echo", ["Other member"]))).toBe("Other member");
  fixture.release(held); await active;
});

it("waits only once per read response and permits a fresh request after the pool recovers", async () => {
  const { fixture, pool } = setup(); await pool.run("echo", ["Warm"]);
  const one = fixture.marker("one"), two = fixture.marker("two");
  const first = pool.run("hold", [one]); await fixture.started(one);
  const second = pool.run("hold", [two]); await fixture.started(two);
  try {
    await withMarkdownScope("read", "reader", async () => {
      await expect(pool.run("echo", ["First wait"])).rejects.toMatchObject({ status: 503 });
      fixture.release(one); fixture.release(two); await Promise.all([first, second]);
      // The pool is available now: further uncached work still uses this response's fallback.
      for (const value of ["Row", "Reply", "Headline"]) await expect(withMarkdownRead(() => pool.run("echo", [value]))).rejects.toMatchObject({ status: 503 });
      expect(await pool.run("echo", ["Warm"])).toBe("Warm");
    });
    expect(await withMarkdownScope("read", "reader", () => pool.run("echo", ["Next response"]))).toBe("Next response");
    expect(await withMarkdownScope("write", "reader", () => pool.run("echo", ["Write"]))).toBe("Write");
  } finally { fixture.release(one); fixture.release(two); await Promise.all([first, second]); }
});
