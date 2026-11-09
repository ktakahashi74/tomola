import { quietLogger as quiet } from "./helpers/logger";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles, translations } from "~/lib/db/schema";
import { createReply, createTopic, editEntry } from "~/lib/entries.server";
import { loadEntryDisplays, loadTitleDisplays } from "~/lib/entry-display.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import type { Lang } from "~/lib/languages";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import { fixEntry } from "~/lib/moderation.server";
import { setStance } from "~/lib/stances.server";
import { addMember, createTestDb } from "./helpers/db";

const t0 = new Date("2026-10-05T00:00:00Z");


async function translateAll(db: Db, now = t0) {
  const handlers = createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null }, env: {} } });
  await runDueJobs(db, handlers, { now, logger: quiet, limit: 500 });
}

async function setup() {
  const db = await createTestDb();
  await addMember(db, "u1", "hana");
  const topic = await createTopic(db, "u1", { lang: "ja", title: "話題の題", body: "本文 **太字**[^1]\n\n[^1]: 注" });
  if (!topic.ok) throw new Error("topic failed");
  const reply = await createReply(db, "u1", topic.id, { lang: "ja", body: "返信の本文" });
  if (!reply.ok) throw new Error("reply failed");
  return { db, topicId: topic.id, replyId: reply.id };
}

async function inputs(db: Db, ids: number[]) {
  const rows = await Promise.all(ids.map((id) => db.select().from(entries).where(eq(entries.id, id)).then((r) => r[0])));
  return rows.map((r) => ({ id: r.id, kind: r.kind as "topic" | "reply", lang: r.lang as Lang, sourceHash: r.sourceHash }));
}

async function displays(db: Db, ids: number[], opts: { readLangs: Lang[]; displayLang: Lang; variant?: "full" | "card"; orig?: number[]; tr?: number[]; old?: number[] }) {
  return loadEntryDisplays(db, await inputs(db, ids), {
    readLangs: opts.readLangs,
    displayLang: opts.displayLang,
    variant: opts.variant,
    forceOriginal: new Set(opts.orig ?? []),
    forceTranslation: new Set(opts.tr ?? []),
    forceOlder: new Set(opts.old ?? []),
  });
}

async function addRow(db: Db, entryId: number, lang: Lang, field: "title" | "body", kind: "human", text: string, flags: string[] = []) {
  const [e] = await db.select({ h: entries.sourceHash, mentionRevision: entries.mentionRevision }).from(entries).where(eq(entries.id, entryId));
  await db.insert(translations).values({ entryId, lang, field, kind, text, sourceHash: e.h, mentionRevision: e.mentionRevision, flags, createdBy: "u1" });
}

