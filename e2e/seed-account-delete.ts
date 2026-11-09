import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { chatConsents, chatMessages, jobs, user, villageMembers, villages } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";
import { nextChatSequence } from "../app/lib/village-chat-sequence.server";
import { CHAT_CONSENT_VERSION } from "../app/lib/village-chat-consent";

export async function seedAccountDeletion(db: Db, directory: string) {
  const result: Record<string, { topicId: number; slug: string; body: string; chat: string }> = {};
  for (const scenario of ["keep", "delete", "signed", "duplicate", "choose"]) {
    const member = async (role: string) => {
      const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, `quit_${scenario}_${role}@example.com`));
      if (!row) throw new Error("Missing account deletion fixture member");
      return row.id;
    };
    const writer = await member("writer"), reader = await member("reader");
    const body = `Account deletion ${scenario} discussion remains identifiable only by its content.`;
    const topic = await createTopic(db, writer, { title: `Account deletion ${scenario} fixture`, body, lang: "en" }, { now: new Date("2025-01-02T00:00:00Z") });
    if (!topic.ok) throw new Error(topic.error);
    await db.delete(jobs).where(sql`${jobs.payload}->>'entryId' = ${String(topic.id)}`);
    const slug = `quit-${scenario}`;
    const [village] = await db.insert(villages).values({ name: `Quit ${scenario} village`, slug, kind: "invite_public", createdBy: writer }).returning();
    await db.insert(villageMembers).values([{ villageId: village.id, userId: writer, role: "owner" }, { villageId: village.id, userId: reader, role: ["duplicate", "choose"].includes(scenario) ? "member" : "owner" }]);
    await db.insert(chatConsents).values([writer, reader].map(userId => ({ villageId: village.id, userId, version: CHAT_CONSENT_VERSION })));
    const seq = await nextChatSequence(db, village.id);
    const chat = `Private chat ${scenario} must disappear`;
    await db.insert(chatMessages).values({ villageId: village.id, authorId: writer, lang: "en", body: chat, createdSeq: seq, changedSeq: seq });
    result[scenario] = { topicId: topic.id, slug, body, chat };
  }
  fs.writeFileSync(path.join(directory, "account-delete.json"), JSON.stringify(result));
}
