import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { listSeen, user } from "~/lib/db/schema";
import { isLang } from "~/lib/languages";

export function validListScope(scope: unknown): scope is string {
  if (typeof scope !== "string" || scope.length > 67 || /\s/.test(scope)) return false;
  return scope === "/" || /^\/v\/[a-z0-9]+(-[a-z0-9]+)*\/?$/.test(scope)
    || /^\/a\/[^/]+\/?$/.test(scope) && isLang(scope.split("/")[2]);
}

// Lock the account even for the first list visit. This serializes exchanges and
// the per-member cap across devices and across different list scopes.
export async function exchangeListSeen(db: Db, userId: string, scope: string, seenAt: Date) {
  return db.transaction(async tx => {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("no key update");
    const ownScope = and(eq(listSeen.userId, userId), eq(listSeen.scope, scope));
    const [previous] = await tx.select({ seenAt: listSeen.seenAt }).from(listSeen).where(ownScope);
    if (!previous || seenAt > previous.seenAt) {
      await tx.insert(listSeen).values({ userId, scope, seenAt, updatedAt: new Date() })
        .onConflictDoUpdate({ target: [listSeen.userId, listSeen.scope], set: { seenAt, updatedAt: new Date() } });
      const expired = await tx.select({ scope: listSeen.scope }).from(listSeen).where(eq(listSeen.userId, userId))
        .orderBy(desc(listSeen.updatedAt), asc(listSeen.scope)).offset(50);
      if (expired.length) await tx.delete(listSeen).where(and(eq(listSeen.userId, userId), inArray(listSeen.scope, expired.map(row => row.scope))));
    }
    return previous?.seenAt.toISOString() ?? null;
  });
}
