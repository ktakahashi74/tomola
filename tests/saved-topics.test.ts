import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteAccount } from "~/lib/account-delete.server";
import { entries, follows, notifications, profiles, savedTopics, translations, user, villages, votes } from "~/lib/db/schema";
import { buildMemberExport, buildObservationExport, MEMBER_EXPORT_VERSION } from "~/lib/exports.server";
import { isTopicSaved, listSavedTopics, setTopicSaved } from "~/lib/saved-topics.server";
import { seedRateLimit } from "./helpers/fixtures";
import { MEMBER_RATE_LIMITS } from "~/lib/rate-limit.server";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

const FIRST = new Date("2026-10-01T00:00:00Z");
const LATER = new Date("2026-10-02T00:00:00Z");
const viewer = (userId: string) => ({ userId, scope: { operator: false, langs: [] } });
async function world() {
  const db = await createTestDb();
  for (const id of ["reader_a", "reader_b", "author"]) await addMember(db, id, id);
  const [topic] = await db.insert(entries).values({ kind: "topic", authorId: "author", lang: "ja", title: "Current title", body: "Current body" }).returning();
  return { db, topic };
}

describe("private saved topics", () => {
  it("is idempotent, preserves the original save time, and changes no public activity", async () => {
    const { db, topic } = await world();
    await setTopicSaved(db, "reader_a", topic.id, true, { now: FIRST });
    await setTopicSaved(db, "reader_a", topic.id, true, { now: LATER });
    expect(await db.select().from(savedTopics)).toEqual([{ userId: "reader_a", topicId: topic.id, createdAt: FIRST }]);
    for (const table of [follows, notifications, votes]) expect(await db.select().from(table)).toEqual([]);
    expect((await db.select().from(entries))[0]).toEqual(topic);
    await setTopicSaved(db, "reader_a", topic.id, false);
    expect(await setTopicSaved(db, "reader_a", topic.id, false)).toEqual({ ok: true, saved: false });
    expect(await isTopicSaved(db, "reader_a", topic.id)).toBe(false);
  });

  it("isolates accounts, orders by save time with stable ties, and filters before pagination", async () => {
    const { db, topic } = await world();
    const made = await db.insert(entries).values(Array.from({ length: 4 }, (_, i) => ({ kind: "topic", authorId: "author", lang: "ja", body: `Remark ${i}` }))).returning();
    const [older, newest, hidden, deleted] = made;
    for (const row of [topic, older, newest, hidden, deleted]) await setTopicSaved(db, "reader_a", row.id, true, { now: row.id === topic.id ? FIRST : LATER });
    await setTopicSaved(db, "reader_b", topic.id, true);
    await db.update(entries).set({ hiddenAt: LATER }).where(eq(entries.id, hidden.id));
    await db.update(entries).set({ deletedAt: LATER }).where(eq(entries.id, deleted.id));
    const first = await listSavedTopics(db, "reader_a", { limit: 2 });
    expect(first.topics.map(row => row.id)).toEqual([newest.id, older.id]);
    expect(first.hasNext).toBe(true);
    expect((await listSavedTopics(db, "reader_a", { page: 2, limit: 2 })).topics.map(row => row.id)).toEqual([topic.id]);
    expect((await listSavedTopics(db, "reader_b")).topics.map(row => row.id)).toEqual([topic.id]);
    await setTopicSaved(db, "reader_b", newest.id, false);
    expect(await isTopicSaved(db, "reader_a", newest.id)).toBe(true);
  });

  it("rejects replies, missing, deleted, hidden and closed-village topics; permits erasure after access is lost", async () => {
    const { db, topic } = await world();
    const [reply] = await db.insert(entries).values({ kind: "reply", threadId: topic.id, authorId: "author", lang: "ja", body: "Reply" }).returning();
    for (const id of [reply.id, 999999]) expect(await setTopicSaved(db, "reader_a", id, true)).toEqual({ ok: false, error: "not_found" });
    await setTopicSaved(db, "reader_a", topic.id, true);
    await db.update(entries).set({ hiddenAt: LATER }).where(eq(entries.id, topic.id));
    expect(await setTopicSaved(db, "reader_b", topic.id, true, { viewer: viewer("author") })).toMatchObject({ ok: false });
    expect(await setTopicSaved(db, "author", topic.id, true, { viewer: viewer("author") })).toMatchObject({ ok: true });
    expect((await listSavedTopics(db, "reader_a")).topics).toEqual([]);
    expect(await setTopicSaved(db, "reader_a", topic.id, false)).toMatchObject({ ok: true });
    const [village] = await db.insert(villages).values({ name: "Closed", slug: "saved-closed", kind: "closed", createdBy: "author" }).returning();
    await db.update(entries).set({ hiddenAt: null, villageId: village.id }).where(eq(entries.id, topic.id));
    expect(await setTopicSaved(db, "reader_a", topic.id, true)).toMatchObject({ ok: false });
    expect((await listSavedTopics(db, "author", { viewer: viewer("author") })).topics).toEqual([]);
    await db.update(entries).set({ villageId: null, deletedAt: LATER }).where(eq(entries.id, topic.id));
    expect(await setTopicSaved(db, "reader_a", topic.id, true)).toMatchObject({ ok: false });
    expect(await setTopicSaved(db, "author", topic.id, false)).toMatchObject({ ok: true });
  });

  it("exports only one's own IDs and times, including unavailable IDs without their content; observation never changes", async () => {
    const { db, topic } = await world();
    const before = await buildObservationExport(db, { model: null, now: FIRST, salt: Buffer.alloc(32) });
    await setTopicSaved(db, "reader_a", topic.id, true, { now: FIRST });
    expect(await buildObservationExport(db, { model: null, now: FIRST, salt: Buffer.alloc(32) })).toEqual(before);
    await db.update(entries).set({ hiddenAt: LATER }).where(eq(entries.id, topic.id));
    const mine = await buildMemberExport(db, "reader_a");
    expect(mine.version).toBe(MEMBER_EXPORT_VERSION);
    expect(mine.saved_topics).toEqual([{ topic_id: topic.id, created_at: FIRST.toISOString() }]);
    expect(JSON.stringify(mine)).not.toContain("Current title");
    expect(JSON.stringify(mine)).not.toContain("Current body");
    expect((await buildMemberExport(db, "reader_b")).saved_topics).toEqual([]);
  });

  it("removes rows when a topic or member is physically deleted", async () => {
    const { db, topic } = await world();
    await setTopicSaved(db, "reader_a", topic.id, true);
    await setTopicSaved(db, "reader_b", topic.id, true);
    await db.delete(user).where(eq(user.id, "reader_a"));
    expect(await db.select().from(savedTopics)).toMatchObject([{ userId: "reader_b" }]);
    await db.delete(entries).where(eq(entries.id, topic.id));
    expect(await db.select().from(savedTopics)).toEqual([]);
  });

  it("erases the saved list on account withdrawal while preserving other accounts' lists", async () => {
    const { db, topic } = await world();
    await setTopicSaved(db, "reader_a", topic.id, true);
    await setTopicSaved(db, "reader_b", topic.id, true);
    await deleteAccount(db, "reader_a", { confirmation: "reader_a", posts: "keep" });
    expect(await db.select().from(savedTopics)).toEqual([{ userId: "reader_b", topicId: topic.id, createdAt: expect.any(Date) }]);
  });
});

