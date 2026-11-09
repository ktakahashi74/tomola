import { and, count, eq, getTableColumns, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { chatConsents, chatMessages, chatReads, notifications, profiles, villageMembers, villages } from "./db/schema";
import { villageChatEnabled } from "./village-chat-enabled.server";
import { chatVillageCondition } from "./village-chat-villages.server";
import { CHAT_CONSENT_VERSION } from "./village-chat-consent";

export type ChatNotificationLocation = { id: string; slug: string; name: string; language: string | null; kind: string };

// A temporary chat shutdown must not preserve state that could reappear after rejoining.
// One statement cleans chat state inside the membership transaction, regardless of the chat setting.
export async function clearVillageChatMemberState(db: Db, villageId: string, userId: string): Promise<void> {
  await db.execute(sql`with cleared_reads as (
    delete from ${chatReads} where ${chatReads.villageId} = ${villageId} and ${chatReads.userId} = ${userId}
  ), cleared_consents as (
    delete from ${chatConsents} where ${chatConsents.villageId} = ${villageId} and ${chatConsents.userId} = ${userId}
  ) delete from ${notifications} where ${notifications.villageId} = ${villageId}
    and ${notifications.userId} = ${userId} and ${notifications.kind} = 'chat_mention'`);
}

// Preserve existing SELECT projections when chat is disabled or a caller only needs posting notices.
export function notificationColumns(includeChat = villageChatEnabled()) {
  const { chatMessageId, ...existing } = getTableColumns(notifications);
  // The common fields remain the query's static type; chat-aware mail rows accept the optional field.
  if (includeChat) Object.assign(existing, { chatMessageId });
  return existing;
}

// Unread counts must exclude notices whose content or membership is no longer available.
// When disabled this condition references no chat or village table.
export function chatNotificationCondition() {
  if (!villageChatEnabled()) return ne(notifications.kind, "chat_mention");
  return or(ne(notifications.kind, "chat_mention"), sql`exists (select 1 from ${chatMessages}
    inner join ${villageMembers} on ${villageMembers.villageId} = ${chatMessages.villageId}
    inner join ${chatConsents} on ${chatConsents.villageId} = ${villageMembers.villageId}
      and ${chatConsents.userId} = ${villageMembers.userId} and ${chatConsents.version} = ${CHAT_CONSENT_VERSION}
    inner join ${villages} on ${villages.id} = ${chatMessages.villageId}
    where ${chatMessages.id} = ${notifications.chatMessageId} and ${chatMessages.villageId} = ${notifications.villageId}
      and ${villageMembers.userId} = ${notifications.userId}
      and ${chatMessages.deletedAt} is null and ${chatMessages.hiddenAt} is null and ${villages.slug} is not null and ${chatVillageCondition()})`);
}

// Called only for a batch containing chat notices. No content or author is selected.
export async function chatNotificationLocations(db: Db, rows: readonly { id: number; chatMessageId: string | null; villageId: string | null }[], userId: string, mailNow?: Date): Promise<Map<number, ChatNotificationLocation>> {
  const out = new Map<number, ChatNotificationLocation>();
  if (!villageChatEnabled() || !rows.length) return out;
  const ids = [...new Set(rows.map(row => row.chatMessageId).filter((id): id is string => !!id))];
  if (!ids.length) return out;
  const locations = await db.select({ id: chatMessages.id, villageId: villages.id, slug: villages.slug, name: villages.name, language: villages.language, kind: villages.kind })
    .from(chatMessages).innerJoin(villages, eq(villages.id, chatMessages.villageId))
    .innerJoin(villageMembers, and(eq(villageMembers.villageId, villages.id), eq(villageMembers.userId, userId)))
    .innerJoin(chatConsents, and(eq(chatConsents.villageId, villageMembers.villageId), eq(chatConsents.userId, villageMembers.userId), eq(chatConsents.version, CHAT_CONSENT_VERSION)))
    .where(and(inArray(chatMessages.id, ids), isNull(chatMessages.deletedAt), isNull(chatMessages.hiddenAt), chatVillageCondition(),
      mailNow ? sql`not exists (select 1 from ${profiles} where ${profiles.userId} = ${chatMessages.authorId} and ${profiles.suspendedUntil} > ${mailNow})` : undefined));
  const byId = new Map(locations.map(location => [location.id, location]));
  for (const row of rows) {
    const location = row.chatMessageId ? byId.get(row.chatMessageId) : undefined;
    if (location?.slug && location.villageId === row.villageId) out.set(row.id, { id: location.id, slug: location.slug, name: location.name, language: location.language, kind: location.kind });
  }
  return out;
}

// Unread mentions in chat, per village (by slug). Chat itself is told by a dot; a mention addressed to the member is told by a number.
export async function chatMentionCounts(db: Db, userId: string): Promise<Map<string, number>> {
  if (!villageChatEnabled()) return new Map();
  const rows = await db.select({ slug: villages.slug, mentions: count() }).from(notifications).innerJoin(villages, eq(villages.id, notifications.villageId))
    .where(and(eq(notifications.userId, userId), eq(notifications.kind, "chat_mention"), isNull(notifications.readAt), chatNotificationCondition()))
    .groupBy(villages.slug);
  return new Map(rows.flatMap(row => row.slug ? [[row.slug, Number(row.mentions)] as const] : []));
}
