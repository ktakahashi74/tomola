import { quietLogger as quiet } from "./helpers/logger";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { entries, jobs, translations } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import {
  countStaleRenderCache,
  createRenderCacheHandlers,
  queueRenderRebuildIfStale,
  REBUILD_RENDER_CACHE_JOB,
  rebuildRenderCache,
  renderCacheDedupeKey,
} from "~/lib/render-cache.server";
import { softDeleteEntry } from "~/lib/entries.server";
import { createMemberDb } from "./helpers/member-db";

// Rebuild topics first for the stream, then replies, newest first within each group, with mention emphasis and bounded cards.
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));


async function setup() {
  const db = await createMemberDb(["alice", "bob"].map(handle => ({ id: handle, handle, options: { readLangs: ["ja", "en"] } })));
  const ids: number[] = [];
  const t = await createTopic(db, "alice", { lang: "ja", title: "t", body: "@bob 見て" });
  if (!t.ok) throw new Error("topic failed");
  ids.push(t.id);
  for (const body of ["@bob 返信1", "返信2", "@alice 返信3"]) {
    const r = await createReply(db, "bob", t.id, { lang: "ja", body });
    if (!r.ok) throw new Error("reply failed");
    ids.push(r.id);
  }
  return { db, ids };
}
const stale = (db: Awaited<ReturnType<typeof setup>>["db"]) => db.update(entries).set({ htmlVersion: RENDER_VERSION - 1, html: "<p>old</p>" });
const htmlOf = async (db: Awaited<ReturnType<typeof setup>>["db"], id: number) => (await db.select({ html: entries.html, v: entries.htmlVersion }).from(entries).where(eq(entries.id, id)))[0];

describe("rebuildRenderCache", () => {
  it("counts only rows of another version, and rebuilds them with the members emphasized", async () => {
    const { db, ids } = await setup();
    expect(await countStaleRenderCache(db)).toEqual({ entries: 0, translations: 0 });
    await stale(db);
    expect(await countStaleRenderCache(db)).toEqual({ entries: 4, translations: 0 });
    expect(await rebuildRenderCache(db)).toEqual({ entries: 4, translations: 0, remaining: 0 });
    for (const id of ids) expect((await htmlOf(db, id)).v).toBe(RENDER_VERSION);
    expect((await htmlOf(db, ids[0])).html).toMatch(/<a class="mention" href="\/u\/id\/[a-z0-9]{12}">@bob<\/a>/);
    expect((await htmlOf(db, ids[2])).html).not.toContain("mention");
    // Nothing is left: a second run does nothing.
    expect(await rebuildRenderCache(db)).toEqual({ entries: 0, translations: 0, remaining: 0 });
  });

  it("rebuilds topics before replies, newest first within each group, and resumes an interrupted batch", async () => {
    const { db, ids } = await setup();
    await stale(db);
    const first = await rebuildRenderCache(db, { batchSize: 1, maxRows: 2 });
    expect(first).toEqual({ entries: 2, translations: 0, remaining: 2 });
    // The topic and the newest reply are done; the other replies are not.
    expect((await htmlOf(db, ids[0])).v).toBe(RENDER_VERSION);
    expect((await htmlOf(db, ids[3])).v).toBe(RENDER_VERSION);
    expect((await htmlOf(db, ids[2])).v).toBe(RENDER_VERSION - 1);
    expect((await htmlOf(db, ids[1])).v).toBe(RENDER_VERSION - 1);
    expect(await rebuildRenderCache(db, { batchSize: 1 })).toEqual({ entries: 2, translations: 0, remaining: 0 });
  });

  it("leaves deleted posts alone, and rebuilds the shown translations of the body with the members of the source only", async () => {
    const { db, ids } = await setup();
    await softDeleteEntry(db, ids[2]);
    const [source] = await db.select({ sourceHash: entries.sourceHash, mentionRevision: entries.mentionRevision }).from(entries).where(eq(entries.id, ids[0]));
    await db.insert(translations).values([
      { entryId: ids[0], field: "body", lang: "en", kind: "primary", text: "@bob look, @alice", engine: "fake", model: "fake", promptVersion: "p", ...source, flags: [], html: null, htmlVersion: 0 },
      // A title translation and a secondary translation are never shown as a body: not rebuilt.
      { entryId: ids[0], field: "title", lang: "en", kind: "primary", text: "title", engine: "fake", model: "fake", promptVersion: "p", sourceHash: "h", flags: [], html: null, htmlVersion: 0 },
      { entryId: ids[0], field: "body", lang: "th", kind: "secondary", text: "@bob", engine: "fake", model: "fake", promptVersion: "p", sourceHash: "h", flags: [], html: null, htmlVersion: 0 },
    ]);
    await stale(db);
    expect(await countStaleRenderCache(db)).toEqual({ entries: 3, translations: 1 });
    expect(await rebuildRenderCache(db)).toEqual({ entries: 3, translations: 1, remaining: 0 });
    const [row] = await db.select({ html: translations.html, v: translations.htmlVersion }).from(translations).where(and(eq(translations.lang, "en"), eq(translations.field, "body")));
    expect(row.v).toBe(RENDER_VERSION);
    expect(row.html).toMatch(/<a class="mention" href="\/u\/id\/[a-z0-9]{12}">@bob<\/a>/);
    // @alice is a member but the source does not name her: not emphasized in the translation.
    expect(row.html).toContain("@alice");
    expect(row.html).not.toMatch(/<a[^>]*>@alice<\/a>/);
    expect((await htmlOf(db, ids[2])).v).toBe(RENDER_VERSION - 1);
  });
});

describe("the rebuild job", () => {
  it("deduplicates the queued job per render version and queues only stale data", async () => {
    const { db } = await setup();
    expect(await queueRenderRebuildIfStale(db)).toBe(false);
    const other = await setup();
    await stale(other.db);
    expect(await queueRenderRebuildIfStale(other.db)).toBe(true);
    // The queue deduplicates by render version.
    expect(await queueRenderRebuildIfStale(other.db)).toBe(false);
    expect((await other.db.select().from(jobs).where(eq(jobs.kind, REBUILD_RENDER_CACHE_JOB))).map((j) => j.dedupeKey)).toEqual([renderCacheDedupeKey()]);
  });

  it("rebuilds a part of the rows in one run and goes back to the queue until nothing is left, without using up an attempt", async () => {
    const { db } = await setup();
    await stale(db);
    await queueRenderRebuildIfStale(db);
    const handlers = createRenderCacheHandlers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const now = new Date(Date.now() + 1000);
    await runDueJobs(db, handlers, { now, logger: quiet, limit: 10 });
    // 4 rows fit in one run (200 at most): nothing is left, the job is done.
    expect((await db.select().from(jobs).where(eq(jobs.kind, REBUILD_RENDER_CACHE_JOB)))[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(await countStaleRenderCache(db)).toEqual({ entries: 0, translations: 0 });
    log.mockRestore();
  });
});
