

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { entries } from "~/lib/db/schema";
import { createReply, createTopic, editEntry, softDeleteEntry } from "~/lib/entries.server";
import { buildChangesMarkdown, CHANGES_LIMIT, formatCursor, loadChanges, parseCursor } from "~/lib/md/changes.server";
import { hideEntry, unhideEntry } from "~/lib/moderation.server";
import { parseBlocks } from "./helpers/md";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { addMember, createTestDb } from "./helpers/db";

const base = Date.parse("2026-10-01T00:00:00Z");
const minutes = (n: number) => new Date(base + n * 60_000);

describe("entries.changed_at (a stored generated column)", () => {
  const changedAt = async (db: Awaited<ReturnType<typeof createTestDb>>, id: number) => (await db.select({ c: entries.changedAt }).from(entries).where(eq(entries.id, id)))[0].c;

  it("is the newest of created, edited, deleted and moderated times, whichever path changed the row", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    await addMember(db, "mod", "moriko");
    const actor = { id: "mod", scope: { operator: true, langs: [] } };
    const created = await createTopic(db, "u1", { lang: "ja", title: "題", body: "本文" }, { now: minutes(0) });
    if (!created.ok) throw new Error("topic failed");
    const id = created.id;
    expect(await changedAt(db, id)).toEqual(minutes(0));
    await editEntry(db, "u1", id, { title: "題2", body: "本文2" }, { now: minutes(10) });
    expect(await changedAt(db, id)).toEqual(minutes(10));
    await hideEntry(db, actor, { entryId: id, reason: "spam", note: "n" }, { now: minutes(20) });
    expect(await changedAt(db, id)).toEqual(minutes(20));
    await unhideEntry(db, actor, { entryId: id, reason: "other" }, { now: minutes(30) });
    expect(await changedAt(db, id)).toEqual(minutes(30));
    await softDeleteEntry(db, id, { now: minutes(40) });
    expect(await changedAt(db, id)).toEqual(minutes(40));
    // Restore: deleted_at returns to null and moderated_at advances.
    await db.update(entries).set({ deletedAt: null, moderatedAt: minutes(50) }).where(eq(entries.id, id));
    expect(await changedAt(db, id)).toEqual(minutes(50));
    // Aggregate updates from adding replies do not change the topic's change timestamp.
    await createReply(db, "u1", id, { lang: "ja", body: "r" }, { now: minutes(60) });
    expect(await changedAt(db, id)).toEqual(minutes(50));
    // Even with reversed timestamps, such as deleting with an earlier now, change time never precedes creation.
    const early = await createTopic(db, "u1", { lang: "ja", title: "t", body: "b" }, { now: minutes(100) });
    if (!early.ok) throw new Error("topic failed");
    await softDeleteEntry(db, early.id, { now: minutes(5) });
    expect(await changedAt(db, early.id)).toEqual(minutes(100));
  });

  it("cannot be written to (it is generated)", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const created = await createTopic(db, "u1", { lang: "ja", title: "t", body: "b" });
    if (!created.ok) throw new Error("topic failed");
    await expect(db.execute(sql`update entries set changed_at = now() where id = ${created.id}`)).rejects.toThrow();
  });

  it("has the changed_at index, and the index on the thread root expression", async () => {
    const db = await createTestDb();
    const rows = await db.execute(sql`select indexname, indexdef from pg_indexes where tablename = 'entries' and indexname in ('entries_changed_idx', 'entries_thread_root_idx')`);
    const defs = Object.fromEntries((rows as unknown as { rows: Array<{ indexname: string; indexdef: string }> }).rows.map((r) => [r.indexname, r.indexdef]));
    expect(defs.entries_changed_idx).toContain("(changed_at, id)");
    expect(defs.entries_thread_root_idx).toContain("COALESCE(thread_id, id)");
  });
});

