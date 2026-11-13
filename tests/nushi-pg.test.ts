import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { PG_MODE } from "./helpers/pg-test";
import { nushiFixture } from "./helpers/nushi";
import { createReply } from "~/lib/entries.server";
import { entries, nushiAnswers, nushiRequests, nushiReservations } from "~/lib/db/schema";
import { processNushiRequest, resolveNushiCompleter } from "~/lib/nushi.server";
import { getMonthlyCostMicro, NUSHI_USAGE_PURPOSES, reserveUsage } from "~/lib/llm/usage.server";

afterEach(() => vi.unstubAllEnvs());
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const pg = it.skipIf(!PG_MODE);
pg("serializes duplicate claims across PostgreSQL connections", async () => {
  const f = await nushiFixture(), entered = latch(), release = latch(), fake = resolveNushiCompleter();
  const complete = vi.fn(async (req: Parameters<typeof fake.complete>[0]) => { entered.resolve(); await release.promise; return fake.complete(req); });
  const first = processNushiRequest(f.db, f.request.id, { completer: { ...fake, complete } });
  await entered.promise;
  try { await expect(processNushiRequest(f.db, f.request.id)).rejects.toMatchObject({ name: "DeferJob" }); }
  finally { release.resolve(); }
  await first;
  expect(complete).toHaveBeenCalledTimes(1); expect(await f.db.select().from(nushiAnswers)).toHaveLength(1);
});
pg("reserves a member allowance before parallel requests can both use it", async () => {
  const f = await nushiFixture();
  const second = await createReply(f.db, "nushi-caller", f.topic, { body: "@nushi orchard", lang: "en" });
  if (!second.ok) throw new Error(second.error);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, second.id));
  const env = { ...process.env, VILLAGE_NUSHI_MEMBER_DAILY_LIMIT: "1" };
  await Promise.all([processNushiRequest(f.db, f.request.id, { env }), processNushiRequest(f.db, request.id, { env })]);
  expect(await f.db.select().from(nushiAnswers)).toHaveLength(1);
  expect((await f.db.select().from(nushiRequests)).map(row => row.state).sort()).toEqual(["answered", "failed"]);
});
pg("enforces a global concurrent allowance without holding locks during the provider call", async () => {
  const f = await nushiFixture(), entered = latch(), release = latch(), fake = resolveNushiCompleter();
  const second = await createReply(f.db, "nushi-caller", f.topic, { body: "@nushi orchard", lang: "en" });
  if (!second.ok) throw new Error(second.error);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, second.id));
  const env = { ...process.env, VILLAGE_NUSHI_CONCURRENT_LIMIT: "1" };
  const first = processNushiRequest(f.db, f.request.id, { env, completer: { ...fake, async complete(req) { entered.resolve(); await release.promise; return fake.complete(req); } } });
  await entered.promise;
  try { await expect(processNushiRequest(f.db, request.id, { env })).rejects.toMatchObject({ name: "DeferJob" }); }
  finally { release.resolve(); }
  await first;
  expect(await f.db.select().from(nushiAnswers)).toHaveLength(1);
});
pg("does not publish after another connection edits a supporting post during generation", async () => {
  const f = await nushiFixture(), entered = latch(), release = latch(), fake = resolveNushiCompleter();
  const first = processNushiRequest(f.db, f.request.id, { completer: { ...fake, async complete(req) { entered.resolve(); await release.promise; return fake.complete(req); } } });
  await entered.promise;
  try { await f.db.transaction(async tx => { await tx.update(entries).set({ body: "A corrected source." }).where(eq(entries.id, f.source)); }); }
  finally { release.resolve(); }
  await first;
  expect(await f.db.select().from(nushiAnswers)).toHaveLength(0);
});
pg("admits only one of two cost reservations that together exceed the Nushi monthly cap", async () => {
  const f = await nushiFixture(), now = new Date();
  const request = { engine: "fake", model: "fake-nushi", purpose: "ask_village" as const, role: "ask" as const, estimateMicro: 750_000, now, env: { VILLAGE_NUSHI_LLM_MONTHLY_BUDGET_USD: "1" } };
  const results = await Promise.allSettled([reserveUsage(f.db, request), reserveUsage(f.db, request)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(await getMonthlyCostMicro(f.db, now, NUSHI_USAGE_PURPOSES)).toBe(750_000);
});

pg("checks only cited authors under the publication lock across PostgreSQL connections", async () => {
  const f = await nushiFixture(), entered = latch(), release = latch(), fake = resolveNushiCompleter();
  const second = await createReply(f.db, "nushi-caller", f.topic, { body: "@nushi orchard", lang: "en" });
  if (!second.ok) throw new Error(second.error);
  const [request] = await f.db.select().from(nushiRequests).where(eq(nushiRequests.entryId, second.id));
  let calls = 0;
  const completer = { ...fake, async complete(req: Parameters<typeof fake.complete>[0]) {
    const result = await fake.complete(req);
    if (++calls === 2) entered.resolve();
    await release.promise;
    return result;
  } };
  const env = { ...process.env, VILLAGE_NUSHI_AUTHOR_DAILY_LIMIT: "1" };
  const pending = [processNushiRequest(f.db, f.request.id, { env, completer }), processNushiRequest(f.db, request.id, { env, completer })];
  try { await entered.promise; } finally { release.resolve(); }
  await Promise.all(pending);
  expect(await f.db.select().from(nushiAnswers)).toHaveLength(1);
  expect(await f.db.select().from(nushiReservations).where(eq(nushiReservations.key, "author:nushi-owner"))).toHaveLength(1);
  expect((await f.db.select().from(nushiRequests)).map(row => [row.state, row.failure]).sort()).toEqual([["answered", null], ["failed", "limit"]]);
});
