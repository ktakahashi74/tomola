import { ApiError } from "@google/genai";
import { eq, inArray, sql } from "drizzle-orm";
import { createElement } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { EMBEDDING_DIM, entries, entryEmbeddings, llmUsage, profiles, rateLimits, translations, translationRevisions, villages } from "~/lib/db/schema";
import { combinedHits, combinedSearch, findLiteral, literalSearchQuery } from "~/lib/combined-search.server";
import { loadPickedTranslations } from "~/lib/entry-display.server";
import { HIDDEN_PRIMARY_FLAGS } from "~/lib/llm/flags";
import { createFakeEmbeddingEngine } from "~/lib/llm/engines/fake-embedding.server";
import { BudgetPausedError, LlmError } from "~/lib/llm/index.server";
import { buildSearchMarkdown } from "~/lib/md/search.server";
import { SEARCH_LIMIT, searchFound, type SearchOptions } from "~/lib/search.server";
import { addMember, createTestDb } from "./helpers/db";
import { getMd, parseBlocks } from "./helpers/md";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { renderInRouter } from "./helpers/render-in-router";
import { parse } from "yaml";

const opts: Pick<SearchOptions, "readLangs" | "displayLang" | "limit"> = { readLangs: [], displayLang: "en" };
const engine = createFakeEmbeddingEngine();
const llm = { env: {}, embeddingEngine: engine };
let db: Db;
const statements: string[] = [];
beforeAll(async () => {
  db = await createTestDb({ logger: { logQuery: query => statements.push(query) } });
  await addMember(db, "literal-author", "literal_author");
});
const topic = async (title: string | null, body = "A saved body.", extra: Partial<typeof entries.$inferInsert> = {}) => {
  const [row] = await db.insert(entries).values({ kind: "topic", authorId: "literal-author", lang: "ja", title, body, sourceHash: "current", ...extra }).returning();
  return row;
};
const ids = async (query: string, options = opts) => (await findLiteral(db, query, options)).map(row => row.id);

