import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { chatMessages, villageMembers, villages } from "./db/schema";
import { getActiveMember } from "./members.server";
import { checkPagination } from "./pagination";
import { ChatError } from "./village-chat";
import { villageChatEnabled } from "./village-chat-enabled.server";
import { deleteChatRows } from "./village-chat-delete.server";
import { signalVillageChat } from "./village-chat-events.server";
import { isSharedVillageKind } from "./villages";
import { villageName } from "./village-name";
import { m } from "~/paraglide/messages.js";

export const CHAT_OWN_PAGE_SIZE = 50;
function ownQuery(db: Db, userId: string) {
  return db.select({
    id: chatMessages.id, villageId: chatMessages.villageId, body: chatMessages.body, lang: chatMessages.lang,
    createdAt: chatMessages.createdAt, editedAt: chatMessages.editedAt, hiddenAt: chatMessages.hiddenAt,
    name: villages.name, language: villages.language, slug: villages.slug, kind: villages.kind, joined: villageMembers.userId,
  }).from(chatMessages).innerJoin(villages, eq(villages.id, chatMessages.villageId))
    .leftJoin(villageMembers, and(eq(villageMembers.villageId, villages.id), eq(villageMembers.userId, userId)))
    .where(and(eq(chatMessages.authorId, userId), isNull(chatMessages.deletedAt))).$dynamic();
}
function discloseVillage(row: { name: string; language: string | null; slug: string | null; kind: string; joined: string | null }) {
  const disclosed = row.joined !== null || isSharedVillageKind(row.kind);
  return {
    name: disclosed ? villageName(row) : m.village_chat_own_former(),
    slug: disclosed ? row.slug : null,
    chatHref: row.slug !== null && row.joined !== null && isSharedVillageKind(row.kind) ? `/v/${row.slug}/chat` : null,
  };
}
export async function ownChatPage(db: Db, userId: string, opts: { page?: number } = {}) {
  const { page, limit, offset } = checkPagination(opts, CHAT_OWN_PAGE_SIZE);
  if (!villageChatEnabled()) return { groups: [], page, hasNext: false };
  const rows = await ownQuery(db, userId).orderBy(desc(chatMessages.createdAt), desc(chatMessages.id)).limit(limit + 1).offset(offset);
  type Group = { anchor: string; village: ReturnType<typeof discloseVillage>; messages: Array<{ id: string; body: string; lang: string; createdAt: string; editedAt: string | null; hidden: boolean; href: string | null }> };
  const groups = new Map<string, Group>();
  for (const row of rows.slice(0, limit)) {
    const village = discloseVillage(row);
    const group = groups.get(row.villageId) ?? { anchor: row.id, village, messages: [] };
    group.messages.push({ id: row.id, body: row.body, lang: row.lang, createdAt: row.createdAt.toISOString(), editedAt: row.editedAt?.toISOString() ?? null, hidden: row.hiddenAt !== null, href: village.chatHref ? `${village.chatHref}?at=${row.id}#chat-${row.id}` : null });
    groups.set(row.villageId, group);
  }
  return { groups: [...groups.values()], page, hasNext: rows.length > limit };
}
export async function exportOwnChat(db: Db, userId: string) {
  if (!villageChatEnabled()) return [];
  const rows = await ownQuery(db, userId).orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
  return rows.map(row => {
    const village = discloseVillage(row);
    return { id: row.id, village: village.slug ?? village.name, lang: row.lang, body: row.body, created_at: row.createdAt.toISOString(), edited_at: row.editedAt?.toISOString() ?? null, hidden: row.hiddenAt !== null };
  });
}
export async function deleteOwnChat(db: Db, userId: string, id: unknown, all = false) {
  if (!villageChatEnabled()) throw new ChatError("not_found");
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw new ChatError("invalid");
  try {
    const result = await db.transaction(async tx => {
      if (!await getActiveMember(tx, userId)) throw new ChatError("forbidden");
      // An owned message is also the opaque anchor for bulk deletion. Never
      // expose a private former village's identifier to the browser.
      const [target] = await tx.select({ villageId: chatMessages.villageId }).from(chatMessages).where(and(eq(chatMessages.id, id), eq(chatMessages.authorId, userId)));
      if (!target) throw new ChatError("not_found");
      const [village] = await tx.select({ id: villages.id }).from(villages).where(eq(villages.id, target.villageId)).for("share");
      if (!village) throw new ChatError("not_found");
      const deleted = await deleteChatRows(tx, village.id, userId, all ? undefined : id);
      const remaining = all ? await tx.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.villageId, village.id), eq(chatMessages.authorId, userId), isNull(chatMessages.deletedAt))).limit(1) : [];
      return { ...deleted, villageId: village.id, more: remaining.length > 0 };
    });
    if (result.count) signalVillageChat(result.villageId, result.seq);
    return { count: result.count, more: result.more };
  } catch (error) {
    if (error instanceof ChatError) throw error;
    throw new Error("Village chat deletion failed");
  }
}
