import { and, inArray, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { moderationActions, reports, villages } from "./db/schema";
import { RETENTION, RETENTION_BATCH_SIZE, daysBefore } from "./retention";
import { countRetentionRows, drainRetentionBatches, updateRetentionRows, type RetentionResults } from "./retention-batch.server";

export async function pruneVillageIconCopies(db: Db, now: Date, results: RetentionResults) {
  const cutoff = daysBefore(now, RETENTION.identityReportDays);
  for (const source of ["actions", "reports"] as const) {
    const table = source === "actions" ? moderationActions : reports;
    const villageId = source === "actions" ? moderationActions.targetVillageId : reports.villageId;
    const image = source === "actions" ? moderationActions.iconMediaIdBefore : reports.iconMediaId;
    const age = source === "actions" ? sql`${moderationActions.createdAt} < ${cutoff}` : sql`${reports.status} <> 'open' and ${reports.handledAt} < ${cutoff}`;
    // A decision on any related appeal starts a fresh evidence period, as for member icons.
    const condition = sql`${image} is not null and ${age} and not exists
      (select 1 from appeals a inner join moderation_actions ma on ma.id = a.action_id
       left join reports ir on ir.id = ma.report_id
       where ma.target_village_id = ${villageId} and (ma.action = 'clear_village_icon' or ir.icon_media_id is not null)
         and (a.status = 'open' or a.decided_at is null or a.decided_at >= ${cutoff}))`;
    const deferred = new Set<number>();
    await drainRetentionBatches(db, `village_icon_${source}`, async tx => {
      const candidates = await tx.select({ id: table.id, villageId }).from(table)
        .where(and(condition, deferred.size ? sql`${table.id} not in (${sql.join([...deferred].map(id => sql`${id}`), sql`, `)})` : undefined))
        .orderBy(table.id).limit(RETENTION_BATCH_SIZE);
      if (!candidates.length) return 0;
      const locked = await tx.select({ id: villages.id }).from(villages)
        .where(inArray(villages.id, candidates.flatMap(row => row.villageId ? [row.villageId] : [])))
        .orderBy(villages.id).for("update", { skipLocked: true });
      const removed = locked.length ? await updateRetentionRows(tx, table,
        and(condition, inArray(table.id, candidates.map(row => row.id)), inArray(villageId, locked.map(row => row.id)))!,
        source === "actions" ? sql`icon_media_id_before = null` : sql`icon_media_id = null`) : 0;
      if (removed < candidates.length) for (const candidate of candidates) deferred.add(candidate.id);
      return { removed, more: true };
    }, () => countRetentionRows(db, table, condition), results);
  }
}
