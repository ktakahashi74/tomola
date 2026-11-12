import { getSessionCookie } from "better-auth/cookies";
import { getSessionProfile } from "~/lib/auth/session.server";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { negotiateUiLocale, setRequestUiLocale } from "./locale.server";

export async function prepareUiLocale(request: Request): Promise<void> {
  if (!getSessionCookie(request) || negotiateUiLocale(request, enabledLangs()).source === "cookie") return;
  const profile = await getSessionProfile(request);
  setRequestUiLocale(request, profile?.uiLocale ?? null);
}
