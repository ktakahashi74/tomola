import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, handleHolds, profiles, translations } from "~/lib/db/schema";
import { createReply, createTopic, editEntry, softDeleteEntry } from "~/lib/entries.server";
import { loadMemberPageContent, resolveMemberPage, setIntroduction } from "~/lib/member-pages.server";
import { changeHandle } from "~/lib/profiles.server";
import { addMember, createTestDb } from "./helpers/db";

const now = new Date("2026-10-03T00:00:00Z");
const read = { viewerId: "viewer", readLangs: ["ja"] as const, displayLang: "en" as const, page: 1 };
async function setup() {
  const db = await createTestDb();
  await addMember(db, "owner", "hana");
  await addMember(db, "viewer", "amina");
  return db;
}
async function topic(db: Db, body = "本文", title: string | null = "題", asksStance = false) {
  const result = await createTopic(db, "owner", { lang: "ja", title: title ?? "", body, asksStance }, { now });
  if (!result.ok) throw new Error(result.error);
  return result.id;
}
async function member(db: Db) {
  const found = await resolveMemberPage(db, "hana", { now });
  if (!found) throw new Error("member missing");
  return found;
}

describe("member pages", () => {
  it("returns distinct lifetime body-language counts only to the author, excluding the source, titles and replies", async () => {
    const db = await setup();
    const id = await topic(db);
    const unseen = await topic(db, "未読の本文", "別の題");
    const reply = await createReply(db, "owner", unseen, { lang: "ja", body: "返信" }, { now });
    if (!reply.ok) throw new Error(reply.error);
    const base = { entryId: id, field: "body", kind: "primary", text: "Translation", sourceHash: "old-source", firstSeenAt: null, everSeen: true };
    await db.insert(translations).values([
      { ...base, lang: "en" },
      { ...base, lang: "en", kind: "human", createdBy: "viewer" },
      { ...base, lang: "fr" },
      { ...base, lang: "ja" },
      { ...base, lang: "de", everSeen: false },
      { ...base, lang: "ko", field: "title" },
      { ...base, entryId: unseen, lang: "en", field: "title" },
      { ...base, entryId: reply.id, lang: "en" },
    ]);
    const identity = await member(db);
    const owner = await loadMemberPageContent(db, identity, { ...read, viewerId: "owner" });
    expect(owner.topics.find(row => row.id === id)?.readLanguageCount).toBe(2);
    expect(owner.topics.find(row => row.id === unseen)).not.toHaveProperty("readLanguageCount");
    const other = await loadMemberPageContent(db, identity, read);
    expect(other.topics.map(row => row.id)).toEqual(owner.topics.map(row => row.id));
    expect(JSON.stringify(other)).not.toContain("readLanguageCount");
    expect(JSON.stringify(other)).not.toContain("everSeen");
  });

  it("resolves current names and active holds, rejects expired and invalid names, and includes suspended members", async () => {
    const db = await setup();
    expect(await resolveMemberPage(db, "hana", { now })).toMatchObject({ userId: "owner", handle: "hana", introEntryId: null });
    await changeHandle(db, "owner", "hanna", { now });
    expect(await resolveMemberPage(db, "hana", { now })).toMatchObject({ handle: "hanna", redirectTo: "/u/hanna" });
    expect(await resolveMemberPage(db, "hana", { now: new Date(now.getTime() + 90 * 86400000) })).toBeNull();
    for (const name of ["Hanna", "ｈａｎｎａ", "hanna.md", "h", "-hana", "missing"]) expect(await resolveMemberPage(db, name, { now })).toBeNull();
    await db.update(profiles).set({ suspendedUntil: new Date("2030-01-01") }).where(eq(profiles.userId, "owner"));
    expect(await resolveMemberPage(db, "hanna", { now })).toMatchObject({ handle: "hanna" });
    // A current owner wins over a legacy hold with the same spelling.
    await db.insert(handleHolds).values({ handleKey: "amina", userId: "owner", heldUntil: new Date("2030-01-01") });
    expect(await resolveMemberPage(db, "amina", { now })).toMatchObject({ userId: "viewer", handle: "amina" });
  });

  it("paginates twenty rows with stable newest-first ordering and excludes replies, hidden and deleted topics even for the owner", async () => {
    const db = await setup();
    const ids: number[] = [];
    for (let i = 0; i < 21; i++) ids.push(await topic(db, `本文${i}`, `題${i}`));
    const hidden = await topic(db, "hidden");
    const deleted = await topic(db, "deleted");
    await db.update(entries).set({ hiddenAt: now }).where(eq(entries.id, hidden));
    await db.update(entries).set({ deletedAt: now }).where(eq(entries.id, deleted));
    await createReply(db, "owner", ids[0], { lang: "ja", body: "返信" }, { now });
    await createTopic(db, "viewer", { lang: "ja", body: "他人" }, { now });
    const page = await loadMemberPageContent(db, await member(db), { ...read, viewerId: "owner" });
    expect(page.topics.map((row: { id: number }) => row.id)).toEqual(ids.slice(1).reverse());
    expect(page).toMatchObject({ own: true, page: 1, hasNext: true });
    const next = await loadMemberPageContent(db, await member(db), { ...read, page: 2 });
    expect(next.topics.map((row: { id: number }) => row.id)).toEqual([ids[0]]);
    expect(next.hasNext).toBe(false);
    expect(next.own).toBe(false);
    expect(Object.keys(page).sort()).toEqual(["avatarUrl", "handle", "hasDisplayName", "hasNext", "hasUploadedAvatar", "intro", "name", "nameLatin", "own", "page", "personal", "topics"]);
    expect(page).toMatchObject({ name: null, nameLatin: null, hasDisplayName: false });
    expect(Object.keys(page.topics[0]).sort()).toEqual(["createdAtISO", "id", "lang", "title"]);
  });

  it("replaces and unsets an introduction while rejecting other authors, replies, questions, deleted and hidden entries", async () => {
    const db = await setup();
    const first = await topic(db);
    const second = await topic(db, "次");
    expect(await setIntroduction(db, "owner", first)).toEqual({ ok: true });
    expect((await member(db)).introEntryId).toBe(first);
    expect(await setIntroduction(db, "owner", second)).toEqual({ ok: true });
    expect((await member(db)).introEntryId).toBe(second);
    expect(await setIntroduction(db, "viewer", first)).toEqual({ ok: false, error: "forbidden" });
    const reply = await createReply(db, "owner", first, { lang: "ja", body: "返信" }, { now });
    if (!reply.ok) throw new Error(reply.error);
    const question = await topic(db, "質問", "質問", true);
    const hidden = await topic(db);
    const deleted = await topic(db);
    await db.update(entries).set({ hiddenAt: now }).where(eq(entries.id, hidden));
    await db.update(entries).set({ deletedAt: now }).where(eq(entries.id, deleted));
    for (const id of [reply.id, question, hidden, deleted]) expect(await setIntroduction(db, "owner", id)).toEqual({ ok: false, error: "invalid_intro" });
    expect(await setIntroduction(db, "owner", 999999)).toEqual({ ok: false, error: "not_found" });
    expect((await member(db)).introEntryId).toBe(second);
    expect(await setIntroduction(db, "owner", null)).toEqual({ ok: true });
    expect((await member(db)).introEntryId).toBeNull();
    expect(await setIntroduction(db, "missing", null)).toEqual({ ok: false, error: "not_found" });
  });

  it("hides a selected introduction after moderation or deletion without clearing its designation", async () => {
    const db = await setup();
    const id = await topic(db);
    await setIntroduction(db, "owner", id);
    await db.update(entries).set({ hiddenAt: now }).where(eq(entries.id, id));
    expect((await loadMemberPageContent(db, await member(db), { ...read, viewerId: "owner" })).intro).toBeNull();
    await db.update(entries).set({ hiddenAt: null, deletedAt: now }).where(eq(entries.id, id));
    expect((await loadMemberPageContent(db, await member(db), read)).intro).toBeNull();
    expect((await member(db)).introEntryId).toBe(id);
  });

  it("clears the introduction foreign key when its topic is physically deleted", async () => {
    const db = await setup();
    const id = await topic(db);
    expect(await setIntroduction(db, "owner", id)).toEqual({ ok: true });
    // Remove post derivatives with their existing restrictive foreign keys before physical deletion.
    await softDeleteEntry(db, id, { now });
    expect((await member(db)).introEntryId).toBe(id);
    await db.delete(entries).where(eq(entries.id, id));
    const [profile] = await db.select({ introEntryId: profiles.introEntryId }).from(profiles).where(eq(profiles.userId, "owner"));
    expect(profile.introEntryId).toBeNull();
    expect((await loadMemberPageContent(db, await member(db), read)).intro).toBeNull();
  });

  it("loads full translated introductions with source and translated reading toggles, and translated titleless topic lines", async () => {
    const db = await setup();
    const id = await topic(db, "自己紹介 **全文**\n\n続き", null);
    await setIntroduction(db, "owner", id);
    const [source] = await db.select().from(entries).where(eq(entries.id, id));
    await db.insert(translations).values({ entryId: id, field: "body", lang: "en", kind: "primary", text: "Introduction **complete**\n\nRest", engine: "fake", model: "fake-1", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision });
    const opts = { ...read, readLangs: ["en"] as const };
    const page = await loadMemberPageContent(db, await member(db), opts);
    expect(page.intro).toMatchObject({ id, lang: "ja", title: null, headline: "自己紹介 全文" });
    expect(page.intro?.html).toContain("続き");
    expect(page.intro?.display).toMatchObject({ shown: "translation", pending: false });
    expect(page.intro?.display.translation?.html).toContain("Rest");
    expect(page.topics[0]).toMatchObject({ lang: "ja", title: { lang: "en", text: "Introduction complete", fromBody: true } });
    expect((await loadMemberPageContent(db, await member(db), { ...opts, forceOriginal: new Set([id]) })).intro?.display.shown).toBe("original");
    expect((await loadMemberPageContent(db, await member(db), { ...read, forceTranslation: new Set([id]) })).intro?.display.shown).toBe("translation");
    expect((await loadMemberPageContent(db, await member(db), read)).intro?.display.shown).toBe("original");
  });

  it("rebuilds introduction HTML from saved mention destinations after rename and name reuse", async () => {
    const db = await setup();
    const id = await topic(db, "@amina 自己紹介");
    await setIntroduction(db, "owner", id);
    const [person] = await db.select().from(profiles).where(eq(profiles.userId, "viewer"));
    await changeHandle(db, "viewer", "amina_now", { now });
    await addMember(db, "new", "new_member");
    await changeHandle(db, "new", "amina", { now: new Date(now.getTime() + 90 * 86400000) });
    await db.update(entries).set({ html: null, htmlVersion: 0 }).where(eq(entries.id, id));
    const page = await loadMemberPageContent(db, await member(db), read);
    expect(page.intro?.html).toContain(`/u/id/${person.publicId}`);
    const [saved] = await db.select().from(entries).where(eq(entries.id, id));
    expect(saved.html).toBe(page.intro?.html);
  });

  it("offers the older human translation separately from the current introduction", async () => {
    const db = await setup();
    const id = await topic(db, "前の自己紹介");
    await setIntroduction(db, "owner", id);
    const [old] = await db.select().from(entries).where(eq(entries.id, id));
    await db.insert(translations).values({ entryId: id, field: "body", lang: "en", kind: "human", text: "Older introduction", createdBy: "viewer", sourceHash: old.sourceHash, mentionRevision: old.mentionRevision });
    expect(await editEntry(db, "owner", id, { title: "題", body: "新しい自己紹介" })).toMatchObject({ ok: true });
    const [current] = await db.select().from(entries).where(eq(entries.id, id));
    await db.insert(translations).values({ entryId: id, field: "body", lang: "en", kind: "primary", text: "Current introduction", engine: "fake", model: "fake-1", sourceHash: current.sourceHash, mentionRevision: current.mentionRevision });
    const page = await loadMemberPageContent(db, await member(db), { ...read, readLangs: ["en"], forceOlder: new Set([id]) });
    expect(page.intro?.html).toContain("新しい自己紹介");
    expect(page.intro?.display.shown).toBe("older");
    expect(page.intro?.display.translation?.html).toContain("Current introduction");
    expect(page.intro?.display.translation?.older?.html).toContain("Older introduction");
    expect(Object.keys(page.intro!).sort()).toEqual(["display", "headline", "html", "id", "lang", "title"]);
  });
});
