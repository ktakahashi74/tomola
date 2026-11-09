import { asc, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as markdown from "~/lib/markdown.server";
import type { Db } from "~/lib/db/client.server";
import { drafts, entries, user } from "~/lib/db/schema";
import {
  createDraft,
  deleteDraft,
  getDraft,
  listDrafts,
  publishDraft,
  updateDraft,
} from "~/lib/drafts.server";
import { createReply, createTopic, getThread } from "~/lib/entries.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
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
  const topic = await createTopic(db, "u1", { lang: "ja", title: "話題", body: "本文" });
  if (!topic.ok) throw new Error("topic failed");
  return { db, topicId: topic.id };
}

const t0 = new Date("2026-10-01T00:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

const allEntries = (db: Db) => db.select().from(entries).orderBy(asc(entries.id));

describe("values that cannot be stored are refused, not thrown", () => {
  const nul = String.fromCodePoint(0);
  const bad = [
    ["NUL in the title", { title: `a${nul}b`, body: "b" }, "invalid_title"],
    ["newline in the title", { title: "a\nb", body: "b" }, "invalid_title"],
    ["control character in the title", { title: "a\u0007b", body: "b" }, "invalid_title"],
    ["C1 control in the title", { title: `a${String.fromCodePoint(0x85)}b`, body: "b" }, "invalid_title"],
    ["line separator in the title", { title: `a${String.fromCodePoint(0x2028)}b`, body: "b" }, "invalid_title"],
    ["paragraph separator in the title", { title: `a${String.fromCodePoint(0x2029)}b`, body: "b" }, "invalid_title"],
    ["NUL in the body", { title: "t", body: `a${nul}b` }, "body_unrenderable"],
  ] as const;

  it("refuses every unstorable field before accessing the database", async () => {
    // Any attempted read or write throws, so invalid fields cannot change a draft.
    const db = new Proxy({} as Db, { get() { throw new Error("Invalid draft fields must not access the database"); } });
    for (const [name, input, error] of bad) {
      expect(await createDraft(db, "u1", { kind: "topic", lang: "ja", ...input }), name).toEqual({ ok: false, error });
      expect(await updateDraft(db, "u1", 1, { lang: "ja", ...input }), name).toEqual({ ok: false, error });
    }
  });

  it("still accepts a tab in a title and an empty title or body (saved while writing)", async () => {
    const { db } = await setup();
    expect((await createDraft(db, "u1", { kind: "topic", lang: "ja", title: "a\tb", body: "" })).ok).toBe(true);
    expect((await createDraft(db, "u1", { kind: "topic", lang: "ja", title: "", body: "x" })).ok).toBe(true);
  });
});

describe("createDraft, getDraft, listDrafts", () => {
  it("saves a topic draft and reads it back (owner only)", async () => {
    const { db } = await setup();
    const res = await createDraft(db, "u1", {
      kind: "topic",
      lang: "en",
      title: "Half-written",
      body: "draft body",
      aiAssistance: "draft",
    });
    if (!res.ok) throw new Error("draft failed");
    expect(await getDraft(db, "u1", res.id)).toMatchObject({
      id: res.id,
      kind: "topic",
      lang: "en",
      title: "Half-written",
      body: "draft body",
      aiAssistance: "draft",
      via: "web",
      threadId: null,
      parentId: null,
    });
    // For another member, indistinguishable from nonexistent.
    expect(await getDraft(db, "u2", res.id)).toBeNull();
    expect(await getDraft(db, "u1", 99999)).toBeNull();
  });

  it("accepts unfinished drafts: empty title and body", async () => {
    const { db, topicId } = await setup();
    expect((await createDraft(db, "u1", { kind: "topic", lang: "ja" })).ok).toBe(true);
    expect((await createDraft(db, "u1", { kind: "topic", lang: "ja", title: "", body: "" })).ok).toBe(true);
    expect((await createDraft(db, "u1", { kind: "reply", threadId: topicId, lang: "ja", body: "" })).ok).toBe(true);
  });

  it("still rejects broken drafts", async () => {
    const { db, topicId } = await setup();
    const bad = (input: Record<string, unknown>) => createDraft(db, "u1", { kind: "topic", lang: "ja", ...input });
    expect(await bad({ lang: "es" })).toEqual({ ok: false, error: "invalid_lang" });
    expect(await bad({ aiAssistance: "ghost" })).toEqual({ ok: false, error: "invalid_ai" });
    expect(await bad({ title: "t".repeat(201) })).toEqual({ ok: false, error: "invalid_title" });
    expect(await bad({ body: "a".repeat(50_001) })).toEqual({ ok: false, error: "body_too_long" });
    expect((await bad({ body: "a".repeat(50_000) })).ok).toBe(true);
    expect(await bad({ kind: "essay" })).toEqual({ ok: false, error: "invalid_draft" });
    expect(await createDraft(db, "u1", "nope")).toEqual({ ok: false, error: "invalid_draft" });
    expect(await createDraft(db, "u1", { kind: "reply", lang: "ja" })).toEqual({
      ok: false,
      error: "thread_not_found",
    });
    expect(await createDraft(db, "u1", { kind: "reply", threadId: 99999, lang: "ja" })).toEqual({
      ok: false,
      error: "thread_not_found",
    });
    // A reply cannot serve as the target topic.
    const reply = await createReply(db, "u1", topicId, { lang: "ja", body: "r" });
    if (!reply.ok) throw new Error("reply failed");
    expect(await createDraft(db, "u1", { kind: "reply", threadId: reply.id, lang: "ja" })).toEqual({
      ok: false,
      error: "thread_not_found",
    });
    const other = await createTopic(db, "u1", { lang: "ja", title: "別", body: "b" });
    if (!other.ok) throw new Error("topic failed");
    expect(
      await createDraft(db, "u1", { kind: "reply", threadId: other.id, parentId: reply.id, lang: "ja" }),
    ).toEqual({ ok: false, error: "parent_not_in_thread" });
    // Only the one exactly at the length limit was saved.
    expect(await listDrafts(db, "u1")).toHaveLength(1);
  });

  it("keeps a reply draft's thread and parent, and never a title", async () => {
    const { db, topicId } = await setup();
    const parent = await createReply(db, "u1", topicId, { lang: "ja", body: "親" });
    if (!parent.ok) throw new Error("reply failed");
    const res = await createDraft(db, "u2", {
      kind: "reply",
      threadId: topicId,
      parentId: parent.id,
      lang: "th",
      title: "ignored",
      body: "ตอบ",
    });
    if (!res.ok) throw new Error("draft failed");
    expect(await getDraft(db, "u2", res.id)).toMatchObject({
      kind: "reply",
      threadId: topicId,
      threadTitle: "話題",
      parentId: parent.id,
      title: null,
    });
  });

  it("records the api origin when asked", async () => {
    const { db } = await setup();
    const res = await createDraft(db, "u1", { kind: "topic", lang: "ja", title: "t", body: "b" }, { via: "api" });
    if (!res.ok) throw new Error("draft failed");
    expect((await getDraft(db, "u1", res.id))?.via).toBe("api");
  });

  it("lists only my drafts, most recently updated first", async () => {
    const { db, topicId } = await setup();
    const a = await createDraft(db, "u1", { kind: "topic", lang: "ja", title: "A", body: "a" }, { now: at(0) });
    const b = await createDraft(db, "u1", { kind: "reply", threadId: topicId, lang: "ja", body: "  返信\n本文  " }, { now: at(5) });
    await createDraft(db, "u2", { kind: "topic", lang: "ja", title: "他人" });
    if (!a.ok || !b.ok) throw new Error("draft failed");
    expect((await listDrafts(db, "u1")).map((d) => d.id)).toEqual([b.id, a.id]);
    await updateDraft(db, "u1", a.id, { lang: "ja", title: "A", body: "a2" }, { now: at(10) });
    const list = await listDrafts(db, "u1");
    expect(list.map((d) => d.id)).toEqual([a.id, b.id]);
    expect(list[1]).toMatchObject({ kind: "reply", excerpt: "返信 本文", threadTitle: "話題" });
    expect(await listDrafts(db, "u2")).toHaveLength(1);
  });
});

describe("the excerpt in the list of drafts", () => {
  it("is plain text: no Markdown marks, cut by character", async () => {
    const { db, topicId } = await setup();
    const d = await createDraft(db, "u1", { kind: "reply", threadId: topicId, lang: "ja", body: "## 見出し\n\n**太字**と[リンク](https://example.org)。\n\n$$x^2$$\n\n" + "あ".repeat(200) });
    if (!d.ok) throw new Error("draft failed");
    const [row] = await listDrafts(db, "u1");
    expect(row.excerpt.startsWith("見出し 太字とリンク。 ")).toBe(true);
    expect(row.excerpt).not.toMatch(/[#*\[\]$]|https?:/);
    expect([...row.excerpt]).toHaveLength(101);
    expect(row.excerpt.endsWith("…")).toBe(true);
  });
});

describe("updateDraft and deleteDraft", () => {
  it("updates the editable fields but not the kind or the thread", async () => {
    const { db, topicId } = await setup();
    const res = await createDraft(db, "u1", { kind: "reply", threadId: topicId, lang: "ja", body: "b" }, { now: at(0) });
    if (!res.ok) throw new Error("draft failed");
    expect(
      await updateDraft(
        db,
        "u1",
        res.id,
        { kind: "topic", threadId: 999, lang: "en", title: "x", body: "new", aiAssistance: "polish" },
        { now: at(3) },
      ),
    ).toEqual({ ok: true });
    const d = await getDraft(db, "u1", res.id);
    expect(d).toMatchObject({ kind: "reply", threadId: topicId, lang: "en", title: null, body: "new", aiAssistance: "polish" });
    expect(d?.updatedAt.toISOString()).toBe(at(3).toISOString());
    expect(d?.createdAt.toISOString()).toBe(at(0).toISOString());
  });

  it("validates like saving", async () => {
    const { db } = await setup();
    const res = await createDraft(db, "u1", { kind: "topic", lang: "ja", title: "t", body: "b" });
    if (!res.ok) throw new Error("draft failed");
    expect(await updateDraft(db, "u1", res.id, { lang: "xx", body: "b" })).toEqual({ ok: false, error: "invalid_lang" });
    expect(await updateDraft(db, "u1", res.id, { lang: "ja", body: "a".repeat(50_001) })).toEqual({
      ok: false,
      error: "body_too_long",
    });
    expect((await getDraft(db, "u1", res.id))?.body).toBe("b");
  });

  it("does not let anyone else update or delete my draft", async () => {
    const { db } = await setup();
    const res = await createDraft(db, "u1", { kind: "topic", lang: "ja", title: "t", body: "mine" });
    if (!res.ok) throw new Error("draft failed");
    expect(await updateDraft(db, "u2", res.id, { lang: "ja", title: "x", body: "stolen" })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await deleteDraft(db, "u2", res.id)).toBe(false);
    expect((await getDraft(db, "u1", res.id))?.body).toBe("mine");
    expect(await deleteDraft(db, "u1", res.id)).toBe(true);
    expect(await getDraft(db, "u1", res.id)).toBeNull();
    expect(await deleteDraft(db, "u1", res.id)).toBe(false);
  });
});

describe("publishDraft", () => {
  it("publishes a topic draft: creates the topic and removes the draft", async () => {
    const { db } = await setup();
    const res = await createDraft(db, "u2", {
      kind: "topic",
      lang: "th",
      title: "หัวข้อ",
      body: "เนื้อหา  \n",
      aiAssistance: "coauthor",
    });
    if (!res.ok) throw new Error("draft failed");
    const pub = await publishDraft(db, "u2", res.id);
    if (!pub.ok) throw new Error(`publish failed: ${pub.error}`);
    expect(pub).toMatchObject({ kind: "topic", threadId: pub.id });
    const thread = await getThread(db, pub.id);
    expect(thread?.topic).toMatchObject({
      kind: "topic",
      lang: "th",
      title: "หัวข้อ",
      body: "เนื้อหา  \n",
      aiAssistance: "coauthor",
      authorHandle: "somchai",
    });
    const [row] = await db.select().from(entries).where(eq(entries.id, pub.id));
    expect(row).toMatchObject({ via: "web", sourceHash: sourceHash("หัวข้อ", "เนื้อหา  \n", "th"), htmlVersion: RENDER_VERSION });
    expect(await getDraft(db, "u2", res.id)).toBeNull();
    expect(await db.select().from(drafts)).toEqual([]);
  });

  it("publishes a reply draft into its thread under its parent", async () => {
    const { db, topicId } = await setup();
    const parent = await createReply(db, "u1", topicId, { lang: "ja", body: "親" });
    if (!parent.ok) throw new Error("reply failed");
    const res = await createDraft(db, "u2", {
      kind: "reply",
      threadId: topicId,
      parentId: parent.id,
      lang: "en",
      body: "answer",
    });
    if (!res.ok) throw new Error("draft failed");
    const pub = await publishDraft(db, "u2", res.id);
    if (!pub.ok) throw new Error(`publish failed: ${pub.error}`);
    expect(pub).toMatchObject({ kind: "reply", threadId: topicId });
    const thread = await getThread(db, topicId);
    expect(thread?.replies.map((r) => [r.id, r.parentId, r.authorHandle, r.body])).toEqual([
      [parent.id, null, "hana", "親"],
      [pub.id, parent.id, "somchai", "answer"],
    ]);
    expect(await getDraft(db, "u2", res.id)).toBeNull();
  });

  it("carries the api origin over to the entry", async () => {
    const { db } = await setup();
    const res = await createDraft(db, "u1", { kind: "topic", lang: "en", title: "t", body: "b" }, { via: "api" });
    if (!res.ok) throw new Error("draft failed");
    const pub = await publishDraft(db, "u1", res.id);
    if (!pub.ok) throw new Error("publish failed");
    const [row] = await db.select({ via: entries.via }).from(entries).where(eq(entries.id, pub.id));
    expect(row.via).toBe("api");
  });

  it("rolls back publication and keeps topic and reply drafts when rendering fails", async () => {
    const { db, topicId } = await setup();
    const topic = await createDraft(db, "u1", { kind: "topic", lang: "ja", title: "Draft title", body: "Draft body" });
    const reply = await createDraft(db, "u1", { kind: "reply", threadId: topicId, lang: "ja", body: "Draft reply" });
    if (!topic.ok || !reply.ok) throw new Error("draft failed");
    const beforeDrafts = await db.select().from(drafts).orderBy(drafts.id);
    const beforeEntries = await allEntries(db);
    const spy = vi.spyOn(markdown, "checkBodyBudget").mockResolvedValue("body_unrenderable");
    try {
      for (const id of [topic.id, reply.id]) {
        expect(await publishDraft(db, "u1", id)).toEqual({ ok: false, error: "body_unrenderable" });
      }
      expect(await db.select().from(drafts).orderBy(drafts.id)).toEqual(beforeDrafts);
      expect(await allEntries(db)).toEqual(beforeEntries);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the draft and creates nothing when the post would be invalid", async () => {
    const { db, topicId } = await setup();
    const before = (await allEntries(db)).length;
    const noBody = await createDraft(db, "u1", { kind: "topic", lang: "ja", title: "t", body: " " });
    // A question needs its title (a topic without one is fine); a draft is saved either way, and publishing it is refused.
    const noTitle = await createDraft(db, "u1", { kind: "topic", lang: "ja", title: "", body: "b", asksStance: true });
    const emptyReply = await createDraft(db, "u1", { kind: "reply", threadId: topicId, lang: "ja", body: "" });
    if (!noBody.ok || !noTitle.ok || !emptyReply.ok) throw new Error("draft failed");
    expect(await publishDraft(db, "u1", noBody.id)).toEqual({ ok: false, error: "body_required" });
    expect(await publishDraft(db, "u1", noTitle.id)).toEqual({ ok: false, error: "invalid_title" });
    expect(await publishDraft(db, "u1", emptyReply.id)).toEqual({ ok: false, error: "body_required" });
    expect((await allEntries(db)).length).toBe(before);
    expect(await listDrafts(db, "u1")).toHaveLength(3);
  });

  it("fails when the topic being replied to is gone, keeping the draft", async () => {
    const { db, topicId } = await setup();
    const res = await createDraft(db, "u1", { kind: "reply", threadId: topicId, lang: "ja", body: "b" });
    if (!res.ok) throw new Error("draft failed");
    await db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, topicId));
    expect(await publishDraft(db, "u1", res.id)).toEqual({ ok: false, error: "thread_not_found" });
    expect(await getDraft(db, "u1", res.id)).not.toBeNull();
  });

  it("does not publish someone else's draft", async () => {
    const { db } = await setup();
    const res = await createDraft(db, "u1", { kind: "topic", lang: "ja", title: "t", body: "b" });
    if (!res.ok) throw new Error("draft failed");
    const before = (await allEntries(db)).length;
    expect(await publishDraft(db, "u2", res.id)).toEqual({ ok: false, error: "not_found" });
    expect((await allEntries(db)).length).toBe(before);
    expect(await getDraft(db, "u1", res.id)).not.toBeNull();
  });

  it("publishes only once, even when asked twice at the same time", async () => {
    const { db } = await setup();
    const res = await createDraft(db, "u1", { kind: "topic", lang: "ja", title: "once", body: "b" });
    if (!res.ok) throw new Error("draft failed");
    const before = (await allEntries(db)).length;
    const results = await Promise.all([publishDraft(db, "u1", res.id), publishDraft(db, "u1", res.id)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: "not_found" });
    expect((await allEntries(db)).length).toBe(before + 1);
  });
});
