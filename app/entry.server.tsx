import { OperatorSettingsContext } from "~/lib/operator-context";
import { operatorConfig, publicOperatorSettings } from "~/lib/operator-config.server";
import { operatorCopy } from "~/lib/operator-settings";
import { safeErrorText } from "~/lib/error-text.server";
// Based on React Router's default Node entry.server (`react-router reveal entry.server`), with startup-check imports, the CSP nonce passed to ServerRouter, and
// error logging (handleError, suppressing 404/405 and hiding secrets in URLs)
// (root middleware creates a nonce per request; this entry retains a fallback for documents that bypass middleware). See app/lib/http/security-headers.server.ts. <Scripts>, <ScrollRestoration>, <Links> and streamed inline scripts
// use ServerRouter's nonce.
import { PassThrough } from "node:stream";

import type { EntryContext, HandleErrorFunction, RouterContextProvider } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import type { RenderToPipeableStreamOptions } from "react-dom/server";
import { renderToPipeableStream } from "react-dom/server";
import { addSecurityHeaders, generateNonce, HTML_CACHE_CONTROL, isProductionEnv, nonceContext } from "~/lib/http/security-headers.server";
import { logServerError } from "~/lib/http/error-log.server";
import "~/lib/startup.server";
import { testSiteEnabled } from "~/lib/site-stage.server";
import { m } from "~/paraglide/messages.js";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { getRequestUiLocale, negotiateUiLocale, shouldSuppressBrowserTranslation } from "~/lib/http/locale.server";
import { BrowserTranslationContext } from "~/lib/browser-translation";
import { TestSiteNoticeContext } from "~/lib/test-site-notice";
import { addStylePreloads } from "~/lib/http/style-preloads.server";

export const streamTimeout = 5_000;

// The production server (server.ts) extracts and invokes this from the server build's entry (app/lib/background.server.ts).
export { startBackgroundServices } from "~/lib/background.server";
export { readinessResponse } from "~/lib/readiness.server";
export { initializeSiteMarkdown as initializeMarkdown } from "~/lib/markdown-startup.server";
export { stopVillageChat } from "~/lib/village-chat-events.server";
export { stopMarkdown } from "~/lib/markdown-budget.server";

// Log server errors except 404/405, including the request URL with secrets redacted (app/lib/http/error-log.server.ts).
export const handleError: HandleErrorFunction = (error, { request }) => {
  logServerError(error, request);
};

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  // Use a CSP nonce only in production; development sends no CSP. Adding a nonce to the development server's critical.css <link> would differ from the client and trigger hydration warnings.
  // Reuse the root middleware's nonce, or generate one and attach the same headers if document handling bypassed middleware.
  const production = isProductionEnv();
  let nonce = production ? (loadContext.get(nonceContext) ?? undefined) : undefined;
  if (loadContext.get(nonceContext) === null) {
    nonce = production ? generateNonce() : undefined;
    addSecurityHeaders(responseHeaders, { nonce: nonce ?? "", production, pathname: new URL(request.url).pathname });
  }

  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    responseHeaders.set("Content-Type", "text/html");
    addStylePreloads(responseHeaders, responseStatusCode, production, routerContext);
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  // Resource responses never enter here. Early HTML errors still need the
  // notice, even when the root loader could not run. The client reads this
  // already-rendered text before hydration instead of translating it again.
  const { locale } = negotiateUiLocale(request, enabledLangs(), getRequestUiLocale(request));
  let fallbackNotice: string | null = null;
  if (testSiteEnabled()) {
    fallbackNotice = operatorCopy(operatorConfig(), locale).testSiteNotice ?? m.test_site_notice({}, { locale });
  }
  const suppressBrowserTranslation = shouldSuppressBrowserTranslation(request, enabledLangs());

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    let userAgent = request.headers.get("user-agent");

    // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
    // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
    let readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode
        ? "onAllReady"
        : "onShellReady";

    // Abort the rendering stream after the `streamTimeout` so it has time to
    // flush down the rejected boundaries
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => abort(),
      streamTimeout + 1000,
    );

    const { pipe, abort } = renderToPipeableStream(
      <BrowserTranslationContext.Provider value={suppressBrowserTranslation}>
        <TestSiteNoticeContext.Provider value={fallbackNotice}>
          <OperatorSettingsContext.Provider value={publicOperatorSettings(locale)}>
            <ServerRouter context={routerContext} url={request.url} nonce={nonce} />
          </OperatorSettingsContext.Provider>
        </TestSiteNoticeContext.Provider>
      </BrowserTranslationContext.Provider>,
      {
        // Add the nonce to React's own inline streaming scripts that complete Suspense boundaries too.
        nonce,
        async [readyOption]() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback) {
              // Clear the timeout to prevent retaining the closure and memory leak
              clearTimeout(timeoutId);
              timeoutId = undefined;
              callback();
            },
          });
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          // Production documents must not enter shared caches because they contain a nonce (HTML_CACHE_CONTROL in app/lib/http/security-headers.server.ts). Preserve route-provided Cache-Control.
          if (production && !responseHeaders.has("Cache-Control")) responseHeaders.set("Cache-Control", HTML_CACHE_CONTROL);
          addStylePreloads(responseHeaders, responseStatusCode, production, routerContext);

          pipe(body);

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          // Log streaming rendering errors from inside the shell.  Don't log
          // errors encountered during initial shell rendering since they'll
          // reject and get logged in handleDocumentRequest.
          if (shellRendered) {
            console.error(safeErrorText(error));
          }
        },
      },
    );
  });
}
