import { quietLogger as quiet } from "./helpers/logger";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, jobs, translations } from "~/lib/db/schema";
import * as entriesModule from "~/lib/entries.server";
import { createReply, createTopic } from "~/lib/entries.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { startWorker } from "~/lib/jobs/worker.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import {
  countStaleRenderCache,
  createRenderCacheHandlers,
  queueRenderRebuildIfStale,
  REBUILD_JOB_MAX_ROWS,
  REBUILD_RENDER_CACHE_JOB,
  rebuildRenderCache,
  saveRenderedEntry,
  saveRenderedTranslation,
} from "~/lib/render-cache.server";
import { sourceHash } from "~/lib/source-hash.server";
import { createMemberDb } from "./helpers/member-db";


const longBody = `${"長い本文。".repeat(200)}\n\n続きの段落。`;

async function topic(db: Db, n: number, body = `本文 ${n}`, at = new Date(Date.UTC(2030, 0, n))): Promise<number> {
  const res = await createTopic(db, "u1", { lang: "ja", title: `題 ${n}`, body }, { now: at });
  if (!res.ok) throw new Error("topic failed");
  return res.id;
}

// Puts a row back to an older render version, as a deploy that raised RENDER_VERSION does.
const makeStale = (db: Db, ids: number[]) =>
  db.update(entries).set({ html: "<p>old</p>", cardHtml: null, htmlVersion: RENDER_VERSION - 1 }).where(inArray(entries.id, ids));
// A row of the second system (kind secondary: only for measuring, never shown) at another version.
const addSecondary = (db: Db, entryId: number) =>
  db.insert(translations).values({ entryId, field: "body", lang: "fr", kind: "secondary", text: "texte", html: "<p>old</p>", htmlVersion: RENDER_VERSION - 1 });
const getEntry = async (db: Db, id: number) => (await db.select().from(entries).where(eq(entries.id, id)))[0];

async function setup() {
  return createMemberDb([{ id: "u1", handle: "hana" }]);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("counting the rows at another version", () => {
  it("counts the posts that are not deleted and the shown translations (primary and human, body), not the second system, titles or deleted posts", async () => {
    const db = await setup();
    const a = await topic(db, 1);
    const b = await topic(db, 2);
    const gone = await topic(db, 3);
    await createReply(db, "u1", a, { lang: "ja", body: "返信" });
    expect(await countStaleRenderCache(db)).toEqual({ entries: 0, translations: 0 });
    const handlers = createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: createFakeEngine(), judge: null }, env: {} } });
    await runDueJobs(db, handlers, { now: new Date("2030-02-01T00:00:00Z"), logger: quiet, limit: 500 });
    await addSecondary(db, a);
    const rows = await db.select().from(translations);
    expect(rows.some((r) => r.kind === "secondary")).toBe(true);
    // everything at another version
    await db.update(entries).set({ htmlVersion: 0, html: null });
    await db.update(translations).set({ htmlVersion: 0 });
    await db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, gone));
    const stale = await countStaleRenderCache(db);
    // a and b and the reply (the deleted topic is not counted)
    expect(stale.entries).toBe(3);
    const shown = rows.filter((r) => r.field === "body" && (r.kind === "primary" || r.kind === "human") && r.entryId !== gone);
    expect(shown.length).toBeGreaterThan(0);
    expect(stale.translations).toBe(shown.length);
    expect(b).toBeGreaterThan(0);
  });
});

