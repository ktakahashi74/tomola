import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.server";
import { profiles, pushSubscriptions, session } from "../db/schema";
import { browserIdentity, validateSubscription } from "./endpoint.server";
import { pushConfig } from "./config.server";

export type BrowserIdentity = { id: string; secret: string };
export class PushRegistrationError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export const browserHash = (secret: string) => createHash("sha256").update(secret).digest("hex");
function matches(row: typeof pushSubscriptions.$inferSelect, identity: BrowserIdentity) {
  const digest = browserHash(identity.secret);
  return row.browserSecretHash.length === digest.length && timingSafeEqual(Buffer.from(row.browserSecretHash), Buffer.from(digest));
}
export function deviceLabel(agent: string) {
  return { os: /iPhone|iPad|iPod/.test(agent) ? "iOS" : /Android/.test(agent) ? "Android" : /Windows/.test(agent) ? "Windows" : /Mac/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : "Other",
    browser: /Edg/.test(agent) ? "Edge" : /Firefox|FxiOS/.test(agent) ? "Firefox" : /Chrome|CriOS/.test(agent) ? "Chrome" : /Safari/.test(agent) ? "Safari" : "Other" };
}
export async function ownPushSubscriptions(db: Db, userId: string) {
  return db.select({ id: pushSubscriptions.id, generation: pushSubscriptions.generation, browser: pushSubscriptions.browser, os: pushSubscriptions.os,
    createdAt: pushSubscriptions.createdAt, stoppedReason: pushSubscriptions.stoppedReason, authorizedUntil: pushSubscriptions.authorizedUntil })
    .from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).orderBy(pushSubscriptions.createdAt);
}
export async function registerPush(db: Db, userId: string, identity: BrowserIdentity, input: unknown, agent: string, authorization: { sessionId: string; expiresAt: Date }, now = new Date()) {
  if (!browserIdentity.safeParse(identity).success) throw new PushRegistrationError(400, "invalid");
  const config = pushConfig();
  if (!config) throw new PushRegistrationError(404, "disabled");
  let subscription: ReturnType<typeof validateSubscription>;
  try { subscription = validateSubscription(input); } catch { throw new PushRegistrationError(400, "invalid"); }
  return db.transaction(async tx => {
    // Member lock serializes the cap and competing registrations.
    await tx.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, userId)).for("update");
    const [old] = await tx.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, identity.id)).for("update");
    if (old && !matches(old, identity)) throw new PushRegistrationError(409, "conflict");
    const [endpoint] = await tx.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, subscription.endpoint));
    if (endpoint && endpoint.id !== identity.id) throw new PushRegistrationError(409, "conflict");
    const active = await tx.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.stoppedReason), ne(pushSubscriptions.id, identity.id)));
    if (active.length >= 10) throw new PushRegistrationError(409, "limit");
    const same = old?.userId === userId && !old.stoppedReason && old.endpoint === subscription.endpoint && old.p256dh === subscription.keys.p256dh && old.auth === subscription.keys.auth && old.vapidPublicKey === config.publicKey;
    const values = { userId, endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth,
      vapidPublicKey: config.publicKey, ...deviceLabel(agent), authorizedUntil: authorization.expiresAt, authorizingSessionId: authorization.sessionId, stoppedReason: null, failures: 0,
      generation: old ? same ? old.generation : old.generation + 1 : 1, createdAt: same ? old.createdAt : now, lastAttemptAt: same ? old.lastAttemptAt : null, lastAcceptedAt: same ? old.lastAcceptedAt : null };
    if (old) await tx.update(pushSubscriptions).set(values).where(eq(pushSubscriptions.id, old.id));
    else await tx.insert(pushSubscriptions).values({ id: identity.id, browserSecretHash: browserHash(identity.secret), ...values });
    return { id: identity.id, generation: values.generation };
  });
}

// Knowing an endpoint is never sufficient to stop or transfer a registration.
// Only the storage-area capability can reconcile a previous account's row.
export async function reconcilePush(db: Db, userId: string, identity: BrowserIdentity, authorization: { sessionId: string; expiresAt: Date }) {
  return db.transaction(async tx => {
    const [row] = await tx.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, identity.id)).for("update");
    if (!row || !matches(row, identity)) return null;
    if (row.userId !== userId) {
      if (!row.stoppedReason) await tx.update(pushSubscriptions).set(pushStoppedValues("account_changed")).where(eq(pushSubscriptions.id, row.id));
      return null;
    }
    if (!row.stoppedReason) await tx.update(pushSubscriptions).set({ authorizedUntil: authorization.expiresAt, authorizingSessionId: authorization.sessionId }).where(eq(pushSubscriptions.id, row.id));
    return { id: row.id, generation: row.generation, stoppedReason: row.stoppedReason, vapidPublicKey: row.vapidPublicKey };
  });
}
export const pushStoppedValues = (reason: string) => ({ stoppedReason: reason, generation: sql`${pushSubscriptions.generation} + 1`, endpoint: null, p256dh: null, auth: null });
export async function stopPush(db: Db, userId: string, id: string | null, reason = "member_stopped", except?: string) {
  await db.update(pushSubscriptions).set(pushStoppedValues(reason))
    .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.stoppedReason), id ? eq(pushSubscriptions.id, id) : undefined, except ? ne(pushSubscriptions.id, except) : undefined));
}
export async function currentPushId(db: Db, userId: string, input: unknown) {
  const parsed = browserIdentity.safeParse(input);
  if (!parsed.success) return null;
  const [row] = await db.select().from(pushSubscriptions).where(and(eq(pushSubscriptions.id, parsed.data.id), eq(pushSubscriptions.userId, userId)));
  return row && matches(row, parsed.data) ? row.id : null;
}
export const pushSessionCondition = (userId: string, now: Date, sessionId: string | typeof pushSubscriptions.authorizingSessionId) => sql`exists (select 1 from ${session} where ${session.userId} = ${userId} and ${session.id} = ${sessionId} and ${session.expiresAt} > ${now})`;
export const activePushCondition = (now: Date) => and(isNull(pushSubscriptions.stoppedReason), gt(pushSubscriptions.authorizedUntil, now));
