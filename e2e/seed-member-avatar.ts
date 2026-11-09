import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { profiles } from "../app/lib/db/schema";
import { createReply, createTopic } from "../app/lib/entries.server";
import { villagesEnabled } from "../app/lib/villages-enabled.server";
import { createVillage } from "../app/lib/village-management.server";
import { acceptChatConsent, mutateChat } from "../app/lib/village-chat.server";

export async function seedMemberAvatar(db: Db) {
  const person = async (handle: string) => (await db.select().from(profiles).where(eq(profiles.handle, handle)))[0];
  const writer = await person("av_writer"), reader = await person("av_reader");
  const topic = await createTopic(db, writer.userId, { title: "Avatar reading fixture", body: "An article with its writer.", lang: "en" }, { now: new Date("2020-01-01") });
  if (!topic.ok) throw Error(topic.error);
  const reply = await createReply(db, reader.userId, topic.id, { body: "A reply with its writer.", lang: "en" }, { now: new Date("2020-01-02") });
  if (!reply.ok) throw Error(reply.error);
  if (villagesEnabled()) {
    const village = await createVillage(db, writer.userId, { slug: "avatar-chat", name: "Avatar chat", description: "", kind: "open" });
    if (!village.ok) throw Error("Avatar village fixture failed");
    await acceptChatConsent(db, writer.userId, "avatar-chat");
    await mutateChat(db, writer.userId, "avatar-chat", "send", { body: "A chat message with its writer." });
  }
}
