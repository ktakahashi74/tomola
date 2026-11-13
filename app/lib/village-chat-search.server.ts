import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { chatMessages, chatMessageTranslations, profiles } from "./db/schema";
import { selectDisplayName } from "./display-names.server";
import type { Lang } from "./languages";
import { chatAccess } from "./village-chat.server";

export const CHAT_SEARCH_LIMIT = 20;
export type ChatSearchExcerpt = { before: string; match: string; after: string };
export type ChatSearchHit = {
  id: string; createdSeq: number; createdAt: string; author: string | null; authorName: string | null;
  matches: Array<{ source: "original" | "translation"; lang: string; excerpt: ChatSearchExcerpt }>;
};

// Positions from PostgreSQL count Unicode characters, rather than UTF-16 units.
export function chatSearchExcerpt(text: string, position: number, length: number): ChatSearchExcerpt {
  const characters = [...text], start = Math.max(0, position - 1);
  const from = Math.max(0, start - 60), to = Math.min(characters.length, start + length + 100);
  return {
    before: `${from ? "…" : ""}${characters.slice(from, start).join("")}`,
    match: characters.slice(start, start + length).join(""),
    after: `${characters.slice(start + length, to).join("")}${to < characters.length ? "…" : ""}`,
  };
}

// Refused destinations must not load an unrelated window or request its translations.
export async function chatSearchTargetAvailable(db: Db, userId: string, slug: string, id: string | null) {
  const access = await chatAccess(db, slug, userId);
  if (!access?.consented || !id || !/^[a-f0-9]{32}$/.test(id)) return false;
  const [message] = await db.select({ id: chatMessages.id }).from(chatMessages).where(and(
    eq(chatMessages.villageId, access.village.id), eq(chatMessages.id, id), isNull(chatMessages.deletedAt), isNull(chatMessages.hiddenAt),
  )).limit(1);
  return !!message;
}

// Only call after chatAccess has authorized the current member for this village.
// strpos treats %, _ and backslash as ordinary text, as in literal post search.
export function chatSearchQuery(db: Db, villageId: string, query: string, displayLang: Lang, before?: number) {
  const originalPosition = sql<number>`strpos(lower(${chatMessages.body}), lower(${query}))`;
  const translationPosition = sql<number>`case when strpos(lower(${chatMessageTranslations.text}), lower(${query})) > 0
    then case when ${chatMessageTranslations.sourceHash} = encode(sha256(convert_to(${chatMessages.body}, 'UTF8')), 'hex')
      then strpos(lower(${chatMessageTranslations.text}), lower(${query})) else 0 end else 0 end`;
  const matches = db.select({
    id: chatMessages.id, authorId: chatMessages.authorId, lang: chatMessages.lang,
    createdSeq: chatMessages.createdSeq, createdAt: chatMessages.createdAt,
    body: chatMessages.body, translated: chatMessageTranslations.text,
    originalPosition: originalPosition.as("original_position"), translationPosition: translationPosition.as("translation_position"),
  }).from(chatMessages).leftJoin(chatMessageTranslations, and(
    eq(chatMessageTranslations.messageId, chatMessages.id), eq(chatMessageTranslations.lang, displayLang), eq(chatMessageTranslations.state, "ready"),
  )).where(and(
    eq(chatMessages.villageId, villageId), isNull(chatMessages.deletedAt), isNull(chatMessages.hiddenAt),
    before === undefined ? undefined : lt(chatMessages.createdSeq, before),
    or(sql`${originalPosition} > 0`, sql`${translationPosition} > 0`),
  )).orderBy(desc(chatMessages.createdSeq)).limit(CHAT_SEARCH_LIMIT + 1).as("chat_search_matches");
  // Look up authors only after limiting the matched messages.
  return db.select({
    id: matches.id, lang: matches.lang, createdSeq: matches.createdSeq, createdAt: matches.createdAt,
    body: matches.body, translated: matches.translated, originalPosition: matches.originalPosition, translationPosition: matches.translationPosition,
    author: profiles.handle, displayName: profiles.displayName, displayNameLatin: profiles.displayNameLatin, homeArea: profiles.homeArea,
  }).from(matches).leftJoin(profiles, eq(profiles.userId, matches.authorId)).orderBy(desc(matches.createdSeq));
}

export async function findChatMessages(db: Db, villageId: string, query: string, displayLang: Lang, before?: number) {
  const rows = await chatSearchQuery(db, villageId, query, displayLang, before);
  const hits: ChatSearchHit[] = rows.slice(0, CHAT_SEARCH_LIMIT).map(row => ({
    id: row.id, createdSeq: row.createdSeq, createdAt: row.createdAt.toISOString(), author: row.author, authorName: selectDisplayName(row),
    matches: [
      ...(row.originalPosition > 0 ? [{ source: "original" as const, lang: row.lang, excerpt: chatSearchExcerpt(row.body, row.originalPosition, [...query].length) }] : []),
      ...(row.translationPosition > 0 && row.translated !== null ? [{ source: "translation" as const, lang: displayLang, excerpt: chatSearchExcerpt(row.translated, row.translationPosition, [...query].length) }] : []),
    ],
  }));
  return { hits, before: rows.length > CHAT_SEARCH_LIMIT ? hits.at(-1)!.createdSeq : null };
}
