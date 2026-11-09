import fs from "node:fs";
import { sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { aiDraftEdits, jobs, translationReports, user } from "../app/lib/db/schema";
import { parseEvalSet } from "../app/lib/eval/cases.server";
import { createEvalJudge } from "../app/lib/eval/judge.server";
import { runEvaluation } from "../app/lib/eval/run.server";
import { recordTranslationGeneration } from "../app/lib/eval/signals.server";
import { createTopic } from "../app/lib/entries.server";
import { createProfile } from "../app/lib/profiles.server";

export async function seedEvalSet(db: Db) {
  const all = parseEvalSet(fs.readFileSync("eval/translation/cases.yaml", "utf8"));
  const set = { ...all, cases: all.cases.filter(c => ["E01", "E31", "E34"].includes(c.id)).map(c => ({ ...c, to: ["en", "fr"] as typeof c.to })) };
  const env = { TRANSLATION_PRIMARY: "fake", EVAL_JUDGE_PROVIDER: "fake" };
  await runEvaluation(db, set, env, { now: () => new Date("2026-11-02T00:00:00Z") });
  const changed = { ...env, EVAL_JUDGE_MODEL: "fake-eval-alternate" };
  const judge = createEvalJudge(changed);
  await runEvaluation(db, set, changed, { now: () => new Date("2026-11-02T01:00:00Z"), judge: { ...judge, async judge(input) {
    const out = await judge.judge(input);
    return { ...out, results: out.results.map(r => r.id.startsWith("E01-") ? { ...r, preserved: false, severe: true, reason: "Deliberate fake failure for the history fixture." } : r) };
  } } });
  const authorId = "eval-quality-writer";
  await db.insert(user).values({ id: authorId, name: "", email: "eval_quality_writer@example.com", emailVerified: true });
  const profile = await createProfile(db, authorId, { handle: "eval_quality_writer", homeArea: "ja", readLangs: ["ja"] });
  if (!profile.ok) throw new Error(profile.error);
  await recordTranslationGeneration(db, "post", "ja", "en");
  await recordTranslationGeneration(db, "post", "ja", "en");
  const entry = await createTopic(db, authorId, { lang: "ja", title: "Evaluation signal fixture", body: "評価の信号を確かめる例文。" }, { now: new Date("2025-01-01T00:00:00Z") });
  if (!entry.ok) throw new Error(entry.error);
  await db.delete(jobs).where(sql`${jobs.payload}->>'entryId' = ${String(entry.id)}`);
  const now = new Date();
  await db.insert(translationReports).values({ entryId: entry.id, sourceLang: "ja", lang: "en", field: "body", createdAt: now, status: "resolved", correctedAt: now, resolvedAt: now });
  await db.insert(aiDraftEdits).values({ entryId: entry.id, source: "mcp", beforeChars: 100, afterChars: 120, changedChars: 20, comparisonChars: 120, changed: true });
}
