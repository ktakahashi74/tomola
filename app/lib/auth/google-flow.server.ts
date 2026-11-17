import { redirect } from "react-router";
import { getAuth } from "./auth.server";
import { googleLoginConfig } from "./google-config.server";
import { safeLocalPath } from "~/lib/display-lang.server";

// Native navigation applies no-referrer to the provider redirect, including
// when the page that started it contains an invitation token.
export async function startGoogleSignIn(request: Request, next = "/") {
  if (!googleLoginConfig()) throw new Response("Not found", { status: 404 });
  const path = new URL(request.url).pathname;
  const { response, headers } = await (await getAuth()).api.signInSocial({
    request, headers: request.headers, returnHeaders: true, asResponse: false,
    body: { provider: "google", callbackURL: safeLocalPath(next), errorCallbackURL: path.startsWith("/invite/") ? path : "/login?google=1" },
  });
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store");
  return redirect(response.url!, { headers });
}
