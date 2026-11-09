import { cookieName, defineCustomServerStrategy } from "~/paraglide/runtime.js";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { HTML_LANG_STRATEGY } from "~/lib/http/locale-strategy";
import { defaultLangOf, LANGS, type Lang } from "~/lib/languages";
import { READING_ONLY_PARAM } from "~/lib/reading-lang";

// How the interface language is decided. Only the server decides; the browser reads the server's decision.
//   1. The language cookie (PARAGLIDE_LOCALE), if it names an enabled language. Only an explicit switcher choice writes it; automatic browser resolution and the server never do.
//   2. The lang query parameter, if it names an enabled language and the address has no reading-only mark (rl, app/lib/reading-lang.ts); a mark that names an enabled language (rl=fr) sets the screen language itself. It does not write a cookie or change the member's remembered UI language.
//   3. The first language of Accept-Language (in order of q) that matches an enabled language: the whole tag, or the part before the first "-" ("en-US" is en).
//      Chinese tags are mapped by script first: zh-Hant (zh-Hant, zh-TW, zh-HK, zh-MO) and zh-Hans (zh-Hans, zh-CN, zh-SG, zh, every other zh-*).
//   4. The default (defaultLangOf): en if it is enabled, otherwise the first enabled language.
// The browser side is Paraglide's custom strategy "custom-htmlLang" (app/lib/http/locale-strategy.ts): it reads <html lang>, which the server rendered from this
// decision, so the two cannot disagree and no matching rule is written twice (a second copy of Paraglide's navigator matching would drift and break hydration).

// Chinese tags by script. Anything else is returned as it came (the caller compares it case-insensitively).
function normalizeChineseTag(tag: string): string {
  const lower = tag.toLowerCase();
  if (lower !== "zh" && !lower.startsWith("zh-")) return tag;
  return /^zh-(hant|tw|hk|mo)(-|$)/.test(lower) ? "zh-Hant" : "zh-Hans";
}

// Accept-Language in order of q (highest first; tags with the same q keep the written order). Chinese tags are mapped by script. "*" and q=0 are left out
// (q=0 means "not acceptable"). Missing, empty or oversized headers give an empty
// list. Malformed q values exclude that range; RFC qvalues have at most 3 decimals.
export function parseAcceptLanguage(header: string | null): Array<{ tag: string; q: number }> {
  if (!header || header.length > 8192) return [];
  const parsed: Array<{ tag: string; q: number; index: number }> = [];
  header.split(",").forEach((part, index) => {
    const [rawTag, ...params] = part.trim().split(";");
    const tag = rawTag.trim();
    if (!tag || tag === "*") return;
    let q = 1;
    for (const param of params) {
      const separator = param.indexOf("=");
      if (separator < 0 || param.slice(0, separator).trim().toLowerCase() !== "q") continue;
      const value = param.slice(separator + 1).trim();
      q = /^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0;
      if (q === 0) return;
    }
    if (!(q > 0) || q > 1) return;
    parsed.push({ tag: normalizeChineseTag(tag), q, index });
  });
  parsed.sort((a, b) => b.q - a.q || a.index - b.index);
  return parsed.map(({ tag, q }) => ({ tag, q }));
}

// The language of LANGS that a tag names: the whole tag, or the part before the first "-". Not looked up in the enabled languages.
function langOfTag(tag: string): Lang | null {
  const lower = tag.toLowerCase();
  const byLower = (t: string) => LANGS.find((l) => l.toLowerCase() === t) ?? null;
  return byLower(lower) ?? byLower(lower.split("-")[0]);
}

// The enabled language that Accept-Language prefers, or null.
export function pickEnabledLang(header: string | null, enabled: readonly Lang[]): Lang | null {
  for (const { tag } of parseAcceptLanguage(header)) {
    const lang = langOfTag(tag);
    if (lang && enabled.includes(lang)) return lang;
  }
  return null;
}

