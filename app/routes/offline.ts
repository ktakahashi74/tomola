import type { Route } from "./+types/offline";
import { renderOfflinePage } from "~/lib/offline-page";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { m } from "~/paraglide/messages.js";

// /offline: unauthenticated, script-free HTML guidance. The service worker (public/sw.js) shows it when a document request cannot connect.
// Read neither sessions nor the DB, excluding member data by construction. The same document serves everyone, so list each language's text instead of choosing a UI locale (app/lib/offline-page.ts).
// Cache-Control: no-cache. The service worker refetches for each build; prevent stale documents remaining in the browser HTTP cache.
// The service worker keeps this document for a long time, so it must not carry the per-request nonce policy of the other pages (a stale nonce would sit in the
// cached copy). It has its own policy, which needs no nonce: no script, no image, no font, no connection; only its inline <style>. The route sets the header
// itself, and the security-headers middleware only adds headers a response does not have yet, so this value is kept (tests/pwa.test.ts).
export const OFFLINE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function loader(_args: Route.LoaderArgs) {
  // Only the sentences of the enabled languages (ENABLED_LANGS). Deploy a new build after changing the enabled languages so installed workers refetch this page (docs/deploy.md).
  const enabled = enabledLangs();
  const html = renderOfflinePage(
    enabled.map((lang) => ({
      lang,
      title: m.offline_title({}, { locale: lang }),
      body: m.offline_body({}, { locale: lang }),
      home: m.offline_home({}, { locale: lang }),
      reload: m.offline_reload({}, { locale: lang }),
    })),
    m.site_name({}, { locale: "en" }),
    enabled,
  );
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "Referrer-Policy": "no-referrer", "Content-Security-Policy": OFFLINE_CSP } });
}
