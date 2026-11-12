import { defineCustomClientStrategy, toLocale } from "~/paraglide/runtime.js";

// The browser half of Paraglide's custom strategy "custom-htmlLang" (the server half is in app/lib/http/locale.server.ts). The server decides the interface
// language of every page and renders it in <html lang>. In the browser, getLocale() uses that attribute (read once, see below), so hydration always uses the language the server rendered and the
// browser never applies its own matching rule (Paraglide's navigator.languages matching knows nothing about ENABLED_LANGS or the Chinese scripts).
// setLocale does nothing here: Paraglide also calls it on the first getLocale(). Explicit language choices persist through the server before reloading; registration can also set the cookie.
// The name must follow the pattern custom-[A-Za-z0-9_-]+ (Paraglide 2.25).
export const HTML_LANG_STRATEGY = "custom-htmlLang";

// Called once in app/entry.client.tsx, before hydration. <html lang> is read ONCE, here: a browser's page translation (or an extension) rewrites <html lang> after hydration
// ("es", "zh-CN", "th", ...), and Paraglide throws on a value that is not one of its locales, so reading the attribute on every getLocale() would make every message call throw
// (the root ErrorBoundary included) and a "th" would silently switch the page to unchecked strings. A language switch always reloads the page, so a value read once is enough.
// A value that is not one of the nine locales ("", "mul", ...) gives undefined, and Paraglide falls to the base locale.
export function defineHtmlLangStrategy(): void {
  const rendered = typeof document === "undefined" ? undefined : toLocale(document.documentElement.lang);
  defineCustomClientStrategy(HTML_LANG_STRATEGY, {
    getLocale: () => rendered,
    setLocale: () => {},
  });
}
