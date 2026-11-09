import { and, eq, isNull, lt, notInArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { appeals, divergences, entries, entryEmbeddings, entryMedia, entryMentionSnapshots, entryReferences, entryRevisions, memberSignatures, moderationActions, reports, segments, translationReports, translationRevisions, translations } from "~/lib/db/schema";
import { RETENTION, RETENTION_BATCH_SIZE, PURGED_QUESTION_TITLE, daysBefore } from "~/lib/retention";
import { deleteRetentionRows, updateRetentionRows, drainRetentionBatches, type RetentionResults } from "~/lib/retention-batch.server";

export type EntryRetentionCounts = { entries: number; revisionsDeleted: number; revisionsPruned: number };

// These are copies or indexes of the original content, not other members' text.
const derivatives = [entryMentionSnapshots, memberSignatures, translations, translationRevisions, entryEmbeddings, segments, divergences, entryMedia] as const;
const referencedRevision = sql`exists (select 1 from ${moderationActions} where ${moderationActions.revisionId} = ${entryRevisions.id})`;
const pendingRevision = sql`(${entryRevisions.body} <> '' or ${entryRevisions.title} is not null or not ${referencedRevision})`;

const sourcePending = sql`(${entries.body} <> '' or (${entries.title} is not null and ${entries.title} <> ${PURGED_QUESTION_TITLE}) or ${entries.sourceHash} is not null)`;
const excerptPending = sql`${translationReports.excerpt} <> ''`;

function eligible(now: Date): SQL {
  return and(
    lt(entries.deletedAt, daysBefore(now, RETENTION.deletedEntryDays)), isNull(entries.hiddenAt),
    // An operator deletion is reversible and is not an author's deletion.
    sql`not exists (select 1 from ${moderationActions} where ${moderationActions.id} = ${entries.moderationActionId} and ${moderationActions.action} = 'delete')`,
    // Include member actions whose underlying report concerns this post.
    sql`not exists (select 1 from ${appeals} inner join ${moderationActions} on ${moderationActions.id} = ${appeals.actionId}
      left join ${reports} on ${reports.id} = ${moderationActions.reportId}
      where ${appeals.status} = 'open' and (${moderationActions.targetEntryId} = ${entries.id} or ${reports.entryId} = ${entries.id}
        or ${moderationActions.revisionId} in (select ${entryRevisions.id} from ${entryRevisions} where ${entryRevisions.entryId} = ${entries.id})))`,
    // A source can already be blank while a bounded derivative backlog remains.
    sql`(${sourcePending}
      or exists (select 1 from ${entryRevisions} where ${entryRevisions.entryId} = ${entries.id} and ${pendingRevision})
      or exists (select 1 from ${translationReports} where ${translationReports.entryId} = ${entries.id} and ${excerptPending})
      or exists (select 1 from ${entryReferences} where ${entryReferences.sourceEntryId} = ${entries.id})
      or ${sql.join(derivatives.map(table => sql`exists (select 1 from ${table} where ${table.entryId} = ${entries.id})`), sql` or `)})`,
  )!;
}

export async function pruneDeletedEntries(db: Db, now: Date, results?: RetentionResults): Promise<EntryRetentionCounts> {
  const counts: EntryRetentionCounts = { entries: 0, revisionsDeleted: 0, revisionsPruned: 0 };
  const condition = eligible(now);
  const blocked = new Set<number>();
  await drainRetentionBatches(db, "entry_content", async tx => {
    // Serialize appeals and source erasure on the entry, and share one mutation
    // budget across its source, revisions and every derivative table.
    const candidates = await tx.select({ id: entries.id, asksStance: entries.asksStance, sourcePending: sql<boolean>`${sourcePending}` }).from(entries)
      .where(and(condition, blocked.size ? notInArray(entries.id, [...blocked]) : undefined)).orderBy(entries.deletedAt, entries.id).limit(RETENTION_BATCH_SIZE).for("no key update", { skipLocked: true });
    let changed = 0;
    const batchCounts: EntryRetentionCounts = { entries: 0, revisionsDeleted: 0, revisionsPruned: 0 };
    for (const entry of candidates) {
      if (changed === RETENTION_BATCH_SIZE) break;
      const before = changed;
      if (entry.sourcePending) {
        await tx.update(entries).set({ body: "", title: entry.asksStance ? PURGED_QUESTION_TITLE : null, sourceHash: null, html: null, cardHtml: null, htmlVersion: 0 }).where(eq(entries.id, entry.id));
        changed++;
        batchCounts.entries++;
      }
      const revisionsDeleted = await deleteRetentionRows(tx, entryRevisions,
        and(eq(entryRevisions.entryId, entry.id), sql`not ${referencedRevision}`)!, RETENTION_BATCH_SIZE - changed);
      changed += revisionsDeleted;
      batchCounts.revisionsDeleted += revisionsDeleted;
      const revisionsPruned = await updateRetentionRows(tx, entryRevisions,
        and(eq(entryRevisions.entryId, entry.id), referencedRevision, sql`(${entryRevisions.body} <> '' or ${entryRevisions.title} is not null)`)!,
        sql`body = '', title = null, mention_revision = 0`, RETENTION_BATCH_SIZE - changed);
      changed += revisionsPruned;
      batchCounts.revisionsPruned += revisionsPruned;
      for (const table of derivatives) changed += await deleteRetentionRows(tx, table, eq(table.entryId, entry.id), RETENTION_BATCH_SIZE - changed);
      changed += await deleteRetentionRows(tx, entryReferences, eq(entryReferences.sourceEntryId, entry.id), RETENTION_BATCH_SIZE - changed);
      changed += await updateRetentionRows(tx, translationReports, and(eq(translationReports.entryId, entry.id), excerptPending)!, sql`excerpt = ''`, RETENTION_BATCH_SIZE - changed);
      // Do not let locked copies fill the next candidate window. Retrying them
      // is safe on the next invocation; the pending count still includes them.
      if (changed === before) blocked.add(entry.id);
    }
    // Commit counts only after all statements in this batch have succeeded.
    counts.entries += batchCounts.entries;
    counts.revisionsDeleted += batchCounts.revisionsDeleted;
    counts.revisionsPruned += batchCounts.revisionsPruned;
    return { removed: changed, more: candidates.length > 0 };
  }, async () => {
    const { rows } = await db.execute(sql`select coalesce(sum(
      (${sourcePending})::int
      + (select count(*) from ${entryRevisions} where ${entryRevisions.entryId} = ${entries.id} and ${pendingRevision})
      + (select count(*) from ${entryReferences} where ${entryReferences.sourceEntryId} = ${entries.id})
      + (select count(*) from ${translationReports} where ${translationReports.entryId} = ${entries.id} and ${excerptPending})
      + ${sql.join(derivatives.map(table => sql`(select count(*) from ${table} where ${table.entryId} = ${entries.id})`), sql` + `)}
    ), 0)::int as count from ${entries} where ${condition}`) as { rows: { count: number }[] };
    return rows[0].count;
  }, results);
  return counts;
}
