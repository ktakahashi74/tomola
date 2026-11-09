import { sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { chatConsents, villageMembers } from "~/lib/db/schema";
import { CHAT_CONSENT_VERSION } from "~/lib/village-chat-consent";
import { chatPage } from "~/lib/village-chat.server";

// Existing chat scenarios start after consent. New consent scenarios seed it explicitly.
export async function consentChatMembers(db: Db) {
  await db.insert(chatConsents).select(db.select({
    villageId: villageMembers.villageId,
    userId: villageMembers.userId,
    version: sql<number>`${CHAT_CONSENT_VERSION}`.as("version"),
    consentedAt: sql<Date>`now()`.as("consented_at"),
  }).from(villageMembers).where(sql`true`)).onConflictDoNothing();
}

export async function consentedChatPage(...args: Parameters<typeof chatPage>) {
  const page = await chatPage(...args);
  if (page?.consentRequired) throw new Error("Chat fixture requires consent");
  return page;
}
