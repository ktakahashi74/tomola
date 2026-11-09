import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, jobs, translations } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";
import { createEmbeddingHandlers } from "../app/lib/jobs/embedding-jobs.server";
import { runDueJobs } from "../app/lib/jobs/queue.server";
import { FLAG_PROVISIONAL_TITLE } from "../app/lib/llm/flags";
import { createFakeEngine } from "../app/lib/llm/engines/fake.server";
import { translateChecked } from "../app/lib/llm/translate.server";

export async function seedTitleFirst(db: Db) {
  const fixture: Record<string, { id: number; sourceTitle: string; listTitle: string }> = {};
  for (const state of ["pending", "provisional", "complete"]) {
    const sourceTitle = `Title first ${state} ${state === "complete" ? "5ドルと10ドルのプラン" : "5ドルのプラン"}`;
    const topic = await createTopic(db, "seed-kim", { lang: "ja", title: sourceTitle, body: `Title first ${state} 原文の本文。` });
    if (!topic.ok) throw new Error("title fixture failed");
    const [entry] = await db.select().from(entries).where(eq(entries.id, topic.id));
    const listTitle = state === "pending" ? sourceTitle : `Title first ${state}: ${state === "complete" ? "The $5 and $10 plans" : "The $5 plan"}`;
    if (state !== "pending") {
      const fake = createFakeEngine();
      const checked = await translateChecked({ ...fake, async translate(req) { return { ...await fake.translate(req), text: listTitle }; } }, { text: sourceTitle, from: "ja", to: "en", field: "title" });
      if (checked.flags.length !== 0 || checked.attempts !== 1) throw new Error("title currency fixture failed checks");
      await db.insert(translations).values({ entryId: topic.id, field: "title", lang: "en", kind: "primary", engine: "fake", text: checked.text, sourceHash: entry.sourceHash, flags: state === "provisional" ? [FLAG_PROVISIONAL_TITLE] : [] });
    }
    if (state === "complete") await db.insert(translations).values({ entryId: topic.id, field: "body", lang: "en", kind: "primary", engine: "fake", text: "Translated body.", sourceHash: entry.sourceHash });
    fixture[state] = { id: topic.id, sourceTitle, listTitle };
  }
  await runDueJobs(db, createEmbeddingHandlers({ llm: { env: { EMBEDDING_ENGINE: "fake" } } }), { now: new Date(Date.now() + 60_000), limit: 1000 });
  await db.delete(jobs).where(inArray(jobs.kind, ["translate_entry", "translate_title", "embed_entry"]));
  fs.writeFileSync(path.join(path.dirname(process.env.PGLITE_DATA_DIR!), "title-first.json"), JSON.stringify(fixture));
}
