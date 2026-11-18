import { desc, eq } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles } from "~/lib/db/schema";
import type { TopicPage } from "~/lib/entries.server";
import type { SourceLang } from "~/lib/languages";
import { visibleIntroduction } from "~/lib/member-pages.server";
import { checkPagination } from "~/lib/pagination";

export async function listIntroductions(db: Db, opts: { page?: number; limit?: number } = {}): Promise<TopicPage> {
  const { page, limit, offset } = checkPagination(opts);
  const rows = await db.select({
    id: entries.id, lang: entries.lang, langCode: entries.langCode, title: entries.title, sourceHash: entries.sourceHash,
    authorId: entries.authorId, authorHandle: profiles.handle, replyCount: entries.replyCount,
    createdAt: entries.createdAt, lastActivityAt: entries.lastActivityAt, asksStance: entries.asksStance,
  }).from(profiles).innerJoin(entries, visibleIntroduction(profiles))
    .orderBy(desc(entries.createdAt), desc(entries.id)).limit(limit + 1).offset(offset);
  return { topics: rows.slice(0, limit).map(row => ({ ...row, lang: row.lang as SourceLang, hidden: false })), page, limit, hasNext: rows.length > limit };
}

export async function hasVisibleIntroduction(db: Db, userId: string): Promise<boolean> {
  const [row] = await db.select({ id: entries.id }).from(profiles).innerJoin(entries, visibleIntroduction(profiles))
    .where(eq(profiles.userId, userId)).limit(1);
  return !!row;
}
