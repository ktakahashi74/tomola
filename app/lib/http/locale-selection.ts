import { isLang, type Lang } from "~/lib/languages";
import { getLocale } from "~/paraglide/runtime.js";
import { confirmUnsavedNavigation } from "./unsaved-navigation";

// An explicit choice is the only browser operation that persists the interface language. Paraglide's initial getLocale() must never write this cookie.
export async function selectUiLocale(value: string, enabled: readonly Lang[], { clearReadingLanguage = false }: { clearReadingLanguage?: boolean } = {}): Promise<boolean> {
  if (!isLang(value) || !enabled.includes(value) || typeof document === "undefined" || typeof window === "undefined") return false;
  const url = clearReadingLanguage ? new URL(window.location.href) : null;
  const clearsOverride = url !== null && (url.searchParams.has("lang") || url.searchParams.has("rl"));
  if ((value !== getLocale() || clearsOverride) && !confirmUnsavedNavigation()) return false;
  try {
    const response = await fetch("/settings/locale", { method: "POST", body: new URLSearchParams({ locale: value }) });
    if (!response.ok) return false;
  } catch { return false; }
  // Header choices also clear the page's reading override, keeping other query values and its fragment. Saved reading preferences remain unchanged.
  if (url && clearsOverride) {
    url.searchParams.delete("lang");
    url.searchParams.delete("rl");
    window.location.replace(url.href);
    return true;
  }
  window.location.reload();
  return true;
}
