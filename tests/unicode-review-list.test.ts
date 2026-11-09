import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, villages } from "~/lib/db/schema";
import { listUnicodeReviewCandidates, parseUnicodeReviewCursor } from "~/lib/unicode-review-list.server";
import { UNICODE_REVIEW_PAGE_SIZE, UNICODE_REVIEW_SCAN_LIMIT } from "~/lib/unicode-review";
import type { ModScope } from "~/lib/roles.server";
import { addMember, createTestDb } from "./helpers/db";

const NOW = new Date("2026-10-25T00:00:00Z");
const DAY = 86_400_000;
const RLO = "‮";
const TAGS = String.fromCodePoint(0xe0041, 0xe0042, 0xe0043);
const operator: ModScope = { operator: true, langs: [] };

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
  await addMember(db, "writer", "writer");
  await addMember(db, "mod", "checker");
});

let tick = 0;
// Each case works in its own thread and sets the time of its posts itself, so the cases do not see one another.
async function topic(over: Partial<typeof entries.$inferInsert> = {}, daysAgo = 1) {
  const at = new Date(NOW.getTime() - daysAgo * DAY + tick++ * 1000);
  const [row] = await db.insert(entries).values({ kind: "topic", authorId: "writer", lang: "ja", title: "題", body: "本文", createdAt: at, updatedAt: at, ...over }).returning();
  return row;
}
async function reply(threadId: number, over: Partial<typeof entries.$inferInsert> = {}, daysAgo = 1) {
  const at = new Date(NOW.getTime() - daysAgo * DAY + tick++ * 1000);
  const [row] = await db.insert(entries).values({ kind: "reply", threadId, authorId: "writer", lang: "ja", body: "返信", createdAt: at, updatedAt: at, ...over }).returning();
  return row;
}
const list = (scope = operator, extra: Parameters<typeof listUnicodeReviewCandidates>[2] = {}) => listUnicodeReviewCandidates(db, scope, { now: NOW, ...extra });

describe("posts with format characters for a moderator to check", () => {
  it("lists a matching topic and reply with their language and the count of each reason, newest first, and leaves out the rest", async () => {
    const t = await topic({ title: `題${RLO}`, body: "本文" });
    const r = await reply(t.id, { body: `返信${TAGS}${RLO}`, lang: "th" }, 0.5);
    const clean = await topic({ body: "ordinary ‌marks 👨‍👩" });
    const { items, cursor, scanLimited } = await list();
    const mine = items.filter((i) => [t.id, r.id, clean.id].includes(i.entryId));
    expect(mine).toEqual([
      { entryId: r.id, kind: "reply", threadId: t.id, lang: "th", counts: { bidi_control: 1, tag_characters: 3 } },
      { entryId: t.id, kind: "topic", threadId: t.id, lang: "ja", counts: { bidi_control: 1 } },
    ]);
    // Neither the matched characters nor any part of the text is in the item.
    expect(JSON.stringify(items)).not.toContain("返信");
    expect([cursor, scanLimited]).toEqual([null, false]);
  });

  it("covers the last 30 days by the time of the last update (an edit brings an old post back)", async () => {
    const old = await topic({ body: `old${RLO}` }, 31);
    const edge = await topic({ body: `edge${RLO}` }, 29.9);
    const edited = await topic({ body: `edited${RLO}` }, 40);
    await db.update(entries).set({ editedAt: new Date(NOW.getTime() - DAY) }).where(eq(entries.id, edited.id));
    const ids = (await list()).items.map((i) => i.entryId);
    expect(ids).toContain(edge.id);
    expect(ids).toContain(edited.id);
    expect(ids).not.toContain(old.id);
  });

  it("looks only at posts anyone could read: not deleted, not hidden, in a topic that is neither, in no closed village", async () => {
    const deleted = await topic({ body: `deleted${RLO}`, deletedAt: NOW });
    const hidden = await topic({ body: `hidden${RLO}`, hiddenAt: NOW });
    const live = await topic({ body: "live" });
    const underHidden = await reply(hidden.id, { body: `under hidden${RLO}` });
    const underDeleted = await reply(deleted.id, { body: `under deleted${RLO}` });
    const hiddenReply = await reply(live.id, { body: `hidden reply${RLO}`, hiddenAt: NOW });
    const deletedReply = await reply(live.id, { body: `deleted reply${RLO}`, deletedAt: NOW });
    const [closed] = await db.insert(villages).values({ kind: "closed", slug: "review-closed" }).returning();
    const inClosed = await topic({ body: `closed${RLO}`, villageId: closed.id });
    const replyInClosed = await reply(inClosed.id, { body: `closed reply${RLO}` });
    const visible = await reply(live.id, { body: `visible${RLO}` });
    const ids = (await list()).items.map((i) => i.entryId);
    for (const gone of [deleted, hidden, underHidden, underDeleted, hiddenReply, deletedReply, inClosed, replyInClosed]) expect(ids, gone.body).not.toContain(gone.id);
    expect(ids).toContain(visible.id);
  });

  it("keeps the moderator's assigned languages, leaves out the moderator's own posts, and gives nothing to a member with no scope", async () => {
    const ja = await topic({ body: `ja${RLO}`, lang: "ja" });
    const th = await topic({ body: `th${RLO}`, lang: "th" });
    const own = await topic({ body: `own${RLO}`, authorId: "mod" });
    const scoped = await list({ operator: false, langs: ["th"] }, { viewerId: "mod" });
    expect(scoped.items.map((i) => i.entryId)).toContain(th.id);
    expect(scoped.items.map((i) => i.entryId)).not.toContain(ja.id);
    const all = (await list(operator, { viewerId: "mod" })).items.map((i) => i.entryId);
    expect(all).toContain(ja.id);
    expect(all).not.toContain(own.id);
    expect(await list({ operator: false, langs: [] })).toEqual({ items: [], cursor: null, scanLimited: false });
  });
});

