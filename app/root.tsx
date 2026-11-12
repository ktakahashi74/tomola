import { webPushEnabled } from "~/lib/push/config.server";
import { useOperatorSettings } from "~/lib/operator-context";
import { operatorConfig } from "~/lib/operator-config.server";
import { operatorCopy } from "~/lib/operator-settings";
import { footerNotices } from "~/lib/notices.server";
import { shellLabels } from "~/lib/shell-labels.server";
import { safeErrorText } from "~/lib/error-text.server";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import { skipRevalidationFor } from "~/lib/stance-ui";
import { villageChatEnabled } from "~/lib/village-chat-enabled.server";
import { initializeSiteMarkdown } from "~/lib/markdown-startup.server";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
  useMatches,
  useLocation,
  useNavigation,
  type MiddlewareFunction,
} from "react-router";
import { useContext, useEffect, useRef, useState } from "react";
import { focusMain } from "~/lib/focus-main";
import type { Route } from "./+types/root";
import "./app.css";
import { PwaRegistration } from "~/components/pwa-registration";
import { SiteFooter } from "~/components/site-footer";
import { paraglideMiddleware } from "./paraglide/server.js";
import { getLocale } from "./paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";
import { hasLogoutNotice, logoutNoticeMiddleware } from "~/lib/auth/logout-notice.server";
import { welcomeMiddleware } from "~/lib/auth/welcome.server";
import { sessionCookieMiddleware } from "~/lib/auth/session-cookies.server";
import { getDb } from "~/lib/db/client.server";
import { readTranslationWaits } from "~/lib/translation-wait.server";
import { NORMAL_WAITS, TranslationWaitContext } from "~/lib/translation-wait";
import { enabledLangs, previewLangs } from "~/lib/enabled-langs.server";
import { getRequestUiLocale, negotiateUiLocale, withLocaleHeaders } from "~/lib/http/locale.server";
import { prepareUiLocale } from "~/lib/http/member-locale.server";
import { securityHeadersMiddleware } from "~/lib/http/security-headers.server";
import { startWorker } from "~/lib/jobs/worker.server";
import { syncOperatorRolesOnce } from "~/lib/roles.server";
import { sourceUrl } from "~/lib/source-url";
import { revision } from "~/lib/revision";
import { maintenanceMiddleware } from "~/lib/maintenance.server";
import { homeTrialEnabled } from "~/lib/home-trial.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { ensureDevelopmentVillagesOnce } from "~/lib/villages.server";
import { publicReading } from "~/lib/public-reading.server";
import { testSiteEnabled } from "~/lib/site-stage.server";
import { TestSiteNoticeContext } from "~/lib/test-site-notice";
import { BrowserTranslationContext } from "~/lib/browser-translation";
import { siteOrigin } from "~/lib/http/csrf.server";
import { HomeTrialBanner } from "~/components/home-trial-banner";
import { RouteError } from "~/components/route-error";
import { MarkdownBusyError, withMarkdownScope } from "~/lib/markdown-budget.server";

// securityHeadersMiddleware adds security headers such as CSP with a per-request nonce (app/lib/http/security-headers.server.ts). Keep it outermost to cover every response.
// paraglide: the display language (cookie, saved member preference, ?lang=, Accept-Language, default; the browser reads <html lang>;
// app/lib/http/locale.server.ts, locale-strategy.ts). sessionCookieMiddleware: puts the Set-Cookie of a session refresh that getSession returns on the response (so the session of an active member does not expire).
export const middleware: MiddlewareFunction[] = [
  securityHeadersMiddleware,
  maintenanceMiddleware,
  async (ctx, next) => { await initializeSiteMarkdown(); return withMarkdownScope(ctx.request.method === "GET" || ctx.request.method === "HEAD" ? "read" : "write", undefined, async () => {
    try { return await next(); }
    catch (error) {
      if (error instanceof MarkdownBusyError) {
        const { locale } = negotiateUiLocale(ctx.request, enabledLangs(), getRequestUiLocale(ctx.request));
        throw Response.json({ error: "temporarily_unavailable", message: m.error_unavailable({}, { locale }), retryAfter: "1" }, { status: 503, headers: { "Retry-After": "1" } });
      }
      throw error;
    }
  }); },
  sessionCookieMiddleware,
  async (ctx, next) => {
    await prepareUiLocale(ctx.request);
    return paraglideMiddleware(ctx.request, async () => withLocaleHeaders(await next()));
  },
  logoutNoticeMiddleware,
  welcomeMiddleware,
];

