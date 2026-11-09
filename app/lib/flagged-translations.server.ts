import { and, arrayOverlaps, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, translations } from "~/lib/db/schema";
import { REVIEW_FLAGS } from "~/lib/llm/flags";

// The machine translations that carry a flag asking an operator to look at them (REVIEW_FLAGS): the check marks of the translation pipeline (structure, link, untranslated, near copy).
// Only the current translation of a post that is not deleted or hidden, newest first. A near-copy flag is shown to readers, so this list is how a false positive gets noticed.
export type FlaggedTranslation = {
  entryId: number;
  threadId: number;
  kind: "topic" | "reply";
  lang: string;
  field: string;
  flags: string[];
  model: string | null;
  updatedAt: Date;
};

export async function listFlaggedTranslations(db: Db, limit = 50): Promise<FlaggedTranslation[]> {
  const rows = await db
    .select({
      entryId: translations.entryId,
      threadId: entries.threadId,
      kind: entries.kind,
      lang: translations.lang,
      field: translations.field,
      flags: translations.flags,
      model: translations.model,
      updatedAt: translations.updatedAt,
    })
    .from(translations)
    .innerJoin(entries, eq(entries.id, translations.entryId))
    .where(
      and(
        eq(translations.kind, "primary"),
        arrayOverlaps(translations.flags, [...REVIEW_FLAGS]),
        sql`${translations.sourceHash} = ${entries.sourceHash}`,
        isNull(entries.deletedAt),
        isNull(entries.hiddenAt),
      ),
    )
    .orderBy(desc(translations.updatedAt), desc(translations.id))
    .limit(limit);
  return rows.map((r) => ({
    entryId: r.entryId,
    threadId: r.threadId ?? r.entryId,
    kind: r.kind as "topic" | "reply",
    lang: r.lang,
    field: r.field,
    flags: r.flags.filter((f) => REVIEW_FLAGS.includes(f)),
    model: r.model,
    updatedAt: r.updatedAt,
  }));
}
