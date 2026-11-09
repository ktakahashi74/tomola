import { useOperatorSettings } from "~/lib/operator-context";
import { useEffect, useState } from "react";
import { isRouteErrorResponse, Link, useLocation } from "react-router";
import { hasLocalDraftAt } from "~/lib/local-draft";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";

// An error screen says what happened, the likely reason, and one next step (the home page). The code (404 and so on) is small and grey under the text.
// Inside the member layout the member's header and footer stay around it. Where no header is around it (showSite: an address that matches nothing, or a failure before the layout) it draws a plain header
// with the site name, because the screen does not know who is reading. It stays small on purpose: this component is part of the root bundle, which every page loads.
// When a screen where something is written is replaced by an error, what was typed is still on this device (DraftKeeper) unless the page itself was refused (a 4xx answer), and a
// reload brings it back: it is said only where this device holds such writing, not to every reader of a thread that failed to show.
export function RouteError({ error, showSite = true }: { error: unknown; showSite?: boolean }) {
  const operator = useOperatorSettings();
  const { pathname } = useLocation();
  const [keptWriting, setKeptWriting] = useState(false);
  useEffect(() => setKeptWriting(hasLocalDraftAt(pathname)), [pathname]);
  let heading: string = m.error_title_unexpected();
  let details: string = m.error_body_unexpected({ email: operator.contactEmail });
  let code: number | null = null;
  let retryAfter: string | null = null;
  if (isRouteErrorResponse(error)) {
    code = error.status;
    if (error.status === 400) { heading = m.error_title_bad_request(); details = m.error_body_bad_request(); }
    else if (error.status === 404) { heading = m.error_title_not_found(); details = m.error_body_not_found(); }
    else if (error.status === 403) { heading = m.error_title_forbidden(); details = m.error_body_forbidden(); }
    else if (error.status === 429) { heading = m.error_title_rate_limited(); details = m.error_body_rate_limited(); }
    else if (error.status === 503 && error.data?.error === "maintenance_readonly") { heading = m.error_title_unavailable(); details = error.data.message; }
    else if (error.status === 503) {
      heading = m.error_title_unavailable();
      details = m.error_body_unavailable();
      // Router error responses retain JSON data, but discard response headers.
      if (error.data && typeof error.data.retryAfter === "string") {
        const value: string = error.data.retryAfter;
        retryAfter = /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
          ? new Intl.NumberFormat(getLocale(), { style: "unit", unit: "second", unitDisplay: "long" }).format(Number(value)) : value;
      }
    }
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
  }
  return (
    <>
      {showSite && <header className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-b pb-3">
        <Link to="/" className="logo"><span aria-hidden /><span>{m.site_name()}</span></Link>
      </header>}
      <main className="space-y-3 py-6">
        <title>{`${heading} · ${m.site_name()}`}</title>
        {!showSite && <img src="/icons/logomark.svg" alt="" width={96} height={96} className="block" />}
        <h1 className="heading-1">{heading}</h1>
        <p>{details}</p>
        {retryAfter && <p>{m.error_retry_after({ time: retryAfter })}</p>}
        {keptWriting && !(isRouteErrorResponse(error) && error.status >= 400 && error.status < 500) && <p role="status">{m.write_error_kept()} <button type="button" className="link-prose" onClick={() => window.location.reload()}>{m.write_error_reload()}</button></p>}
        <p><Link to="/" className="link-ui font-medium">{m.error_go_home()}</Link></p>
        {code !== null && <p className="ui-meta text-muted-foreground">{code}</p>}
      </main>
    </>
  );
}