// Start one job worker on the process's first load (startWorker uses globalThis to prevent duplicate startup;
// WORKER_ENABLED=false disables it). Worker startup failure must not block pages.
// Synchronize operator role rows with OPERATOR_EMAILS once per process, removing operators not listed.
export async function loader({ request }: Route.LoaderArgs) {
  try {
    startWorker();
  } catch (error) {
    console.error("[worker] failed to start:", safeErrorText(error));
  }
  syncOperatorRolesOnce(getDb);
  ensureDevelopmentVillagesOnce(getDb);
  // The footer's link to the source code (SOURCE_URL; null when it is empty). A bad value is refused at startup, so this never throws in a running server.
  let source: string | null = null;
  try {
    source = sourceUrl();
  } catch {
    source = null;
  }
  // The enabled languages (ENABLED_LANGS), for the language choices (useEnabledLangs in app/lib/use-enabled-langs.ts). Add keys here, do not change the shape.
  const labels = shellLabels();
  return { ...footerNotices(), labels, loggedOut: hasLogoutNotice(request), webPush: webPushEnabled(), testSiteNotice: testSiteEnabled() ? (operatorCopy(operatorConfig(), getLocale()).testSiteNotice ?? m.test_site_notice()) : null, enabledLangs: enabledLangs(), previewLangs: previewLangs(), sourceUrl: source, revision: revision(), homeTrial: homeTrialEnabled(), publicReading: publicReading(), siteOrigin: publicReading() ? siteOrigin() : null, villages: villagesEnabled(), villageChat: villageChatEnabled(), translationWait: await readTranslationWaits(getDb) };
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Undefined when the root loader did not run (an error before it): the footer then has no source link.
  const rootData = useRouteLoaderData<typeof loader>("root");
  const operator = useOperatorSettings();
  const fallbackNotice = useContext(TestSiteNoticeContext);
  const suppressBrowserTranslation = useContext(BrowserTranslationContext);
  const testSiteNotice = rootData ? rootData.testSiteNotice : fallbackNotice;
  const memberData = useRouteLoaderData("routes/member-layout") as { reader: boolean } | undefined;
  const chat = useMatches().some(match => (match.handle as { chat?: boolean } | undefined)?.chat) && rootData?.villageChat;
  return (
    <html lang={getLocale()} translate={suppressBrowserTranslation ? "no" : undefined}>
      <head>
        <meta charSet="utf-8" />
        <meta name="tomola-operator" content={JSON.stringify(operator)} />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {suppressBrowserTranslation && <meta name="google" content="notranslate" />}
        {/* Add to home screen (PWA; public/manifest.webmanifest). theme-color matches the manifest's theme_color. */}
        {/* The theme colour is white because the app has a light theme only (app/app.css); the icon stays dark. */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#ffffff" />
        <link rel="icon" type="image/x-icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
        <link rel="icon" type="image/svg+xml" href="/icons/icon.svg" sizes="any" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <Meta />
        <Links />
      </head>
      <body className="site-frame mx-auto py-6 text-foreground">
        {testSiteNotice && <p data-test-site-notice="" role="note" className="mb-4 border-b pb-3 ui-meta text-muted-foreground">{testSiteNotice}</p>}
        {rootData?.homeTrial && <HomeTrialBanner />}
        <RouteAnnouncement />
        <NavigationProgress />
        <TranslationWaitContext.Provider value={rootData?.translationWait ?? NORMAL_WAITS}>{children}</TranslationWaitContext.Provider>
        {!chat && <SiteFooter labels={rootData?.labels} privacyLabel={rootData?.privacyLabel} member={memberData?.reader === false} publicReading={rootData?.publicReading} statsLabel={rootData?.statsLabel} previewNotice={rootData?.previewNotice} sourceUrl={rootData?.sourceUrl ?? null} revision={rootData?.revision} />}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

function RouteAnnouncement() {
  const { pathname } = useLocation();
  const previous = useRef(pathname);
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    setTitle("");
    const frame = requestAnimationFrame(() => {
      setTitle(document.title);
      focusMain();
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname]);
  return <div id="route-announcement" aria-live="polite" aria-atomic="true" className="sr-only">{title}</div>;
}

// A thin line at the top edge while a page change takes longer than 150 ms (a quick change shows nothing). It does not move or fill: whether to animate is left to the visual style.
// Only page changes count (links and forms that go to a page); a fetcher's send does not, because the button that sent it shows its own pending state.
const NAVIGATION_PROGRESS_DELAY_MS = 150;
function NavigationProgress() {
  const waiting = useNavigation().state !== "idle";
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!waiting) { setShown(false); return; }
    const timer = setTimeout(() => setShown(true), NAVIGATION_PROGRESS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  return shown ? <div role="progressbar" aria-label={m.navigation_loading()} className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 bg-foreground/60" /> : null;
}

export default function App() {
  const rootData = useRouteLoaderData<typeof loader>("root");
  const member = useRouteLoaderData<typeof import("~/routes/member-layout").loader>("routes/member-layout");
  return (
    <>
      <PwaRegistration loggedOut={rootData?.loggedOut ?? false} pushEnabled={rootData?.webPush ?? false} memberId={member && "userId" in member ? member.userId : null} />
      <Outlet />
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError error={error} />;
}

export function shouldRevalidate({ formAction, currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return skipRevalidationFor(formAction) && currentUrl.href === nextUrl.href ? false : defaultShouldRevalidate;
}
