import { webPushEnabled } from "./config.server";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.server";
import { pushDeliveries } from "../db/schema";
import { immediateNotification } from "../notification-access.server";

// Delivery identifiers reveal no content. Resolve only for the original member,
// and recheck every notice against current read permissions before displaying it.
export async function pushOpeningIds(db: Db, userId: string, value: string, now = new Date()) {
  if (!webPushEnabled()) return null;
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) return null;
  const [delivery] = await db.select().from(pushDeliveries).where(and(eq(pushDeliveries.id, Number(value)), eq(pushDeliveries.userId, userId)));
  if (!delivery?.notificationIds?.length) return null;
  const ids = [];
  for (const id of delivery.notificationIds) if (await immediateNotification(db, userId, id, now)) ids.push(id);
  return ids.length ? ids : null;
}
