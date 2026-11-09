import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "~/lib/db/schema";
import { RETENTION, RETENTION_BATCH_SIZE, daysBefore } from "~/lib/retention";
import { countRetentionRows, drainRetentionBatches, type RetentionResults } from "~/lib/retention-batch.server";

export async function listConnections(db: Db, userId: string) {
  return db.select({ id: oauthConsent.id, clientId: oauthConsent.clientId, name: oauthClient.name, uri: oauthClient.uri, scopes: oauthConsent.scopes, createdAt: oauthConsent.createdAt, lastUsedAt: oauthConsent.lastUsedAt })
    .from(oauthConsent).innerJoin(oauthClient, eq(oauthConsent.clientId, oauthClient.clientId))
    .where(eq(oauthConsent.userId, userId)).orderBy(desc(oauthConsent.createdAt));
}

// Deleting the consent UUID invalidates already-issued JWTs as well as future refreshes.
// A new authorization creates a different UUID; reconnecting cannot revive an old JWT.
export async function revokeConnection(db: Db, userId: string, id: string) {
  const [candidate] = await db.select({ clientId: oauthConsent.clientId }).from(oauthConsent).where(and(eq(oauthConsent.id, id), eq(oauthConsent.userId, userId)));
  if (!candidate) return false;
  return db.transaction(async (tx) => {
    // Stable client rows survive consent deletion. Token issuance takes this same lock first.
    await tx.select({ id: oauthClient.id }).from(oauthClient).where(eq(oauthClient.clientId, candidate.clientId)).for("no key update");
    const [grant] = await tx.select().from(oauthConsent).where(and(eq(oauthConsent.id, id), eq(oauthConsent.userId, userId))).for("update");
    if (!grant) return false;
    const owner = and(eq(oauthAccessToken.clientId, grant.clientId), eq(oauthAccessToken.userId, userId));
    await tx.delete(oauthAccessToken).where(owner);
    await tx.delete(oauthRefreshToken).where(and(eq(oauthRefreshToken.clientId, grant.clientId), eq(oauthRefreshToken.userId, userId)));
    await tx.delete(oauthConsent).where(and(eq(oauthConsent.id, id), eq(oauthConsent.userId, userId)));
    return true;
  });
}

// Issuance and consent creation lock the client row too. Recheck grants after
// obtaining that lock, so cleanup cannot cascade-delete a concurrent new grant.
export async function pruneUnusedClients(db: Db, now = new Date(), results?: RetentionResults): Promise<void> {
  const condition = and(lt(oauthClient.createdAt, daysBefore(now, RETENTION.unusedOauthClientDays)), sql`not exists (select 1 from ${oauthConsent} where ${oauthConsent.clientId} = ${oauthClient.clientId})`)!;
  await drainRetentionBatches(db, "unused_oauth_clients", async tx => {
    const clients = await tx.select({ id: oauthClient.id, clientId: oauthClient.clientId }).from(oauthClient)
      .where(condition).orderBy(oauthClient.id).limit(RETENTION_BATCH_SIZE).for("update", { skipLocked: true });
    let removed = 0;
    for (const client of clients) {
      const [grant] = await tx.select({ id: oauthConsent.id }).from(oauthConsent).where(eq(oauthConsent.clientId, client.clientId)).limit(1);
      if (!grant) removed += (await tx.delete(oauthClient).where(eq(oauthClient.id, client.id)).returning({ id: oauthClient.id })).length;
    }
    return removed;
  }, () => countRetentionRows(db, oauthClient, condition), results);
}

// A refresh token that was just rotated keeps its answer for a short grace period so a repeated request gets the same result. Once the period is over the stored answer
// (which holds the live refresh token) has no use: empty it, so it does not stay in the database until the next rotation.
export async function pruneRotationReplays(db: Db, now = new Date(), results?: RetentionResults): Promise<number> {
  const condition = and(isNotNull(oauthRefreshToken.rotationReplayResponse), lt(oauthRefreshToken.rotationReplayExpiresAt, now))!;
  const result = await drainRetentionBatches(db, "oauth_rotation_replays", async tx => {
    // Never wait for token issuance or family invalidation while holding other token rows.
    const rows = await tx.select({ id: oauthRefreshToken.id }).from(oauthRefreshToken)
      .where(condition).orderBy(oauthRefreshToken.id).limit(RETENTION_BATCH_SIZE).for("update", { skipLocked: true });
    if (!rows.length) return 0;
    return (await tx.update(oauthRefreshToken).set({ rotationReplayResponse: null })
      .where(inArray(oauthRefreshToken.id, rows.map(row => row.id))).returning({ id: oauthRefreshToken.id })).length;
  }, () => countRetentionRows(db, oauthRefreshToken, condition), results);
  return result.removed;
}
