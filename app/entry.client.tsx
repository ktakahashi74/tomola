import { OperatorSettingsContext } from "~/lib/operator-context";
// React Router's default entry.client, plus the browser half of the interface-language strategy: it must be defined before hydration so that getLocale() reads <html lang>,
// the language the server rendered (app/lib/http/locale-strategy.ts).
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { defineHtmlLangStrategy } from "~/lib/http/locale-strategy";
import { trackInitialActivation } from "~/lib/initial-activation";
import { clearLocalDrafts } from "~/lib/local-draft";
import { TestSiteNoticeContext } from "~/lib/test-site-notice";
import { BrowserTranslationContext } from "~/lib/browser-translation";

defineHtmlLangStrategy();
trackInitialActivation();
const operator = JSON.parse(document.querySelector('meta[name="tomola-operator"]')!.getAttribute("content")!);
const testSiteNotice = document.querySelector("[data-test-site-notice]")?.textContent ?? null;
const suppressBrowserTranslation = document.documentElement.getAttribute("translate") === "no";
// Unsent writing kept on this device is removed when the member logs out.
document.addEventListener("submit", event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  try { if (new URL(form.action, window.location.href).pathname === "/logout") clearLocalDrafts(); } catch { /* Not a URL. */ }
}, true);

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <BrowserTranslationContext.Provider value={suppressBrowserTranslation}>
        <TestSiteNoticeContext.Provider value={testSiteNotice}>
          <OperatorSettingsContext.Provider value={operator}>
            <HydratedRouter />
          </OperatorSettingsContext.Provider>
        </TestSiteNoticeContext.Provider>
      </BrowserTranslationContext.Provider>
    </StrictMode>,
  );
});
