import { isDeletedIdentity } from "../deleted-member";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { Db } from "~/lib/db/client.server";
import * as schema from "~/lib/db/schema";
import { RETENTION, DAY_MS } from "~/lib/retention";
import { DCR_JWKS_DISCOVERY_ID } from "~/lib/mcp/cimd.server";

type Adapter = ReturnType<ReturnType<typeof drizzleAdapter>>;
type SessionQuery = Parameters<Adapter["findOne"]>[0];

function bounded<T extends { model: string; where?: SessionQuery["where"] }>(query: T): T {
  return query.model === "session" ? { ...query, where: [...query.where ?? [], { field: "createdAt", operator: "gt" as const, value: new Date(Date.now() - RETENTION.sessionAbsoluteDays * DAY_MS) }] } : query;
}

function allowed(value: unknown, model: string): boolean {
  if (!value || typeof value !== "object") return true;
  const row = value as { id?: string; email?: string; userId?: string; user?: { id?: string; email?: string } };
  return model === "user" ? !isDeletedIdentity(row.id, row.email)
    : model !== "session" || (!isDeletedIdentity(row.userId) && !isDeletedIdentity(row.user?.id, row.user?.email));
}

// Enforce the lifetime at the authoritative read, including library middleware
// that calls getSession internally instead of the app's session helper.
function wrap<T extends Pick<Adapter, "findOne" | "findMany">>(adapter: T, prepareRemoteKeys: boolean): T {
  return {
    ...adapter,
    findOne: async <R>(query: Parameters<Adapter["findOne"]>[0]) => {
      const value = await adapter.findOne<R>(bounded(query));
      if (prepareRemoteKeys && query.model === "oauthClient") {
        const client = value as { clientDiscoveryId?: string; tokenEndpointAuthMethod?: string; jwks?: string; jwksUri?: string } | null;
        // Better Auth chooses the remote JWKS transport by discovery id. Use the
        // staged transport for this read without changing the stored DCR client.
        if (!client?.clientDiscoveryId && client?.tokenEndpointAuthMethod === "private_key_jwt" && client.jwksUri) {
          return { ...value, clientDiscoveryId: DCR_JWKS_DISCOVERY_ID };
        }
      }
      return allowed(value, query.model) ? value : null;
    },
    findMany: async <R>(query: Parameters<Adapter["findMany"]>[0]) => (await adapter.findMany<R>(bounded(query))).filter(value => allowed(value, query.model)),
  };
}

export function sessionAdapter(db: Db, prepareRemoteKeys = false): ReturnType<typeof drizzleAdapter> {
  const factory = drizzleAdapter(db, { provider: "pg", schema });
  return options => {
    const adapter = factory(options);
    return { ...wrap(adapter, prepareRemoteKeys), transaction: callback => adapter.transaction(tx => callback(wrap(tx, prepareRemoteKeys))) };
  };
}
