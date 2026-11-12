import { data } from "react-router";
import { getSessionProfile } from "~/lib/auth/session.server";
import { getDb } from "~/lib/db/client.server";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { uiLocaleCookie } from "~/lib/http/locale.server";
import { isLang } from "~/lib/languages";
import { setUiLocale } from "~/lib/profiles.server";
import type { Route } from "./+types/settings-locale";

// Guests choose a cookie; members also save the choice for their other devices.
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const locale = (await request.formData()).get("locale");
  if (!isLang(locale) || !enabledLangs().includes(locale)) throw data("Bad request", { status: 400 });
  const profile = await getSessionProfile(request);
  if (profile) await setUiLocale(await getDb(), profile.userId, locale);
  return new Response(null, { status: 204, headers: { "Set-Cookie": uiLocaleCookie(request, locale), "Cache-Control": "no-store" } });
}
