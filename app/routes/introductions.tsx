import { Link } from "react-router";
import type { Route } from "./+types/introductions";
import { ReadingList } from "~/components/reading-list";
import { readReadingRequest } from "~/lib/reading-page";
import { TopicList } from "~/components/topic-list";
import { requireMember } from "~/lib/auth/session.server";
import { displayLangFor, langCarry, screenReadLangsFor } from "~/lib/display-lang.server";
import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { hasVisibleIntroduction, listIntroductions } from "~/lib/introductions.server";
import { parsePage } from "~/lib/params.server";
import { toTopicItems } from "~/lib/topic-list.server";
import { m } from "~/paraglide/messages.js";

export const middleware: Route.MiddlewareFunction[] = [privateCacheMiddleware];
export function headers() { return { "Cache-Control": "private, no-store" }; }
export function meta() { return [{ title: `${m.introductions_title()} · ${m.site_name()}` }]; }

export async function loader({ request }: Route.LoaderArgs) {
  const { user, profile, db } = await requireMember(request);
  const [result, hasIntro] = await Promise.all([listIntroductions(db, { reading: readReadingRequest(request, "created", parsePage(request)), page: parsePage(request) }), hasVisibleIntroduction(db, user.id)]);
  return {
    list: result.list!,
    page: result.page, hasNext: result.hasNext, hasIntro, langParam: langCarry(request),
    topics: await toTopicItems(db, result.topics, { readLangs: screenReadLangsFor(request, profile), displayLang: displayLangFor(request, profile) }),
  };
}

export default function Introductions({ loaderData }: Route.ComponentProps) {
  const { topics, hasIntro, langParam } = loaderData;
  return <main className="space-y-4">
    <h1 className="text-2xl font-bold">{m.introductions_title()}</h1>
    {!hasIntro && <section className="space-y-2" data-introduction-prompt>
      <Link to="/t/new?intro=1" className="link-ui">{m.member_page_write_intro()}</Link>
      <p className="ui-help text-muted-foreground">{m.member_page_intro_hint()}</p>
    </section>}
    <ReadingList topics={topics} list={loaderData.list}>{items => <TopicList compactMeta topics={items} order="created" langParam={langParam} empty={m.introductions_empty()} />}</ReadingList>
  </main>;
}
