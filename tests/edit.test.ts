

import { asc, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, entryRevisions, jobs, translations, user } from "~/lib/db/schema";
import { createReply, createTopic, editEntry, getEditableEntry, getThread } from "~/lib/entries.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import * as markdown from "~/lib/markdown.server";
import { createProfile } from "~/lib/profiles.server";
import { sourceHash } from "~/lib/source-hash.server";
import { createTestDb } from "./helpers/db";

async function addMember(db: Db, id: string, handle: string) {
  await db.insert(user).values({ id, name: "", email: `${id}@example.com`, emailVerified: true });
  await createProfile(db, id, { handle, homeArea: "ja", readLangs: ["ja"] });
}

async function setup() {
  const db = await createTestDb();
  await addMember(db, "u1", "hana");
  await addMember(db, "u2", "somchai");
  const topic = await createTopic(db, "u1", { lang: "ja", title: "元の題", body: "元の本文" });
  if (!topic.ok) throw new Error("topic failed");
  const reply = await createReply(db, "u1", topic.id, { lang: "ja", body: "元の返信" });
  if (!reply.ok) throw new Error("reply failed");
  return { db, topicId: topic.id, replyId: reply.id };
}

const revisionsOf = (db: Db, entryId: number) =>
  db.select().from(entryRevisions).where(eq(entryRevisions.entryId, entryId)).orderBy(asc(entryRevisions.id));

const t1 = new Date("2026-10-02T00:00:00Z");
const t2 = new Date("2026-10-03T00:00:00Z");

describe("getEditableEntry and the question attributes", () => {
  it("tells whether the post is a question, whether it is locked, its mark and whether its topic is a question", async () => {
    const { db, topicId, replyId } = await setup();
    expect(await getEditableEntry(db, "u1", topicId, { kind: "topic" })).toMatchObject({ ok: true, entry: { asksStance: false, locked: false, stanceTag: null, threadAsksStance: false, mode: "author" } });
    const q = await createTopic(db, "u1", { lang: "ja", title: "問い", body: "本文", asksStance: true });
    if (!q.ok) throw new Error("question failed");
    const r = await createReply(db, "u2", q.id, { lang: "ja", body: "返信", stanceTag: "agree" });
    if (!r.ok) throw new Error("reply failed");
    expect(await getEditableEntry(db, "u1", q.id, { kind: "topic" })).toMatchObject({ ok: true, entry: { asksStance: true, locked: false, threadAsksStance: true, mode: "author" } });
    expect(await getEditableEntry(db, "u2", r.id, { kind: "reply" })).toMatchObject({ ok: true, entry: { asksStance: false, stanceTag: "agree", threadAsksStance: true, locked: false, mode: "author" } });
    expect(await getEditableEntry(db, "u1", replyId, { kind: "reply" })).toMatchObject({ ok: true, entry: { threadAsksStance: false, stanceTag: null } });
    // Set the lock column directly: the author becomes author-locked; other members remain forbidden.
    await db.update(entries).set({ stanceLockedAt: t1 }).where(eq(entries.id, q.id));
    expect(await getEditableEntry(db, "u1", q.id, { kind: "topic" })).toMatchObject({ ok: true, entry: { locked: true, mode: "author-locked" } });
    expect(await getEditableEntry(db, "u2", q.id, { kind: "topic" })).toEqual({ ok: false, error: "forbidden" });
  });

  it("keeps the edit of a reply and of an ordinary topic working as before, and an ordinary topic reads as not locked", async () => {
    const { db, topicId, replyId } = await setup();
    expect(await editEntry(db, "u1", replyId, { body: "直した返信" }, { kind: "reply", now: t1 })).toEqual({ ok: true, id: replyId, threadId: topicId, changed: true });
    expect(await editEntry(db, "u1", topicId, { title: "直した題", body: "直した本文" }, { kind: "topic", now: t2 })).toMatchObject({ ok: true, changed: true });
    expect((await getThread(db, topicId))?.topic).toMatchObject({ asksStance: false, altOf: null, stanceLocked: false });
  });
});

