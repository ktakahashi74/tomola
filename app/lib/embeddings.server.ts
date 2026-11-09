import { and, eq, isNull, ne, notExists, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, entryEmbeddings, jobs } from "~/lib/db/schema";
import { enqueue } from "~/lib/jobs/queue.server";

// Small DB helpers for entry embeddings (semantic search and observation diversity metrics). Used by posting/editing (entries.server.ts), unhide/restoration (moderation, appeals),
// deletion cleanup (purgeEntryDerivatives in translations.server.ts), jobs (jobs/embedding-jobs.server.ts), and the backfill script.
// embed_entry ({ entryId, sourceHash }; dedupe: embed:<entry id>:<source revision>) embeds source title/body and stores the model's row in entry_embeddings.
// Do not embed deleted/hidden entries. Remove rows when hidden; rebuild with the same job on unhide/restoration.

export const EMBED_JOB = "embed_entry";
// Allow long waits for budget stops and failures, as with translation: double delays starting at 30 seconds, capped at one hour; ten attempts span roughly three hours. Budget stops do not count as attempts.
export const EMBED_MAX_ATTEMPTS = 10;

export type EmbedJobPayload = { entryId: number; sourceHash: string };

export function embedDedupeKey(p: EmbedJobPayload): string {
  return `embed:${p.entryId}:${p.sourceHash}`;
}

// Queue embeddings without duplicating unfinished jobs for the same source revision. May be called within tx, which is assignable to Db.
export async function enqueueEmbedding(db: Db, entry: { id: number; sourceHash: string }): Promise<boolean> {
  const payload: EmbedJobPayload = { entryId: entry.id, sourceHash: entry.sourceHash };
  const res = await enqueue(db, EMBED_JOB, payload, { dedupeKey: embedDedupeKey(payload), maxAttempts: EMBED_MAX_ATTEMPTS });
  return res.created;
}

// Delete entry embeddings on deletion/hiding.
export async function purgeEmbeddings(db: Db, entryId: number): Promise<void> {
  await db.delete(entryEmbeddings).where(eq(entryEmbeddings.entryId, entryId));
}

// Cancel this entry's queued embed_entry jobs on deletion.
export async function cancelEmbeddingJobs(db: Db, entryId: number): Promise<number> {
  const rows = await db
    .delete(jobs)
    .where(and(eq(jobs.kind, EMBED_JOB), eq(jobs.status, "queued"), sql`${jobs.payload}->>'entryId' = ${String(entryId)}`))
    .returning({ id: jobs.id });
  return rows.length;
}

// Embedding text: title/body for topics, body for replies. Also pass the title separately to the model as the document title.
export function embeddingInput(entry: { title: string | null; body: string }): { text: string; title?: string } {
  return { text: entry.body, ...(entry.title ? { title: entry.title } : {}) };
}

// Backfill: queue embed_entry for readable entries missing this model's current-revision embedding. dedupe_key makes repeated runs safe,
// without duplicating unfinished jobs. Return queued and examined counts.
export async function requeueEmbeddings(db: Db, model: string): Promise<{ entries: number; queued: number }> {
  const missing = await db
    .select({ id: entries.id, sourceHash: entries.sourceHash })
    .from(entries)
    .where(
      and(
        isNull(entries.deletedAt),
        isNull(entries.hiddenAt),
        sql`${entries.sourceHash} is not null`,
        notExists(
          db
            .select({ one: sql`1` })
            .from(entryEmbeddings)
            .where(and(eq(entryEmbeddings.entryId, entries.id), eq(entryEmbeddings.model, model), eq(entryEmbeddings.sourceHash, entries.sourceHash))),
        ),
      ),
    )
    .orderBy(entries.id);
  let queued = 0;
  for (const row of missing) {
    if (row.sourceHash !== null && (await enqueueEmbedding(db, { id: row.id, sourceHash: row.sourceHash }))) queued++;
  }
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(entries).where(and(isNull(entries.deletedAt), isNull(entries.hiddenAt)));
  return { entries: Number(total), queued };
}

// Delete rows for other models after a model change. Search and observations use only the current model, so retained rows are unused. Keep them only if reverting
// the model is possible. Return the deleted count. Called by pnpm embeddings:backfill --prune-other-models.
export async function pruneOtherModels(db: Db, model: string): Promise<number> {
  const rows = await db.delete(entryEmbeddings).where(ne(entryEmbeddings.model, model)).returning({ entryId: entryEmbeddings.entryId });
  return rows.length;
}
