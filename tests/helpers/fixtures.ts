import { clearMemoryReadLimitsForTests, hitRateLimit } from "~/lib/rate-limit.server";
import { sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles, rateLimits } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { recomputeThreadActivity, renderEntryHtml } from "~/lib/entries.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import type { RateLimitRule } from "~/lib/rate-limit.server";
import { sourceHash } from "~/lib/source-hash.server";

export async function seedRateLimit(db: Db, key: string, rule: RateLimitRule, now = new Date()) {
  if (key.startsWith("read:member:")) {
    clearMemoryReadLimitsForTests(db);
    for (let i = 0; i < rule.limit; i++) await hitRateLimit(db, { key, ...rule });
    return;
  }
  const windowMs = rule.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const expiresAt = new Date(windowStart.getTime() + windowMs);
  await db.insert(rateLimits).values({ key, windowStart, expiresAt, count: rule.limit })
    .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: rule.limit, expiresAt } });
}

// Pagination fixtures need persisted bodies and current caches, but no notification or translation jobs.
// Individual posting tests continue to exercise the full creation path.
export async function seedReplies(db: Db, authorId: string, threadId: number, rows: Array<{ body: string; createdAt: Date; lang?: string; stanceTag?: "agree" }>): Promise<number[]> {
  const [profile] = await db.select({ homeArea: profiles.homeArea }).from(profiles).where(eq(profiles.userId, authorId));
  const added = await db.insert(entries).values(rows.map(row => ({
    kind: "reply", authorId, authorArea: profile?.homeArea ?? null, threadId,
    body: row.body, lang: row.lang ?? "ja", stanceTag: row.stanceTag ?? null,
    createdAt: row.createdAt, updatedAt: row.createdAt, lastActivityAt: row.createdAt,
    sourceHash: sourceHash(null, row.body),
  }))).returning({ id: entries.id, body: entries.body, lang: entries.lang });
  added.sort((a, b) => a.id - b.id);
  const cached = (await Promise.all(added.map(async row => {
    const { html } = (await renderEntryHtml("reply", row.id, row.body, row.lang, new Map()));
    return sql`(${row.id}::bigint, ${html}::text)`;
  })));
  await db.execute(sql`update ${entries} set html = seed.html, html_version = ${RENDER_VERSION}
    from (values ${sql.join(cached, sql`, `)}) as seed(id, html) where ${entries.id} = seed.id`);
  await recomputeThreadActivity(db, threadId);
  return added.map(row => row.id);
}
