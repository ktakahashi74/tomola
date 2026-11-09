import { and, eq } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { translationRevisions, translations, type TRANSLATION_REVISION_REASONS } from "~/lib/db/schema";

// Translation history (translation_revisions). Preserve the old row before overwriting a translation.
// Call before overwriting within the same transaction so an overwrite cannot commit without its history entry.
// Skip history when the translation text, engine, model, source version, and secondary flag are all unchanged; do not accumulate identical revisions.

export type RevisionReason = (typeof TRANSLATION_REVISION_REASONS)[number];
export type TranslationKey = { entryId: number; field: string; lang: string; kind: string };
// Content after the overwrite; skip history if identical. Omit when deleting.
export type NextTranslation = { text: string; engine: string | null; model: string | null; sourceHash: string | null; fallback: boolean };

// Copy an existing old row to history and return true; return false if absent or unchanged.
export async function recordRevision(db: Db, key: TranslationKey, reason: RevisionReason, now: Date, next?: NextTranslation): Promise<boolean> {
  const [old] = await db
    .select()
    .from(translations)
    .where(and(eq(translations.entryId, key.entryId), eq(translations.field, key.field), eq(translations.lang, key.lang), eq(translations.kind, key.kind)));
  if (!old) return false;
  if (next && old.text === next.text && old.engine === next.engine && old.model === next.model && old.sourceHash === next.sourceHash && old.fallback === next.fallback) return false;
  await db.insert(translationRevisions).values({
    entryId: old.entryId,
    field: old.field,
    lang: old.lang,
    kind: old.kind,
    text: old.text,
    engine: old.engine,
    model: old.model,
    promptVersion: old.promptVersion,
    glossaryVersion: old.glossaryVersion,
    sourceHash: old.sourceHash,
    flags: old.flags,
    fallback: old.fallback,
    createdBy: old.createdBy,
    createdAt: old.createdAt,
    replacedAt: now,
    reason,
  });
  return true;
}

// Delete translation history for a post during deletion (purgeEntryDerivatives).
export async function purgeTranslationRevisions(db: Db, entryId: number): Promise<void> {
  await db.delete(translationRevisions).where(eq(translationRevisions.entryId, entryId));
}
