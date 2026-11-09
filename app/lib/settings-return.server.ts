import { safeSettingsReturnPath } from "./settings-return";
import { siteOrigin } from "./http/csrf.server";

export function settingsReturnFromRequest(request: Request): string | null {
  const url = new URL(request.url);
  const query = url.searchParams.get("returnTo");
  if (query !== null) return safeSettingsReturnPath(query);
  try {
    const referer = new URL(request.headers.get("Referer") ?? "");
    return referer.origin === siteOrigin() ? safeSettingsReturnPath(`${referer.pathname}${referer.search}${referer.hash}`) : null;
  } catch { return null; }
}
