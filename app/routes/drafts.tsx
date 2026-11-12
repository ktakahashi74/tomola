import { languageLabel } from "~/lib/language-label";
import { Link } from "react-router";
import { LocalTime } from "~/components/local-time";
import type { Route } from "./+types/drafts";
import { requireMember } from "~/lib/auth/session.server";
import { listDrafts } from "~/lib/drafts.server";
import { LANG_LABELS } from "~/lib/languages";
import { m } from "~/paraglide/messages.js";

export async function loader({ request }: Route.LoaderArgs) {
  const { user, db } = await requireMember(request);
  return { drafts: await listDrafts(db, user.id) };
}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.drafts_title() }];
}

export default function Drafts({ loaderData }: Route.ComponentProps) {
  const { drafts } = loaderData;
  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-bold">{m.drafts_title()}</h1>
      {drafts.length === 0 ? (
        <p>{m.drafts_empty()}</p>
      ) : (
        <ul className="divide-y">
          {drafts.map((d) => (
            <li key={d.id} className="py-2">
              <Link to={`/drafts/${d.id}`} dir="auto" lang={d.lang} className="font-semibold hover:underline">
                {d.kind === "topic" ? d.title || d.headline || m.draft_untitled() : d.excerpt || m.draft_untitled()}
              </Link>
              <div className="ui-meta text-muted-foreground">
                {d.kind === "topic" ? m.draft_kind_topic() : m.draft_kind_reply()}
                {d.asksStance && <> · {m.question_badge()}</>} · {languageLabel(d.lang)}
                {d.kind === "reply" && d.threadTitle && <> · {m.draft_reply_to({ title: d.threadTitle })}</>}
                {d.via === "api" && <> · {m.draft_badge_api()}</>} ·{" "}
                <LocalTime iso={d.updatedAt.toISOString()} formatLabel={(date) => m.draft_updated({ date })} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
