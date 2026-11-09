import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { GuestHeader } from "./guest-header";
import { MemberHeader } from "./member-header";
import { TooltipProvider } from "./ui/tooltip";
import type { loader } from "~/routes/member-layout";
import { readerLoginHref } from "~/lib/public-reading";
import { NavigationDataContext } from "~/lib/navigation-data";
import { setDocumentMember } from "~/lib/document-member";
import type { JoinedVillageNavigation } from "~/lib/village-navigation.server";
import type { FollowedVillageNavigation } from "~/lib/village-follows.server";

// Public document HTML contains no member data; only navigation is personalized after loading.
export function DocumentHeader({ showWhyLink = false }: { showWhyLink?: boolean } = {}) {
  const location = useLocation();
  const container = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [navigation, setNavigation] = useState<Awaited<ReturnType<typeof loader>>>();
  useLayoutEffect(() => {
    const focused = previousFocus.current;
    previousFocus.current = null;
    if (!focused || focused.isConnected || document.activeElement !== document.body) return;
    const controls = [...container.current!.querySelectorAll<HTMLElement>('a[href], button, input, select, [tabindex="0"]')]
      .filter(element => element.getClientRects().length && (element.checkVisibility?.() ?? true) && !element.closest("[inert]") && !element.matches(":disabled"));
    const equivalent = controls.find(element => focused.hasAttribute("href")
      ? element.getAttribute("href") === focused.getAttribute("href")
      : element.tagName === focused.tagName && element.getAttribute("aria-label") === focused.getAttribute("aria-label"));
    (equivalent ?? controls[0])?.focus({ preventScroll: true });
  }, [navigation]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/navigation-header", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (response.ok) {
          const value = await response.json();
          if (!controller.signal.aborted) {
            const focused = document.activeElement;
            previousFocus.current = focused instanceof HTMLElement && container.current?.contains(focused) ? focused : null;
            setNavigation(value);
            setDocumentMember(!value.reader);
          }
        }
      })
      .catch(() => { /* The public document stays readable offline or when navigation cannot load. */ });
    return () => controller.abort();
  }, [location.key]);
  useEffect(() => () => setDocumentMember(false), []);
  const member = navigation && !navigation.reader ? navigation : null;
  return <TooltipProvider><div ref={container} className="grid">
    {member && <div className="min-w-0 [grid-area:1/1]"><NavigationDataContext.Provider value={{ villages: "villages" in member ? (member.villages as JoinedVillageNavigation[] | undefined) ?? [] : [], followedVillages: ("followedVillages" in member ? member.followedVillages : []) as FollowedVillageNavigation[], followedUnread: member.followedUnread, villagesEnabled: "villages" in member }}><MemberHeader data={member} whyLink={showWhyLink} /></NavigationDataContext.Provider></div>}
    {/* Keep the guest's actual wrapping height without exposing duplicate controls. */}
    <GuestHeader sizing={!!member} loginHref={readerLoginHref(location.pathname, location.search)} />
  </div></TooltipProvider>;
}