describe("editEntry", () => {
  it("returns body_unrenderable without changing the entry or its revisions when rendering fails", async () => {
    const { db, topicId } = await setup();
    const before = await db.select().from(entries).orderBy(asc(entries.id));
    const spy = vi.spyOn(markdown, "checkBodyBudget").mockResolvedValue("body_unrenderable");
    try {
      expect(await editEntry(db, "u1", topicId, { title: "New title", body: "New body" })).toEqual({ ok: false, error: "body_unrenderable" });
      expect(spy).toHaveBeenCalledWith("New body", "u1");
      expect(await db.select().from(entries).orderBy(asc(entries.id))).toEqual(before);
      expect(await revisionsOf(db, topicId)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("lets the author edit a topic, keeping the previous version as a revision", async () => {
    const { db, topicId } = await setup();
    const res = await editEntry(db, "u1", topicId, { title: "新しい題", body: "新しい本文" }, { now: t1 });
    expect(res).toEqual({ ok: true, id: topicId, threadId: topicId, changed: true });
    const thread = await getThread(db, topicId);
    expect(thread?.topic).toMatchObject({ title: "新しい題", body: "新しい本文", lang: "ja" });
    expect(thread?.topic.editedAt?.toISOString()).toBe(t1.toISOString());
    expect(thread?.topic.html).toContain("新しい本文");
    const revs = await revisionsOf(db, topicId);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ entryId: topicId, title: "元の題", body: "元の本文", editorId: "u1" });
    expect(revs[0].editedAt.toISOString()).toBe(t1.toISOString());
  });

  it("keeps one revision per edit, each holding the version it replaced", async () => {
    const { db, topicId } = await setup();
    await editEntry(db, "u1", topicId, { title: "題2", body: "本文2" }, { now: t1 });
    await editEntry(db, "u1", topicId, { title: "題3", body: "本文3" }, { now: t2 });
    const revs = await revisionsOf(db, topicId);
    expect(revs.map((r) => [r.title, r.body])).toEqual([
      ["元の題", "元の本文"],
      ["題2", "本文2"],
    ]);
    const [row] = await db.select().from(entries).where(eq(entries.id, topicId));
    expect(row).toMatchObject({ title: "題3", body: "本文3" });
    expect(row.editedAt?.toISOString()).toBe(t2.toISOString());
  });

  it("edits a reply's body only", async () => {
    const { db, topicId, replyId } = await setup();
    const res = await editEntry(db, "u1", replyId, { title: "ignored", body: "直した返信" }, { now: t1 });
    expect(res).toEqual({ ok: true, id: replyId, threadId: topicId, changed: true });
    const thread = await getThread(db, topicId);
    expect(thread?.replies[0]).toMatchObject({ body: "直した返信", title: null });
    expect(thread?.replies[0].editedAt).not.toBeNull();
    // The topic was not edited.
    expect(thread?.topic.editedAt).toBeNull();
    const revs = await revisionsOf(db, replyId);
    expect(revs.map((r) => [r.title, r.body])).toEqual([[null, "元の返信"]]);
  });

  it("does not let anyone but the author edit, and changes nothing", async () => {
    const { db, topicId, replyId } = await setup();
    expect(await editEntry(db, "u2", topicId, { title: "乗っ取り", body: "x" })).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await editEntry(db, "u2", replyId, { body: "x" })).toEqual({ ok: false, error: "forbidden" });
    expect(await getEditableEntry(db, "u2", topicId)).toEqual({ ok: false, error: "forbidden" });
    const thread = await getThread(db, topicId);
    expect(thread?.topic).toMatchObject({ title: "元の題", body: "元の本文", editedAt: null });
    expect(thread?.replies[0]).toMatchObject({ body: "元の返信", editedAt: null });
    expect(await revisionsOf(db, topicId)).toEqual([]);
    expect(await revisionsOf(db, replyId)).toEqual([]);
  });

  it("checks ownership before looking at the input", async () => {
    const { db, topicId } = await setup();
    expect(await editEntry(db, "u2", topicId, { title: "", body: "" })).toEqual({ ok: false, error: "forbidden" });
  });

  it("reports missing, deleted and wrong-kind entries as not_found", async () => {
    const { db, topicId, replyId } = await setup();
    expect(await editEntry(db, "u1", 99999, { title: "t", body: "b" })).toEqual({ ok: false, error: "not_found" });
    expect(await editEntry(db, "u1", replyId, { body: "b" }, { kind: "topic" })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await editEntry(db, "u1", topicId, { title: "t", body: "b" }, { kind: "reply" })).toEqual({
      ok: false,
      error: "not_found",
    });
    await db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, replyId));
    expect(await editEntry(db, "u1", replyId, { body: "b" })).toEqual({ ok: false, error: "not_found" });
    expect(await getEditableEntry(db, "u1", replyId)).toEqual({ ok: false, error: "not_found" });
  });

  it("validates like creation and leaves the entry untouched on failure", async () => {
    const { db, topicId, replyId } = await setup();
    expect(await editEntry(db, "u1", topicId, { title: "t".repeat(201), body: "b" })).toEqual({
      ok: false,
      error: "invalid_title",
    });
    expect(await editEntry(db, "u1", topicId, { title: "t", body: " \n" })).toEqual({
      ok: false,
      error: "body_required",
    });
    expect(await editEntry(db, "u1", replyId, { body: "" })).toEqual({ ok: false, error: "body_required" });
    const thread = await getThread(db, topicId);
    expect(thread?.topic).toMatchObject({ title: "元の題", body: "元の本文", editedAt: null });
    expect(thread?.replies[0].body).toBe("元の返信");
    expect(await revisionsOf(db, topicId)).toEqual([]);
    expect(await revisionsOf(db, replyId)).toEqual([]);
  });

  it("does not record anything when nothing changed", async () => {
    const { db, topicId } = await setup();
    const res = await editEntry(db, "u1", topicId, { title: "元の題", body: "元の本文" });
    expect(res).toEqual({ ok: true, id: topicId, threadId: topicId, changed: false });
    expect((await getThread(db, topicId))?.topic.editedAt).toBeNull();
    expect(await revisionsOf(db, topicId)).toEqual([]);
  });

  it("revises a language-only edit and discards every translation before queuing from the corrected language", async () => {
    const { db, topicId, replyId } = await setup();
    for (const id of [topicId, replyId]) {
      const [before] = await db.select().from(entries).where(eq(entries.id, id));
      await db.insert(translations).values(["primary", "secondary", "human"].map(kind => ({ entryId: id, field: "body", lang: "en", kind, text: "Old translation", sourceHash: before.sourceHash })));
      expect(await editEntry(db, "u1", id, { title: before.title, body: before.body, lang: "en" }, { now: t1 })).toMatchObject({ ok: true, changed: true });
      expect((await db.select().from(entries).where(eq(entries.id, id)))[0]).toMatchObject({ lang: "en", mentionRevision: 1 });
      expect(await revisionsOf(db, id)).toHaveLength(1);
      expect(await db.select().from(translations).where(eq(translations.entryId, id))).toEqual([]);
      const queued = (await db.select().from(jobs)).filter(j => j.status === "queued" && j.kind === "translate_entry" && (j.payload as { entryId: number }).entryId === id);
      expect(queued.length).toBeGreaterThan(0);
      expect(queued.every(j => (j.payload as { lang: string }).lang !== "en")).toBe(true);
      expect(queued.every(j => j.dedupeKey?.includes(":en:"))).toBe(true);
    }
  });

  it("rejects disabled languages and language-only edits to pinned questions", async () => {
    const { db, topicId, replyId } = await setup();
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    try {
      for (const id of [topicId, replyId]) {
        for (const lang of ["vi", "unknown"]) {
          expect(await editEntry(db, "u1", id, { title: "元の題", body: "元の本文", lang })).toEqual({ ok: false, error: "invalid_lang" });
        }
      }
      await db.update(entries).set({ asksStance: true, stanceLockedAt: t1 }).where(eq(entries.id, topicId));
      expect(await editEntry(db, "u1", topicId, { title: "元の題", body: "元の本文", lang: "en" })).toEqual({ ok: false, error: "locked" });
    } finally { vi.unstubAllEnvs(); }
  });

  it("stores the body as submitted, like creation", async () => {
    const { db, topicId } = await setup();
    const body = "    indented code\n\ntext  \n\n";
    await editEntry(db, "u1", topicId, { title: "t", body });
    expect((await getThread(db, topicId))?.topic.body).toBe(body);
  });

  it("re-renders the cached html with the entry's footnote prefix", async () => {
    const { db, topicId, replyId } = await setup();
    await editEntry(db, "u1", topicId, { title: "t", body: "新[^1]\n\n[^1]: 注" });
    await editEntry(db, "u1", replyId, { body: "新[^1]\n\n[^1]: 注" });
    const rows = await db
      .select({ id: entries.id, html: entries.html, htmlVersion: entries.htmlVersion })
      .from(entries)
      .orderBy(asc(entries.id));
    expect(rows[0].html).toContain(`p-${topicId}-`);
    expect(rows[1].html).toContain(`c-${replyId}-`);
    expect(rows.map((r) => r.htmlVersion)).toEqual([RENDER_VERSION, RENDER_VERSION]);
  });
});

describe("source hash", () => {
  it("is set when posting and updated by an edit", async () => {
    const { db, topicId, replyId } = await setup();
    const hashes = async () =>
      (await db.select({ id: entries.id, h: entries.sourceHash }).from(entries).orderBy(asc(entries.id))).map(
        (r) => r.h,
      );
    expect(await hashes()).toEqual([sourceHash("元の題", "元の本文", "ja"), sourceHash(null, "元の返信", "ja")]);
    await editEntry(db, "u1", topicId, { title: "元の題", body: "直した本文" });
    await editEntry(db, "u1", replyId, { body: "直した返信" });
    expect(await hashes()).toEqual([sourceHash("元の題", "直した本文", "ja"), sourceHash(null, "直した返信", "ja")]);
  });

  it("tells titles and bodies apart", () => {
    expect(sourceHash("a", "b\nc")).not.toBe(sourceHash("a\nb", "c"));
    expect(sourceHash("", "x")).toBe(sourceHash(null, "x"));
    expect(sourceHash("t", "b")).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceHash("t", "b", "ja")).not.toBe(sourceHash("t", "b", "en"));
  });
});