describe("saved-list routes", () => {
  let h: RouteHarness;
  let topicId: number;
  beforeAll(async () => {
    h = await setupRouteHarness();
    for (const name of ["save_a", "save_b"]) await h.signIn(name, { homeArea: "en", readLangs: ["en"] });
    await h.signIn("save_half", { profile: false });
    const [topic] = await h.db.insert(entries).values({ kind: "topic", authorId: h.ids.save_b, lang: "ja", title: "Original", body: "Original body", sourceHash: "source" }).returning();
    topicId = topic.id;
  });
  afterAll(() => h.restore());
  const post = async (as?: string, form: Record<string, string> = { topicId: String(topicId), saved: "1" }, headers?: Record<string, string>) => {
    const mod = await import("~/routes/save");
    return h.outcome(() => mod.action(h.args(h.request("/save", { as, form, headers }))));
  };

  it("requires same origin and an authenticated member; validates IDs and explicit target states", async () => {
    expect((await post("save_a", undefined, { origin: "https://elsewhere.invalid" })).status).toBe(403);
    expect((await post()).status).toBe(302);
    expect((await post("save_half")).location).toBe("/onboarding");
    for (const topicId of ["0", "-1", "1.2", "9007199254740992", "invalid"]) expect((await post("save_a", { topicId, saved: "1" })).status).toBe(400);
    expect((await post("save_a", { topicId: String(topicId), saved: "toggle" })).status).toBe(400);
    expect((await post("save_a", { topicId: "999999", saved: "1" })).status).toBe(404);
    const mod = await import("~/routes/save");
    expect((await h.outcome(() => mod.action(h.args(new Request("http://localhost:5173/save", { method: "DELETE", headers: { origin: "http://localhost:5173" } }))))).status).toBe(405);
  });

  it("takes identity only from the session, returns private no-store, and allows suspended members to control their list", async () => {
    // Saved reading is private and never publishes, so suspension and optional
    // post signatures do not remove this member's right to save or erase rows.
    await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86400000), signPosts: true }).where(eq(profiles.userId, h.ids.save_a));
    const res = await post("save_a", { topicId: String(topicId), saved: "1", userId: h.ids.save_b });
    expect(res.status).toBe(200);
    expect((res.value as { init: { headers: unknown } }).init.headers).toEqual({ "Cache-Control": "private, no-store" });
    expect(await isTopicSaved(h.db, h.ids.save_a, topicId)).toBe(true);
    expect(await isTopicSaved(h.db, h.ids.save_b, topicId)).toBe(false);
    await post("save_b", { topicId: String(topicId), saved: "0", userId: h.ids.save_a });
    expect(await isTopicSaved(h.db, h.ids.save_a, topicId)).toBe(true);
    expect((await post("save_a", { topicId: String(topicId), saved: "0" })).status).toBe(200);
    await h.db.update(profiles).set({ suspendedUntil: null, signPosts: false }).where(eq(profiles.userId, h.ids.save_a));
  });

  it("loads current translations and edits, isolates loaders, and redirects an emptied later page with its reading language", async () => {
    const { loader } = await import("~/routes/saved");
    await post("save_a");
    const read = async (as: string, query = "?lang=en") => {
      const result = await loader(h.args(h.request(`/saved${query}`, { as })));
      return result.data;
    };
    await h.db.insert(translations).values({ entryId: topicId, field: "title", lang: "en", kind: "primary", text: "Fresh translation", sourceHash: "source" });
    expect((await read("save_a")).topics[0].title.text).toBe("Fresh translation");
    await h.db.update(translations).set({ text: "Edited translation" }).where(and(eq(translations.entryId, topicId), eq(translations.field, "title")));
    expect((await read("save_a")).topics[0].title.text).toBe("Edited translation");
    await h.db.update(entries).set({ title: "Edited original" }).where(eq(entries.id, topicId));
    expect((await read("save_a", "?lang=ja")).topics[0].title.text).toBe("Edited original");
    expect((await read("save_b")).topics).toEqual([]);
    expect((await h.outcome(() => loader(h.args(h.request("/saved?page=2&lang=en", { as: "save_a" }))))).location).toBe("/saved?page=1&lang=en");
    await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, topicId));
    expect((await read("save_a")).topics).toEqual([]);
    expect((await post("save_a", { topicId: String(topicId), saved: "0" })).status).toBe(200);
    expect((await h.outcome(() => loader(h.args(h.request("/saved"))))).status).toBe(302);
  });

  it("enforces the per-member operation limit", async () => {
    await seedRateLimit(h.db, `member:save:${h.ids.save_a}`, MEMBER_RATE_LIMITS.save);
    expect((await post("save_a")).status).toBe(429);
    expect((await post("save_b", { topicId: String(topicId), saved: "0" })).status).toBe(200);
  });
});
