import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { notifications, profiles, pushDeliveries, pushSubscriptions } from "../db/schema";
import { immediateNotifications } from "../notification-access.server";
import { memberMailLocale } from "../mail/magic-link.server";
import { hitMemberLimit } from "../rate-limit.server";
import { pushConfig, webPushEnabled } from "../push/config.server";
import { PUSH_WINDOW_MS, SEND_PUSH_JOB } from "../push/enqueue.server";
import { pushMessage } from "../push/messages.server";
import { pushSessionCondition, pushStoppedValues } from "../push/subscriptions.server";
import { sendWebPush, type PushSender } from "../push/send.server";
import { DeferJob, type JobHandlers } from "./queue.server";

const payload = z.object({ deliveryId: z.number().int().positive() });
// Longer than the transport's total deadline. A crashed attempt can be reclaimed.
const ATTEMPT_LEASE_MS = 30_000;
export function createPushHandlers(deps: { send?: PushSender } = {}): JobHandlers {
  if (!webPushEnabled()) return {};
  return { [SEND_PUSH_JOB]: async (job, ctx) => {
    if (!webPushEnabled()) return;
    const parsed = payload.safeParse(job.payload);
    if (!parsed.success) throw Object.assign(new Error("Invalid push delivery job"), { retryable: false });
    const reserved = await ctx.db.transaction(async tx => {
      const [peek] = await tx.select().from(pushDeliveries).where(eq(pushDeliveries.id, parsed.data.deliveryId));
      if (!peek || peek.completedAt) return;
      // Serialize reservation with stop/re-registration, then release every DB
      // lock before DNS/HTTPS. A committed reservation is an in-flight send.
      const [registration] = await tx.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, peek.subscriptionId)).for("update");
      let [delivery] = await tx.select().from(pushDeliveries).where(eq(pushDeliveries.id, peek.id));
      if (!delivery || delivery.completedAt) return;
      const now = ctx.clock?.() ?? ctx.now;
      if (delivery.batchId !== null && delivery.batchId !== delivery.id) {
        if (delivery.expiresAt <= now) {
          await tx.update(pushDeliveries).set({ completedAt: now }).where(eq(pushDeliveries.id, delivery.id));
          return;
        }
        const [leader] = await tx.select({ id: pushDeliveries.id }).from(pushDeliveries)
          .where(and(eq(pushDeliveries.id, delivery.batchId), isNull(pushDeliveries.completedAt)));
        if (leader) return { defer: Math.min(delivery.expiresAt.getTime(), now.getTime() + PUSH_WINDOW_MS) };
        // Notification deletion can cascade to the leader. Release its peers
        // under the registration lock, then recheck every send permission.
        await tx.update(pushDeliveries).set({ batchId: null }).where(and(eq(pushDeliveries.subscriptionId, delivery.subscriptionId),
          eq(pushDeliveries.generation, delivery.generation), eq(pushDeliveries.userId, delivery.userId), eq(pushDeliveries.batchId, delivery.batchId)));
        delivery = { ...delivery, batchId: null };
      }
      if (delivery.attemptStartedAt && delivery.attemptStartedAt.getTime() + ATTEMPT_LEASE_MS > now.getTime()) return { defer: delivery.attemptStartedAt.getTime() + ATTEMPT_LEASE_MS };
      const batch = and(eq(pushDeliveries.subscriptionId, delivery.subscriptionId), eq(pushDeliveries.generation, delivery.generation), eq(pushDeliveries.userId, delivery.userId));
      const finish = () => tx.update(pushDeliveries).set({ completedAt: now, attemptToken: null, attemptStartedAt: null })
        .where(and(batch, sql`(${pushDeliveries.id} = ${delivery.id} or ${pushDeliveries.batchId} = ${delivery.id})`));
      const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, delivery.userId));
      const [liveSession] = await tx.select({ id: profiles.userId }).from(profiles).where(and(eq(profiles.userId, delivery.userId), pushSessionCondition(delivery.userId, now, registration?.authorizingSessionId ?? "")));
      if (!profile || !registration || registration.userId !== delivery.userId || registration.generation !== delivery.generation || registration.stoppedReason
        || !registration.endpoint || !registration.p256dh || !registration.auth || registration.authorizedUntil <= now || !liveSession || delivery.expiresAt <= now || (profile.suspendedUntil && profile.suspendedUntil > now)) { await finish(); return; }
      if (registration.vapidPublicKey !== pushConfig()!.publicKey) {
        await finish(); return { operator: true };
      }
      const [notice] = await tx.select().from(notifications).where(eq(notifications.id, delivery.notificationId));
      if (!notice || notice.userId !== delivery.userId) { await finish(); return; }
      const peers = await tx.select({ delivery: pushDeliveries, notice: notifications }).from(pushDeliveries).innerJoin(notifications, eq(notifications.id, pushDeliveries.notificationId))
        .where(and(batch, isNull(pushDeliveries.completedAt), delivery.batchId !== null ? eq(pushDeliveries.batchId, delivery.id) : and(isNull(pushDeliveries.batchId),
          gt(pushDeliveries.expiresAt, now), gte(pushDeliveries.createdAt, delivery.createdAt), lte(pushDeliveries.createdAt, new Date(delivery.createdAt.getTime() + PUSH_WINDOW_MS)),
          notice.threadId !== null ? eq(notifications.threadId, notice.threadId) : notice.villageId !== null ? and(isNull(notifications.threadId), eq(notifications.villageId, notice.villageId)) : eq(notifications.id, notice.id))))
        .orderBy(asc(pushDeliveries.createdAt), asc(pushDeliveries.id)).limit(100);
      const allowed = await immediateNotifications(tx, delivery.userId, peers.map(peer => peer.notice.id), now);
      const valid = peers.filter(peer => !peer.notice.readAt && peer.delivery.expiresAt > now && allowed.has(peer.notice.id));
      const ids = [...new Set([delivery.id, ...peers.map(peer => peer.delivery.id)])];
      if (!valid.length) { await tx.update(pushDeliveries).set({ completedAt: now, attemptToken: null, attemptStartedAt: null }).where(inArray(pushDeliveries.id, ids)); return; }
      const rate = await hitMemberLimit(tx, "push-send", delivery.userId, now);
      if (!rate.allowed) return { defer: Math.min(delivery.expiresAt.getTime(), now.getTime() + rate.retryAfterSeconds * 1000) };
      const tag = createHash("sha256").update(`${delivery.userId}:${registration.id}:${notice.threadId ?? notice.villageId ?? notice.id}`).digest("base64url").slice(0, 32);
      const notificationIds = valid.map(peer => peer.notice.id);
      const message = JSON.stringify({ title: "tomola", body: pushMessage(valid[0].notice.kind, memberMailLocale(profile.uiLocale, profile.homeArea), valid.length > 1), tag,
        url: valid.length > 1 ? `/notifications?push=${delivery.id}` : `/notifications/${notificationIds[0]}/open?push=${delivery.id}` });
      const token = randomUUID();
      // Peers keep the same leader across retries; their queue jobs cannot send
      // this batch independently while the leader is deferred or in flight.
      await tx.update(pushDeliveries).set({ batchId: delivery.id }).where(inArray(pushDeliveries.id, ids));
      await tx.update(pushDeliveries).set({ attemptToken: token, attemptStartedAt: now }).where(eq(pushDeliveries.id, delivery.id));
      await tx.update(pushSubscriptions).set({ lastAttemptAt: now }).where(eq(pushSubscriptions.id, registration.id));
      return { attempt: { delivery, registration, ids, notificationIds, token, message, tag, endpoint: registration.endpoint, p256dh: registration.p256dh, auth: registration.auth, now } };
    });
    if (reserved && "operator" in reserved) throw Object.assign(new Error("Push configuration changed; check VAPID configuration"), { retryable: false });
    if (reserved?.defer !== undefined) throw new DeferJob(new Date(reserved.defer), "Push delivery deferred");
    if (!reserved || !("attempt" in reserved)) return;
    const a = reserved.attempt;
    const result = await (deps.send ?? sendWebPush)({ endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } }, a.message,
      { ttl: Math.max(0, Math.floor((a.delivery.expiresAt.getTime() - a.now.getTime()) / 1000)), topic: a.tag });
    const outcome = await ctx.db.transaction(async tx => {
      const same = and(eq(pushSubscriptions.id, a.registration.id), eq(pushSubscriptions.userId, a.delivery.userId), eq(pushSubscriptions.generation, a.delivery.generation), isNull(pushSubscriptions.stoppedReason));
      const [registration] = await tx.select().from(pushSubscriptions).where(same).for("update");
      const [claimed] = await tx.select().from(pushDeliveries).where(and(eq(pushDeliveries.id, a.delivery.id), eq(pushDeliveries.attemptToken, a.token))).for("update");
      if (!claimed || claimed.completedAt) return;
      const now = ctx.clock?.() ?? ctx.now;
      const clear = { attemptToken: null, attemptStartedAt: null };
      const finish = () => tx.update(pushDeliveries).set({ ...clear, completedAt: now }).where(and(inArray(pushDeliveries.id, a.ids), eq(pushDeliveries.batchId, a.delivery.id)));
      // A stop, account switch or new generation wins over any stale response.
      // End the old batch without changing the new registration or retrying it.
      if (!registration) { await finish(); return; }
      if (result.kind === "accepted") {
        await tx.update(pushSubscriptions).set({ lastAcceptedAt: now, failures: 0 }).where(same);
        await tx.update(pushDeliveries).set({ notificationIds: a.notificationIds }).where(eq(pushDeliveries.id, a.delivery.id));
        await finish(); return;
      }
      await tx.update(pushSubscriptions).set({ failures: sql`${pushSubscriptions.failures} + 1`, ...(result.kind === "gone" ? pushStoppedValues("expired") : {}) }).where(same);
      if (result.kind === "gone" || result.kind === "operator") { await finish(); return result.kind === "operator" ? { operator: true } : undefined; }
      await tx.update(pushDeliveries).set(clear).where(eq(pushDeliveries.id, a.delivery.id));
      const delay = Math.max(result.retryAfterSeconds ?? 0, Math.min(1800, 30 * 2 ** Math.min(registration.failures, 6)));
      return { defer: Math.min(a.delivery.expiresAt.getTime(), now.getTime() + delay * 1000) };
    });
    if (outcome?.operator) throw Object.assign(new Error("Push provider rejected the request; check VAPID configuration"), { retryable: false });
    if (outcome?.defer !== undefined) throw new DeferJob(new Date(outcome.defer), "Push delivery deferred");
  } };
}
