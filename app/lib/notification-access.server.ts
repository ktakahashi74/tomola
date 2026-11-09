import { chatNotificationLocations } from "./village-chat-notifications.server";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { notifications, profiles } from "./db/schema";
import { AUTO_IMMEDIATE_KINDS } from "./notifications";
import { listNotifications } from "./notifications.server";
import { notificationHrefs } from "./notification-opening.server";

// Shared delivery/opening check. Batch the current projection, actor status,
// chat permissions and reply locations instead of reloading them per notice.
export async function immediateNotifications(db: Db, userId: string, ids: number[], now = new Date()) {
  if (!ids.length) return new Map();
  const rows = await db.select().from(notifications).where(and(inArray(notifications.id, ids), eq(notifications.userId, userId), inArray(notifications.kind, [...AUTO_IMMEDIATE_KINDS])));
  if (!rows.length) return new Map();
  const actors = rows.flatMap(row => row.kind === "mention" && row.actorId ? [row.actorId] : []);
  const suspended = new Set(actors.length ? (await db.select({ id: profiles.userId }).from(profiles).where(and(inArray(profiles.userId, actors), gt(profiles.suspendedUntil, now)))).map(row => row.id) : []);
  const chat = rows.filter(row => row.kind === "chat_mention");
  const chatLocations = chat.length ? await chatNotificationLocations(db, chat, userId, now) : new Map();
  const { items } = await listNotifications(db, userId, { ids: rows.map(row => row.id), limit: rows.length });
  const hrefs = await notificationHrefs(db, items);
  const byId = new Map(rows.map(row => [row.id, row]));
  return new Map(items.flatMap(item => {
    const row = byId.get(item.id)!;
    const href = hrefs.get(item.id);
    return item.unavailable || !href || row.kind === "mention" && row.actorId && suspended.has(row.actorId) || row.kind === "chat_mention" && !chatLocations.has(row.id)
      ? [] : [[row.id, { row, item, href }] as const];
  }));
}
export async function immediateNotification(db: Db, userId: string, id: number, now = new Date()) {
  return (await immediateNotifications(db, userId, [id], now)).get(id) ?? null;
}