describe("loadEntryDisplays", () => {
  it("shows the display-language translation for a reader who cannot read the original, with the machine-translation data", async () => {
    const { db, topicId, replyId } = await setup();
    await translateAll(db);
    const map = await displays(db, [topicId, replyId], { readLangs: ["th"], displayLang: "th" });
    const topic = map.get(topicId)!;
    expect(topic.shown).toBe("translation");
    expect(topic.pending).toBe(false);
    expect(topic.translation).toMatchObject({ lang: "th", kind: "primary", engine: "fake", model: "fake-1", stale: false });
    expect(topic.translation?.title).toEqual({ text: "[th] 話題の題", kind: "primary", stale: false });
    expect(topic.translation?.html).toContain("[th] 本文");
    expect(topic.translation?.html).toContain("<strong>太字</strong>");
    const reply = map.get(replyId)!;
    expect(reply.shown).toBe("translation");
    expect(reply.translation?.title).toBeNull();
    expect(reply.translation?.html).toContain("[th] 返信の本文");
  });

  it("uses footnote ids that do not collide with the original's", async () => {
    const { db, topicId } = await setup();
    await translateAll(db);
    const [row] = await db.select({ html: entries.html }).from(entries).where(eq(entries.id, topicId));
    const tr = (await displays(db, [topicId], { readLangs: ["th"], displayLang: "th" })).get(topicId)!.translation!;
    const ids = (html: string) => [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    const original = ids(row.html!);
    const translated = ids(tr.html);
    expect(original.some((i) => i.startsWith(`p-${topicId}-`))).toBe(true);
    expect(translated.length).toBeGreaterThan(0);
    expect(translated.every((i) => i.startsWith(`p-${topicId}-th-`))).toBe(true);
    expect(translated.filter((i) => original.includes(i))).toEqual([]);
    // References (href) use the same prefix.
    expect(tr.html).toContain(`href="#p-${topicId}-th-fn-1"`);
  });

  it("shows the original by default when its language is readable, but still offers the translation for the toggle", async () => {
    const { db, topicId } = await setup();
    await translateAll(db);
    const both = (await displays(db, [topicId], { readLangs: ["ja", "en"], displayLang: "en" })).get(topicId)!;
    expect(both.shown).toBe("original");
    expect(both.pending).toBe(false);
    expect(both.translation).toMatchObject({ lang: "en", kind: "primary" });
    // No translation is needed if the display language is the source language.
    const same = (await displays(db, [topicId], { readLangs: ["ja"], displayLang: "ja" })).get(topicId)!;
    expect(same).toEqual({ shown: "original", pending: false, translation: null });
  });

  it("falls back to the original with a pending flag until the translation exists", async () => {
    const { db, topicId } = await setup();
    const before = (await displays(db, [topicId], { readLangs: ["th"], displayLang: "th" })).get(topicId)!;
    expect(before).toEqual({ shown: "original", pending: true, translation: null });
    await translateAll(db);
    expect((await displays(db, [topicId], { readLangs: ["th"], displayLang: "th" })).get(topicId)!.pending).toBe(false);
  });

  it("applies the display language from the reader (ja reader who displays en sees English only if the original is not readable)", async () => {
    const { db, topicId } = await setup();
    await translateAll(db);
    const enOnly = (await displays(db, [topicId], { readLangs: ["en"], displayLang: "en" })).get(topicId)!;
    expect(enOnly.shown).toBe("translation");
    expect(enOnly.translation?.lang).toBe("en");
    const fr = (await displays(db, [topicId], { readLangs: ["en"], displayLang: "fr" })).get(topicId)!;
    expect(fr.translation?.lang).toBe("fr");
  });

  it("prefers a human-edited translation over the primary one, per field and per language", async () => {
    const { db, topicId } = await setup();
    await translateAll(db);
    const show = async () => (await displays(db, [topicId], { readLangs: ["en"], displayLang: "en" })).get(topicId)!.translation!;
    expect(await show()).toMatchObject({ kind: "primary" });
    await addRow(db, topicId, "en", "body", "human", "HUMAN BODY");
    const withHuman = await show();
    expect(withHuman).toMatchObject({ kind: "human", engine: null });
    expect(withHuman.html).toContain("HUMAN BODY");
    // Without a human title correction, keep the machine title; select per field.
    expect(withHuman.title).toMatchObject({ kind: "primary", text: "[en] 話題の題" });
    await addRow(db, topicId, "en", "title", "human", "HUMAN TITLE");
    expect((await show()).title).toEqual({ text: "HUMAN TITLE", kind: "human", stale: false });
    // Human corrections in another language do not affect this one.
    await addRow(db, topicId, "fr", "body", "human", "HUMAIN");
    expect((await show()).html).toContain("HUMAN BODY");
  });

  it("shows a human-edited translation even before any machine translation exists", async () => {
    const { db, topicId } = await setup();
    await addRow(db, topicId, "en", "body", "human", "HUMAN BODY");
    const d = (await displays(db, [topicId], { readLangs: ["en"], displayLang: "en" })).get(topicId)!;
    expect(d).toMatchObject({ shown: "translation", pending: false, translation: { kind: "human" } });
  });

  it("hides a machine translation of an older source until it is redone, and flags the stale human translation", async () => {
    const { db, topicId } = await setup();
    await translateAll(db);
    await addRow(db, topicId, "en", "body", "human", "HUMAN BODY");
    await editEntry(db, "u1", topicId, { title: "話題の題", body: "直した本文" });
    const staleView = (await displays(db, [topicId], { readLangs: ["en"], displayLang: "en" })).get(topicId)!;
    // Retain human with the "原文が更新されています" marker.
    expect(staleView.translation).toMatchObject({ kind: "human", stale: true });
    expect(staleView.translation?.html).toContain("HUMAN BODY");
    // For fr without a human translation, the old primary is hidden while translation is pending.
    const fr = (await displays(db, [topicId], { readLangs: ["fr"], displayLang: "fr" })).get(topicId)!;
    expect(fr).toEqual({ shown: "original", pending: true, translation: null });
    await translateAll(db, new Date(t0.getTime() + 1000));
    const redone = (await displays(db, [topicId], { readLangs: ["fr"], displayLang: "fr" })).get(topicId)!;
    expect(redone.translation).toMatchObject({ kind: "primary", stale: false });
    expect(redone.translation?.html).toContain("直した本文");
  });

  it("shows a stale human translation with a notice until the new primary exists, then the new primary with the human one as an older choice", async () => {
    const { db, topicId } = await setup();
    await translateAll(db);
    await addRow(db, topicId, "en", "body", "human", "HUMAN BODY");
    await addRow(db, topicId, "en", "title", "human", "HUMAN TITLE");
    await editEntry(db, "u1", topicId, { title: "新しい題", body: "直した本文" });
    const show = async (force?: { old?: number[] }) =>
      (await displays(db, [topicId], { readLangs: ["en"], displayLang: "en", ...force })).get(topicId)!;
    // No new primary yet: default to old human with "原文が更新されています", without an older alternative.
    const before = await show();
    expect(before.translation).toMatchObject({ kind: "human", stale: true, older: null });
    expect(before.translation?.html).toContain("HUMAN BODY");
    // After retranslation, default to the new primary; old human becomes older, including its old-version title translation.
    await translateAll(db, new Date(t0.getTime() + 1000));
    const after = await show();
    expect(after.shown).toBe("translation");
    expect(after.translation).toMatchObject({ kind: "primary", stale: false });
    expect(after.translation?.html).toContain("直した本文");
    expect(after.translation?.title).toMatchObject({ kind: "primary", text: "[en] 新しい題" });
    expect(after.translation?.older).toMatchObject({ kind: "human", engine: null });
    expect(after.translation?.older?.html).toBeNull();
    expect(JSON.stringify(after)).not.toContain("HUMAN BODY");
    expect((await show({ old: [topicId] })).translation?.older?.html).toContain("HUMAN BODY");
    expect(after.translation?.older?.title).toEqual({ text: "HUMAN TITLE", kind: "human", stale: true });
    // ?old=<id> selects the older translation by default.
    expect((await show({ old: [topicId] })).shown).toBe("older");
    // For a language without an older translation, ?old selects the current translation.
    const fr = (await displays(db, [topicId], { readLangs: ["fr"], displayLang: "fr", old: [topicId] })).get(topicId)!;
    expect(fr.shown).toBe("translation");
    expect(fr.translation?.older).toBeNull();
  });

  it("the older translation's title falls back to the current translation's title", async () => {
    const { db, topicId } = await setup();
    await translateAll(db);
    await addRow(db, topicId, "en", "body", "human", "HUMAN BODY");
    await editEntry(db, "u1", topicId, { title: "話題の題", body: "直した本文" });
    await translateAll(db, new Date(t0.getTime() + 1000));
    const view = (await displays(db, [topicId], { readLangs: ["en"], displayLang: "en" })).get(topicId)!;
    // The unchanged title carries its machine translation forward.
    expect(view.translation?.title).toMatchObject({ kind: "primary", text: "[en] 話題の題" });
    expect(view.translation?.kind).toBe("primary");
    expect(view.translation?.older).toMatchObject({ kind: "human" });
    expect(view.translation?.older?.title).toEqual(view.translation?.title);
  });

  it("honours ?orig (original) and ?tr (translation) for the chosen entries only", async () => {
    const { db, topicId, replyId } = await setup();
    await translateAll(db);
    const forcedOrig = await displays(db, [topicId, replyId], { readLangs: ["th"], displayLang: "th", orig: [replyId] });
    expect(forcedOrig.get(topicId)!.shown).toBe("translation");
    expect(forcedOrig.get(replyId)!.shown).toBe("original");
    expect(forcedOrig.get(replyId)!.translation).not.toBeNull(); // Can switch back to the translation.
    const forcedTr = await displays(db, [topicId], { readLangs: ["ja", "th"], displayLang: "th", tr: [topicId] });
    expect(forcedTr.get(topicId)!.shown).toBe("translation");
  });

  it("caches the rendered translation html and re-renders when the cache version differs", async () => {
    const { db, topicId } = await setup();
    await translateAll(db);
    const cached = () =>
      db.select({ html: translations.html, v: translations.htmlVersion }).from(translations).where(and(eq(translations.entryId, topicId), eq(translations.lang, "th"), eq(translations.field, "body")));
    // The job renders translation HTML when saving the translation.
    expect((await cached())[0].v).toBe(RENDER_VERSION);
    expect((await cached())[0].html).toContain("[th] 本文");
    // Without cached HTML, render and save on display.
    await db.update(translations).set({ html: null, htmlVersion: 0 }).where(and(eq(translations.entryId, topicId), eq(translations.lang, "th"), eq(translations.field, "body")));
    expect((await cached())[0]).toEqual({ html: null, v: 0 });
    await displays(db, [topicId], { readLangs: ["th"], displayLang: "th" });
    const [row] = await cached();
    expect(row.v).toBe(RENDER_VERSION);
    expect(row.html).toContain("[th] 本文");
    // At the same render version, reuse the cache.
    await db.update(translations).set({ html: "<p>cached marker</p>" }).where(and(eq(translations.entryId, topicId), eq(translations.lang, "th"), eq(translations.field, "body")));
    expect((await displays(db, [topicId], { readLangs: ["th"], displayLang: "th" })).get(topicId)!.translation?.html).toBe("<p>cached marker</p>");
    // At a different version, rerender and save.
    await db.update(translations).set({ htmlVersion: RENDER_VERSION - 1 }).where(and(eq(translations.entryId, topicId), eq(translations.lang, "th"), eq(translations.field, "body")));
    expect((await displays(db, [topicId], { readLangs: ["th"], displayLang: "th" })).get(topicId)!.translation?.html).toContain("[th] 本文");
    expect((await cached())[0].v).toBe(RENDER_VERSION);
  });

  it.each(["author", "moderator"] as const)("rebuilds warm human full/card caches with their saved source targets after a %s body edit, and keeps them for a title-only edit", async (editor) => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    await addMember(db, "bob-id", "bob");
    await addMember(db, "carol-id", "carol");
    await addMember(db, "mod-id", "moriko");
    const [bob] = await db.select({ publicId: profiles.publicId }).from(profiles).where(eq(profiles.userId, "bob-id"));
    const [carol] = await db.select({ publicId: profiles.publicId }).from(profiles).where(eq(profiles.userId, "carol-id"));
    const originalTarget = [{ handle: "bob", href: `/u/id/${bob.publicId}` }];
    const editedTarget = [{ handle: "carol", href: `/u/id/${carol.publicId}` }];
    const created = await createTopic(db, "u1", { lang: "ja", title: "原文の題", body: "原文 @bob。", asksStance: editor === "moderator" });
    if (!created.ok) throw new Error(`topic failed: ${created.error}`);
    const id = created.id;
    if (editor === "moderator") {
      expect((await setStance(db, "bob-id", { questionId: id, position: "agree", expectedVersion: 0 })).ok).toBe(true);
    }
    // Both mentions fit in the first block; the rest forces a separate, non-null card cache.
    const humanText = "Human translation @bob and @carol.\n\n" + "More translated context. ".repeat(40);
    await addRow(db, id, "en", "body", "human", humanText, ["checked"]);
    const cached = async () => (await db.select().from(translations).where(and(eq(translations.entryId, id), eq(translations.kind, "human"), eq(translations.field, "body"), eq(translations.lang, "en"))))[0];
    const mentioned = (html: string) => [...html.matchAll(/<a\b[^>]*class="mention"[^>]*href="([^"]+)"[^>]*>@([^<]+)<\/a>/g)]
      .map((match) => ({ handle: match[2], href: match[1] }));
    const show = async (variant: "full" | "card") => (await displays(db, [id], { readLangs: ["en"], displayLang: "en", variant })).get(id)!.translation!;
    for (const variant of ["full", "card"] as const) {
      const view = await show(variant);
      expect(view).toMatchObject({ kind: "human", stale: false });
      expect(mentioned(view.html)).toEqual(originalTarget);
      expect(view.html).toContain("@carol");
    }
    const warm = await cached();
    expect(warm.htmlVersion).toBe(RENDER_VERSION);
    expect(warm.html).not.toBeNull();
    expect(warm.cardHtml).not.toBeNull();
    expect(mentioned(warm.html!)).toEqual(originalTarget);
    expect(mentioned(warm.cardHtml!)).toEqual(originalTarget);

    const edit = async (title: string, body: string) => {
      if (editor === "author") return editEntry(db, "u1", id, { title, body });
      const [entry] = await db.select({ sourceHash: entries.sourceHash }).from(entries).where(eq(entries.id, id));
      return fixEntry(db, { id: "mod-id", scope: { operator: false, langs: ["ja"] } }, { entryId: id, title, body, note: "Correct the source mention.", sourceHash: entry.sourceHash });
    };
    expect((await edit("原文の題", "変更した原文 @carol。")).ok).toBe(true);
    const invalidated = await cached();
    expect(invalidated).toMatchObject({ text: humanText, sourceHash: warm.sourceHash, flags: ["checked", "stale"], html: null, cardHtml: null, htmlVersion: 0 });
    const [editedSource] = await db.select({ sourceHash: entries.sourceHash, html: entries.html, mentionRevision: entries.mentionRevision }).from(entries).where(eq(entries.id, id));
    expect(editedSource.sourceHash).not.toBe(warm.sourceHash);
    expect(editedSource.mentionRevision).not.toBe(warm.mentionRevision);
    expect(mentioned(editedSource.html!)).toEqual(editedTarget);
    // The old human translation still belongs to the original source revision, whose only resolved spelling was @bob.
    for (const variant of ["full", "card"] as const) {
      const view = await show(variant);
      expect(view).toMatchObject({ kind: "human", stale: true });
      expect(mentioned(view.html)).toEqual(originalTarget);
      expect(view.html).toContain("@carol");
    }
    const rewarmed = await cached();
    expect(rewarmed).toMatchObject({ text: humanText, sourceHash: warm.sourceHash, mentionRevision: warm.mentionRevision, flags: ["checked", "stale"], htmlVersion: RENDER_VERSION });
    expect(mentioned(rewarmed.html!)).toEqual(originalTarget);
    expect(mentioned(rewarmed.cardHtml!)).toEqual(originalTarget);

    expect((await edit("題だけを変更", "変更した原文 @carol。")).ok).toBe(true);
    expect(await cached()).toMatchObject({ text: humanText, sourceHash: rewarmed.sourceHash, flags: rewarmed.flags, html: rewarmed.html, cardHtml: rewarmed.cardHtml, htmlVersion: RENDER_VERSION });
  });
});