describe("the change feed cursor", () => {
  let h: RouteHarness;
  let hana: string;
  beforeAll(async () => {
    h = await setupRouteHarness();
    hana = await h.signIn("hana", { homeArea: "ja" });
  });
  afterAll(() => h.restore());

  const feed = async (query: string, as: string | undefined = "hana") => (await (await import("~/routes/changes-md")).loader(h.args(h.request(`/changes.md${query}`, { as })))) as Awaited<Promise<Response>>;
  const items = (md: string) => parse(parseBlocks(md)[0].body, { schema: "core" }) as Array<Record<string, unknown>>;
  const footerOf = (md: string) => parseBlocks(md).at(-1)!.fm as Record<string, unknown>;

  it("parses and formats a cursor (ms ISO time + id) strictly", () => {
    const c = parseCursor("2026-10-01T00:20:00.000Z_12");
    expect(c).toEqual({ at: new Date("2026-10-01T00:20:00.000Z"), id: 12 });
    expect(formatCursor(c!)).toBe("2026-10-01T00:20:00.000Z_12");
    for (const bad of ["", "2026-10-01T00:20:00Z_12", "2026-10-01T00:20:00.000Z", "2026-10-01T00:20:00.000Z_0", "2026-10-01T00:20:00.000Z_-1", "2026-13-01T00:20:00.000Z_1", "2026-10-01T00:20:00.000+09:00_1", "x_1", "2026-10-01T00:20:00.000Z_1e3"]) {
      expect(parseCursor(bad), bad).toBeNull();
    }
  });

  it("advances through more than 500 changes at one instant without repeating or skipping any (a since-based follow cannot)", async () => {
    const instant = new Date(base + 24 * 3600 * 1000);
    const total = CHANGES_LIMIT * 2 + 37;
    await h.db.insert(entries).values(Array.from({ length: total }, (_, i) => ({ kind: "topic", authorId: hana, lang: "ja", title: `same instant ${i}`, body: "b", sourceHash: "x", createdAt: instant, updatedAt: instant, lastActivityAt: instant })));
    // since alone repeatedly returns the same 500 rows and cannot advance.
    const bySince1 = await loadChanges(h.db, { since: instant });
    const bySince2 = await loadChanges(h.db, { since: bySince1.changes.at(-1)!.changedAt });
    expect(bySince2.changes.map((c) => c.id)).toEqual(bySince1.changes.map((c) => c.id));
    // Continue with a cursor.
    const seen: number[] = [];
    let query = `?since=${encodeURIComponent(instant.toISOString())}`;
    let pages = 0;
    for (;;) {
      const res = await feed(query);
      expect(res.status).toBe(200);
      const md = await res.text();
      const footer = footerOf(md);
      const ids = items(md).map((i) => Number(String(i.id).slice(2)));
      // Within each page, newest first (descending id); between pages, start with older, smaller IDs.
      expect(ids).toEqual([...ids].sort((a, b) => b - a));
      seen.push(...[...ids].reverse());
      pages++;
      expect(footer.next_cursor).toBe(`${instant.toISOString()}_${Math.max(...ids)}`);
      expect(String(footer.next)).toContain("cursor=");
      if (!footer.has_more) break;
      query = `?cursor=${encodeURIComponent(String(footer.next_cursor))}`;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(3);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it("returns only changes strictly after the cursor, with no default 7-day window, and combines with since", async () => {
    const t1 = await createTopic(h.db, hana, { lang: "ja", title: "A", body: "a" }, { now: minutes(3000) });
    const t2 = await createTopic(h.db, hana, { lang: "ja", title: "B", body: "b" }, { now: minutes(3001) });
    if (!t1.ok || !t2.ok) throw new Error("topic failed");
    const after1 = items(await (await feed(`?cursor=${encodeURIComponent(`${minutes(3000).toISOString()}_${t1.id}`)}`)).text()).map((i) => i.id);
    expect(after1).toEqual([`p-${t2.id}`]);
    // Same timestamp, larger IDs only.
    const sameInstant = items(await (await feed(`?cursor=${encodeURIComponent(`${minutes(3000).toISOString()}_${t1.id - 1}`)}`)).text()).map((i) => i.id);
    expect(sameInstant).toEqual([`p-${t2.id}`, `p-${t1.id}`]);
    // A cursor without since has no seven-day cutoff: even a very old cursor returns everything, here the oldest rows up to the 500-row limit.
    const ancient = await (await feed(`?cursor=${encodeURIComponent("2000-01-01T00:00:00.000Z_1")}`)).text();
    expect(footerOf(ancient)).toMatchObject({ count: CHANGES_LIMIT, has_more: true });
    // With both since and cursor, require both conditions.
    const both = items(await (await feed(`?since=${encodeURIComponent(minutes(3001).toISOString())}&cursor=${encodeURIComponent(`${minutes(3000).toISOString()}_${t1.id}`)}`)).text()).map((i) => i.id);
    expect(both).toEqual([`p-${t2.id}`]);
    // Without changes, next_cursor equals the received cursor.
    const none = footerOf(await (await feed(`?cursor=${encodeURIComponent(`${minutes(3001).toISOString()}_${t2.id}`)}`)).text());
    expect(none).toMatchObject({ count: 0, next_cursor: `${minutes(3001).toISOString()}_${t2.id}`, has_more: false });
    expect(String(none.next)).toContain(`cursor=${encodeURIComponent(`${minutes(3001).toISOString()}_${t2.id}`)}`);
  });

  it("classifies a change after the cursor as an edit, not a creation, and keeps since-based classification", async () => {
    const t = await createTopic(h.db, hana, { lang: "ja", title: "C", body: "c" }, { now: minutes(4000) });
    if (!t.ok) throw new Error("topic failed");
    await editEntry(h.db, hana, t.id, { title: "C2", body: "c2" }, { now: minutes(4010) });
    const afterCreate = items(await (await feed(`?cursor=${encodeURIComponent(`${minutes(4000).toISOString()}_${t.id}`)}`)).text());
    expect(afterCreate).toEqual([expect.objectContaining({ id: `p-${t.id}`, change: "edited", changed_at: minutes(4010).toISOString() })]);
    const sinceBefore = items(await (await feed(`?since=${encodeURIComponent(minutes(3999).toISOString())}`)).text()).find((i) => i.id === `p-${t.id}`);
    expect(sinceBefore).toMatchObject({ change: "created" });
  });

  it("answers 400 invalid_cursor for a malformed cursor, still 400 invalid_since, carries ?k= and the header and footer fields", async () => {
    for (const bad of ["abc", "2026-10-01T00:20:00Z_1", "2026-10-01T00:20:00.000Z_0"]) {
      const res = await feed(`?cursor=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
      expect(await res.text()).toContain("invalid_cursor");
    }
    const res = await feed(`?since=nope&cursor=${encodeURIComponent("2026-10-01T00:20:00.000Z_1")}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid_since");
    const md = await buildChangesMarkdown(h.db, { since: null, cursor: { at: minutes(3000), id: 1 }, k: "tml_read_x" });
    const blocks = parseBlocks(md);
    expect(blocks[0].fm).toMatchObject({ type: "index", title: "Changes", cursor: `${minutes(3000).toISOString()}_1` });
    expect(blocks[0].fm).not.toHaveProperty("since");
    expect(new URL(String(blocks.at(-1)!.fm.next)).searchParams.get("k")).toBe("tml_read_x");
  });
});
