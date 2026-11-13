import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { PG_MODE } from "./helpers/pg-test";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { consentChatMembers } from "./helpers/chat-consent";
import { chatSequences, villageMembers, villages } from "~/lib/db/schema";
import { chatSearchQuery } from "~/lib/village-chat-search.server";
import { action } from "~/routes/village-chat-search";

const performanceEnabled = process.env.TOMOLA_CHAT_SEARCH_PERF === "1";
describe.skipIf(!PG_MODE || !performanceEnabled)("chat search synthetic PostgreSQL performance", { tags: performanceEnabled ? ["postgres"] : [] }, () => {
  let h: RouteHarness, villageId: string;
  const handles = Array.from({ length: 5 }, (_, i) => `cs_perf_${i}`);
  beforeAll(async () => {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
    h = await setupRouteHarness();
    for (const handle of handles) await h.signIn(handle, { homeArea: "en", readLangs: ["en"] });
    const [village] = await h.db.insert(villages).values({ kind: "open", slug: "chat-search-performance" }).returning();
    villageId = village.id;
    await h.db.insert(villageMembers).values(handles.map(handle => ({ villageId, userId: h.ids[handle] })));
    await consentChatMembers(h.db);
    await h.db.execute(sql`insert into chat_messages (village_id, author_id, lang, body, created_seq, changed_seq)
      select ${villageId}, ${h.ids[handles[0]]}, (array['ja', 'en', 'zh-Hans', 'ko'])[1 + (i / 4) % 4],
        left(repeat('commonneedle 日本語 中文 한국어 %_ https://example.org/path ', 60), (array[40, 200, 800, 2000])[1 + i % 4]), i, i
      from generate_series(1, 50000) i`);
    await h.db.execute(sql`insert into chat_message_translations (message_id, lang, state, source_hash, text)
      select id, 'en', 'ready', encode(sha256(convert_to(body, 'UTF8')), 'hex'),
        left(repeat('translatedneedle A synthetic translated message. ', 60), (array[40, 200, 800, 2000])[1 + created_seq % 4])
      from chat_messages where village_id = ${villageId} and created_seq % 16 in (0, 1, 2, 3, 8, 9, 14, 15)`);
    await h.db.insert(chatSequences).values({ villageId, seq: 50000 });
    await h.db.execute(sql`analyze chat_messages`);
    await h.db.execute(sql`analyze chat_message_translations`);
  }, 120_000);
  afterAll(() => { h?.restore(); vi.unstubAllEnvs(); });

  it("records twenty single requests and twenty five-member bursts per query class against a 500 ms p95 target", async () => {
    const counted = await h.db.execute(sql`select
      (select count(*)::int from chat_messages where village_id = ${villageId}) as messages,
      (select count(*)::int from chat_message_translations t join chat_messages m on m.id = t.message_id where m.village_id = ${villageId}) as translations`);
    const totals = (counted as unknown as { rows: Array<{ messages: number; translations: number }> }).rows[0];
    expect(totals).toEqual({ messages: 50000, translations: 25000 });
    const distribution = await h.db.execute(sql`select length(m.body) as characters, count(*)::int as originals, count(t.message_id)::int as translations
      from chat_messages m left join chat_message_translations t on t.message_id = m.id and t.lang = 'en'
      where m.village_id = ${villageId} group by length(m.body) order by characters`);
    const lengthDistribution = (distribution as unknown as { rows: Array<{ characters: number; originals: number; translations: number }> }).rows;
    expect(lengthDistribution).toEqual([40, 200, 800, 2000].map(characters => ({ characters, originals: 12500, translations: 6250 })));
    const classes = [
      { name: "no-match", query: "missingneedle", count: 0 },
      { name: "many-original", query: "commonneedle", count: 20 },
      { name: "many-translated", query: "translatedneedle", count: 20 },
    ];
    const measurements = [];
    async function request(handle: string, query: string, count: number) {
      const req = h.request("/v/chat-search-performance/chat/search", { as: handle, form: { q: query } });
      const start = performance.now();
      const response = await action(h.args(req, { slug: "chat-search-performance" }));
      const elapsed = performance.now() - start;
      expect(response.data).toHaveProperty("hits", expect.any(Array));
      if (!("hits" in response.data)) throw new Error("Synthetic search failed");
      expect(response.data.hits).toHaveLength(count);
      return elapsed;
    }
    function stats(values: number[]) {
      const sorted = [...values].sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
      return { samples: values.length, medianMs: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2, p95Ms: p95, maxMs: sorted.at(-1), targetMs: 500, withinTarget: p95 <= 500 };
    }
    for (const scenario of classes) {
      for (const concurrency of [1, 5]) {
        await h.db.execute(sql`delete from rate_limits where key like 'member:chat-search:%'`);
        const members = handles.slice(0, concurrency);
        for (let warmup = 0; warmup < 2; warmup++) await Promise.all(members.map(handle => request(handle, scenario.query, scenario.count)));
        const values: number[] = [];
        for (let round = 0; round < 20; round++) values.push(...await Promise.all(members.map(handle => request(handle, scenario.query, scenario.count))));
        measurements.push({ scenario: scenario.name, concurrency, ...stats(values) });
      }
    }
    const plans = [];
    for (const scenario of classes) {
      for (const searchPath of ["recent", "original", "translation"] as const) {
        const plan = await h.db.execute(sql`explain (analyze, buffers, format json) ${chatSearchQuery(h.db, villageId, scenario.query, "en", searchPath === "recent" ? { from: 49801 } : { before: 49801, source: searchPath }).getSQL()}`);
        plans.push({ scenario: scenario.name, searchPath, plan: (plan as unknown as { rows: Array<{ "QUERY PLAN": unknown }> }).rows[0]["QUERY PLAN"] });
      }
    }
    console.log("chat search synthetic measurement", JSON.stringify({ ...totals, lengthDistribution, poolMax: 4, scope: "authenticated action; excludes HTTP and browser rendering", measurements, plans }));
  }, 180_000);
});
