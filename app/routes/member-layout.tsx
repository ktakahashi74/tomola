import { NavigationUnreadContext, type NavigationUnread } from "~/lib/navigation-unread";
import { NavigationDataContext } from "~/lib/navigation-data";
import { useCallback, useState } from "react";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import { synchronizeTopicRead } from "~/lib/topic-read.server";
import { skipRevalidationFor } from "~/lib/stance-ui";
import { villageChatEnabled } from "~/lib/village-chat-enabled.server";
import { joinedVillageNavigation } from "~/lib/village-navigation.server";
import { followedVillageNavigation, type FollowedVillageNavigation } from "~/lib/village-follows.server";
import { GuestHeader } from "~/components/guest-header";
import { MemberHeader } from "~/components/member-header";
import { SiteNavigation } from "~/components/site-navigation";
import { sideNavigationPath } from "~/lib/navigation";
import { eq } from "drizzle-orm";
import { passkey } from "~/lib/db/schema";
import type { PasskeyPrompt } from "~/components/passkey-prompt";
import { WelcomeNotice } from "~/components/welcome-notice";
import { welcomeFor } from "~/lib/auth/welcome.server";
import { hasLogoutNotice } from "~/lib/auth/logout-notice.server";
import { passkeyPromptPreference } from "~/lib/passkey-prompt.server";
import { data, Outlet, useLocation, useMatches } from "react-router";
import type { Route } from "./+types/member-layout";
import { getReader, getMemberScope, getCredentialSessionFresh } from "~/lib/auth/session.server";
import { readerLoginHref } from "~/lib/public-reading";
import { countApiDrafts } from "~/lib/drafts.server";
import { countUnreadNotifications, hasUnreadFollowedThread } from "~/lib/notifications.server";
import { isModerator } from "~/lib/roles.server";
import { rememberUiLocale } from "~/lib/profiles.server";
import { TooltipProvider } from "~/components/ui/tooltip";
import { negotiateUiLocale } from "~/lib/http/locale.server";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { canCreateInvitations } from "~/lib/invitation-permissions.server";
import { villageReaderFor } from "~/lib/display-lang.server";
import { m } from "~/paraglide/messages.js";

export async function loader({ request }: { request: Request }) {
  // A closed village route must render the ordinary 404, including for private-site guests.
  const pathname = new URL(request.url).pathname.replace(/\.data$/, "").replace(/\/$/, "");
  if ((pathname === "/villages" || pathname.startsWith("/villages/") || pathname.startsWith("/mod/village/") || /^\/v\/[^/]+(?:\/chat)?$/.test(pathname)) && !villagesEnabled()) throw data("Not found", { status: 404 });
  if ((/^\/v\/[^/]+\/chat$/.test(pathname) || pathname === "/settings/chat") && !villageChatEnabled()) throw data("Not found", { status: 404 });
  const { user, profile, db } = await getReader(request);
  // loggedOut: the notice left by logging out, which now lands on the posts where reading needs no login (the middleware clears it after this read).
  if (!user) return { reader: true as const, ...(hasLogoutNotice(request) ? { loggedOut: true as const } : {}) };
  // apiDrafts: number of API drafts awaiting approval, shown in the header's 「下書き」 badge.
  // isOperator: operator status (OPERATOR_EMAILS; roles.server.ts).
  const scopePromise = getMemberScope(request);
  // Initialize a missing display preference without adopting a shared link's language.
  const ui = negotiateUiLocale(request, enabledLangs(), profile.uiLocale);
  const [scope, keys, apiDrafts, notificationState, joined, followedVillages] = await Promise.all([
    scopePromise,
    db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, user.id)).limit(1),
    countApiDrafts(db, user.id),
    synchronizeTopicRead(request).then(() => Promise.all([countUnreadNotifications(db, user.id), hasUnreadFollowedThread(db, user.id)])),
    villagesEnabled() ? joinedVillageNavigation(db, user.id, villageReaderFor(request, profile)) : Promise.resolve([]),
    villagesEnabled() ? followedVillageNavigation(db, user.id, villageReaderFor(request, profile), { excludeJoined: true }) : Promise.resolve([]),
    ui.source === "cookie" || ui.source === "accept-language" ? rememberUiLocale(db, user.id, profile.uiLocale, ui.locale) : Promise.resolve(),
  ]);
  const navigation = {
    reader: false as const,
    userId: user.id,
    passkeyPrompt: passkeyPromptPreference(request, user.id),
    hasPasskey: keys.length > 0,
    credentialFresh: await getCredentialSessionFresh(request),
    handle: profile.handle,
    isOperator: scope.operator,
    canInvite: canCreateInvitations(scope.operator),
    isModerator: isModerator(scope),
    apiDrafts,
    unreadNotifications: notificationState[0],
    followedUnread: notificationState[1],
    // The greeting's words are made here, in the member's language, so that the page's script carries none of them (they are used on one page view in a member's life).
    welcome: welcomeFor(request, profile.handle),
  };
  if (!villagesEnabled()) return navigation;
  return { ...navigation, villages: joined, followedVillages, ...(villageChatEnabled() ? { chatUnreadTotal: joined.reduce((total, village) => total + (village.unread ?? 0), 0) } : {}) };
}

