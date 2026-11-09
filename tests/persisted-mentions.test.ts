import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { entries, entryMentionSnapshots, profiles, translations, user } from "~/lib/db/schema";
import { createTopic, editEntry, getThread, softDeleteEntry } from "~/lib/entries.server";
import { loadEntryDisplays } from "~/lib/entry-display.server";
import { changeHandle, createProfile } from "~/lib/profiles.server";
import { rebuildRenderCache } from "~/lib/render-cache.server";
import { saveRenderedEntry, saveRenderedTranslation } from "~/lib/render-cache.server";
import { addMember, createTestDb } from "./helpers/db";

const now = new Date("2026-10-03T00:00:00Z");
const later = new Date(now.getTime() + 90 * 86_400_000);
async function setup(body = "@hana さん") {
  const db = await createTestDb();
  await addMember(db, "author", "amina");
  await addMember(db, "original", "hana");
  const topic = await createTopic(db, "author", { lang: "ja", title: "Names", body }, { now });
  if (!topic.ok) throw new Error(topic.error);
  const [person] = await db.select().from(profiles).where(eq(profiles.userId, "original"));
  return { db, id: topic.id, href: `/u/id/${(person as typeof person & { publicId: string }).publicId}` };
}
async function reuse(db: Awaited<ReturnType<typeof createTestDb>>) {
  expect(await changeHandle(db, "original", "hanna", { now })).toMatchObject({ ok: true });
  await db.insert(user).values({ id: "new", name: "", email: "new@example.com", emailVerified: true });
  expect(await createProfile(db, "new", { handle: "hana", homeArea: "ja" }, { now: later })).toMatchObject({ ok: true });
}

it("links each saved original to its member after a rename, reuse, and render rebuild", async () => {
  const { db, id, href } = await setup();
  expect((await getThread(db, id))?.topic.html).toContain(`href="${href}"`);
  await reuse(db);
  await db.update(entries).set({ html: null, htmlVersion: 0 }).where(eq(entries.id, id));
  await rebuildRenderCache(db);
  const html = (await getThread(db, id))?.topic.html;
  expect(html).toContain(`href="${href}"`);
  expect(html).toContain(">@hana</a>");
});

it("renders translations and a restored deleted original from the same saved bindings", async () => {
  const { db, id, href } = await setup();
  await reuse(db);
  await db.transaction(tx => softDeleteEntry(tx, id));
  await db.update(entries).set({ deletedAt: null }).where(eq(entries.id, id));
  const [row] = await db.select().from(entries).where(eq(entries.id, id));
  await db.insert(translations).values({ entryId: id, field: "body", lang: "en", kind: "primary", text: "Dear @hana, hello.", engine: "fake", model: "fake-1", sourceHash: row.sourceHash });
  const display = await loadEntryDisplays(db, [{ id, kind: "topic", lang: "ja", sourceHash: row.sourceHash }], { readLangs: ["en"], displayLang: "en" });
  expect(display.get(id)?.translation?.html).toContain(`href="${href}"`);
  expect((await getThread(db, id))?.topic.html).toContain(`href="${href}"`);
});

it("inherits exact spellings on edit while resolving only newly written spellings", async () => {
  const { db, id, href } = await setup("@hana @absent");
  await reuse(db);
  await addMember(db, "late", "absent");
  const [newPerson] = await db.select().from(profiles).where(eq(profiles.userId, "new"));
  const newHref = `/u/id/${(newPerson as typeof newPerson & { publicId: string }).publicId}`;
  expect(await editEntry(db, "author", id, { title: "Names", body: "@hana @HANA @absent" })).toMatchObject({ ok: true });
  const html = (await getThread(db, id))?.topic.html ?? "";
  expect(html).toContain(`href="${href}">@hana</a>`);
  expect(html).toContain(`href="${newHref}">@HANA</a>`);
  expect(html).not.toMatch(/class="mention"[^>]*>@absent/);
  const saved = await db.select().from(entryMentionSnapshots).where(eq(entryMentionSnapshots.entryId, id));
  expect(saved).toHaveLength(2);
});

