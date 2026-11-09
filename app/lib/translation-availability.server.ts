import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, jobs, translations } from "./db/schema";
import { pickTranslation, SHOWN_KINDS } from "./display";
import { HIDDEN_PRIMARY_FLAGS } from "./llm/flags";
import type { Lang } from "./languages";
import { TRANSLATE_JOB, translateDedupeKey } from "./translations.server";

export type TranslationAvailability = "available" | "pending" | "unavailable" | "unrequested";
export const availabilityKey = (entryId: number, lang: string) => `${entryId}:${lang}`;

// Read terminal failures and hidden current output in batches. A requeued job takes
// precedence over its previous failed output, so an automatic retry becomes pending.
export async function loadTranslationAvailability(
  db: Db,
  inputs: readonly { id: number; lang: Lang; sourceHash: string | null }[],
  langs: readonly Lang[],
  knownAvailable?: ReadonlyMap<number, readonly Lang[]>,
  opts: { currentOnly?: boolean } = {},
): Promise<Map<string, TranslationAvailability>> {
  const out = new Map<string, TranslationAvailability>();
  if (!inputs.length || !langs.length) return out;
  const byLang = new Map<Lang, number[]>();
  const keys: string[] = [];
  for (const entry of inputs) for (const lang of langs) {
    if (lang === entry.lang || knownAvailable?.get(entry.id)?.includes(lang)) continue;
    byLang.set(lang, [...(byLang.get(lang) ?? []), entry.id]);
    keys.push(translateDedupeKey({ entryId: entry.id, lang, sourceHash: entry.sourceHash! }, entry.lang), `translate:${entry.id}:${lang}:${entry.sourceHash}`);
  }
  if (!byLang.size) return out;
  const missing = or(...[...byLang].map(([lang, ids]) => and(eq(translations.lang, lang), inArray(translations.entryId, ids))));
  const [rows, work] = await Promise.all([
    db.select({ entryId: translations.entryId, lang: translations.lang, kind: translations.kind,
      sourceHash: translations.sourceHash, flags: translations.flags, mentionRevision: translations.mentionRevision,
      currentRevision: entries.mentionRevision }).from(translations)
      .innerJoin(entries, eq(entries.id, translations.entryId))
      .where(and(missing, eq(translations.field, "body"), inArray(translations.kind, [...SHOWN_KINDS]))),
    db.select({ payload: jobs.payload, status: jobs.status, dedupeKey: jobs.dedupeKey }).from(jobs)
      .where(and(eq(jobs.kind, TRANSLATE_JOB), inArray(jobs.status, ["queued", "running", "failed"]),
        inArray(jobs.dedupeKey, keys))),
  ]);
  for (const entry of inputs) for (const lang of langs) {
    if (lang === entry.lang || knownAvailable?.get(entry.id)?.includes(lang)) continue;
    const mine = rows.filter(r => r.entryId === entry.id && r.lang === lang);
    const key = availabilityKey(entry.id, lang);
    const candidates = opts.currentOnly ? mine.filter(r => r.sourceHash === entry.sourceHash && !r.flags.includes("stale")) : mine;
    if (pickTranslation(candidates, entry.sourceHash, mine[0]?.currentRevision)) { out.set(key, "available"); continue; }
    const relevant = work.filter(job => {
      const p = job.payload as { entryId?: number; lang?: string; sourceHash?: string };
      return p.entryId === entry.id && p.lang === lang && p.sourceHash === entry.sourceHash &&
        (job.dedupeKey === translateDedupeKey({ entryId: entry.id, lang, sourceHash: entry.sourceHash! }, entry.lang) ||
          job.dedupeKey === `translate:${entry.id}:${lang}:${entry.sourceHash}`);
    });
    if (relevant.some(job => job.status === "queued" || job.status === "running")) { out.set(key, "pending"); continue; }
    const hidden = mine.some(r => r.kind === "primary" && r.sourceHash === entry.sourceHash &&
      (r.mentionRevision === null || r.mentionRevision === r.currentRevision) && r.flags.some(f => HIDDEN_PRIMARY_FLAGS.includes(f)));
    const current = mine.some(r => r.sourceHash === entry.sourceHash && (r.mentionRevision === null || r.mentionRevision === r.currentRevision));
    out.set(key, hidden || relevant.some(job => job.status === "failed") ? "unavailable" : current ? "pending" : "unrequested");
  }
  return out;
}
