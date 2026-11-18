import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { jobs, listSeen, profiles } from "../app/lib/db/schema";
import { createTopic } from "../app/lib/entries.server";
import { encodeReadingCursor } from "../app/lib/reading-page";
import { setTopicSaved } from "../app/lib/saved-topics.server";
import { seedMembers } from "./seed-members";

export async function seedLoadMore(db: Db, dir: string, baseURL: string) {
  await seedMembers(db, dir, baseURL, [
    { handle: "load_more_author", email: "load_more_author@example.com", homeArea: "en", uiLocale: "en" },
    { handle: "load_more_reader", email: "load_more_reader@example.com", homeArea: "en", uiLocale: "en" },
    { handle: "load_more_saver", email: "load_more_saver@example.com", homeArea: "en", uiLocale: "en" },
    { handle: "load_more_publisher", email: "load_more_publisher@example.com", homeArea: "en", uiLocale: "en" },
    { handle: "load_more_links", email: "load_more_links@example.com", homeArea: "en", uiLocale: "en" },
    { handle: "load_more_follower", email: "load_more_follower@example.com", homeArea: "en", uiLocale: "en" },
    { handle: "load_more_navigation", email: "load_more_navigation@example.com", homeArea: "en", uiLocale: "en" },
    { handle: "load_more_history", email: "load_more_history@example.com", homeArea: "en", uiLocale: "en" },
  ]);
  const [author] = await db.select().from(profiles).where(eq(profiles.handle, "load_more_author"));
  const [reader] = await db.select().from(profiles).where(eq(profiles.handle, "load_more_reader"));
  const [saver] = await db.select().from(profiles).where(eq(profiles.handle, "load_more_saver"));
  const ids: number[] = [];
  const base = Date.UTC(2020, 0, 1);
  for (let index = 0; index < 330; index++) {
    const made = await createTopic(db, author.userId, { lang: "en", title: `Load more fixture ${index}`, body: "A dedicated reading list fixture." }, { now: new Date(base + index * 1000) });
    if (!made.ok) throw new Error(made.error);
    ids.push(made.id);
  }
  await db.insert(listSeen).values({ userId: reader.userId, scope: "/", seenAt: new Date(base + 290_000) });
  for (const id of ids.slice(-65)) await setTopicSaved(db, saver.userId, id, true, { now: new Date(base) });
  await db.delete(jobs).where(inArray(jobs.kind, ["translate_entry", "translate_title", "embed_entry"]));
  const start = encodeReadingCursor({ order: "created", keys: [new Date(base + 329_000).toISOString(), ids.at(-1)!] });
  fs.writeFileSync(path.join(dir, "load-more.json"), JSON.stringify({ path: `/?lang=en&list_start=${start}`, ids: ids.reverse(), before: new Date(base + 290_000).toISOString() }));
}
