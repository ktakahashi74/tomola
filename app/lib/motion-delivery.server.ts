import { desc, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { motionDelivery } from "./db/schema";

export async function countMotionDelivery(db: Db, bytes: number, now = new Date()) {
  try {
    await db.insert(motionDelivery).values({ day: now.toISOString().slice(0, 10), requests: 1, bytes })
      .onConflictDoUpdate({ target: motionDelivery.day, set: { requests: sql`${motionDelivery.requests} + 1`, bytes: sql`${motionDelivery.bytes} + ${bytes}` } });
  } catch { console.warn("motion delivery: daily counter unavailable"); }
}
export const recentMotionDelivery = (db: Db) => db.select().from(motionDelivery).orderBy(desc(motionDelivery.day)).limit(30);
