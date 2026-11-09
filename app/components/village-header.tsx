import type { ReactNode } from "react";
import { Link } from "react-router";
import { PageHeader } from "./page-header";
import { NavigationDrawer } from "./navigation-drawer";
import { CountBadge, UnreadDot } from "./unread";
import { useNavigationData } from "~/lib/navigation-data";
import { villageName } from "~/lib/village-name";
import { villageNameLang, villageNameTitle, type WithVillageTranslation } from "~/lib/village-translation-view";
import { m } from "~/paraglide/messages.js";

type VillageHead = { slug: string | null; name: string; language: string | null; kind?: string; iconUrl?: string } & WithVillageTranslation;
type ChatTab = { joined: boolean; unread: number; member?: boolean };

// The two faces of a village as real tabs: Posts and Chat. Chat is always shown: its content is for members only, but its existence is not a secret.
// A person who has not joined sees it as plain text with "Members only"; nothing of its content or amount is shown.
function VillageTabs({ village, current, chat }: { village: VillageHead; current: "posts" | "chat"; chat: ChatTab }) {
  const data = useNavigationData();
  const mentions = data?.villages.find(item => item.slug === village.slug)?.mentions ?? 0;
  const mentionLabel = m.village_chat_mentions({ count: mentions >= 100 ? "99+" : mentions });
  return <nav aria-label={villageName(village)} className="flex flex-wrap items-center gap-x-4 gap-y-1 ui-help">
    <Link to={`/v/${village.slug}`} aria-current={current === "posts" ? "page" : undefined} className="choice">{m.village_posts_tab()}</Link>
    {chat.joined
      ? <Link to={`/v/${village.slug}/chat`} aria-current={current === "chat" ? "page" : undefined} className="choice gap-1.5">
        {m.village_chat_title()}
        {mentions > 0 ? <CountBadge count={mentions} label={mentionLabel} tone="strong" /> : chat.unread > 0 ? <UnreadDot label={m.notification_unread()} /> : null}
      </Link>
      : <span className="choice cursor-default gap-1.5" title={chat.member === false ? m.village_chat_login_to_read() : m.village_chat_join_to_read()}>
        {m.village_chat_title()}{" "}<span className="text-muted-foreground">{m.village_chat_members_only()}</span>
      </span>}
  </nav>;
}

// The head of a village. On the posts face it is one block (name and kind mark, one main action, purpose, tabs).
// On the chat face it is the sticky strip: the places drawer, the name, the tabs, and the chat's own switch at the right end (`children`).
export function VillageHeader({ village, current, chat, actions, purpose, children }: {
  village: VillageHead; current: "posts" | "chat"; chat?: ChatTab; actions?: ReactNode; purpose?: ReactNode; children?: ReactNode;
}) {
  const name = villageName(village);
  const icon = village.iconUrl && <img src={village.iconUrl} alt="" className="me-2 inline-block size-8 shrink-0 rounded align-middle" />;
  const tabs = chat ? <VillageTabs village={village} current={current} chat={chat} /> : null;
  if (current === "chat") {
    return <header data-village-header className="sticky top-0 z-30 flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-background py-2">
      {/* The side column carries the places from 1024px; the drawer is for narrower screens. */}
      <div className="contents lg:hidden"><NavigationDrawer /></div>
      <h1 title={villageNameTitle(village)} lang={villageNameLang(village)} className="min-w-0 font-bold">{icon}{name}</h1>
      {tabs}
      {/* At the right end when it shares the row; on a narrow screen it wraps to a row of its own, which starts at the left like the name. */}
      {children != null && <div className="flex items-center gap-3 sm:ms-auto">{children}</div>}
    </header>;
  }
  return <header data-village-header>
    <PageHeader
      title={name}
      heading={<div className="flex flex-wrap items-center gap-x-3"><h1 lang={villageNameLang(village)} className="heading-1">{icon}{name}</h1>{village.kind === "invite_public" && <span title={m.village_invite_only_help()} className="rounded border px-1.5 ui-meta text-muted-foreground">{m.village_invite_only()}</span>}</div>}
      actions={actions}
      purpose={purpose}
      switches={tabs}
    />
    {children}
  </header>;
}
