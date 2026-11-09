import { isLang, type Lang } from "~/lib/languages";
import { cookieMaxAge, cookieName, getLocale, setLocale } from "~/paraglide/runtime.js";
import { confirmUnsavedNavigation } from "./unsaved-navigation";

// An explicit choice is the only browser operation that persists the interface language. Paraglide's initial getLocale() must never write this cookie.
export function selectUiLocale(value: string, enabled: readonly Lang[], { clearReadingLanguage = false }: { clearReadingLanguage?: boolean } = {}): boolean {
  if (!isLang(value) || !enabled.includes(value) || typeof document === "undefined" || typeof window === "undefined") return false;
  const url = clearReadingLanguage ? new URL(window.location.href) : null;
  const clearsOverride = url !== null && (url.searchParams.has("lang") || url.searchParams.has("rl"));
  if ((value !== getLocale() || clearsOverride) && !confirmUnsavedNavigation()) return false;
  document.cookie = `${cookieName}=${value}; Path=/; Max-Age=${cookieMaxAge}; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
  // Header choices also clear the page's reading override, keeping other query values and its fragment. Saved reading preferences remain unchanged.
  if (url && clearsOverride) {
    url.searchParams.delete("lang");
    url.searchParams.delete("rl");
    window.location.replace(url.href);
    return true;
  }
  setLocale(value);
  return true;
}
