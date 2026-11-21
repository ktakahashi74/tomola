import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { entries, entryReadingCounts, profiles, readingCounts, translations, user } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";

import { ARTICLE_AUTHOR, ARTICLE_RESTRICTED, ARTICLE_SUSPENDED, ARTICLE_UNCONSENTED, articleCounts } from "./article-reading-fixtures";

export async function seedArticleReading(db: Db, dir: string) {
  const members = await db.select({ id: user.id, email: user.email }).from(user).where(inArray(user.email, [
    ARTICLE_AUTHOR, ARTICLE_SUSPENDED, ARTICLE_UNCONSENTED, ARTICLE_RESTRICTED,
  ]));
  const id = (email: string) => members.find(member => member.email === email)!.id;
  await db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86_400_000) }).where(eq(profiles.userId, id(ARTICLE_SUSPENDED)));
  await db.update(profiles).set({ trialConsentAt: null, trialConsentVersion: null }).where(eq(profiles.userId, id(ARTICLE_UNCONSENTED)));
  await db.update(profiles).set({ residenceCountry: "DE" }).where(eq(profiles.userId, id(ARTICLE_RESTRICTED)));

  const topic = await createTopic(db, id(ARTICLE_AUTHOR), { lang: "ja", title: "Article count browser fixture", body: "原文で閲覧するための記事です。" }, { now: new Date("2025-01-01T00:00:00Z") });
  if (!topic.ok) throw new Error(topic.error);
  const [source] = await db.select().from(entries).where(eq(entries.id, topic.id));
  const day = new Date().toISOString().slice(0, 10);
  await db.insert(translations).values({
    entryId: topic.id, sourceHash: source.sourceHash, lang: "en", kind: "primary", field: "body",
    text: "This is the translation in the article-count fixture.", engine: "fake", everSeen: true, firstSeenAt: new Date(),
  });
  await db.insert(entryReadingCounts).values([
    { entryId: topic.id, day, method: "browser", isTranslated: false, count: articleCounts.original },
    { entryId: topic.id, day, method: "browser", isTranslated: true, count: articleCounts.translated },
    { entryId: topic.id, day, method: "api", isTranslated: false, count: 3 },
  ]);
  await db.insert(readingCounts).values([
    { day, method: "browser", sourceLang: "ja", readLang: "en", count: articleCounts.translated, source: "search" },
    { day, method: "browser", sourceLang: "ja", readLang: "ja", count: articleCounts.original, source: "none" },
    { day, method: "api", sourceLang: "ja", readLang: "ja", count: 3, source: "none" },
  ]).onConflictDoUpdate({ target: [readingCounts.day, readingCounts.method, readingCounts.sourceLang, readingCounts.readLang, readingCounts.source],
    set: { count: sql`${readingCounts.count} + excluded.count` } });
  fs.writeFileSync(path.join(dir, "article-reading.json"), JSON.stringify({ id: topic.id }));
}
