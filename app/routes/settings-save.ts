import type { Route } from "./+types/settings-save";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { formString } from "~/lib/entry-form.server";
import { action as saveSettings } from "./settings";

// A resource response lets enhanced controls read JSON without navigating or
// replacing another field's unsaved choice. Ordinary forms still use /settings.
export async function action(args: Route.ActionArgs) {
  assertSameOrigin(args.request);
  const headers = { "Cache-Control": "private, no-store" };
  if (args.request.method !== "POST") return Response.json({ ok: false, error: "method" }, { status: 405, headers: { ...headers, Allow: "POST" } });
  const form = await args.request.clone().formData();
  const intent = formString(form, "intent");
  if (formString(form, "autosave") !== "1" || !(intent === "email-pref" || (intent === "preferences" && ["readLangs", "displayLang", "village", "colorScheme"].includes(formString(form, "field"))))) {
    return Response.json({ ok: false, error: "invalid_field" }, { status: 400, headers });
  }
  return saveSettings(args);
}
