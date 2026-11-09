import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, translations } from "./db/schema";
import { pickTranslation, SHOWN_KINDS, wantsTranslation } from "./display";
import { topicLine } from "./entry-display.server";
import { localizeResponseBodies } from "./response-line.server";
import { fallbackHeadline } from "./headline.server";
import { markdownReadBusy, withMarkdownRead } from "./markdown-budget.server";
import { defaultLangOf, isLang, type Lang } from "./languages";
import { enabledLangs } from "./enabled-langs.server";
import { siteUrl } from "./site-url";
import type { ChatMessage, ChatTopicCard } from "./village-chat";
import { villageChatEnabled } from "./village-chat-enabled.server";
import { publicTopicPlace } from "./visibility.server";

export const CHAT_TOPIC_CARD_LIMIT = 3;
// A change response contains at most 100 messages. Bound direct callers too.
export const CHAT_TOPIC_PAGE_LIMIT = 300;
export const CHAT_TOPIC_BODY_CHARS = 4000;
export const CHAT_TOPIC_HEADLINE_LIMIT = 10;
export type ChatTopicOptions = { displayLang: Lang; readLangs: readonly Lang[]; langParam?: Lang | null };
function topicIds(message: ChatMessage, origin: string): number[] {
  if (message.deleted || message.hidden) return [];
  const ids: number[] = [];
  for (const part of message.parts) {
    if (part.type !== "link") continue;
    try {
      const url = new URL(part.href);
      const match = /^\/t\/([1-9]\d{0,15})\/?$/.exec(url.pathname);
      if (url.origin !== origin || url.username || url.password || !match) continue;
      const id = Number(match[1]);
      if (Number.isSafeInteger(id) && !ids.includes(id)) {
        ids.push(id);
        if (ids.length === CHAT_TOPIC_CARD_LIMIT) break;
      }
    } catch { /* Keep malformed links as ordinary text/links. */ }
  }
  return ids;
}

// One page-wide statement reads public topics and saved title/body translations.
// This helper never requests a translation or fetches an external URL.
export async function addChatTopicCards(db: Db, messages: ChatMessage[], options?: ChatTopicOptions): Promise<ChatMessage[]> {
  if (!villageChatEnabled()) return messages;
  const opts = options ?? { displayLang: defaultLangOf(enabledLangs()), readLangs: [] };
  const origin = new URL(siteUrl()).origin;
  const wanted = new Map<string, number[]>(), candidates = new Set<number>();
  for (const message of messages) {
    const accepted = topicIds(message, origin).filter(id => {
      if (candidates.has(id)) return true;
      if (candidates.size === CHAT_TOPIC_PAGE_LIMIT) return false;
      candidates.add(id); return true;
    });
    wanted.set(message.id, accepted);
  }
  const ids = [...candidates];
  if (!ids.length) return messages;
  const rows = await db.select({
    topic: { id: entries.id, lang: entries.lang, title: entries.title, body: sql<string>`case when ${entries.title} is null then left(${entries.body}, ${CHAT_TOPIC_BODY_CHARS}) else '' end`, replyCount: entries.replyCount, sourceHash: entries.sourceHash, mentionRevision: entries.mentionRevision },
    translation: { field: translations.field, kind: translations.kind, text: sql<string>`case when ${translations.field} = 'body' then left(${translations.text}, ${CHAT_TOPIC_BODY_CHARS}) else ${translations.text} end`, sourceHash: translations.sourceHash, mentionRevision: translations.mentionRevision, flags: translations.flags, engine: translations.engine, model: translations.model, fallback: translations.fallback },
  }).from(entries).leftJoin(translations, and(
    eq(translations.entryId, entries.id), eq(translations.lang, opts.displayLang), inArray(translations.kind, [...SHOWN_KINDS]),
    or(and(sql`${entries.title} is not null`, eq(translations.field, "title")), and(isNull(entries.title), eq(translations.field, "body"))),
  )).where(and(inArray(entries.id, ids), eq(entries.kind, "topic"), isNull(entries.deletedAt), isNull(entries.hiddenAt), publicTopicPlace()));
  const projected = await localizeResponseBodies(db, rows.flatMap(row => row.translation ? [{ ...row.translation, entryId: row.topic.id, lang: opts.displayLang }] : []), rows.map(row => row.topic));
  let translatedIndex = 0;
  for (const row of rows) if (row.translation) row.translation = projected[translatedIndex++];
  const byId = new Map<number, ChatTopicCard>();
  const position = new Map(ids.map((id, index) => [id, index]));
  rows.sort((left, right) => position.get(left.topic.id)! - position.get(right.topic.id)!);
  await withMarkdownRead(async () => {
    let headlines = 0;
    for (const row of rows) {
      if (byId.has(row.topic.id) || !isLang(row.topic.lang)) continue;
      // Keep the original link when the page's titleless-card budget is exhausted.
      if (row.topic.title === null && headlines++ >= CHAT_TOPIC_HEADLINE_LIMIT) continue;
      const mine = rows.filter(r => r.topic.id === row.topic.id).flatMap(r => r.translation ? [r.translation] : []);
      const title = pickTranslation(mine.filter(r => r.field === "title"), row.topic.sourceHash, row.topic.mentionRevision);
      const body = pickTranslation(mine.filter(r => r.field === "body"), row.topic.sourceHash, row.topic.mentionRevision);
      const wants = wantsTranslation(row.topic.lang, opts.readLangs, opts.displayLang);
      const translatedBody = wants && body;
      const line = row.topic.title === null && markdownReadBusy()
        ? { text: fallbackHeadline(translatedBody ? translatedBody.text : row.topic.body), lang: translatedBody ? opts.displayLang : row.topic.lang, fromBody: true }
        : await topicLine({ ...row.topic, lang: row.topic.lang }, { title, body, hasBody: body !== null }, wants, opts.displayLang, true);
      const href = `/t/${row.topic.id}${opts.langParam ? `?lang=${opts.langParam}` : ""}`;
      byId.set(row.topic.id, { id: row.topic.id, title: line.text, lang: line.lang, fromBody: line.fromBody, replyCount: row.topic.replyCount, href, replyHref: `${href}#reply` });
    }
  });
  return messages.map(message => {
    if (message.deleted || message.hidden) return message;
    const topics = wanted.get(message.id)!.flatMap(id => byId.has(id) ? [byId.get(id)!] : []).slice(0, CHAT_TOPIC_CARD_LIMIT);
    return topics.length ? { ...message, topics } : message;
  });
}
