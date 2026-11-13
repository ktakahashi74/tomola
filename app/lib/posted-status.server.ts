import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, jobs } from "~/lib/db/schema";
import { enabledTargetLangs } from "~/lib/enabled-langs.server";
import type { Lang, SourceLang } from "~/lib/languages";
import { availabilityKey, loadTranslationAvailability, type TranslationAvailability } from "~/lib/translation-availability.server";

export type PostedLangState = { lang: Lang; state: Exclude<TranslationAvailability, "unrequested"> };

// Use the same initial state and polling state, including completed notices.
export async function postedSourceLanguageStatus(db: Db, displayed: { id: number; lang: string; langCode?: string | null }) {
  const [entry] = await db.select({ lang: entries.lang, langCode: entries.langCode, langSource: entries.langSource, revision: entries.mentionRevision, sourceHash: entries.sourceHash }).from(entries).where(eq(entries.id, displayed.id));
  const work = entry ? await db.select({ kind: jobs.kind, payload: jobs.payload, status: jobs.status }).from(jobs).where(and(sql`${jobs.payload}->>'entryId' = ${String(displayed.id)}`, sql`(${jobs.payload}->>'sourceHash' = ${entry.sourceHash} or (${jobs.kind} = 'check_source_language' and ${jobs.payload}->>'revision' = ${String(entry.revision)}))`)) : [];
  // A completed correction may have overtaken the reading loader's snapshot.
  const changed = !!entry && (entry.lang !== displayed.lang || (entry.langCode ?? null) !== (displayed.langCode ?? null));
  return {
    checking: changed || entry?.langSource !== "checked" && work.some(w => w.kind === "check_source_language" && (w.payload as { revision?: number }).revision === entry?.revision && ["queued", "running"].includes(w.status)),
    mismatch: work.some(w => ["check_source_language", "source_language_receipt"].includes(w.kind) && (w.payload as { revision?: number }).revision === entry?.revision && (w.payload as { mismatch?: boolean }).mismatch),
    untranslatable: work.some(w => (w.payload as { untranslatableRevision?: number }).untranslatableRevision === entry?.revision),
  };
}

// For the author's own post: the languages it is being translated into, and whether each translation is there yet. Names only: nothing counts or ranks the readers.
export async function postedTranslationStates(db: Db, entry: { id: number; lang: SourceLang; sourceHash: string | null }): Promise<PostedLangState[]> {
  const langs = enabledTargetLangs(entry.lang);
  if (!langs.length || !entry.sourceHash) return [];
  const states = await loadTranslationAvailability(db, [entry], langs);
  return langs.flatMap(lang => {
    const state = states.get(availabilityKey(entry.id, lang)) ?? "available";
    return state === "unrequested" ? [] : [{ lang, state }];
  });
}

// Whether the topic just posted is the member's first. Nothing is recorded for this: it is read from the posts the member has.
export async function isFirstTopic(db: Db, authorId: string): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(entries).where(and(eq(entries.authorId, authorId), eq(entries.kind, "topic")));
  return Number(row.n) <= 1;
}
