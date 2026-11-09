import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, figureTranslations, translations, user } from "../app/lib/db/schema";
import { createTopic, createReply } from "../app/lib/entries.server";
import { putMedia } from "../app/lib/media-store.server";
import { createFigureHandlers } from "../app/lib/jobs/figure-jobs.server";
import { runDueJobs } from "../app/lib/jobs/queue.server";

export async function seedFigureTranslation(db: Db, dir: string) {
  const fixtures: Record<string, { id: number; reply: number; url: string; alt: string; translatedAlt: string }> = {};
  for (const scenario of ["toggle", "nojs", "missing", "fallback_all", "unavailable", "unchanged"]) {
    const [author] = await db.select().from(user).where(eq(user.email, `figure_${scenario}_author@example.com`));
    const image = await sharp({ create: { width: 360, height: 200, channels: 3, background: "#e3edf7" } }).composite([
      { input: { text: { text: "Synthetic figure label", font: "sans 18", width: 280, height: 60, rgba: true } }, left: 40, top: 50 },
    ]).webp({ lossless: true }).toBuffer();
    const upload = await putMedia(db, author.id, { bytes: image, width: 360, height: 200 });
    const alt = `Authored figure ${scenario}`;
    const translatedAlt = `Translated caption ${scenario}`;
    const body = `A figure.\n\n![${alt}](${upload.url})`;
    const topic = await createTopic(db, author.id, { title: `Figure ${scenario}`, body, lang: "en" }, { now: new Date("2025-01-01T00:00:00Z") });
    if (!topic.ok) throw new Error(topic.error);
    const reply = await createReply(db, author.id, topic.id, { body, lang: "en" }, { now: new Date("2025-01-01T00:01:00Z") });
    if (!reply.ok) throw new Error(reply.error);
    for (const id of [topic.id, reply.id]) {
      const [source] = await db.select().from(entries).where(eq(entries.id, id));
      await db.insert(translations).values({ entryId: id, field: "body", kind: "primary", lang: "ja", text: `[ja] ${body.replace(alt, translatedAlt)}`, sourceHash: source.sourceHash, engine: "fake" });
    }
    fixtures[scenario] = { id: topic.id, reply: reply.id, url: upload.url, alt, translatedAlt };
  }
  // Use the actual fake pipeline, with just the one target used by these cases.
  const result = await runDueJobs(db, createFigureHandlers({ llm: { env: { ...process.env, FIGURE_TRANSLATION: "1", TRANSLATION_PRIMARY: "fake", TRANSLATION_SECONDARY: "none", DIVERGENCE_JUDGE: "none", ENABLED_LANGS: "ja,en" } } }), { limit: 100 });
  if (result.failed || result.retried || result.deferred) throw new Error("Figure fixture generation failed");
  for (const scenario of ["toggle", "nojs", "fallback_all"]) {
    const id = fixtures[scenario].url.slice(7, 71);
    await db.update(figureTranslations).set({ ...(scenario === "fallback_all" ? { state: "skipped", bytes: null } : {}), labelResults: [
      { source: "Source <label>", translation: "訳 <label>", status: "external", reason: "does_not_fit", required: { width: 500, height: 20 }, available: { width: 100, height: 20 } },
      { source: "∂ K(w)", translation: "d K(w)", status: "external", reason: "math_mismatch" },
      { source: "Example Name", translation: "example name", status: "unchanged", reason: null },
    ] }).where(eq(figureTranslations.mediaId, id));
  }
  const unavailable = fixtures.unavailable.url.slice(7, 71);
  await db.update(figureTranslations).set({ state: "skipped", bytes: null, labels: null, labelResults: ["First", "Second"].map(source => ({ source, translation: null, status: "external" as const, reason: "invalid_translation" as const })) }).where(eq(figureTranslations.mediaId, unavailable));
  const missing = fixtures.missing.url.slice(7, 71);
  await db.update(figureTranslations).set({ state: "skipped", bytes: null, labels: null }).where(eq(figureTranslations.mediaId, missing));
  const unchanged = fixtures.unchanged.url.slice(7, 71);
  await db.update(figureTranslations).set({ state: "skipped", bytes: null, labels: ["Example Name"], labelResults: [{ source: "Example Name", translation: "Example Name", status: "unchanged", reason: null }] }).where(eq(figureTranslations.mediaId, unchanged));
  fs.writeFileSync(path.join(dir, "figure-translation.json"), JSON.stringify(fixtures));
}
