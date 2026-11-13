import { useShellLabels } from "~/lib/use-shell-labels";
import { Link } from "react-router";
import { cn } from "~/lib/utils";
import { CountBadge, UnreadDot } from "./unread";
import type { JoinedVillageNavigation } from "~/lib/village-navigation.server";
import { FOLLOWED_NAVIGATION_VISIBLE } from "~/lib/village-follow-limits";
import type { FollowedVillageNavigation } from "~/lib/village-follows.server";
import { villageName, villagePath } from "~/lib/village-name";
import { villageNameTitle } from "~/lib/village-translation-view";
import { m } from "~/paraglide/messages.js";

// The way into a village's chat, written once for the places that show it as a word (village list, village head).
// Chat with something new: a dot. Chat with a mention of the member: a number (the number is only for what is addressed to the member).
// With nothing new it stays, in a lighter ink, so the entrance is always in the same place. Pressing it always opens the chat.
// The place list (side column, drawer) does not use this: it shows only the mark, see ChatMark.
export function ChatEntry({ slug, name, unread = 0, mentions = 0, current = false, quiet = true, className }: {
  slug: string; name: string; unread?: number; mentions?: number; current?: boolean; quiet?: boolean; className?: string;
}) {
  const labels = useShellLabels();
  const pending = unread > 0 || mentions > 0;
  const mentionLabel = m.village_chat_mentions({ count: mentions >= 100 ? "99+" : mentions });
  return <Link to={`/v/${slug}/chat`} aria-current={current ? "page" : undefined}
    aria-label={`${name} · ${labels.village_chat_title}${mentions > 0 ? ` · ${mentionLabel}` : unread > 0 ? ` · ${labels.notification_unread}` : ""}`}
    className={cn("choice shrink-0 gap-1 px-1 ui-meta", quiet && !pending && !current && "opacity-70", className)}>
    {labels.village_chat_title}
    {mentions > 0 ? <CountBadge count={mentions} label={mentionLabel} tone="strong" cap={99} /> : unread > 0 ? <UnreadDot /> : null}
  </Link>;
}

// The mark in a place list's village row: shown only when the chat has something new (a dot) or a mention of the member (a number),
// and then it is the link to the chat. Nothing new, nothing shown; the way to the chat is then the village page's "Chat" tab.
// The link keeps a comfortable target around the small mark and never wraps.
function ChatMark({ slug, name, unread, mentions }: { slug: string; name: string; unread: number; mentions: number }) {
  const labels = useShellLabels();
  if (unread <= 0 && mentions <= 0) return null;
  const mentionLabel = m.village_chat_mentions({ count: mentions >= 100 ? "99+" : mentions });
  return <Link to={`/v/${slug}/chat`} aria-label={`${name} · ${labels.village_chat_title} · ${mentions > 0 ? mentionLabel : labels.notification_unread}`}
    className="-my-1 inline-flex min-h-8 min-w-8 shrink-0 items-center justify-center whitespace-nowrap">
    {mentions > 0 ? <CountBadge count={mentions} label={mentionLabel} tone="strong" cap={99} /> : <UnreadDot />}
  </Link>;
}

// The places of a member, as one list: Home, Following, Read later, their own village, the villages joined (name = posts; a mark = something new in the chat, linking to it), and the way to the list of villages.
// The side column (wide list screens) and the drawer (everywhere else) both show exactly this.
export function PlaceList({ villages, followedVillages = [], followedUnread, pathname, villagesEnabled = true }: {
  villages: JoinedVillageNavigation[]; followedVillages?: FollowedVillageNavigation[]; followedUnread: boolean; pathname: string; villagesEnabled?: boolean;
}) {
  const labels = useShellLabels();
  const path = pathname.replace(/\/$/, "") || "/";
  const home = path === "/" || path.startsWith("/a/");
  const following = path === "/following";
  const slug = /^\/v\/([^/]+?)(?:\/chat)?$/i.exec(path)?.[1]?.toLowerCase();
  const inChat = /^\/v\/[^/]+\/chat$/.test(path);
  // A followed village is a plain link to its posts (the chat is for those who joined); it has no mark of its own, and no count of anything is shown.
  const followedRow = (village: FollowedVillageNavigation) => <li key={village.slug}>
    <Link to={villagePath(village.slug)} title={villageNameTitle(village)} aria-current={villagePath(village.slug) === path ? "page" : undefined} className="choice min-w-0 gap-2 px-1 py-1 [overflow-wrap:anywhere]">{village.iconUrl && <img src={village.iconUrl} alt="" className="size-5 shrink-0 rounded" />}<span className="min-w-0">{villageName(village)}</span></Link>
  </li>;
  const groups = [followedVillages.filter(v => v.kind !== "personal"), followedVillages.filter(v => v.kind === "personal")];
  return <>
    <ul className="space-y-0.5">
      <li><Link to="/" aria-current={home ? (path === "/" ? "page" : "true") : undefined} className="choice px-1 py-1">{labels.nav_home}</Link></li>
      <li><Link to="/following" aria-current={following ? "page" : undefined} className="choice gap-1.5 px-1 py-1">{labels.nav_following}{followedUnread && <UnreadDot label={labels.notification_unread} />}</Link></li>
      <li><Link to="/saved" aria-current={path === "/saved" ? "page" : undefined} className="choice px-1 py-1">{labels.saved_title}</Link></li>
    </ul>
    {villagesEnabled && <>
      {villages.length > 0 && <><h2 className="px-1 pt-3 ui-meta font-semibold text-muted-foreground">{labels.villages_title}</h2>
      <ul className="space-y-0.5">
        {villages.map(village => {
          const name = villageName(village);
          const here = villagePath(village.slug) === path || village.slug === slug;
          return <li key={village.slug} className="flex min-w-0 items-center justify-between gap-x-2">
            <Link to={villagePath(village.slug)} title={villageNameTitle(village)} aria-current={here ? (inChat ? "true" : "page") : undefined} className="choice min-w-0 gap-2 px-1 py-1 [overflow-wrap:anywhere]">{village.iconUrl && <img src={village.iconUrl} alt="" className="size-5 shrink-0 rounded" />}<span className="min-w-0">{name}</span></Link>
            {village.chatAvailable && village.slug && <ChatMark slug={village.slug} name={name} unread={village.unread ?? 0} mentions={village.mentions ?? 0} />}
          </li>;
        })}
      </ul></>}
      {groups.map((group, index) => group.length > 0 && <section key={index}>
        <h2 className="px-1 pt-3 ui-meta font-semibold text-muted-foreground">{index ? labels.village_personal_places : labels.village_follow_places}</h2>
        <ul className="space-y-0.5">{group.slice(0, FOLLOWED_NAVIGATION_VISIBLE).map(followedRow)}</ul>
        {group.length > FOLLOWED_NAVIGATION_VISIBLE && <details open={group.slice(FOLLOWED_NAVIGATION_VISIBLE).some(village => villagePath(village.slug) === path) || undefined}>
          <summary className="choice cursor-pointer px-1 py-1 ui-meta">{group[0].moreLabel}</summary>
          <ul className="space-y-0.5">{group.slice(FOLLOWED_NAVIGATION_VISIBLE).map(followedRow)}</ul>
        </details>}
      </section>)}
      <div className="mt-2 border-t pt-2"><Link to="/villages" aria-current={path === "/villages" ? "page" : undefined} className="choice px-1 py-1">{labels.nav_all_villages}</Link></div>
    </>}
  </>;
}
