import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, notifications, profiles } from "./db/schema";
import { resolveDisplayLang } from "./display";
import { enabledLangs } from "./enabled-langs.server";
import type { Lang } from "./languages";
import { enqueue } from "./jobs/queue.server";
import { TRANSLATE_JOB, TRANSLATE_MAX_ATTEMPTS, translateDedupeKey } from "./translations.server";

// Notification excerpts (including daily mail) need the recipient's translation
// even when the site-wide reader threshold is higher than that audience.
export async function enqueueNotificationTranslations(db: Db, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  const rows = await db.select({ entryId: entries.id, lang: entries.lang, sourceHash: entries.sourceHash,
    displayLang: profiles.displayLang, readLangs: profiles.readLangs, uiLocale: profiles.uiLocale })
    .from(notifications).innerJoin(entries, eq(entries.id, notifications.entryId)).innerJoin(profiles, eq(profiles.userId, notifications.userId))
    .where(and(inArray(notifications.id, [...ids]), isNull(entries.deletedAt), isNull(entries.hiddenAt)));
  const seen = new Set<string>();
  for (const row of rows) {
    const lang = resolveDisplayLang({ profile: { displayLang: row.displayLang as Lang | null, readLangs: row.readLangs as Lang[] }, uiLocale: row.uiLocale, enabled: enabledLangs() });
    if (!row.sourceHash || lang === row.lang) continue;
    const payload = { entryId: row.entryId, lang, sourceHash: row.sourceHash };
    const dedupeKey = translateDedupeKey(payload, row.lang);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    await enqueue(db, TRANSLATE_JOB, payload, { dedupeKey, maxAttempts: TRANSLATE_MAX_ATTEMPTS });
  }
}
