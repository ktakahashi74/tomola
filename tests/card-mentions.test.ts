import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { entries, profiles, translations } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { loadEntryDisplays } from "~/lib/entry-display.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import { rebuildRenderCache } from "~/lib/render-cache.server";
import { addMember, createTestDb } from "./helpers/db";

const source = `@bob 最初の呼びかけ。\n\n${"長い段落。".repeat(200)}\n\nCARDMENTIONTAIL`;

async function setup() {
  const db = await createTestDb();
  for (const handle of ["alice", "bob"]) await addMember(db, handle, handle, { readLangs: ["ja", "en"] });
  const topic = await createTopic(db, "alice", { lang: "ja", title: "A mention on a long card", body: source });
  if (!topic.ok) throw new Error("topic failed");
  const [row] = await db.select().from(entries).where(eq(entries.id, topic.id));
  const [bob] = await db.select({ publicId: profiles.publicId }).from(profiles).where(eq(profiles.userId, "bob"));
  return { db, topic, row, memberLink: `<a class="mention" href="/u/id/${bob.publicId}">@bob</a>` };
}

it("keeps source mentions linked in bounded original cards, including a rebuilt render cache", async () => {
  const { db, topic, memberLink } = await setup();
  for (const stale of [false, true]) {
    if (stale) await db.update(entries).set({ html: "<p>old</p>", cardHtml: null, htmlVersion: RENDER_VERSION - 1 }).where(eq(entries.id, topic.id));
    await rebuildRenderCache(db);
    const [stored] = await db.select().from(entries).where(eq(entries.id, topic.id));
    const card = { html: stored.cardHtml!, truncated: stored.cardHtml !== null };
    expect(card.truncated).toBe(true);
    expect(card.html).toContain(memberLink);
    expect(card.html).not.toContain("CARDMENTIONTAIL");
    const [saved] = await db.select().from(entries).where(eq(entries.id, topic.id));
    expect(saved.htmlVersion).toBe(RENDER_VERSION);
    expect(saved.cardHtml).toBe(card.html);
    expect(saved.html).toContain("CARDMENTIONTAIL");
  }
});

it("a translated card links only members mentioned by the source and saves its bounded rendering with the full one", async () => {
  const { db, topic, row, memberLink } = await setup();
  const [translation] = await db.insert(translations).values({
    entryId: topic.id, field: "body", lang: "en", kind: "human", sourceHash: row.sourceHash,
    text: `@bob look, @alice is only in the translation.\n\n${"Long paragraph. ".repeat(100)}\n\nTRANSLATEDCARDTAIL`,
    html: "<p>old</p>", htmlVersion: RENDER_VERSION - 1,
  }).returning();
  const display = (await loadEntryDisplays(db, [{ id: topic.id, kind: "topic", lang: "ja", sourceHash: row.sourceHash }], { readLangs: ["en"], displayLang: "en", variant: "card" })).get(topic.id)!;
  expect(display.shown).toBe("translation");
  expect(display.translation!.html).toContain(memberLink);
  expect(display.translation!.html).toContain("@alice");
  expect(display.translation!.html).not.toMatch(/<a\b[^>]*>@alice<\/a>/);
  expect(display.translation!.html).not.toContain("TRANSLATEDCARDTAIL");
  const [saved] = await db.select().from(translations).where(eq(translations.id, translation.id));
  expect(saved.htmlVersion).toBe(RENDER_VERSION);
  expect(saved.cardHtml).toBe(display.translation!.html);
  expect(saved.html).toContain("TRANSLATEDCARDTAIL");
});

it("keeps the original recipient when a source card and its translation are rebuilt after the old name is reassigned", async () => {
  const { db, topic, row, memberLink } = await setup();
  await db.update(profiles).set({ handle: "bob_now", handleKey: "bob_now" }).where(eq(profiles.userId, "bob"));
  await addMember(db, "replacement-bob", "bob", { readLangs: ["ja", "en"] });
  const [replacement] = await db.select({ publicId: profiles.publicId }).from(profiles).where(eq(profiles.userId, "replacement-bob"));
  await db.update(entries).set({ html: "<p>old</p>", cardHtml: null, htmlVersion: RENDER_VERSION - 1 }).where(eq(entries.id, topic.id));
  await db.insert(translations).values({
    entryId: topic.id, field: "body", lang: "en", kind: "human", sourceHash: row.sourceHash,
    text: `@bob thanks.\n\n${"Long paragraph. ".repeat(100)}`,
    html: "<p>old</p>", htmlVersion: RENDER_VERSION - 1,
  });
  await rebuildRenderCache(db);
  const [stored] = await db.select().from(entries).where(eq(entries.id, topic.id));
  const card = { html: stored.cardHtml! };
  const display = (await loadEntryDisplays(db, [{ id: topic.id, kind: "topic", lang: "ja", sourceHash: row.sourceHash }], { readLangs: ["en"], displayLang: "en", variant: "card" })).get(topic.id)!;
  expect(card.html).toContain(memberLink);
  expect(display.translation!.html).toContain(memberLink);
  expect(card.html).not.toContain(`/u/id/${replacement.publicId}`);
  expect(display.translation!.html).not.toContain(`/u/id/${replacement.publicId}`);
});
