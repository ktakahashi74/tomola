import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.server";
import { pushDeliveries, pushSubscriptions } from "../db/schema";
import { AUTO_IMMEDIATE_KINDS, type NotificationKind } from "../notifications";
import { enqueue } from "../jobs/queue.server";
import { pushConfig, webPushEnabled } from "./config.server";
export const SEND_PUSH_JOB = "send_push";
export const PUSH_WINDOW_MS = 60_000;
export const PUSH_LIFETIME_MS = 2 * 60 * 60_000;

// Called inside the notification producer's transaction, independently of the
// email preference. Persistent delivery rows preserve dedupe after completion.
export async function enqueuePush(db: Db, created: readonly { id: number; userId: string; kind: NotificationKind }[], now = new Date()) {
  if (!webPushEnabled()) return;
  const publicKey = pushConfig()!.publicKey;
  for (const notice of [...created].sort((a, b) => a.userId.localeCompare(b.userId) || a.id - b.id)) {
    if (!(AUTO_IMMEDIATE_KINDS as readonly string[]).includes(notice.kind)) continue;
    const registrations = await db.select({ id: pushSubscriptions.id, generation: pushSubscriptions.generation }).from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, notice.userId), isNull(pushSubscriptions.stoppedReason), eq(pushSubscriptions.vapidPublicKey, publicKey))).orderBy(pushSubscriptions.id);
    for (const registration of registrations) {
      const [delivery] = await db.insert(pushDeliveries).values({ notificationId: notice.id, subscriptionId: registration.id, generation: registration.generation,
        userId: notice.userId, createdAt: now, expiresAt: new Date(now.getTime() + PUSH_LIFETIME_MS) }).onConflictDoNothing().returning({ id: pushDeliveries.id });
      if (delivery) await enqueue(db, SEND_PUSH_JOB, { deliveryId: delivery.id }, { dedupeKey: `push:${notice.id}:${registration.id}:${registration.generation}`, runAt: new Date(now.getTime() + PUSH_WINDOW_MS), priority: 0, maxAttempts: 12 });
    }
  }
}