describe("independent literal SQL", () => {
  it("finds original titles and bodies without embeddings, including Japanese, case and literal symbols", async () => {
    const title = await topic("題名の部分一致 SeArChTitle");
    const body = await topic("An unrelated heading", "本文の途中に語句がある。exact %_\\ marker.");
    for (const query of ["部分一致", "searchtitle", "ArChTi"]) expect(await ids(query)).toContain(title.id);
    for (const query of ["途中に語句", "%_\\", "%", "_", "\\"]) expect(await ids(query)).toContain(body.id);
    expect(await ids("does-not-exist-at-all")).toEqual([]);
    expect(await ids("exact %_\\ missing")).toEqual([]);
    expect(await ids("exact marker")).toEqual([]);
    expect(await db.select().from(entryEmbeddings).where(inArray(entryEmbeddings.entryId, [title.id, body.id]))).toEqual([]);
  });

  it("does not search HTML tag names, attributes or cached HTML", async () => {
    const row = await topic(null, '<span data-secret="a > tagonlyword">Readable body text</span><!-- commentonlyneedle -->', { html: "cachedhtmlneedle" });
    expect(await ids("Readable body")).toContain(row.id);
    for (const query of ["tagonlyword", "cachedhtmlneedle", "data-secret", "commentonlyneedle"]) expect(await ids(query)).not.toContain(row.id);
  });

  it("keeps visible text between separate HTML comments in originals and translations", async () => {
    const row = await topic(null, "Before <!-- first\noriginalcommentneedle --> <em>visibleoriginalneedle</em> <!-- secondoriginalcommentneedle --> after.");
    await db.insert(translations).values({ entryId: row.id, field: "body", lang: "en", kind: "human", text: "Before <!-- first\ntranslatedcommentneedle --> <em>visibletranslatedneedle</em> <!-- secondtranslatedcommentneedle --> after." });
    for (const [query, source] of [["visibleoriginalneedle", "original"], ["visibletranslatedneedle", "translation"]] as const) {
      const found = await findLiteral(db, query, opts);
      expect(found).toMatchObject([{ id: row.id, match: { field: "body", source } }]);
      const [hit] = await combinedHits(db, query, { found, literalOnly: true }, opts);
      expect(hit.match!.text).toContain(query);
      expect(hit.match!.text).not.toContain("<!--");
    }
    for (const query of ["originalcommentneedle", "secondoriginalcommentneedle", "translatedcommentneedle", "secondtranslatedcommentneedle"]) expect(await ids(query)).not.toContain(row.id);
  });

  it("ranks own title matches before body matches, then creation time and ID, deduplicating languages", async () => {
    const older = await topic("rankneedle title", "rankneedle body", { createdAt: new Date("2025-01-01") });
    const newer = await topic("rankneedle newer", "body", { createdAt: new Date("2025-01-02") });
    const tie = await topic("rankneedle tied", "body", { createdAt: newer.createdAt });
    const body = await topic("Different title", "rankneedle body", { createdAt: new Date("2025-01-03") });
    await db.insert(translations).values({ entryId: older.id, lang: "en", field: "title", kind: "human", text: "rankneedle translation", sourceHash: "current" });
    expect(await ids("rankneedle")).toEqual([tie.id, newer.id, older.id, body.id]);
    const [reply] = await db.insert(entries).values({ kind: "reply", threadId: tie.id, parentId: tie.id, authorId: "literal-author", lang: "ja", body: "Only the parent's title matches." }).returning();
    expect(await ids("rankneedle")).not.toContain(reply.id);
  });

  it("selects display-language human and machine translations by the same rules as reading", async () => {
    const row = await topic("Source title for selection", "Source body for selection");
    await db.insert(translations).values([
      { entryId: row.id, field: "title", lang: "en", kind: "primary", sourceHash: "current", text: "hiddenprimaryneedle" },
      { entryId: row.id, field: "title", lang: "en", kind: "human", sourceHash: "current", text: "humanselectedneedle" },
      { entryId: row.id, field: "body", lang: "en", kind: "primary", sourceHash: "current", text: "machineselectedneedle" },
      { entryId: row.id, field: "body", lang: "en", kind: "human", sourceHash: "old", flags: ["stale"], text: "olderalternativeneedle" },
      { entryId: row.id, field: "body", lang: "en", kind: "secondary", sourceHash: "current", text: "comparisononlyneedle" },
      { entryId: row.id, field: "body", lang: "fr", kind: "human", text: "otherlanguageneedle" },
    ]);
    for (const query of ["humanselectedneedle", "machineselectedneedle"]) expect(await ids(query)).toContain(row.id);
    for (const query of ["hiddenprimaryneedle", "olderalternativeneedle", "comparisononlyneedle", "otherlanguageneedle"]) expect(await ids(query)).not.toContain(row.id);
    expect(await ids("humanselectedneedle", { ...opts, readLangs: ["ja"] })).not.toContain(row.id);
    await db.update(translations).set({ flags: ["untranslated"] }).where(eq(translations.kind, "primary"));
    // With no usable primary, the reader's default is the stale human, which remains searchable.
    expect(await ids("olderalternativeneedle")).toContain(row.id);
    const picked = (await loadPickedTranslations(db, [{ ...row, kind: "topic", lang: "ja" }], "en")).get(row.id)!;
    expect(picked.body?.text).toBe("olderalternativeneedle");
  });

  it("excludes every hidden-primary flag, old machine revisions and stale mention bindings", async () => {
    for (const [index, flags] of [...HIDDEN_PRIMARY_FLAGS.map(flag => [flag]), []].entries()) {
      const row = await topic(`Flags ${index}`);
      await db.insert(translations).values({ entryId: row.id, field: "body", lang: "en", kind: "primary", sourceHash: flags.length ? "current" : "old", flags, text: "excludedmachineneedle" });
    }
    const row = await topic("Mention revision", "Source body", { mentionRevision: 2 });
    await db.insert(translations).values({ entryId: row.id, field: "body", lang: "en", kind: "primary", sourceHash: "current", mentionRevision: 1, text: "excludedmachineneedle" });
    await db.insert(translationRevisions).values({ entryId: row.id, field: "body", lang: "en", kind: "primary", text: "historyonlyneedle", createdAt: new Date(), reason: "retranslate" });
    expect(await ids("excludedmachineneedle")).toEqual([]);
    expect(await ids("historyonlyneedle")).toEqual([]);
    const titleless = await topic(null, "No heading");
    await db.insert(translations).values({ entryId: titleless.id, field: "title", lang: "en", kind: "human", text: "removedtitleneedle" });
    expect(await ids("removedtitleneedle")).toEqual([]);
  });

  it("filters posts, parent topics and closed villages before the limit, including their translated text", async () => {
    const [village] = await db.insert(villages).values({ kind: "closed", name: "Closed", description: "" }).returning();
    const closed = await topic("visibilityneedle", "visibilityneedle", { villageId: village.id });
    const hidden = await topic("visibilityneedle", "visibilityneedle", { hiddenAt: new Date() });
    const deleted = await topic("visibilityneedle", "visibilityneedle", { deletedAt: new Date() });
    const [reply] = await db.insert(entries).values({ kind: "reply", threadId: hidden.id, parentId: hidden.id, authorId: "literal-author", lang: "ja", body: "visibilityneedle" }).returning();
    await db.insert(translations).values([closed, hidden, deleted, reply].map(row => ({ entryId: row.id, field: "body", lang: "en", kind: "human", text: "visibilitytranslatedneedle" })));
    const visible = await topic("visibilityneedle", "ordinary body", { createdAt: new Date("2020-01-01") });
    expect(await findLiteral(db, "visibilityneedle", { ...opts, limit: 1 })).toMatchObject([{ id: visible.id }]);
    expect(await ids("visibilitytranslatedneedle")).toEqual([]);
  });

  it("caps the total in SQL and uses a fixed number of batched reads, recording the synthetic query plan", async () => {
    await db.insert(entries).values(Array.from({ length: SEARCH_LIMIT + 7 }, (_, i) => ({ kind: "topic", authorId: "literal-author", lang: "ja", title: `limitneedle ${i}`, body: "Limit fixture", sourceHash: "current" })));
    statements.length = 0;
    const start = performance.now();
    const found = await findLiteral(db, "limitneedle", opts);
    const elapsed = performance.now() - start;
    expect(found).toHaveLength(SEARCH_LIMIT);
    expect(statements).toHaveLength(1);
    const plan = await db.execute(sql`explain (analyze, buffers, format json) ${literalSearchQuery(db, "limitneedle", opts).getSQL()}`);
    const count = await db.select({ count: sql<number>`count(*)::int` }).from(entries);
    const explain = (plan as unknown as { rows: Array<{ "QUERY PLAN": unknown }> }).rows[0]["QUERY PLAN"];
    console.log("literal SQL synthetic measurement", JSON.stringify({ posts: count[0].count, translations: (await db.select({ count: sql<number>`count(*)::int` }).from(translations))[0].count, elapsedMs: elapsed, plan: explain }));
    statements.length = 0;
    await combinedHits(db, "limitneedle", { found, literalOnly: true }, opts);
    const readsForTwenty = statements.length;
    statements.length = 0;
    await combinedHits(db, "limitneedle", { found: found.slice(0, 1), literalOnly: true }, opts);
    expect(readsForTwenty).toBe(statements.length);
  });
});