describe("rebuildRenderCache", () => {
  it("does not restore rendered derivatives after a post was deleted during the rebuild", async () => {
    const db = await setup();
    const id = await topic(db, 1);
    const read = await getEntry(db, id);
    await entriesModule.softDeleteEntry(db, id);
    expect(await saveRenderedEntry(db, id, read.body, { html: "<p>private old body</p>", cardHtml: "<p>old card</p>" })).toBe(false);
    expect(await getEntry(db, id)).toMatchObject({ html: null, cardHtml: null });
  });
  it("rebuilds the rows at another version until none is left, and makes the card version of a long body", async () => {
    const db = await setup();
    const short = await topic(db, 1);
    const long = await topic(db, 2, longBody);
    const reply = await createReply(db, "u1", long, { lang: "ja", body: longBody });
    if (!reply.ok) throw new Error("reply failed");
    await makeStale(db, [short, long, reply.id]);
    expect((await countStaleRenderCache(db)).entries).toBe(3);
    const result = await rebuildRenderCache(db);
    expect(result).toEqual({ entries: 3, translations: 0, remaining: 0 });
    for (const id of [short, long, reply.id]) expect((await getEntry(db, id)).htmlVersion).toBe(RENDER_VERSION);
    expect((await getEntry(db, short)).cardHtml).toBeNull();
    const rebuilt = await getEntry(db, long);
    expect(rebuilt.cardHtml).not.toBeNull();
    expect(rebuilt.html).toContain("続きの段落");
    expect(rebuilt.cardHtml).not.toContain("続きの段落");
    // a reply has no card version
    expect((await getEntry(db, reply.id)).cardHtml).toBeNull();
    expect(await rebuildRenderCache(db)).toEqual({ entries: 0, translations: 0, remaining: 0 });
  });

  it("rebuilds the translations that are shown, with the card version, and not the second system", async () => {
    const db = await setup();
    const id = await topic(db, 1, longBody);
    const handlers = createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: createFakeEngine(), judge: null }, env: {} } });
    await runDueJobs(db, handlers, { now: new Date("2030-02-01T00:00:00Z"), logger: quiet, limit: 500 });
    await addSecondary(db, id);
    await db.update(translations).set({ html: "<p>old</p>", cardHtml: null, htmlVersion: RENDER_VERSION - 1 });
    const before = await countStaleRenderCache(db);
    expect(before.translations).toBeGreaterThan(0);
    const result = await rebuildRenderCache(db);
    expect(result.remaining).toBe(0);
    expect(result.translations).toBe(before.translations);
    const rows = await db.select().from(translations).where(eq(translations.entryId, id));
    for (const r of rows.filter((x) => x.field === "body" && x.kind === "primary")) {
      expect(r.htmlVersion).toBe(RENDER_VERSION);
      expect(r.cardHtml).not.toBeNull();
      expect(r.html).toContain("続きの段落");
      expect(r.cardHtml).not.toContain("続きの段落");
    }
    // the second system (measuring only) and the titles are left as they were
    for (const r of rows.filter((x) => x.kind === "secondary" || x.field === "title")) {
      expect(r.html).toBe("<p>old</p>");
      expect(r.htmlVersion).toBe(RENDER_VERSION - 1);
    }
  });

  it("does not touch a deleted post", async () => {
    const db = await setup();
    const a = await topic(db, 1);
    const gone = await topic(db, 2);
    await makeStale(db, [a, gone]);
    await db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, gone));
    expect(await rebuildRenderCache(db)).toEqual({ entries: 1, translations: 0, remaining: 0 });
    expect((await getEntry(db, gone)).htmlVersion).toBe(RENDER_VERSION - 1);
    expect((await getEntry(db, gone)).html).toBe("<p>old</p>");
  });

  it("goes newest topics first, topics before replies, and a stopped run is continued by the next", async () => {
    const db = await setup();
    const oldest = await topic(db, 1);
    const middle = await topic(db, 2);
    const newest = await topic(db, 3);
    const reply = await createReply(db, "u1", oldest, { lang: "ja", body: "返信" }, { now: new Date(Date.UTC(2030, 5, 1)) });
    if (!reply.ok) throw new Error("reply failed");
    const all = [oldest, middle, newest, reply.id];
    await makeStale(db, all);
    const versions = async () => Object.fromEntries(await Promise.all(all.map(async (id) => [id, (await getEntry(db, id)).htmlVersion])));
    // two rows: the two newest topics (the reply is newer than all topics, but replies come after topics)
    let result = await rebuildRenderCache(db, { maxRows: 2, batchSize: 1 });
    expect(result).toEqual({ entries: 2, translations: 0, remaining: 2 });
    expect(await versions()).toEqual({ [oldest]: RENDER_VERSION - 1, [middle]: RENDER_VERSION, [newest]: RENDER_VERSION, [reply.id]: RENDER_VERSION - 1 });
    result = await rebuildRenderCache(db, { maxRows: 1 });
    expect(result.remaining).toBe(1);
    expect((await getEntry(db, oldest)).htmlVersion).toBe(RENDER_VERSION);
    expect((await getEntry(db, reply.id)).htmlVersion).toBe(RENDER_VERSION - 1);
    result = await rebuildRenderCache(db);
    expect(result).toEqual({ entries: 1, translations: 0, remaining: 0 });
  });

  it("reads in batches of the given size and rebuilds everything", async () => {
    const db = await setup();
    const ids = [];
    for (let i = 1; i <= 7; i++) ids.push(await topic(db, i));
    await makeStale(db, ids);
    expect(await rebuildRenderCache(db, { batchSize: 3 })).toEqual({ entries: 7, translations: 0, remaining: 0 });
  });

  it("rebuilds every post and translation sharing a timestamp with PostgreSQL microseconds across batches", async () => {
    const db = await setup();
    const ids = [];
    for (let i = 1; i <= 7; i++) {
      const id = await topic(db, i);
      ids.push(id);
      const source = await getEntry(db, id);
      await db.insert(translations).values({ entryId: id, field: "body", lang: "en", kind: "human", text: `Translated body ${i}`, sourceHash: source.sourceHash, htmlVersion: 0 });
    }
    await db.update(entries).set({ createdAt: sql`'2030-01-01T00:00:00.123456Z'::timestamptz` });
    await makeStale(db, ids);
    expect(await rebuildRenderCache(db, { batchSize: 2 })).toEqual({ entries: 7, translations: 7, remaining: 0 });
  });

  it("the save is guarded: a post (or a translation) that was edited after it was read is not overwritten with the html of the old text", async () => {
    const db = await setup();
    const id = await topic(db, 1, "old body");
    const read = (await getEntry(db, id)).body;
    await makeStale(db, [id]);
    const rendered = (await entriesModule.renderEntryHtml("topic", id, read, "ja", new Map()));
    // an edit lands between the read and the save
    await db.update(entries).set({ body: "edited body" }).where(eq(entries.id, id));
    expect(await saveRenderedEntry(db, id, read, rendered)).toBe(false);
    const row = await getEntry(db, id);
    expect(row.html).toBe("<p>old</p>");
    expect(row.htmlVersion).toBe(RENDER_VERSION - 1);
    // with the text it was read from, it is written
    expect(await saveRenderedEntry(db, id, "edited body", (await entriesModule.renderEntryHtml("topic", id, "edited body", "ja", new Map())))).toBe(true);
    expect((await getEntry(db, id)).html).toContain("edited body");

    const handlers = createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null }, env: {} } });
    await runDueJobs(db, handlers, { now: new Date("2030-02-01T00:00:00Z"), logger: quiet, limit: 500 });
    const [tr] = await db.select().from(translations).where(and(eq(translations.entryId, id), eq(translations.field, "body"), eq(translations.lang, "en")));
    await db.update(translations).set({ text: "re-translated", html: "<p>old</p>", htmlVersion: RENDER_VERSION - 1 }).where(eq(translations.id, tr.id));
    expect(await saveRenderedTranslation(db, tr.id, tr.text, (await entriesModule.renderTranslationHtml("topic", id, "en", tr.text, new Map())))).toBe(false);
    expect((await db.select().from(translations).where(eq(translations.id, tr.id)))[0].html).toBe("<p>old</p>");
  });
});

