import { useShellLabels } from "~/lib/use-shell-labels";
import { useLocation } from "react-router";
import { useEffect, useRef } from "react";
import { PersistentDetails } from "./persistent-details";
import { PlaceList } from "./place-navigation";
import { UnreadDot } from "./unread";
import { useNavigationData } from "~/lib/navigation-data";

// The drawer for the places of a member (Home, Following, villages and their chats): the same list as the side column, opened from the "≡" at the left end of the header.
// It is a <details>, so the places can be reached without JavaScript; with it, the focus moves in, Escape closes it and returns the focus, and a press outside or on a link closes it. No motion.
// The chat's sticky head carries one too, because the header above is out of sight there.
// An open drawer lies over the page, so the page behind it is dimmed (a layer that takes no press, so that a press on the text behind still closes it) and the list stands out from what it covers.
export function NavigationDrawer() {
  const labels = useShellLabels();
  const data = useNavigationData();
  const location = useLocation();
  const element = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const menu = element.current;
    if (!menu) return;
    const trigger = menu.querySelector("summary")!;
    const close = (restoreFocus: boolean) => {
      menu.open = false;
      if (restoreFocus) trigger.focus({ preventScroll: true });
    };
    // A press on a link or a button of the page behind only closes the drawer: the press that closes it is not also a press on what lies behind. The controls of the header keep working.
    let swallow = 0;
    const pointerdown = (event: PointerEvent) => {
      if (menu.open && event.target instanceof Node && !menu.contains(event.target)) {
        close(false);
        if (event.target instanceof Element && event.target.closest("main") && event.target.closest("a[href], button, summary, [role=button]")) swallow = Date.now();
      }
    };
    const behind = (event: MouseEvent) => {
      if (!swallow) return;
      const recent = Date.now() - swallow < 1000;
      swallow = 0;
      if (recent && event.target instanceof Element && event.target.closest("main")) { event.preventDefault(); event.stopPropagation(); }
    };
    const click = (event: MouseEvent) => {
      if (menu.open && event.target instanceof Element && menu.contains(event.target) && event.target.closest("a[href]")) close(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !menu.open) return;
      event.preventDefault();
      close(true);
    };
    const focus = (event: FocusEvent) => {
      if (menu.open && event.target instanceof Node && !menu.contains(event.target)) close(false);
    };
    document.addEventListener("pointerdown", pointerdown, true);
    document.addEventListener("click", behind, true);
    document.addEventListener("click", click);
    document.addEventListener("keydown", keydown);
    document.addEventListener("focusin", focus);
    return () => {
      document.removeEventListener("pointerdown", pointerdown, true);
      document.removeEventListener("click", behind, true);
      document.removeEventListener("click", click);
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", focus);
    };
  }, [location.key]);
  if (!data) return null;
  const anythingNew = data.followedUnread || data.villages.some(village => (village.unread ?? 0) > 0 || (village.mentions ?? 0) > 0);
  return <PersistentDetails ref={element} key={location.key} data-navigation-drawer className="relative shrink-0 whitespace-normal open:before:pointer-events-none open:before:fixed open:before:inset-0 open:before:z-40 open:before:bg-foreground/10 open:before:content-['']" onToggle={event => {
    if (event.currentTarget.open) event.currentTarget.querySelector<HTMLAnchorElement>("a[href]")?.focus({ preventScroll: true });
  }}>
    <summary className="flex size-8 cursor-pointer list-none items-center justify-center gap-0.5 rounded-sm hover:bg-muted [&::-webkit-details-marker]:hidden">
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-5"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
      <span className="sr-only">{labels.nav_places}</span>
      {anythingNew && <UnreadDot label={labels.notification_unread} className="-ms-1 -mt-3" />}
    </summary>
    <nav aria-label={labels.nav_side_label} className="absolute start-0 z-50 max-h-[80vh] w-64 max-w-[calc(100vw-2rem)] space-y-1 overflow-y-auto rounded-md border bg-popover p-3 text-sm text-popover-foreground shadow-md [overflow-wrap:anywhere] top-full mt-2">
      <PlaceList villages={data.villages} followedVillages={data.followedVillages} followedUnread={data.followedUnread} pathname={location.pathname} villagesEnabled={data.villagesEnabled} />
    </nav>
  </PersistentDetails>;
}