describe("how much one request reads", () => {
  it("shows 50 matches at most and continues from the 50th with no row skipped or repeated", async () => {
    const owner = await db.insert(entries).values({ kind: "topic", authorId: "writer", lang: "ko", title: "t", body: "b", createdAt: new Date(NOW.getTime() - 2 * DAY), updatedAt: new Date(NOW.getTime() - 2 * DAY) }).returning();
    const base = NOW.getTime() - DAY;
    const rows = await db.insert(entries).values(Array.from({ length: 120 }, (_, i) => ({ kind: "reply", threadId: owner[0].id, authorId: "writer", lang: "ko", body: `x${RLO}${i}`, createdAt: new Date(base + i * 1000), updatedAt: new Date(base + i * 1000) }))).returning({ id: entries.id });
    const scope: ModScope = { operator: false, langs: ["ko"] };
    const seen: number[] = [];
    let cursor: string | null = null;
    let requests = 0;
    do {
      const page = await list(scope, { cursor: parseUnicodeReviewCursor(cursor) });
      expect(page.items.length).toBeLessThanOrEqual(UNICODE_REVIEW_PAGE_SIZE);
      if (cursor === null) expect(page.items).toHaveLength(UNICODE_REVIEW_PAGE_SIZE);
      seen.push(...page.items.map((i) => i.entryId));
      cursor = page.cursor;
      requests++;
    } while (cursor && requests < 5);
    expect(requests).toBe(3);
    expect(seen).toEqual(rows.map((r) => r.id).reverse());
  });

  it("stops after 500 rows, says it did, and offers the rest", async () => {
    const [owner] = await db.insert(entries).values({ kind: "topic", authorId: "writer", lang: "vi", title: "t", body: "b", createdAt: new Date(NOW.getTime() - 3 * DAY), updatedAt: new Date(NOW.getTime() - 3 * DAY) }).returning();
    const base = NOW.getTime() - 2 * DAY;
    // 520 plain replies written later than the one match: the newest 500 hold no match.
    const [match] = await db.insert(entries).values({ kind: "reply", threadId: owner.id, authorId: "writer", lang: "vi", body: `match${RLO}`, createdAt: new Date(base), updatedAt: new Date(base) }).returning();
    await db.insert(entries).values(Array.from({ length: 520 }, (_, i) => ({ kind: "reply", threadId: owner.id, authorId: "writer", lang: "vi", body: `plain ${i}`, createdAt: new Date(base + (i + 1) * 1000), updatedAt: new Date(base + (i + 1) * 1000) })));
    const scope: ModScope = { operator: false, langs: ["vi"] };
    const first = await list(scope);
    expect(first.items).toEqual([]);
    expect(first.scanLimited).toBe(true);
    expect(first.cursor).not.toBeNull();
    const second = await list(scope, { cursor: parseUnicodeReviewCursor(first.cursor) });
    expect(second.items.map((i) => i.entryId)).toEqual([match.id]);
    expect([second.cursor, second.scanLimited]).toEqual([null, false]);
    expect(UNICODE_REVIEW_SCAN_LIMIT).toBe(500);
  });

  it("accepts only a cursor it wrote", () => {
    expect(parseUnicodeReviewCursor("2026-10-24T00:00:00.123456Z_12")).toEqual({ at: "2026-10-24T00:00:00.123456Z", id: 12 });
    for (const bad of [null, "", "12", "2026-10-24_12", "2026-10-24T00:00:00.123456Z_0", "2026-10-24T00:00:00.123456Z_x", "x'; drop table entries;--_1"]) expect(parseUnicodeReviewCursor(bad), String(bad)).toBeNull();
  });
});
