import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, translations, user } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";
import { rewriteMedia } from "../app/lib/media-processing.server";
import { putMedia, putUploadedMedia } from "../app/lib/media-store.server";
import { motionImage } from "../tests/helpers/motion-images";
import { createFigureHandlers } from "../app/lib/jobs/figure-jobs.server";
import { runDueJobs } from "../app/lib/jobs/queue.server";

export async function seedMotionFigures(db: Db, dir: string) {
  const [author] = await db.select({ id: user.id }).from(user).where(eq(user.email, "motion_figure_author@example.com"));
  const saved = await putUploadedMedia(db, author.id, await rewriteMedia((await motionImage("gif", 8, 360, 200)).bytes));
  if (!("posterUrl" in saved)) throw new Error("Motion poster missing");
  // Match the fake reader's invented label and box so this case exercises a
  // translated still rather than the legitimate external-label fallback.
  const bytes = await sharp({ create: { width: 360, height: 200, channels: 3, background: "#e3edf7" } }).composite([
    { input: { text: { text: "Synthetic figure label", font: "sans 18", width: 280, height: 60, rgba: true } }, left: 40, top: 50 },
  ]).webp({ lossless: true }).toBuffer();
  const still = await putMedia(db, author.id, { bytes, width: 360, height: 200 });
  const body = `[![Synthetic diagram](${still.url})](${saved.url})`;
  const previous = process.env.FIGURE_TRANSLATION;
  process.env.FIGURE_TRANSLATION = "1";
  try {
    const created = await createTopic(db, author.id, { title: "Translated motion figure", body, lang: "en" });
    if (!created.ok) throw new Error(created.error);
    const [source] = await db.select().from(entries).where(eq(entries.id, created.id));
    await db.insert(translations).values({ entryId: created.id, field: "body", kind: "primary", lang: "ja", text: body.replace("Synthetic diagram", "試験の図"), sourceHash: source.sourceHash, engine: "fake" });
    const result = await runDueJobs(db, createFigureHandlers({ llm: { env: { ...process.env, FIGURE_TRANSLATION: "1", TRANSLATION_PRIMARY: "fake", TRANSLATION_SECONDARY: "none", DIVERGENCE_JUDGE: "none", ENABLED_LANGS: "ja,en" } } }), { limit: 100 });
    if (result.failed || result.retried || result.deferred) throw new Error("Motion figure fixture generation failed");
    fs.writeFileSync(path.join(dir, "motion-figure.json"), JSON.stringify({ id: created.id, ...saved, posterUrl: still.url }));
  } finally { if (previous === undefined) delete process.env.FIGURE_TRANSLATION; else process.env.FIGURE_TRANSLATION = previous; }
}
