import * as markdown from "~/lib/markdown.server";
import { Worker } from "node:worker_threads";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, user } from "~/lib/db/schema";
import { createReply, createTopic, editEntry, getThread, listTopics } from "~/lib/entries.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import { createProfile } from "~/lib/profiles.server";
import { createTestDb } from "./helpers/db";

async function addMember(db: Db, id: string, handle: string) {
  await db.insert(user).values({ id, name: "", email: `${id}@example.com`, emailVerified: true });
  await createProfile(db, id, { handle, homeArea: "ja", readLangs: ["ja"] });
}

const t0 = new Date("2026-10-01T00:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

describe("entries", () => {
  it("returns rendering failures without saving a topic or reply", async () => {
    const db = new Proxy({} as Db, { get() { throw new Error("An unrenderable body must not access the database"); } });
    const body = ">".repeat(3000);
    expect(await createTopic(db, "u1", { lang: "en", title: "t", body })).toEqual({ ok: false, error: "body_unrenderable" });
    expect(await createReply(db, "u1", 1, { lang: "en", body })).toEqual({ ok: false, error: "body_unrenderable" });
  });

  it("keeps the real worker after render exceptions and accepts the next body", async () => {
    const terminated = vi.spyOn(Worker.prototype, "terminate");
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        // Distinct values exercise the worker rather than the admission cache.
        const body = ">".repeat(3000) + `\nAttempt ${attempt}.`;
        expect(await markdown.checkBodyBudget(body, "u1")).toBe("body_unrenderable");
      }
      const normal = "A normal **post** after the refusal.\n";
      expect(await markdown.checkBodyBudget(normal, "u1")).toBeNull();
      expect(await markdown.renderMarkdown(normal)).toContain("<strong>post</strong>");
      expect(terminated).not.toHaveBeenCalled();
    } finally { terminated.mockRestore(); }
  }, 20_000);

  it("creates a topic and reads it as a thread", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const res = await createTopic(db, "u1", { lang: "ja", title: "共生は制御の代替か", body: "本文" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const thread = await getThread(db, res.id);
    expect(thread?.topic).toMatchObject({
      id: res.id,
      kind: "topic",
      lang: "ja",
      title: "共生は制御の代替か",
      body: "本文",
      authorHandle: "hana",
      // Not stated: nothing was written for ai_assistance.
      aiAssistance: null,
    });
    expect(thread?.replies).toEqual([]);
  });

  it("validates topic input", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    // The title is optional (a blank one means no title); a title that is there must be at most 200 characters.
    expect(await createTopic(db, "u1", { lang: "ja", title: "t".repeat(201), body: "b" })).toEqual({
      ok: false,
      error: "invalid_title",
    });
    expect(await createTopic(db, "u1", { lang: "ja", title: "t", body: "" })).toEqual({
      ok: false,
      error: "body_required",
    });
    expect(await createTopic(db, "u1", { lang: "es", title: "t", body: "b" })).toEqual({
      ok: false,
      error: "invalid_lang",
    });
    expect(await createTopic(db, "u1", { lang: "ja", title: "t", body: "b", aiAssistance: "ghost" })).toEqual({
      ok: false,
      error: "invalid_ai",
    });
  });

  it("stores the body exactly as submitted", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    // Four leading spaces form an indented code block; trimming would turn it into a paragraph.
    const body = "    indented code\n\ntext  \n\n";
    const topic = await createTopic(db, "u1", { lang: "en", title: "t", body });
    if (!topic.ok) throw new Error("topic failed");
    const reply = await createReply(db, "u1", topic.id, { lang: "en", body });
    if (!reply.ok) throw new Error("reply failed");
    const thread = await getThread(db, topic.id);
    expect(thread?.topic.body).toBe(body);
    expect(thread?.replies[0].body).toBe(body);
  });

  it("rejects blank and too long bodies with distinct errors", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const topic = await createTopic(db, "u1", { lang: "en", title: "t", body: "b" });
    if (!topic.ok) throw new Error("topic failed");
    for (const body of ["", " ", " \n\t\u3000 ", " \n\n ", " \n", "   \n ", undefined]) {
      expect(await createTopic(db, "u1", { lang: "en", title: "t", body })).toEqual({
        ok: false,
        error: "body_required",
      });
      expect(await createReply(db, "u1", topic.id, { lang: "en", body })).toEqual({
        ok: false,
        error: "body_required",
      });
    }
    for (const tooLong of ["a".repeat(50_001), "x".repeat(50_001), "あ".repeat(50_001)]) {
      expect(await createTopic(db, "u1", { lang: "en", title: "t", body: tooLong })).toEqual({
        ok: false,
        error: "body_too_long",
      });
      expect(await createReply(db, "u1", topic.id, { lang: "en", body: tooLong })).toEqual({
        ok: false,
        error: "body_too_long",
      });
    }
    // Exactly the maximum length is accepted.
    expect((await createTopic(db, "u1", { lang: "en", title: "t", body: "a".repeat(50_000) })).ok).toBe(true);
  });

  it("rejects a NUL in the body (PostgreSQL text cannot store it) and control characters or newlines in a title, on create and edit", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const topic = await createTopic(db, "u1", { lang: "en", title: "t", body: "b" });
    if (!topic.ok) throw new Error("topic failed");
    const nul = String.fromCodePoint(0);
    expect(await createTopic(db, "u1", { lang: "en", title: "t", body: `a${nul}b` })).toEqual({ ok: false, error: "body_unrenderable" });
    expect(await createReply(db, "u1", topic.id, { lang: "en", body: `a${nul}b` })).toEqual({ ok: false, error: "body_unrenderable" });
    expect(await editEntry(db, "u1", topic.id, { title: "t", body: `a${nul}b` })).toEqual({ ok: false, error: "body_unrenderable" });
    for (const title of ["a\nb", "a\rb", `a${nul}b`, "a\u0007b", "a\u007fb", `a${String.fromCodePoint(0x85)}b`, `a${String.fromCodePoint(0x9f)}b`, `a${String.fromCodePoint(0x2028)}b`, `a${String.fromCodePoint(0x2029)}b`]) {
      expect(await createTopic(db, "u1", { lang: "en", title, body: "b" }), JSON.stringify(title)).toEqual({ ok: false, error: "invalid_title" });
      expect(await editEntry(db, "u1", topic.id, { title, body: "b" }), JSON.stringify(title)).toEqual({ ok: false, error: "invalid_title" });
    }
    // Titles may contain tabs.
    expect((await createTopic(db, "u1", { lang: "en", title: "a\tb", body: "b" })).ok).toBe(true);
    expect((await listTopics(db)).topics.length).toBe(2);
  });

  it("adds replies in order, in any language, with an optional parent", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    await addMember(db, "u2", "somchai");
    const topic = await createTopic(db, "u1", { lang: "ja", title: "t", body: "b" }, { now: at(0) });
    if (!topic.ok) throw new Error("topic failed");
    const r1 = await createReply(db, "u2", topic.id, { lang: "th", body: "ตอบ", aiAssistance: "draft" }, { now: at(1) });
    if (!r1.ok) throw new Error("reply failed");
    const r2 = await createReply(db, "u1", topic.id, { lang: "ja", body: "返信", parentId: r1.id }, { now: at(2) });
    expect(r2.ok).toBe(true);
    const thread = await getThread(db, topic.id);
    expect(thread?.replies.map((r) => [r.lang, r.authorHandle, r.parentId, r.aiAssistance])).toEqual([
      ["th", "somchai", null, "draft"],
      ["ja", "hana", r1.id, null],
    ]);
  });

  it("rejects replies to missing threads and foreign parents", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const a = await createTopic(db, "u1", { lang: "ja", title: "a", body: "a" });
    const b = await createTopic(db, "u1", { lang: "ja", title: "b", body: "b" });
    if (!a.ok || !b.ok) throw new Error("topics failed");
    const ra = await createReply(db, "u1", a.id, { lang: "ja", body: "ra" });
    if (!ra.ok) throw new Error("reply failed");
    expect(await createReply(db, "u1", 99999, { lang: "ja", body: "x" })).toEqual({
      ok: false,
      error: "thread_not_found",
    });
    expect(await createReply(db, "u1", ra.id, { lang: "ja", body: "x" })).toEqual({
      ok: false,
      error: "thread_not_found",
    });
    expect(await createReply(db, "u1", b.id, { lang: "ja", body: "x", parentId: ra.id })).toEqual({
      ok: false,
      error: "parent_not_in_thread",
    });
  });

  it("returns null for a missing thread", async () => {
    const db = await createTestDb();
    expect(await getThread(db, 12345)).toBeNull();
  });
});

