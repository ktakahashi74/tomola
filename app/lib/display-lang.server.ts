import { resolveDisplayLang } from "~/lib/display";
import { enabledLangs, isEnabledLang } from "~/lib/enabled-langs.server";
import { type Lang } from "~/lib/languages";
import type { Profile } from "~/lib/profiles.server";
import { getLocale } from "~/paraglide/runtime.js";
import { negotiateUiLocale } from "~/lib/http/locale.server";
import { carriedLang, type ReadingLanguageChoice } from "~/lib/reading-lang";
import type { VillageReader } from "~/lib/village-translation-view";

// Screen translation language: page override > preference > current UI locale > original-reading languages > enabled default.
export function displayLangFor(request: Request, profile?: Profile | null): Lang {
  return resolveDisplayLang({ query: new URL(request.url).searchParams.get("lang"), profile: profile ?? { displayLang: null, readLangs: [] }, uiLocale: getLocale(), enabled: enabledLangs() });
}

// ?lang= (changes the display language for this page only); it is carried over to links to threads. null when it is absent, malformed or not an enabled language.
export function langQueryParam(request: Request): Lang | null {
  const query = new URL(request.url).searchParams.get("lang");
  return isEnabledLang(query) ? query : null;
}

// The ?lang= value for links to other pages that keep this page's reading language: see carriedLang. Use langQueryParam where the language itself is needed.
export function langCarry(request: Request): string | null {
  return carriedLang(langQueryParam(request), new URL(request.url).search);
}

// HTML loaders only: an enabled page override supersedes original-reading
// exceptions. Machine reads keep passing the profile's unchanged readLangs.
export function screenReadLangsFor(request: Request, profile?: Pick<Profile, "readLangs"> | null): readonly Lang[] {
  return langQueryParam(request) ? [] : profile?.readLangs ?? [];
}

// Who reads the name and description of a village: the same language and original-reading languages as for posts on this page.
export function villageReaderFor(request: Request, profile?: Profile | null): VillageReader {
  return { displayLang: displayLangFor(request, profile), readLangs: screenReadLangsFor(request, profile) };
}

export function readingLanguageChoice(request: Request, profile?: Profile | null): ReadingLanguageChoice {
  const enabled = enabledLangs();
  const usualUrl = new URL(request.url);
  usualUrl.searchParams.delete("lang");
  // The current UI locale can itself come from ?lang=. Resolve the same request
  // without that query to find the language restored by removing the override.
  const usualLocale = negotiateUiLocale(new Request(usualUrl, { headers: request.headers }), enabled, profile?.uiLocale ?? null).locale;
  const ui = negotiateUiLocale(request, enabled, profile?.uiLocale ?? null);
  return { current: displayLangFor(request, profile), enabled, ui: ui.source === "query" ? ui.locale : null,
    usual: resolveDisplayLang({ profile: profile ?? { displayLang: null, readLangs: [] }, uiLocale: usualLocale, enabled }) };
}

// Return destination after an operation. Accept only site-local paths; use "/" for external URLs, paths starting with "//", or those containing backslashes/newlines.
// "/.//evil.example", "/%2e//evil.example", and "/a/..//evil.example" normalize as URLs to "//evil.example", pointing to another site,
// so check the normalized path too, and return the normalized value.
// dropLang removes ?lang=, the page-specific display-language override.
export function safeLocalPath(raw: string | null | undefined, opts: { dropLang?: boolean } = {}): string {
  const value = raw ?? "";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\r\n]/.test(value)) return "/";
  try {
    const url = new URL(value, "http://tomola.invalid");
    if (url.origin !== "http://tomola.invalid" || url.pathname.startsWith("//") || url.pathname.includes("\\")) return "/";
    if (opts.dropLang) url.searchParams.delete("lang");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
