import { pruneVillageIconCopies } from "./village-icon-retention.server";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "~/lib/db/client.server";
import { appeals, entryMedia, media, moderationActions, profiles, reports, villages } from "~/lib/db/schema";
import { deleteMedia } from "~/lib/media-store.server";
import { RETENTION, RETENTION_BATCH_SIZE, daysBefore } from "~/lib/retention";
import { countRetentionRows, drainRetentionBatches, updateRetentionRows, withRetentionRun, type RetentionResults } from "~/lib/retention-batch.server";

// Related reports can be closed together with only one linked to the action.
// Protect all copies for this member and identity kind, including member actions
// linked through a report. Finished appeals start another full evidence period.
function appealProtection(userId: SQL, kind: "avatar" | "display_name", cutoff: Date): SQL {
  const action = alias(moderationActions, "identity_appeal_action");
  const report = alias(reports, "identity_appeal_report");
  const reportUser = kind === "avatar" ? report.avatarUserId : report.displayNameUserId;
  return sql`not exists (select 1 from ${appeals} inner join ${moderationActions} as ${action} on ${action.id} = ${appeals.actionId}
    left join ${reports} as ${report} on ${report.id} = ${action.reportId}
    where ((${action.targetUserId} = ${userId} and ${action.action} = ${`clear_${kind}`}) or ${reportUser} = ${userId})
      and (${appeals.status} = 'open' or ${appeals.decidedAt} is null or ${appeals.decidedAt} >= ${cutoff}))`;
}

async function pruneCopies(db: Db, now: Date, source: "actions" | "reports", results: RetentionResults) {
  const table = source === "actions" ? moderationActions : reports;
  const userId = source === "actions" ? sql`${moderationActions.targetUserId}` : sql`coalesce(${reports.avatarUserId}, ${reports.displayNameUserId})`;
  const cutoff = daysBefore(now, RETENTION.identityReportDays);
  const age = source === "actions" ? sql`${moderationActions.createdAt} < ${cutoff}` : sql`${reports.status} <> 'open' and ${reports.handledAt} < ${cutoff}`;
  const avatar = source === "actions" ? moderationActions.avatarMediaIdBefore : reports.avatarMediaId;
  const names = source === "actions" ? moderationActions.displayNamesBefore : reports.displayNamesReported;
  const condition = sql`${age} and (
    (${avatar} is not null and ${appealProtection(userId, "avatar", cutoff)}) or
    (${names} is not null and ${appealProtection(userId, "display_name", cutoff)}))`;
  // Eligibility already proves the sole non-null copy is unprotected. Only a
  // mixed row needs another appeal lookup to preserve its protected half.
  const singleKind = sql`${avatar} is null or ${names} is null`;
  const avatarValue = sql`case when ${singleKind} or ${appealProtection(userId, "avatar", cutoff)} then null else ${avatar} end`;
  const namesValue = sql`case when ${singleKind} or ${appealProtection(userId, "display_name", cutoff)} then null else ${names} end`;
  const values = source === "actions" ? sql`avatar_media_id_before = ${avatarValue}, display_names_before = ${namesValue}` : sql`avatar_media_id = ${avatarValue}, display_names_reported = ${namesValue}`;
  const deferred = new Set<number>();
  await drainRetentionBatches(db, `identity_${source === "actions" ? "action" : "report"}_snapshots`, async tx => {
    const candidates = await tx.select({ id: table.id, userId: userId.mapWith(String) }).from(table)
      .where(and(condition, deferred.size ? sql`${table.id} not in (${sql.join([...deferred].map(id => sql`${id}`), sql`, `)})` : undefined))
      .orderBy(table.id).limit(RETENTION_BATCH_SIZE);
    if (!candidates.length) return 0;
    // Match identity changes, report handling and appeal filing: profile first,
    // then evidence rows. Recheck eligibility in a fresh statement after locking.
    const locked = await tx.select({ id: profiles.userId }).from(profiles)
      .where(inArray(profiles.userId, [...new Set(candidates.map(row => row.userId))])).orderBy(profiles.userId).for("update", { skipLocked: true });
    const removed = locked.length ? await updateRetentionRows(tx, table,
      and(condition, inArray(table.id, candidates.map(row => row.id)), sql`${userId} in (${sql.join(locked.map(row => sql`${row.id}`), sql`, `)})`)!, values) : 0;
    if (removed < candidates.length) for (const candidate of candidates) deferred.add(candidate.id);
    return { removed, more: true };
  }, () => countRetentionRows(db, table, condition), results);
}

async function pruneAvatarMedia(db: Db, now: Date, results: RetentionResults) {
  const condition = sql`${media.avatar} = true and ${media.deletedAt} is null and ${media.uploadedAt} < ${daysBefore(now, RETENTION.identityReportDays)}
    and not exists (select 1 from ${profiles} where ${profiles.avatarMediaId} = ${media.id})
    and not exists (select 1 from ${reports} where ${reports.avatarMediaId} = ${media.id})
    and not exists (select 1 from ${moderationActions} where ${moderationActions.avatarMediaIdBefore} = ${media.id})
    and not exists (select 1 from ${villages} where ${villages.iconMediaId} = ${media.id})
    and not exists (select 1 from ${reports} where ${reports.iconMediaId} = ${media.id})
    and not exists (select 1 from ${moderationActions} where ${moderationActions.iconMediaIdBefore} = ${media.id})
    and not exists (select 1 from ${entryMedia} where ${entryMedia.mediaId} = ${media.id})`;
  const deferred = new Set<string>();
  await drainRetentionBatches(db, "identity_avatar_media", async tx => {
    const candidates = await tx.select({ id: media.id, userId: media.uploadedBy }).from(media)
      .where(and(condition, deferred.size ? sql`${media.id} not in (${sql.join([...deferred].map(id => sql`${id}`), sql`, `)})` : undefined))
      .orderBy(media.id).limit(RETENTION_BATCH_SIZE);
    let removed = 0;
    for (const candidate of candidates) {
      const [person] = await tx.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, candidate.userId)).for("update", { skipLocked: true });
      if (!person) { deferred.add(candidate.id); continue; }
      const [binding] = await tx.select({ villageId: media.villageId }).from(media).where(eq(media.id, candidate.id));
      if (binding?.villageId) {
        const [place] = await tx.select({ id: villages.id }).from(villages).where(eq(villages.id, binding.villageId)).for("update", { skipLocked: true });
        if (!place) { deferred.add(candidate.id); continue; }
      }
      const [image] = await tx.select({ id: media.id }).from(media).where(and(eq(media.id, candidate.id), condition)).for("update", { skipLocked: true });
      if (image && await deleteMedia(tx, image.id, now)) removed++;
      else deferred.add(candidate.id);
    }
    return { removed, more: candidates.length > 0 };
  }, () => countRetentionRows(db, media, condition), results);
}

// Separate media sweeping survives a stop between clearing a pointer and erasing
// the bytes. Existing media deletion retains the URL's withdrawn tombstone.
export function pruneIdentitySnapshots(db: Db, now: Date, results: RetentionResults = {}) {
  return withRetentionRun({}, async () => {
    await pruneCopies(db, now, "actions", results);
    await pruneCopies(db, now, "reports", results);
    await pruneVillageIconCopies(db, now, results);
    await pruneAvatarMedia(db, now, results);
    return results;
  });
}