describe("combined results", () => {
  it("puts independent literal hits first, deduplicates semantic hits, and keeps API/MCP semantic search opt-in unchanged", async () => {
    const literal = await topic("mergedneedle literal", "Saved, without an embedding.");
    const semantic = await topic("Something else", "cooperation between people");
    const vector = (await engine.embed({ text: "mergedneedle", task: "query" })).vector;
    await db.insert(entryEmbeddings).values([literal, semantic].map(row => ({ entryId: row.id, model: engine.model, embedding: vector, dim: EMBEDDING_DIM, sourceHash: "current" })));
    const embed = vi.fn(engine.embed);
    const result = await combinedSearch(db, "mergedneedle", { ...opts, llm: { ...llm, embeddingEngine: { ...engine, embed } } });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(result.literalOnly).toBe(false);
    expect(result.found.map(row => row.id)).toEqual([literal.id, semantic.id]);
    expect(result.found[0].match?.source).toBe("original");
    expect(result.found[1].match).toBeUndefined();
    const noEmbedding = await topic("mergedneedle no embedding");
    expect((await combinedSearch(db, "mergedneedle", { ...opts, llm, limit: 1 })).found).toHaveLength(1);
    expect((await searchFound(db, "mergedneedle", { llm })).map(row => row.id)).not.toContain(noEmbedding.id);
    const legacy = await buildSearchMarkdown(db, "mergedneedle", await searchFound(db, "mergedneedle", { llm }), { lang: "en", k: null });
    expect(legacy).not.toContain("search_status");
    expect(legacy).not.toContain("match_kind");
  });

  it("returns literal-only results on a paused budget and classified engine failures, without retrying", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const row = await topic("fallbackneedle");
      for (const failure of [new BudgetPausedError("stopped", new Date(), "embed"), new LlmError("unavailable", "offline"), new ApiError({ status: 503, message: "Provider unavailable" }), new DOMException("Timed out", "TimeoutError"), new TypeError("fetch failed")]) {
        const embed = vi.fn(async () => { throw failure; });
        const result = await combinedSearch(db, "fallbackneedle", { ...opts, llm: { ...llm, embeddingEngine: { ...engine, embed } } });
        expect(result.literalOnly).toBe(true);
        expect(result.found.map(hit => hit.id)).toEqual([row.id]);
        expect(embed).toHaveBeenCalledTimes(1);
      }
      const embed = vi.fn(engine.embed);
      const stopped = await combinedSearch(db, "no-literal-results", { ...opts, llm: { env: { LLM_MONTHLY_BUDGET_USD: "0" }, embeddingEngine: { ...engine, embed } } });
      expect(stopped).toEqual({ found: [], literalOnly: true });
      expect(embed).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(6);
      const warnings = warn.mock.calls.flat().join("\n");
      expect(warnings).toContain("Provider unavailable");
      expect(warnings).not.toContain("fallbackneedle");
      expect(warnings).not.toContain("no-literal-results");
    } finally {
      warn.mockRestore();
    }
  });

  it("propagates programming errors and database failures, including after literal results succeeded", async () => {
    await expect(combinedSearch(db, "errors", { ...opts, llm: { ...llm, embeddingEngine: { ...engine, embed: async () => { throw new Error("programming error"); } } } })).rejects.toThrow("programming error");
    await db.transaction(async tx => {
      await tx.execute(sql`alter table entry_embeddings rename to unavailable_embeddings`);
      await expect(combinedSearch(tx, "rankneedle", { ...opts, llm })).rejects.toThrow();
      // Roll back the deliberate schema failure, restoring the shared fixture.
      throw new Error("rollback fixture");
    }).catch(error => { expect(error.message).toBe("rollback fixture"); });
    await expect(combinedSearch({ select: () => { throw new Error("literal database failed"); } } as unknown as Db, "errors", { ...opts, llm })).rejects.toThrow("literal database failed");
  });

  it("shows a matching source window beyond the beginning and distinguishes the translated match", async () => {
    const row = await topic("Excerpt source", `${"First paragraph. ".repeat(400)}A deepneedle phrase. More context.`);
    await db.insert(translations).values({ entryId: row.id, field: "body", lang: "en", kind: "human", text: "A translatedneedle passage." });
    for (const [query, source, lang] of [["deepneedle", "original", "ja"], ["translatedneedle", "translation", "en"]] as const) {
      const found = await findLiteral(db, query, opts);
      const [hit] = await combinedHits(db, query, { found, literalOnly: true }, opts);
      expect(hit.match).toMatchObject({ source, lang, field: "body" });
      expect(hit.match!.text).toContain(query);
      expect(hit.match!.text.length).toBeLessThan(400);
      expect(hit.match!.translation?.kind ?? null).toBe(source === "translation" ? "human" : null);
    }
  });

  it("retains a literal escaped punctuation match in the snippet", async () => {
    const query = String.raw`literal\*punctuation`;
    await topic("Punctuation excerpt", `Before ${query} after.`);
    const found = await findLiteral(db, query, opts);
    const [hit] = await combinedHits(db, query, { found, literalOnly: true }, opts);
    expect(hit.match!.text).toContain(query);
  });
});

