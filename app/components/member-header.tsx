import { useShellLabels } from "~/lib/use-shell-labels";
import { Form, Link, useLocation, useRouteLoaderData } from "react-router";
import { Button, buttonVariants } from "./ui/button";
import { Input } from "./ui/input";
import { CountBadge } from "./unread";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "./ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { LANG_LABELS } from "~/lib/languages";
import { useEnabledLangs } from "~/lib/use-enabled-langs";
import { selectUiLocale } from "~/lib/http/locale-selection";
import { MAX_QUERY_LENGTH } from "~/lib/search";
import type { loader } from "~/routes/member-layout";
import type { loader as topicNewLoader } from "~/routes/topic-new";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import { NavigationDrawer } from "./navigation-drawer";
import { Bell, ChevronDown, PenLine, Search } from "lucide-react";
import { navigationSection, villageWritingHref } from "~/lib/navigation";
import { withSettingsReturn } from "~/lib/settings-return";

type MemberNavigation = Exclude<Awaited<ReturnType<typeof loader>>, { reader: true }>;

export function MemberHeader({ data, sideNavigation = false, whyLink = false }: { data: MemberNavigation; sideNavigation?: boolean; whyLink?: boolean }) {
  const labels = useShellLabels();
  const location = useLocation();
  const newTopic = useRouteLoaderData<typeof topicNewLoader>("routes/topic-new");
  const prefill = location.pathname.startsWith("/t/new") ? newTopic?.prefill : null;
  const current = navigationSection(location.pathname);
  const joined = "villages" in data ? data.villages : [];
  const draftBadge = <CountBadge count={data.apiDrafts} label={m.nav_drafts_api_count({ count: data.apiDrafts })} tone="strong" cap={Number.MAX_SAFE_INTEGER} />;
  const adminLinks = <>
    <DropdownMenuItem render={<Link to="/mod" />}>{labels.nav_mod}</DropdownMenuItem>
    <DropdownMenuItem render={<Link to="/admin/translations" />}>{labels.nav_translations}</DropdownMenuItem>
    {data.isOperator && <>
      <DropdownMenuItem render={<Link to="/admin/invitations" />}>{labels.nav_invitations}</DropdownMenuItem>
      <DropdownMenuItem render={<Link to="/admin/roles" />}>{labels.nav_roles}</DropdownMenuItem>
      <DropdownMenuItem render={<Link to="/admin/usage" />}>{labels.nav_usage}</DropdownMenuItem>
      <DropdownMenuItem render={<Link to="/admin/metrics" />}>{labels.nav_metrics}</DropdownMenuItem>
      <DropdownMenuItem render={<Link to="/admin/observation" />}>{labels.nav_observation}</DropdownMenuItem>
    </>}
  </>;
  return (
    <header className="site-header member-header mb-6 items-center gap-x-1 whitespace-nowrap border-b pb-3 sm:gap-x-2">
      {/* A chat has its own "≡" in its sticky head, so the one above would be a second one beside it. */}
      {!/^\/v\/[^/]+\/chat\/?$/.test(location.pathname) && <div className={sideNavigation ? "member-header-drawer site-navigation-header-links" : "member-header-drawer"}><NavigationDrawer /></div>}
      <Link to="/" aria-current={current === "home" && "page"} className="logo"><span aria-hidden /><span>{labels.site_name}</span></Link>
      <div className="member-header-reading">
      {whyLink && <Link to="/why" aria-current={location.pathname === "/why" ? "page" : undefined} className="link-ui shrink-0 text-sm">{labels.footer_why}</Link>}
      <Form method="get" action="/search" role="search" className="hidden min-w-8 flex-1 sm:flex">
        <Input type="search" name="q" maxLength={MAX_QUERY_LENGTH} placeholder={labels.nav_search_placeholder} aria-label={labels.nav_search_label} className="h-6 w-full" />
      </Form>
      </div>
      <Tooltip><TooltipTrigger render={<Link to="/search" aria-label={labels.nav_search_label} className="ms-auto flex size-8 shrink-0 items-center justify-center rounded-sm hover:bg-muted sm:hidden" />}>
        <Search aria-hidden="true" className="size-5" />
      </TooltipTrigger><TooltipContent role="tooltip">{labels.nav_search_label}</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger render={<Link to="/notifications" aria-current={current === "notifications" ? "page" : undefined} aria-label={data.unreadNotifications ? `${labels.nav_notifications} · ${m.nav_notifications_unread({ count: data.unreadNotifications >= 100 ? "99+" : data.unreadNotifications })}` : labels.nav_notifications} className="flex h-8 shrink-0 items-center gap-0.5 rounded-sm px-1 hover:bg-muted" />}>
        <Bell aria-hidden="true" className="size-5" />
        <CountBadge count={data.unreadNotifications} label={m.nav_notifications_unread({ count: data.unreadNotifications >= 100 ? "99+" : data.unreadNotifications })} tone="strong" />
      </TooltipTrigger><TooltipContent role="tooltip">{labels.nav_notifications}</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger render={<Link to={villageWritingHref(location.pathname, joined)} aria-label={labels.nav_new_topic} className={buttonVariants({ className: "h-7 px-1 sm:px-2" })} onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !/^\/(?:t\/new|drafts\/\d+)\/?$/.test(location.pathname)) return;
        const form = document.querySelector<HTMLTextAreaElement>('main textarea[name="body"]')?.form;
        if (!form) return;
        // Keep authored writing even after autosave; unchanged starter text can be left.
        const fields = new FormData(form);
        const normalize = (value: unknown) => String(value ?? "").replace(/\r\n?/g, "\n").trim();
        const title = normalize(fields.get("title")), body = normalize(fields.get("body"));
        if ((title || body) && (title !== normalize(prefill?.title) || body !== normalize(prefill?.body))) event.preventDefault();
      }} />}>
        <PenLine aria-hidden="true" className="size-4 sm:hidden" />
        <span className="hidden sm:inline">{labels.nav_new_topic}</span>
      </TooltipTrigger><TooltipContent role="tooltip">{labels.nav_new_topic}</TooltipContent></Tooltip>
      {data.isModerator && <DropdownMenu key={`admin-${location.key}`}>
        <DropdownMenuTrigger data-admin-menu-trigger className="hidden shrink-0 sm:inline-flex" render={<Button variant="ghost" className="px-1" />}>{labels.nav_admin}</DropdownMenuTrigger>
        <DropdownMenuContent data-admin-menu align="end" className="w-64 max-w-[calc(100vw-2rem)]">{adminLinks}</DropdownMenuContent>
      </DropdownMenu>}
      <DropdownMenu key={`member-${location.key}`}>
        <DropdownMenuTrigger data-member-menu-trigger title={`@${data.handle}`} aria-label={`${labels.nav_menu} @${data.handle}${data.apiDrafts ? ` · ${m.nav_drafts_api_count({ count: data.apiDrafts })}` : ""}`} className="min-w-0 max-w-28 shrink" render={<Button variant="ghost" className="gap-1 px-1" />}>
          <span className="min-w-0 truncate">@{data.handle}</span>
          {draftBadge}
          <ChevronDown aria-hidden="true" className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent data-member-menu align="end" className="w-64 max-w-[calc(100vw-2rem)]">
          <DropdownMenuItem render={<Link to="/drafts" />}>{labels.nav_drafts}{draftBadge}</DropdownMenuItem>
          <DropdownMenuItem render={<Link to={`/u/${data.handle}`} />}>{labels.nav_my_page}</DropdownMenuItem>
          <DropdownMenuItem render={<Link to="/settings/stances" />}>{labels.nav_stances}</DropdownMenuItem>
          <DropdownMenuItem render={<Link to={withSettingsReturn("/settings", location.pathname === "/settings" ? new URLSearchParams(location.search).get("returnTo") : `${location.pathname}${location.search}${location.hash}`)} />}>{labels.nav_settings}</DropdownMenuItem>
          {data.canInvite && <DropdownMenuItem render={<Link to="/invites/new" />}>{labels.nav_invite}</DropdownMenuItem>}
          <LocaleMenu />
          <Form method="post" action="/logout"><DropdownMenuItem nativeButton render={<button type="submit" />}>{labels.nav_logout}</DropdownMenuItem></Form>
          {data.isModerator && <DropdownMenuGroup className="sm:hidden" data-mobile-admin>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{labels.nav_admin}</DropdownMenuLabel>
            {adminLinks}
          </DropdownMenuGroup>}
        </DropdownMenuContent>
      </DropdownMenu>
      <p className="site-tagline">{labels.site_tagline}</p>
    </header>
  );
}

function LocaleMenu() {
  const labels = useShellLabels();
  const langs = useEnabledLangs();
  return <DropdownMenuSub>
    <DropdownMenuSubTrigger>{labels.nav_language}</DropdownMenuSubTrigger>
    <DropdownMenuSubContent>
      <DropdownMenuRadioGroup value={getLocale()} onValueChange={value => { void selectUiLocale(value, langs, { clearReadingLanguage: true }); }}>
        {langs.map(lang => <DropdownMenuRadioItem key={lang} value={lang} lang={lang}>{LANG_LABELS[lang]}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
      <DropdownMenuItem render={<Link to="/languages" />}>{labels.languages_other}</DropdownMenuItem>
    </DropdownMenuSubContent>
  </DropdownMenuSub>;
}
