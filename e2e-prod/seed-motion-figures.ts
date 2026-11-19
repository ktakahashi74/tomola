import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, figureTranslations, translations, user } from "../app/lib/db/schema";
import { parseMediaPath } from "../app/lib/media";
import { createTopic } from "../app/lib/entries.server";
import { rewriteMedia } from "../app/lib/media-processing.server";
import { putMedia, putUploadedMedia } from "../app/lib/media-store.server";
import { motionImage } from "../tests/helpers/motion-images";
import { createFigureHandlers } from "../app/lib/jobs/figure-jobs.server";
import { runDueJobs } from "../app/lib/jobs/queue.server";

export async function seedMotionFigures(db: Db, dir: string) {
  const [author] = await db.select({ id: user.id }).from(user).where(eq(user.email, "motion_figure_author@example.com"));
  const width = 960, height = 200;
  const saved = await putUploadedMedia(db, author.id, await rewriteMedia((await motionImage("gif", 4, width, height, 300)).bytes));
  if (!("posterUrl" in saved)) throw new Error("Motion poster missing");
  // Match the fake reader's invented label and box so this case exercises a
  // translated still rather than the legitimate external-label fallback.
  const bytes = await sharp({ create: { width, height, channels: 3, background: "#e3edf7" } }).composite([
    { input: { text: { text: "Synthetic figure label", font: "sans 18", width: 280, height: 60, rgba: true } }, left: 100, top: 50 },
  ]).webp({ lossless: true }).toBuffer();
  const still = await putMedia(db, author.id, { bytes, width, height });
  const body = `[![Synthetic diagram](${still.url})](${saved.url})`;
  const previous = process.env.FIGURE_TRANSLATION;
  process.env.FIGURE_TRANSLATION = "1";
  try {
    const created = await createTopic(db, author.id, { title: "Translated motion figure", body: body + "\n\nText after the figure.", lang: "en" }, { asIntroduction: true });
    if (!created.ok) throw new Error(created.error);
    const [source] = await db.select().from(entries).where(eq(entries.id, created.id));
    await db.insert(translations).values({ entryId: created.id, field: "body", kind: "primary", lang: "ja", text: body.replace("Synthetic diagram", "試験の図") + "\n\nText after the figure.", sourceHash: source.sourceHash, engine: "fake" });
    const condition = and(eq(figureTranslations.mediaId, parseMediaPath(still.url)!.id), eq(figureTranslations.lang, "ja"));
    const handlers = createFigureHandlers({ llm: { env: { ...process.env, FIGURE_TRANSLATION: "1", TRANSLATION_PRIMARY: "fake", TRANSLATION_SECONDARY: "none", DIVERGENCE_JUDGE: "none", ENABLED_LANGS: "ja,en" } } });
    let translated: typeof figureTranslations.$inferSelect | undefined;
    // PostgreSQL job timestamps can fall just beyond the current JS millisecond.
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await runDueJobs(db, handlers, { limit: 100 });
      if (result.failed || result.retried || result.deferred) throw new Error("Motion figure fixture generation failed");
      [translated] = await db.select().from(figureTranslations).where(condition);
      if (translated) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!translated) throw new Error("Motion figure translation missing");
    // Include both an overlaid label and an external list to exercise layout.
    await db.update(figureTranslations).set({ labelResults: [...translated.labelResults!, { source: "Additional diagram explanation", translation: "図の補足説明", status: "external", reason: "does_not_fit" }] }).where(condition);
    // No eager body job: the browser releases its request after autoplay ends.
    const priorMinimum = process.env.TRANSLATION_EAGER_MIN_READERS;
    const priorScope = process.env.TRANSLATION_EAGER_SCOPE;
    process.env.TRANSLATION_EAGER_MIN_READERS = "1000000";
    process.env.TRANSLATION_EAGER_SCOPE = "readers";
    let pending;
    try { pending = await createTopic(db, author.id, { body, lang: "en" }); }
    finally {
      if (priorMinimum === undefined) delete process.env.TRANSLATION_EAGER_MIN_READERS; else process.env.TRANSLATION_EAGER_MIN_READERS = priorMinimum;
      if (priorScope === undefined) delete process.env.TRANSLATION_EAGER_SCOPE; else process.env.TRANSLATION_EAGER_SCOPE = priorScope;
    }
    if (!pending.ok) throw new Error(pending.error);
    fs.writeFileSync(path.join(dir, "motion-figure.json"), JSON.stringify({ id: created.id, pendingId: pending.id, ...saved, posterUrl: still.url }));
  } finally { if (previous === undefined) delete process.env.FIGURE_TRANSLATION; else process.env.FIGURE_TRANSLATION = previous; }
}