describe("rendered html cache", () => {
  async function stored(db: Db, id: number) {
    const [row] = await db
      .select({ html: entries.html, htmlVersion: entries.htmlVersion })
      .from(entries)
      .where(eq(entries.id, id));
    return row;
  }

  it("renders and stores html when a topic or reply is posted", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const topic = await createTopic(db, "u1", { lang: "en", title: "t", body: "**bold** text[^1]\n\n[^1]: note" });
    if (!topic.ok) throw new Error("topic failed");
    const reply = await createReply(db, "u1", topic.id, { lang: "en", body: "reply[^1]\n\n[^1]: note" });
    if (!reply.ok) throw new Error("reply failed");
    const t = await stored(db, topic.id);
    expect(t.htmlVersion).toBe(RENDER_VERSION);
    expect(t.html).toContain("<strong>bold</strong>");
    // Footnote prefixes are assigned after IDs are known: p-<id>- for topics and c-<id>- for replies.
    expect(t.html).toContain(`p-${topic.id}-`);
    const r = await stored(db, reply.id);
    expect(r.htmlVersion).toBe(RENDER_VERSION);
    expect(r.html).toContain(`c-${reply.id}-`);
  });

  it("serves the cached html when the version matches", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const topic = await createTopic(db, "u1", { lang: "en", title: "t", body: "*a*" });
    if (!topic.ok) throw new Error("topic failed");
    await db.update(entries).set({ html: "<p>cached</p>" }).where(eq(entries.id, topic.id));
    expect((await getThread(db, topic.id))?.topic.html).toBe("<p>cached</p>");
  });

  it("re-renders and stores again when the version differs or the cache is empty", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const topic = await createTopic(db, "u1", { lang: "en", title: "t", body: "*a*" });
    if (!topic.ok) throw new Error("topic failed");
    const reply = await createReply(db, "u1", topic.id, { lang: "en", body: "*b*" });
    if (!reply.ok) throw new Error("reply failed");
    await db
      .update(entries)
      .set({ html: "<p>old renderer</p>", htmlVersion: RENDER_VERSION - 1 })
      .where(eq(entries.id, topic.id));
    await db.update(entries).set({ html: null, htmlVersion: RENDER_VERSION }).where(eq(entries.id, reply.id));
    const thread = await getThread(db, topic.id);
    expect(thread?.topic.html).toContain("<em>a</em>");
    expect(thread?.replies[0].html).toContain("<em>b</em>");
    expect(await stored(db, topic.id)).toEqual({ html: thread?.topic.html, htmlVersion: RENDER_VERSION });
    expect(await stored(db, reply.id)).toEqual({ html: thread?.replies[0].html, htmlVersion: RENDER_VERSION });
  });

  it("renders rows that predate the cache (version 0)", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const topic = await createTopic(db, "u1", { lang: "en", title: "t", body: "plain" });
    if (!topic.ok) throw new Error("topic failed");
    await db.update(entries).set({ html: null, htmlVersion: 0 }).where(eq(entries.id, topic.id));
    expect((await getThread(db, topic.id))?.topic.html).toContain("<p>plain</p>");
    expect((await stored(db, topic.id)).htmlVersion).toBe(RENDER_VERSION);
  });
});
