import { quietLogger as quiet } from "./helpers/logger";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { entries, translations } from "~/lib/db/schema";
import { createReply, createTopic, entryIdPrefix } from "~/lib/entries.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import { createTranslationReport, resolveReportWithHumanTranslation } from "~/lib/translation-reports.server";
import { loadEntryDisplays } from "~/lib/entry-display.server";
import { addMember, createTestDb } from "./helpers/db";

const now = new Date("2026-10-05T00:00:00Z");


async function translateAll(db: Awaited<ReturnType<typeof createTestDb>>) {
  const handlers = createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null }, env: {} } });
  return runDueJobs(db, handlers, { now, logger: quiet, limit: 500 });
}

const row = (db: Awaited<ReturnType<typeof createTestDb>>, entryId: number, field: string, lang: string, kind: string) =>
  db
    .select()
    .from(translations)
    .where(and(eq(translations.entryId, entryId), eq(translations.field, field), eq(translations.lang, lang), eq(translations.kind, kind)))
    .then((rows) => rows[0]);

describe("rendering translations when they are saved, not when they are viewed", () => {
  it("the translate job stores the rendered html of the body (with the translation's own id prefix) and none for the title", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const topic = await createTopic(db, "u1", { lang: "ja", title: "題", body: "本文 **強調**[^1]\n\n[^1]: 注。" });
    if (!topic.ok) throw new Error("topic failed");
    const reply = await createReply(db, "u1", topic.id, { lang: "ja", body: "返信" });
    if (!reply.ok) throw new Error("reply failed");
    await translateAll(db);
    const body = await row(db, topic.id, "body", "en", "primary");
    expect(body.htmlVersion).toBe(RENDER_VERSION);
    expect(body.html).toContain("<strong>強調</strong>");
    // Use a prefix p-<id>-<lang>- that does not collide with the source prefix p-<id>-.
    expect(body.html).toContain(entryIdPrefix("topic", topic.id, "en"));
    const title = await row(db, topic.id, "title", "en", "primary");
    expect(title.html).toBeNull();
    expect(title.htmlVersion).toBe(0);
    const replyBody = await row(db, reply.id, "body", "de", "primary");
    expect(replyBody.html).toContain("<p>");
    expect(replyBody.htmlVersion).toBe(RENDER_VERSION);
  });

  it("viewing uses the stored html as it is, and renders only when the cache is missing or from an older render version", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const topic = await createTopic(db, "u1", { lang: "ja", title: "題", body: "本文" });
    if (!topic.ok) throw new Error("topic failed");
    await translateAll(db);
    const [e] = await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, topic.id));
    const input = [{ id: topic.id, kind: "topic" as const, lang: "ja" as const, sourceHash: e.h }];
    const opts = { readLangs: ["ja" as const], displayLang: "en" as const };
    const where = and(eq(translations.entryId, topic.id), eq(translations.field, "body"), eq(translations.lang, "en"), eq(translations.kind, "primary"));

    // Use stored HTML unchanged without rerendering; verify with a marked replacement HTML value.
    await db.update(translations).set({ html: "<p>stored</p>" }).where(where);
    expect((await loadEntryDisplays(db, input, opts)).get(topic.id)?.translation?.html).toBe("<p>stored</p>");
    // Rerender and save an old-version cache when displaying it.
    await db.update(translations).set({ htmlVersion: RENDER_VERSION - 1 }).where(where);
    const rendered = (await loadEntryDisplays(db, input, opts)).get(topic.id)?.translation?.html;
    expect(rendered).toContain("[en] 本文");
    expect((await row(db, topic.id, "body", "en", "primary")).htmlVersion).toBe(RENDER_VERSION);
    // The same applies when the cache is missing.
    await db.update(translations).set({ html: null, htmlVersion: 0 }).where(where);
    expect((await loadEntryDisplays(db, input, opts)).get(topic.id)?.translation?.html).toContain("[en] 本文");
    expect((await row(db, topic.id, "body", "en", "primary")).html).toContain("[en] 本文");
  });

  it("a human translation is rendered on save", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    await addMember(db, "u2", "taro");
    const topic = await createTopic(db, "u1", { lang: "ja", title: "題", body: "本文" });
    if (!topic.ok) throw new Error("topic failed");
    const report = await createTranslationReport(db, "u2", { entryId: topic.id, lang: "fr", field: "body", excerpt: "x", note: "" });
    expect(report.ok).toBe(true);
    const reportId = 1;
    const resolved = await resolveReportWithHumanTranslation(db, "u1", reportId, "Corps **gras**");
    expect(resolved.ok).toBe(true);
    const human = await row(db, topic.id, "body", "fr", "human");
    expect(human.html).toContain("<strong>gras</strong>");
    expect(human.htmlVersion).toBe(RENDER_VERSION);
  });
});
