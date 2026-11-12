import { data } from "react-router";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Route } from "./+types/posted-status";
import { requireMember } from "~/lib/auth/session.server";
import { entries, jobs } from "~/lib/db/schema";
import { parseIdOrNull } from "~/lib/params.server";
import { postedTranslationStates } from "~/lib/posted-status.server";
import type { SourceLang } from "~/lib/languages";

// Which translations of the member's own topic are there yet (names of languages only), polled for a short while by the notice that follows a post.
export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, db } = await requireMember(request);
  const id = parseIdOrNull(params.id);
  if (id === null) throw data("Not found", { status: 404 });
  const [entry] = await db.select({ id: entries.id, lang: entries.lang, langCode: entries.langCode, langSource: entries.langSource, revision: entries.mentionRevision, sourceHash: entries.sourceHash }).from(entries)
    .where(and(eq(entries.id, id), eq(entries.authorId, user.id), isNull(entries.deletedAt)));
  if (!entry) throw data("Not found", { status: 404 });
  const work = await db.select({ kind: jobs.kind, payload: jobs.payload, status: jobs.status }).from(jobs).where(and(sql`${jobs.payload}->>'entryId' = ${String(entry.id)}`, sql`(${jobs.payload}->>'sourceHash' = ${entry.sourceHash} or (${jobs.kind} = 'check_source_language' and ${jobs.payload}->>'revision' = ${String(entry.revision)}))`));
  return data({ lang: entry.lang, langCode: entry.langCode,
    checking: entry.langSource !== "checked" && work.some(w => w.kind === "check_source_language" && (w.payload as { revision?: number }).revision === entry.revision && ["queued", "running"].includes(w.status)),
    mismatch: work.some(w => ["check_source_language", "source_language_receipt"].includes(w.kind) && (w.payload as { revision?: number }).revision === entry.revision && (w.payload as { mismatch?: boolean }).mismatch),
    untranslatable: work.some(w => (w.payload as { untranslatableRevision?: number }).untranslatableRevision === entry.revision),
    langs: await postedTranslationStates(db, { id: entry.id, lang: entry.lang as SourceLang, sourceHash: entry.sourceHash }) }, { headers: { "Cache-Control": "private, no-store" } });
}
