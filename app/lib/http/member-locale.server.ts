import { getSessionCookie } from "better-auth/cookies";
import { getSessionProfile } from "~/lib/auth/session.server";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { negotiateUiLocale, setRequestUiLocale } from "./locale.server";

export async function prepareUiLocale(request: Request): Promise<void> {
  if (!getSessionCookie(request) || negotiateUiLocale(request, enabledLangs()).source === "cookie") return;
  try {
    const profile = await getSessionProfile(request);
    setRequestUiLocale(request, profile?.uiLocale ?? null);
  } catch {
    setRequestUiLocale(request, null);
    console.warn("Member display language unavailable; using guest language negotiation.");
  }
}
