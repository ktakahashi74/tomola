import { asc, eq } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken, profiles, session } from "~/lib/db/schema";
import { revokeConnection } from "~/lib/mcp/connections.server";
import { revokeOpenInAiLinks } from "~/lib/open-in-ai.server";
import { revokeAllApiTokens } from "~/lib/tokens.server";

export async function revokeAllCredentials(db: Db, userId: string, now = new Date()) {
  return db.transaction(async tx => {
    const [member] = await tx.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (!member) return { ok: false as const };
    const grants = await tx.select({ id: oauthConsent.id, clientId: oauthConsent.clientId }).from(oauthConsent).where(eq(oauthConsent.userId, userId)).orderBy(asc(oauthConsent.clientId), asc(oauthConsent.id));
    const access = await tx.select({ clientId: oauthAccessToken.clientId }).from(oauthAccessToken).where(eq(oauthAccessToken.userId, userId));
    const refresh = await tx.select({ clientId: oauthRefreshToken.clientId }).from(oauthRefreshToken).where(eq(oauthRefreshToken.userId, userId));
    const clients = [...new Set([...grants, ...access, ...refresh].map(row => row.clientId))].sort();
    for (const clientId of clients) await tx.select({ id: oauthClient.id }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).for("no key update");
    for (const grant of grants) await revokeConnection(tx, userId, grant.id);
    // Also remove orphaned token rows left without a consent by older versions.
    await tx.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, userId));
    await tx.delete(oauthRefreshToken).where(eq(oauthRefreshToken.userId, userId));
    const tokens = await revokeAllApiTokens(tx, userId, { now });
    const sessions = await tx.delete(session).where(eq(session.userId, userId)).returning({ id: session.id });
    await revokeOpenInAiLinks(tx, userId);
    return { ok: true as const, tokens, sessions: sessions.length, connections: grants.length };
  });
}