describe("the rebuild job", () => {
  afterEach(async () => {
    const g = globalThis as { __tomolaWorker?: { stop(): Promise<unknown> } };
    await g.__tomolaWorker?.stop();
    g.__tomolaWorker = undefined;
  });
  const queued = (db: Db) => db.select().from(jobs).where(eq(jobs.kind, REBUILD_RENDER_CACHE_JOB)).orderBy(asc(jobs.id));

  it("is queued once when rows are at another version, never twice for the same version, and not at all when none is", async () => {
    const db = await setup();
    const id = await topic(db, 1);
    expect(await queueRenderRebuildIfStale(db)).toBe(false);
    expect(await queued(db)).toHaveLength(0);
    await makeStale(db, [id]);
    expect(await queueRenderRebuildIfStale(db)).toBe(true);
    expect(await queueRenderRebuildIfStale(db)).toBe(false);
    const rows = await queued(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupeKey).toBe(`render-cache:${RENDER_VERSION}`);
  });

  it("the worker queues it when it starts (once per process), and queues nothing when the renders are current", async () => {
    const db = await setup();
    const id = await topic(db, 1);
    const g = globalThis as { __tomolaWorker?: { stop(): Promise<unknown> } };
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = startWorker({ env: {}, intervalMs: 5, getDb: async () => db, handlers: {}, signals: false })!;
    await vi.advanceTimersByTimeAsync(5);
    await first.stop();
    g.__tomolaWorker = undefined;
    expect(await queued(db)).toHaveLength(0);
    await makeStale(db, [id]);
    const second = startWorker({ env: {}, intervalMs: 5, getDb: async () => db, handlers: {}, signals: false })!;
    await vi.advanceTimersByTimeAsync(5);
    await second.stop();
    expect(await queued(db)).toHaveLength(1);
  });

  it("one run rebuilds up to the row limit and queues itself again for the rest; the last run queues nothing", async () => {
    const db = await setup();
    const total = REBUILD_JOB_MAX_ROWS + 30;
    await db.insert(entries).values(Array.from({ length: total }, (_, index) => {
      const i = index + 1;
      const title = `題 ${1 + (i % 28)}`, body = `本文 ${i}`;
      const createdAt = new Date(Date.UTC(2030, 0, 1 + (i % 28)));
      return { kind: "topic", authorId: "u1", authorArea: "ja", lang: "ja", title, body, sourceHash: sourceHash(title, body),
        createdAt, updatedAt: createdAt, lastActivityAt: createdAt, html: "<p>old</p>", htmlVersion: RENDER_VERSION - 1 };
    }));
    expect(await queueRenderRebuildIfStale(db)).toBe(true);
    const handlers = createRenderCacheHandlers();
    await runDueJobs(db, handlers, { now: new Date("2031-01-01T00:00:00Z"), logger: quiet, limit: 1 });
    expect((await countStaleRenderCache(db)).entries).toBe(30);
    let rows = await queued(db);
    expect(rows.filter((r) => r.status === "queued")).toHaveLength(1);
    await runDueJobs(db, handlers, { now: new Date("2031-01-01T00:00:01Z"), logger: quiet, limit: 1 });
    expect((await countStaleRenderCache(db)).entries).toBe(0);
    rows = await queued(db);
    expect(rows.filter((r) => r.status === "queued")).toHaveLength(0);
    expect(rows.every((r) => r.status === "done")).toBe(true);
  }, 60_000);
});
