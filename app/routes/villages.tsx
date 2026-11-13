import { data, Link } from "react-router";
import { Plus } from "lucide-react";
import type { Route } from "./+types/villages";
import { getReader } from "~/lib/auth/session.server";
import { villageReaderFor } from "~/lib/display-lang.server";
import { localizeVillages } from "~/lib/village-translations.server";
import { villageNameTitle } from "~/lib/village-translation-view";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { listVillages } from "~/lib/villages.server";
import { ownVillageNavigation } from "~/lib/village-navigation.server";
import { villageName, villagePath } from "~/lib/village-name";
import { villageDescription } from "~/lib/village-description";
import { readingHeaders } from "~/lib/public-reading.server";
import { readingRobotsMeta } from "~/lib/public-reading";
import { m } from "~/paraglide/messages.js";
import { VillageInvites } from "~/components/village-invites";
import { incomingVillageInvites } from "~/lib/village-management.server";
import { villageChatEnabled } from "~/lib/village-chat-enabled.server";
import { chatUnreadCounts } from "~/lib/village-chat.server";
import { chatMentionCounts } from "~/lib/village-chat-notifications.server";
import { PageHeader } from "~/components/page-header";
import { buttonVariants } from "~/components/ui/button";
import { ChatEntry } from "~/components/place-navigation";

export function headers() { return readingHeaders(); }
export function meta({ loaderData, matches }: Route.MetaArgs) {
  if (!loaderData) return [];
  return [...readingRobotsMeta(matches), { title: m.villages_title() }, { tagName: "link" as const, rel: "alternate", type: "text/markdown", href: "/villages.md" }];
}
export async function loader({ request }: Route.LoaderArgs) {
  if (!villagesEnabled()) throw data("Not found", { status: 404 });
  const { db, user, profile } = await getReader(request);
  const [places, own] = await Promise.all([listVillages(db, user?.id), user ? ownVillageNavigation(db, user.id) : null]);
  if (own) places.unshift({ ...own, joined: true });
  const directory = { villages: await localizeVillages(db, places, villageReaderFor(request, profile)), member: !!user, invites: user ? await localizeVillages(db, await incomingVillageInvites(db, user.id), villageReaderFor(request, profile)) : [] };
  if (!user || !villageChatEnabled()) return directory;
  const [unread, mentions] = await Promise.all([chatUnreadCounts(db, user.id, { excludeEnded: true }), chatMentionCounts(db, user.id)]);
  return { ...directory, chatUnread: Object.fromEntries(unread), chatMentions: Object.fromEntries(mentions) };
}
export function action() {
  if (!villagesEnabled()) throw data("Not found", { status: 404 });
  throw data("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
}
export default function Villages({ loaderData }: Route.ComponentProps) {
  const joined = loaderData.member ? loaderData.villages.filter(village => village.joined).sort((a, b) => Number(!!a.language) - Number(!!b.language)) : [];
  // The rest in one list: villages people made first, then the language villages.
  const remaining = loaderData.villages.filter(village => !loaderData.member || !village.joined).sort((a, b) => Number(!!a.language) - Number(!!b.language));
  const groups = [
    { id: "joined-villages", label: m.villages_joined_heading(), villages: joined },
    // A signed-out reader sees one list under the heading of the screen, so it needs no heading of its own.
    { id: "other-villages", label: loaderData.member ? m.villages_others_heading() : null, villages: remaining },
  ];
  // The way to make a village is on the row of the first heading (or on a row of its own only when there is no heading), not on a row of its own above the lists.
  const create = loaderData.member ? <Link to="/villages/new" className={buttonVariants({ variant: "outline" })}><Plus aria-hidden="true" className="size-4" />{m.village_create()}</Link> : null;
  const firstGroup = groups.find(group => group.villages.length > 0)?.id;
  return <main className="space-y-4">
    <PageHeader title={m.villages_title()} hideTitle />
    <VillageInvites invites={loaderData.invites} />
    {loaderData.villages.length === 0 && <p>{m.villages_empty()}</p>}
    {create && firstGroup === undefined && <div className="flex justify-end">{create}</div>}
    {groups.filter(group => group.villages.length > 0).map(group => <section key={group.id} aria-labelledby={group.label ? group.id : undefined} aria-label={group.label ? undefined : m.villages_title()}>
      {group.label
        ? <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"><h2 id={group.id} className="heading-2">{group.label}</h2>{group.id === firstGroup && create}</div>
        : group.id === firstGroup && create && <div className="flex justify-end">{create}</div>}
      <ul className="divide-y">
        {group.villages.map(village => {
          const chat = village.kind !== "personal" && group.id === "joined-villages" && village.slug && "chatUnread" in loaderData && Object.hasOwn(loaderData.chatUnread, village.slug);
          // The made-up description of a language village only says what its name says; one an operator wrote is shown.
          const description = village.language && !village.description ? null : villageDescription(village);
          return <li key={village.slug} className="space-y-1 py-3">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <Link to={villagePath(village.slug)} title={villageNameTitle(village)} className="link-ui inline-flex flex-wrap items-center gap-x-3 font-semibold">{villageName(village)}
                {village.kind === "invite_public" && <span title={m.village_invite_only_help()} className="rounded border px-1.5 ui-meta font-normal text-muted-foreground">{m.village_invite_only()}</span>}
              </Link>
              {chat && <ChatEntry slug={village.slug!} name={villageName(village)} unread={loaderData.chatUnread[village.slug!]} mentions={"chatMentions" in loaderData ? loaderData.chatMentions[village.slug!] ?? 0 : 0} />}
            </div>
            {description && <p className="line-clamp-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{description}</p>}
            {village.members !== undefined && <p className="ui-meta text-muted-foreground">{m.village_members({ count: village.members })}</p>}
          </li>;
        })}
      </ul>
    </section>)}
  </main>;
}