// The default of the "main language" field at signup: the language the browser prefers most (the first tag in order of q), if it is enabled;
// otherwise, and when there is no Accept-Language, "other". Later tags are not looked at: the main language is the language area that the member's reactions are
// counted in, so a guess must not fall back to a language the person ranked lower.
export function defaultMainLang(header: string | null, enabled: readonly Lang[]): Lang | "other" {
  const first = parseAcceptLanguage(header)[0];
  if (!first) return "other";
  const lang = langOfTag(first.tag);
  return lang && enabled.includes(lang) ? lang : "other";
}

// The value of the language cookie, if the request has one.
function cookieLocale(request: Request): string | null {
  const prefix = `${cookieName}=`;
  const found = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

// The source lets callers distinguish a page's language from a preference that can be remembered.
export function negotiateUiLocale(request: Request, enabled: readonly Lang[]): { locale: Lang; source: "cookie" | "query" | "accept-language" | "default" } {
  const cookie = cookieLocale(request);
  if (cookie !== null) {
    const lang = LANGS.find((l) => l === cookie);
    if (lang && enabled.includes(lang)) return { locale: lang, source: "cookie" };
  }
  // An address made by pressing a reading language on a page carries the mark: its ?lang= says what to read, not which language the screen speaks. When the mark names an enabled
  // language (rl=fr), the screen was in that language only because of an address, and stays in it.
  const params = new URL(request.url).searchParams;
  const mark = params.get(READING_ONLY_PARAM);
  const pinned = mark !== null ? LANGS.find((l) => l === mark) : undefined;
  if (pinned && enabled.includes(pinned)) return { locale: pinned, source: "query" };
  const query = mark !== null ? null : params.get("lang");
  const lang = LANGS.find((l) => l === query);
  if (lang && enabled.includes(lang)) return { locale: lang, source: "query" };
  const preferred = pickEnabledLang(request.headers.get("accept-language"), enabled);
  if (preferred) return { locale: preferred, source: "accept-language" };
  return { locale: defaultLangOf(enabled), source: "default" };
}

// Keep browser translation available unless the reader chose a screen language or the screen matches their first browser language.
// defaultMainLang already checks only the highest-ranked acceptable tag, ignoring the region and normalizing Chinese by script.
export function shouldSuppressBrowserTranslation(request: Request, enabled: readonly Lang[]): boolean {
  const { locale, source } = negotiateUiLocale(request, enabled);
  return source === "cookie" || defaultMainLang(request.headers.get("accept-language"), enabled) === locale;
}

// Adds only the header names that are missing to a Vary value.
function mergeVary(existing: string | null, add: string[]): string {
  const have = (existing ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (have.includes("*")) return "*";
  for (const name of add) if (!have.some((v) => v.toLowerCase() === name.toLowerCase())) have.push(name);
  return have.join(", ");
}

// The header for the interface language on HTML responses (not on APIs, data requests or Markdown twins): Vary: Accept-Language, Cookie. HTML changes with the browser language and the
// cookies (language choice, session), so a shared cache (a CDN) put in front never serves the page of another language. The server sets no language cookie (the server decides,
// the browser reads <html lang>).
export function withLocaleHeaders(response: unknown): unknown {
  if (!(response instanceof Response)) return response;
  if (!(response.headers.get("content-type") ?? "").startsWith("text/html")) return response;
  const vary = mergeVary(response.headers.get("vary"), ["Accept-Language", "Cookie"]);
  try {
    response.headers.set("Vary", vary);
    return response;
  } catch {
    // Headers that cannot be changed: copy into a new Response.
    const headers = new Headers(response.headers);
    headers.set("Vary", vary);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

// Registers the server half of Paraglide's custom strategy "custom-htmlLang" (strategy: custom-htmlLang, cookie, baseLocale in vite.config.ts). Paraglide's middleware asks it
// for the locale of each request, so the decision above is the only one. The browser half is in app/lib/http/locale-strategy.ts. Registered once, when this module is first imported.
defineCustomServerStrategy(HTML_LANG_STRATEGY, {
  getLocale: (request) => (request ? negotiateUiLocale(request, enabledLangs()).locale : undefined),
});
