import { useShellLabels } from "~/lib/use-shell-labels";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { PlaceList } from "./place-navigation";
import { useNavigationData } from "~/lib/navigation-data";

type ChatNavigation = { slug: string; unreadCounts: Record<string, number>; atBottom: boolean };
const ChatNavigationContext = createContext<((value: ChatNavigation | null) => void) | null>(null);

// Reuse the chat's existing live snapshot; navigation never starts its own requests.
export function useChatNavigation(slug: string, unreadCounts: Record<string, number>, atBottom: boolean) {
  const publish = useContext(ChatNavigationContext);
  useEffect(() => {
    publish?.({ slug, unreadCounts, atBottom });
    return () => publish?.(null);
  }, [publish, slug, unreadCounts, atBottom]);
}

// The side column of the wide list screens: the places list (also the content of the drawer in the header).
export function SiteNavigation({ children }: { children: ReactNode }) {
  const labels = useShellLabels();
  const { pathname } = useLocation();
  const data = useNavigationData();
  const [chat, setChat] = useState<ChatNavigation | null>(null);
  const slug = /^\/v\/([^/]+)(?:\/chat)?\/?$/i.exec(pathname)?.[1]?.toLowerCase();
  const inChat = /\/chat\/?$/.test(pathname);
  const live = chat?.slug === slug && inChat ? chat : null;
  // In the chat being read to the end, nothing in it is new; its own live counts are fresher than the layout's.
  const villages = (data?.villages ?? []).map(village => {
    if (village.unread === undefined) return village;
    const unread = live && village.slug === slug && live.atBottom ? 0 : live?.unreadCounts[village.slug!] ?? village.unread;
    return { ...village, unread, ...(unread === 0 ? { mentions: 0 } : {}) };
  });
  return <ChatNavigationContext.Provider value={setChat}>
    <nav data-site-navigation aria-label={labels.nav_side_label} className="site-navigation space-y-1 text-sm [overflow-wrap:anywhere]">
      <PlaceList villages={villages} followedVillages={data?.followedVillages} followedUnread={data?.followedUnread ?? false} pathname={pathname} villagesEnabled={data?.villagesEnabled ?? true} />
    </nav>
    {children}
  </ChatNavigationContext.Provider>;
}
