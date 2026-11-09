import { testOperator } from "./helpers/operator";
import { operatorName } from "~/lib/operator-settings";
import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { SHELL_LABEL_KEYS } from "~/lib/shell-labels";
import { shellLabels } from "~/lib/shell-labels.server";
import { SiteFooter } from "~/components/site-footer";
import { GuestHeader } from "~/components/guest-header";
import { MemberHeader } from "~/components/member-header";
import { SiteNavigation } from "~/components/site-navigation";
import { NavigationDataContext } from "~/lib/navigation-data";
import { TooltipProvider } from "~/components/ui/tooltip";
import { m } from "~/paraglide/messages.js";
import { renderInRouter } from "./helpers/render-in-router";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
vi.mock("~/lib/use-villages", () => ({ useVillages: () => true }));

it.each(["ja", "en", "fr"] as const)("builds every shared label from its message in %s", locale => {
  const labels = shellLabels(locale);
  expect(Object.keys(labels)).toEqual([...SHELL_LABEL_KEYS]);
  for (const key of SHELL_LABEL_KEYS) expect(labels[key]).toBe(key === "footer_operator" ? m.footer_operator({ operator: operatorName(testOperator, locale) }, { locale }) : m[key]({}, { locale }));
});

it.each(["ja", "en", "fr"] as const)("renders the server's labels in public and member shells in %s", async locale => {
  // Leave the message runtime on its ordinary locale to detect client-side
  // translation calls in place of the labels supplied by the root loader.
  const labels = shellLabels(locale);
  const navigation = { reader: false, handle: "labels_reader", userId: "labels_reader", hasPasskey: true, passkeyPrompt: false, isOperator: false, isModerator: false, apiDrafts: 0, unreadNotifications: 0 };
  const places = { villages: [], followedUnread: false, villagesEnabled: true };
  const markup = await renderInRouter(() => createElement(NavigationDataContext.Provider, { value: places },
    createElement(TooltipProvider, {},
      createElement(GuestHeader),
      createElement(MemberHeader, { data: navigation } as never),
      createElement(SiteNavigation, { children: null }),
      createElement(SiteFooter, { labels, sourceUrl: "https://example.com/source", member: true, privacyLabel: "privacy" }),
    )), "/", undefined, { labels });
  for (const key of ["footer_connect", "footer_source", "footer_operator", "nav_home", "nav_following", "nav_search_placeholder", "nav_places", "nav_side_label"] as const) {
    const escaped = labels[key].replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    expect(markup).toContain(escaped);
  }
});

it("keeps the ordinary footer links when the root loader failed", async () => {
  const markup = await renderInRouter(() => createElement(SiteFooter, { labels: undefined, sourceUrl: null }));
  for (const [href, label] of [["/principles", m.footer_principles()], ["/why", m.footer_why()], ["/connect", m.footer_connect()]]) {
    expect(markup).toContain(`href="${href}"`);
    expect(markup).toContain(label);
  }
});

it("keeps footer labels when member data survives a root loader failure", async () => {
  const markup = await renderInRouter(() => createElement(SiteFooter, { labels: undefined, sourceUrl: null, member: true }));
  expect(markup).toContain(m.nav_glossary());
  expect(markup).toContain(m.nav_moderation_log());
});
