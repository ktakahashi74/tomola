import { redirect } from "react-router";
import { getAuth } from "./auth.server";
import { googleLoginConfig } from "./google-config.server";
import { safeLocalPath } from "~/lib/display-lang.server";
import { googleInvitationContext } from "./google-policy.server";

// Native navigation applies no-referrer to the provider redirect, including
// when the page that started it contains an invitation token.
export async function startGoogleSignIn(request: Request, next = "/", invitationId: string | null = null) {
  if (!googleLoginConfig()) throw new Response("Not found", { status: 404 });
  const auth = await getAuth();
  const { response, headers } = await googleInvitationContext.run(invitationId, () => auth.api.signInSocial({
    request, headers: request.headers, returnHeaders: true, asResponse: false,
    body: { provider: "google", callbackURL: safeLocalPath(next) },
  }));
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store");
  return redirect(response.url!, { headers });
}
