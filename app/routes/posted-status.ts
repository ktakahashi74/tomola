import { data } from "react-router";
import { and, eq, isNull } from "drizzle-orm";
import type { Route } from "./+types/posted-status";
import { requireMember } from "~/lib/auth/session.server";
import { entries } from "~/lib/db/schema";
import { parseIdOrNull } from "~/lib/params.server";
import { postedTranslationStates } from "~/lib/posted-status.server";
import type { Lang } from "~/lib/languages";

// Which translations of the member's own topic are there yet (names of languages only), polled for a short while by the notice that follows a post.
export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, db } = await requireMember(request);
  const id = parseIdOrNull(params.id);
  if (id === null) throw data("Not found", { status: 404 });
  const [entry] = await db.select({ id: entries.id, lang: entries.lang, sourceHash: entries.sourceHash }).from(entries)
    .where(and(eq(entries.id, id), eq(entries.kind, "topic"), eq(entries.authorId, user.id), isNull(entries.deletedAt)));
  if (!entry) throw data("Not found", { status: 404 });
  return data({ langs: await postedTranslationStates(db, { id: entry.id, lang: entry.lang as Lang, sourceHash: entry.sourceHash }) }, { headers: { "Cache-Control": "private, no-store" } });
}
