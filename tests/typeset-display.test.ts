import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { entries, translations } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { loadEntryDisplays, loadTitleDisplays } from "~/lib/entry-display.server";
import { loadMdTranslations } from "~/lib/md/translations.server";
import { toHits, type SearchFound } from "~/lib/search.server";
import { rebuildRenderCache } from "~/lib/render-cache.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import { addMember, createTestDb } from "./helpers/db";

it("typesets displayed machine titles and cached bodies, preserving stored text, human corrections, mail and export selection", async () => {
  const db = await createTestDb();
  await addMember(db, "author", "typesetter");
  const original = "機械学習(ML) internationalization";
  const topic = await createTopic(db, "author", { lang: "ja", title: "原文(ML)", body: original });
  if (!topic.ok) throw new Error("topic creation failed");
  const [entry] = await db.select().from(entries).where(eq(entries.id, topic.id));
  const raw = '"L\'IA"... mot: oui!';
  await db.insert(translations).values([
    ...(["title", "body"] as const).map(field => ({ entryId: entry.id, field, lang: "fr", kind: "primary", sourceHash: entry.sourceHash, mentionRevision: entry.mentionRevision, text: raw, html: field === "body" ? "<p>old cache</p>" : null, htmlVersion: RENDER_VERSION - 1 })),
    ...(["title", "body"] as const).map(field => ({ entryId: entry.id, field, lang: "fr", kind: "human", sourceHash: "older-revision", mentionRevision: entry.mentionRevision, text: raw, flags: ["stale"] })),
  ]);
  const input = { id: entry.id, kind: "topic" as const, lang: "ja" as const, sourceHash: entry.sourceHash };
  const opts = { readLangs: ["fr" as const], displayLang: "fr" as const };
  const view = (await loadEntryDisplays(db, [input], opts)).get(entry.id)!;
  expect(view.translation?.title?.text).toBe('«\u00a0L’IA\u00a0»… mot\u00a0: oui\u202f!');
  expect(view.translation?.html).toContain('«\u00a0L’IA\u00a0»… mot\u00a0: oui\u202f!');
  expect(view.translation?.older?.title?.text).toBe(raw);
  expect(view.translation?.older?.html).toBeNull();
  const older = (await loadEntryDisplays(db, [input], { ...opts, forceOlder: new Set([entry.id]) })).get(entry.id)!;
  expect(older.translation?.older?.html).toContain(raw);
  const list = [{ ...input, title: entry.title }];
  expect((await loadTitleDisplays(db, list, opts, true)).get(entry.id)?.text).toBe(view.translation?.title?.text);
  expect((await loadTitleDisplays(db, list, opts)).get(entry.id)?.text).toBe(raw);
  expect((await loadTitleDisplays(db, list, opts, false)).get(entry.id)?.text).toBe(raw);
  expect((await loadTitleDisplays(db, list, { ...opts, readLangs: ["ja"] })).get(entry.id)?.text).toBe(entry.title);
  const exported = (await loadMdTranslations(db, [input], "fr")).shown.get(entry.id)![0];
  expect(exported).toMatchObject({ text: raw, title: raw });
  const found: SearchFound = { id: entry.id, createdAt: entry.createdAt, kind: "topic", threadId: entry.id, lang: entry.lang, title: entry.title, body: original, sourceHash: entry.sourceHash, authorHandle: "typesetter", distance: 0, topicTitle: entry.title, topicBody: null, topicLang: entry.lang, topicSourceHash: entry.sourceHash };
  expect((await toHits(db, [found], opts))[0].title.text).toBe(raw);
  expect((await toHits(db, [found], opts, true))[0].title.text).toBe(view.translation?.title?.text);
  await db.update(translations).set({ htmlVersion: RENDER_VERSION - 1 });
  expect((await rebuildRenderCache(db)).remaining).toBe(0);
  const saved = await db.select().from(translations);
  for (const row of saved) {
    expect(row.text).toBe(raw);
    if (row.field === "body") {
      expect(row.htmlVersion).toBe(RENDER_VERSION);
      expect(row.html).toBe(row.kind === "primary" ? view.translation?.html : older.translation?.older?.html);
    }
  }
  expect((await db.select().from(entries).where(eq(entries.id, entry.id)))[0].body).toBe(original);
  await db.update(translations).set({ sourceHash: entry.sourceHash, flags: [] }).where(eq(translations.kind, "human"));
  const human = (await loadEntryDisplays(db, [input], opts)).get(entry.id)!;
  expect(human.translation).toMatchObject({ kind: "human", title: { text: raw } });
  expect(human.translation?.html).toContain(raw);
});