it("never promotes an unresolved spelling during rebuild or a title-only edit", async () => {
  const { db, id } = await setup("Hello @absent.");
  await addMember(db, "late", "absent");
  await db.update(entries).set({ html: null, htmlVersion: 0 }).where(eq(entries.id, id));
  await rebuildRenderCache(db);
  expect((await getThread(db, id))?.topic.html).not.toContain('class="mention"');
  await editEntry(db, "author", id, { title: "New title", body: "Hello @absent." });
  expect((await getThread(db, id))?.topic.html).not.toContain('class="mention"');
});

it("rolls back the post and its binding snapshot together", async () => {
  const { db } = await setup();
  await expect(db.transaction(async tx => {
    const created = await createTopic(tx, "author", { lang: "ja", title: "Rollback", body: "@hana" });
    if (!created.ok) throw new Error(created.error);
    throw new Error("rollback");
  })).rejects.toThrow("rollback");
  expect(await db.select().from(entryMentionSnapshots)).toHaveLength(1);
});

it("uses a distinct binding revision when an edit returns to a previous body and hash", async () => {
  const { db, id, href } = await setup();
  const [old] = await db.select().from(entries).where(eq(entries.id, id));
  await reuse(db);
  await editEntry(db, "author", id, { title: "Names", body: "No mention now." });
  await editEntry(db, "author", id, { title: "Names", body: "@hana さん" });
  const [current] = await db.select().from(entries).where(eq(entries.id, id));
  expect(current.sourceHash).toBe(old.sourceHash);
  expect(current.mentionRevision).toBe(old.mentionRevision + 2);
  expect(current.html).not.toContain(href);
  expect(await saveRenderedEntry(db, id, old.body, { html: old.html!, cardHtml: old.cardHtml }, old.sourceHash, old.mentionRevision)).toBe(false);
  const [translation] = await db.insert(translations).values({ entryId: id, field: "body", lang: "en", kind: "primary", text: "Dear @hana", engine: "fake", model: "fake-1", sourceHash: current.sourceHash }).returning();
  expect(await saveRenderedTranslation(db, translation.id, translation.text, { html: old.html!, cardHtml: null }, { entryId: id, source: old.body, sourceHash: old.sourceHash, mentionRevision: old.mentionRevision, translationSourceHash: translation.sourceHash })).toBe(false);
});

it("keeps an older human translation linked to the original recipient after source removal and reintroduction", async () => {
  const { db, id, href } = await setup();
  const [old] = await db.select().from(entries).where(eq(entries.id, id));
  await db.insert(translations).values({ entryId: id, field: "body", lang: "en", kind: "human", text: "Dear @hana", sourceHash: old.sourceHash, mentionRevision: old.mentionRevision });
  await reuse(db);
  await editEntry(db, "author", id, { title: "Names", body: "No mention now." });
  const [changed] = await db.select().from(entries).where(eq(entries.id, id));
  await db.insert(translations).values({ entryId: id, field: "body", lang: "en", kind: "primary", text: "No mention now.", engine: "fake", model: "fake-1", sourceHash: changed.sourceHash, mentionRevision: changed.mentionRevision });
  const view = await loadEntryDisplays(db, [{ id, kind: "topic", lang: "ja", sourceHash: changed.sourceHash }], { readLangs: ["en"], displayLang: "en", forceOlder: new Set([id]) });
  expect(view.get(id)?.translation?.older?.html).toContain(href);
  await editEntry(db, "author", id, { title: "Names", body: "@hana さん" });
  await rebuildRenderCache(db);
  const [human] = await db.select().from(translations).where(eq(translations.kind, "human"));
  expect(human.html).toContain(href);
  expect((await getThread(db, id))?.topic.html).not.toContain(href);
});