describe("authenticated HTML and Markdown entries", () => {
  let h: RouteHarness;
  let row: typeof entries.$inferSelect;
  beforeAll(async () => {
    h = await setupRouteHarness();
    const author = await h.signIn("literal_reader", { homeArea: "en", readLangs: ["en"] });
    [row] = await h.db.insert(entries).values({ kind: "topic", authorId: author, lang: "ja", title: "route-literal-needle", body: "A matching body", sourceHash: "route-current" }).returning();
    await h.db.insert(translations).values({ entryId: row.id, field: "body", lang: "en", kind: "human", text: "translated-route-needle" });
    await h.db.insert(llmUsage).values({ engine: "fake", model: "fixture", purpose: "translate", costUsdMicro: 25_000_000 });
  });
  afterAll(() => h.restore());
  it("serves literal hits and the explicit empty state with HTTP 200 during budget suspension, in both twins", async () => {
    const { loader } = await import("~/routes/search");
    const screen = await loader(h.args(h.request("/search?q=route-literal-needle&lang=en", { as: "literal_reader" })));
    expect(screen).toMatchObject({ state: "results", literalOnly: true, lang: "en", hits: [{ id: row.id, matchKind: "literal" }] });
    expect((await h.db.select().from(rateLimits).where(eq(rateLimits.key, `member:search:${h.ids.literal_reader}`)))[0].count).toBe(1);
    for (const suffix of ["md", "txt"]) {
      const response = await getMd(h, `/search.${suffix}?q=route-literal-needle&lang=en`, { as: "literal_reader" });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const blocks = parseBlocks(await response.text());
      expect(blocks[0].fm).toMatchObject({ search_status: "literal_only" });
      const items = parse(blocks[0].body);
      expect(items).toMatchObject([{ id: `p-${row.id}`, match_kind: "literal", match: { source: "original", lang: "ja" } }]);
      expect(items[0]).not.toHaveProperty("distance");
    }
    const empty = await getMd(h, "/search.md?q=missing-needle", { as: "literal_reader" });
    const blocks = parseBlocks(await empty.text());
    expect(blocks[0].fm).toMatchObject({ search_status: "literal_only" });
    expect(blocks.at(-1)!.fm).toMatchObject({ count: 0 });
  });

  it("keeps the screen's literal scope when following its Markdown link, with and without a language override", async () => {
    await h.db.update(profiles).set({ readLangs: ["ja"], displayLang: "en", uiLocale: "en" }).where(eq(profiles.userId, h.ids.literal_reader));
    const { default: Search, loader } = await import("~/routes/search");
    for (const override of ["", "&lang=en", "&lang=en&rl=1"]) {
      const path = `/search?q=translated-route-needle${override}`;
      const screen = await loader(h.args(h.request(path, { as: "literal_reader" })));
      expect(screen).toMatchObject({ state: "results", literalOnly: true, hits: override ? [{ id: row.id }] : [] });
      const html = await renderInRouter(() => createElement(Search, { loaderData: screen } as never), path);
      const href = html.match(/href="(\/search\.md\?[^"]*)"/)?.[1].replaceAll("&amp;", "&");
      expect(href).toBeDefined();
      expect(new URL(href!, "http://localhost").searchParams.get("lang")).toBe(override ? "en" : null);
      for (const suffix of ["md", "txt"]) {
        const response = await getMd(h, href!.replace("/search.md?", `/search.${suffix}?`), { as: "literal_reader" });
        expect(response.status).toBe(200);
        const blocks = parseBlocks(await response.text());
        expect(blocks.at(-1)!.fm.count).toBe(override ? 1 : 0);
        if (override) expect(parse(blocks[0].body)).toMatchObject([{ id: `p-${row.id}`, match: { source: "translation", lang: "en" } }]);
      }
    }
  });
});