export default function MemberLayout({ loaderData }: Route.ComponentProps) {
  const location = useLocation();
  // Only the routes offering registration load the notice. Their handle is
  // available during server rendering, keeping the notice above the header.
  const Prompt = (useMatches().at(-1)?.handle as { PasskeyPrompt?: typeof PasskeyPrompt } | undefined)?.PasskeyPrompt;
  const [receipt, setReceipt] = useState<{ source: typeof loaderData; counts: NavigationUnread } | null>(null);
  const updateUnread = useCallback((counts: NavigationUnread) => setReceipt({ source: loaderData, counts }), [loaderData]);
  const counts = receipt?.source === loaderData ? receipt.counts : null;
  const navigation = !loaderData.reader && counts ? { ...loaderData, unreadNotifications: counts.notifications,
    ...("villages" in loaderData ? { villages: loaderData.villages.map(v => {
      const unread = counts.unreadCounts[v.slug!] ?? v.unread;
      // Everything is read in this village, so no mention is left either.
      return { ...v, unread, ...(unread === 0 ? { mentions: 0 } : {}) };
    }) } : {}),
    chatUnreadTotal: Object.values(counts.unreadCounts).reduce((a, b) => a + b, 0),
  } : loaderData;
  const places = loaderData.reader ? null : {
    villages: "villages" in navigation ? navigation.villages ?? [] : [],
    followedVillages: ("followedVillages" in navigation ? navigation.followedVillages : []) as FollowedVillageNavigation[],
    followedUnread: "followedUnread" in navigation && navigation.followedUnread,
    villagesEnabled: "villages" in loaderData,
  };
  if (loaderData.reader) return <TooltipProvider>
    <GuestHeader loginHref={readerLoginHref(location.pathname, location.search)} />
    {"loggedOut" in loaderData && <p role="status" className="mb-4">{m.logged_out()}</p>}
    <Outlet />
  </TooltipProvider>;
  const sideNavigation = "villages" in loaderData && sideNavigationPath(location.pathname);
  return (
    <NavigationUnreadContext.Provider value={updateUnread}><NavigationDataContext.Provider value={places}><TooltipProvider>
      {loaderData.welcome && <WelcomeNotice welcome={loaderData.welcome} handle={loaderData.handle} passkeyOffer={!loaderData.hasPasskey && location.pathname !== "/" && location.pathname !== "/settings"} villages={"villages" in loaderData} />}
      {Prompt && <Prompt key={location.pathname} eligible={!loaderData.hasPasskey} preference={loaderData.passkeyPrompt} fresh={loaderData.credentialFresh} />}
      <MemberHeader data={navigation as Exclude<typeof navigation, { reader: true }>} sideNavigation={sideNavigation} />
      {sideNavigation ? <SiteNavigation><Outlet /></SiteNavigation> : <Outlet />}
    </TooltipProvider></NavigationDataContext.Provider></NavigationUnreadContext.Provider>
  );
}

export function shouldRevalidate({ formAction, currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return skipRevalidationFor(formAction) && currentUrl.href === nextUrl.href ? false : defaultShouldRevalidate;
}
