import { chatNushiEnabled } from "./chat-nushi-config.server";
import { CHAT_NOTIFICATION_KINDS } from "./notifications";
import { and, count, eq, getTableColumns, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
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
    and ${notifications.userId} = ${userId} and ${notifications.kind} in ('chat_mention', 'chat_reply', 'chat_nushi_result', 'chat_nushi_cited')`);
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
  if (!villageChatEnabled()) return notInArray(notifications.kind, [...CHAT_NOTIFICATION_KINDS]);
  return and(chatNushiEnabled() ? undefined : notInArray(notifications.kind, ["chat_nushi_result", "chat_nushi_cited"]), or(notInArray(notifications.kind, [...CHAT_NOTIFICATION_KINDS]), sql`exists (select 1 from ${chatMessages}
    inner join ${villageMembers} on ${villageMembers.villageId} = ${chatMessages.villageId}
    inner join ${chatConsents} on ${chatConsents.villageId} = ${villageMembers.villageId}
      and ${chatConsents.userId} = ${villageMembers.userId} and ${chatConsents.version} = ${CHAT_CONSENT_VERSION}
    inner join ${villages} on ${villages.id} = ${chatMessages.villageId}
    where ${chatMessages.id} = ${notifications.chatMessageId} and ${chatMessages.villageId} = ${notifications.villageId}
      and ${villageMembers.userId} = ${notifications.userId}
      and not exists (select 1 from ${profiles} where ${profiles.userId} = ${notifications.userId} and ${profiles.suspendedUntil} > now())
      ${chatNushiEnabled() ? sql`and (${notifications.kind} <> 'chat_nushi_cited' or exists (select 1 from ${profiles} preference where preference.user_id = ${notifications.userId} and preference.nushi_citation_notifications = true))` : sql``}
      and ${chatMessages.deletedAt} is null and ${chatMessages.hiddenAt} is null and ${villages.slug} is not null and ${chatVillageCondition()})`));
}

// Called only for a batch containing chat notices. No content or author is selected.
export async function chatNotificationLocations(db: Db, rows: readonly { id: number; chatMessageId: string | null; villageId: string | null; kind?: string }[], userId: string, mailNow?: Date): Promise<Map<number, ChatNotificationLocation>> {
  const out = new Map<number, ChatNotificationLocation>();
  if (!villageChatEnabled() || !rows.length) return out;
  rows = rows.filter(row => chatNushiEnabled() || !["chat_nushi_result", "chat_nushi_cited"].includes(row.kind ?? ""));
  const ids = [...new Set(rows.map(row => row.chatMessageId).filter((id): id is string => !!id))];
  if (!ids.length) return out;
  const locations = await db.select({ id: chatMessages.id, villageId: villages.id, slug: villages.slug, name: villages.name, language: villages.language, kind: villages.kind })
    .from(chatMessages).innerJoin(villages, eq(villages.id, chatMessages.villageId))
    .innerJoin(villageMembers, and(eq(villageMembers.villageId, villages.id), eq(villageMembers.userId, userId)))
    .innerJoin(chatConsents, and(eq(chatConsents.villageId, villageMembers.villageId), eq(chatConsents.userId, villageMembers.userId), eq(chatConsents.version, CHAT_CONSENT_VERSION)))
    .where(and(inArray(chatMessages.id, ids), isNull(chatMessages.deletedAt), isNull(chatMessages.hiddenAt), chatVillageCondition(),
      sql`not exists (select 1 from ${profiles} where ${profiles.userId} = ${userId} and ${profiles.suspendedUntil} > ${mailNow ?? new Date()})`,
      mailNow ? sql`not exists (select 1 from ${profiles} where ${profiles.userId} = ${chatMessages.authorId} and ${profiles.suspendedUntil} > ${mailNow})` : undefined));
  if (rows.some(row => row.kind === "chat_nushi_cited")) {
    const [preference] = await db.select({ enabled: profiles.nushiCitationNotifications }).from(profiles).where(eq(profiles.userId, userId));
    if (!preference?.enabled) rows = rows.filter(row => row.kind !== "chat_nushi_cited");
  }
  const byId = new Map(locations.map(location => [location.id, location]));
  for (const row of rows) {
    const location = row.chatMessageId ? byId.get(row.chatMessageId) : undefined;
    if (location?.slug && location.villageId === row.villageId) out.set(row.id, { id: location.id, slug: location.slug, name: location.name, language: location.language, kind: location.kind });
  }
  return out;
}

// Unread replies and mentions per village (by slug). Ordinary chat arrivals use a dot; addressed messages use a number.
export async function chatMentionCounts(db: Db, userId: string): Promise<Map<string, number>> {
  if (!villageChatEnabled()) return new Map();
  const rows = await db.select({ slug: villages.slug, mentions: count() }).from(notifications).innerJoin(villages, eq(villages.id, notifications.villageId))
    .where(and(eq(notifications.userId, userId), inArray(notifications.kind, ["chat_mention", "chat_reply"]), isNull(notifications.readAt), chatNotificationCondition()))
    .groupBy(villages.slug);
  return new Map(rows.flatMap(row => row.slug ? [[row.slug, Number(row.mentions)] as const] : []));
}
