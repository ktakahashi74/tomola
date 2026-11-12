// Offline document (/offline): the sole HTML page public/sw.js caches for offline navigation.
// No member data, per-request nonce or scripts. Cacheable documents must be retrievable without sessions and have identical content.
// Offline has neither Cookie nor settings to choose the reader's language, so show text in every enabled language.
import { SOURCE_LOCALE } from "~/lib/i18n/messages";
import logomark from "../../public/icons/logomark.svg?raw";

export type OfflineText = { lang: string; title: string; body: string; home: string; reload: string };

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Omit text identical to English, including the fallback for untranslated messages.
// A language appears automatically when its translation is added.
// With `enabled` (the languages of ENABLED_LANGS) only the sentences of enabled languages are kept (a language that is not enabled is left out even when it is translated).
export function offlineSections(texts: readonly OfflineText[], enabled?: readonly string[]): OfflineText[] {
  const source = texts.find((t) => t.lang === SOURCE_LOCALE);
  return texts.filter((t) => !enabled || enabled.includes(t.lang)).filter((t) => t.lang === SOURCE_LOCALE || !source || t.title !== source.title || t.body !== source.body || t.home !== source.home || t.reload !== source.reload);
}

// One script-free HTML document: `<html lang="mul">` for multiple languages and per-section `lang`. Minimal `<style>` rules fit CSP style-src 'self' 'unsafe-inline'.
export function renderOfflinePage(texts: readonly OfflineText[], siteName: string, enabled?: readonly string[]): string {
  const sections = offlineSections(texts, enabled)
    .map(
      (t) => `<section lang="${escapeHtml(t.lang)}"><h1>${escapeHtml(t.title)}</h1><p>${escapeHtml(t.body)}</p><p><a href="">${escapeHtml(t.reload)}</a></p><p><a href="/">${escapeHtml(t.home)}</a></p></section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="mul">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fbfaf7">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1a1917">
<title>${escapeHtml(siteName)}</title>
<style>:root{color-scheme:light dark}body{margin:0 auto;max-width:40rem;padding:1.5rem 1rem;font:16px/1.6 system-ui,sans-serif;color:light-dark(#171717,#e4e1db);background:light-dark(#fbfaf7,#1a1917)}.logomark{display:block;width:96px;height:96px;margin:0 0 1.5rem}h1{font-size:1.25rem;margin:0 0 .25rem}section{margin:0 0 2rem}a{color:inherit}</style>
</head>
<body>
<main>
${logomark.replace("<svg ", '<svg class="logomark" aria-hidden="true" focusable="false" ')}
${sections}
</main>
</body>
</html>
`;
}
