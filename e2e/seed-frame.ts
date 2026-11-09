import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { profiles, villages } from "../app/lib/db/schema";
import { villagesEnabled } from "../app/lib/villages-enabled.server";
import { changeVillageMembership } from "../app/lib/villages.server";
import { createReply, createTopic } from "../app/lib/entries.server";
export async function seedFrame(db: Db) {
  const id = async (handle: string) => (await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.handle, handle)))[0].id;
  if (villagesEnabled()) {
    await changeVillageMembership(db, await id("frame_nojs"), "en", "join");
    await changeVillageMembership(db, await id("frame_no_villages"), "ja", "leave");
    const [ended] = await db.insert(villages).values({ slug: "frame-ended-default", kind: "open", endedAt: new Date() }).returning();
    await db.update(profiles).set({ defaultVillageId: ended.id }).where(eq(profiles.userId, await id("frame_ended_default")));
    await db.update(profiles).set({ defaultVillageId: null }).where(eq(profiles.userId, await id("frame_empty_default")));
  }
  const now = new Date("2020-01-01T00:00:00Z");
  const topic = await createTopic(db, await id("frame_notice_reader"), { title: "A notification owned by the frame reader", body: "Notification opening", lang: "ja" }, { now });
  if (!topic.ok) throw new Error("Frame notification topic failed");
  const reply = await createReply(db, await id("frame_notice_writer"), topic.id, { body: "A reply for the frame reader", lang: "ja" }, { now });
  if (!reply.ok) throw new Error("Frame notification reply failed");
  const passkey = await createTopic(db, await id("frame_passkey"), { title: "Passkey prompt scope", body: "An independently owned reading screen", lang: "ja" }, { now });
  if (!passkey.ok) throw new Error("Frame passkey topic failed");
}
