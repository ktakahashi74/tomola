import { and, count, eq } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries } from "~/lib/db/schema";
import { enabledTargetLangs } from "~/lib/enabled-langs.server";
import type { Lang, SourceLang } from "~/lib/languages";
import { availabilityKey, loadTranslationAvailability, type TranslationAvailability } from "~/lib/translation-availability.server";

export type PostedLangState = { lang: Lang; state: Exclude<TranslationAvailability, "unrequested"> };

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