describe("loadTitleDisplays (lists)", () => {
  const topic = (id: number, lang: Lang, title: string, sourceHash: string | null) => ({ id, lang, title, sourceHash });

  it("shows the translated title when the original is not readable, the original title otherwise, and pending when missing", async () => {
    const { db, topicId } = await setup();
    const [e] = await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, topicId));
    const list = [topic(topicId, "ja", "話題の題", e.h)];
    const pending = (await loadTitleDisplays(db, list, { readLangs: ["th"], displayLang: "th" })).get(topicId)!;
    expect(pending).toEqual({ text: "話題の題", lang: "ja", kind: null, engine: null, fallback: false, stale: false, pending: true, fromBody: false });
    await translateAll(db);
    const th = (await loadTitleDisplays(db, list, { readLangs: ["th"], displayLang: "th" })).get(topicId)!;
    expect(th).toEqual({ text: "[th] 話題の題", lang: "th", kind: "primary", engine: "fake", fallback: false, stale: false, pending: false, fromBody: false });
    const ja = (await loadTitleDisplays(db, list, { readLangs: ["ja", "th"], displayLang: "th" })).get(topicId)!;
    expect(ja).toMatchObject({ text: "話題の題", lang: "ja", kind: null, pending: false });
    await addRow(db, topicId, "th", "title", "human", "HUMAN TITLE");
    expect((await loadTitleDisplays(db, list, { readLangs: ["th"], displayLang: "th" })).get(topicId)).toMatchObject({ text: "HUMAN TITLE", kind: "human" });
  });

  it("does not use a title translation of an older source", async () => {
    const { db, topicId } = await setup();
    await translateAll(db);
    await editEntry(db, "u1", topicId, { title: "新しい題", body: "本文" });
    const [e] = await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, topicId));
    const d = (await loadTitleDisplays(db, [topic(topicId, "ja", "新しい題", e.h)], { readLangs: ["th"], displayLang: "th" })).get(topicId)!;
    expect(d).toMatchObject({ text: "新しい題", lang: "ja", pending: true });
  });
});
