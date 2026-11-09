import { getSessionUser } from "~/lib/auth/session.server";
import { getDb } from "~/lib/db/client.server";
import { webPushEnabled } from "~/lib/push/config.server";
import { currentPushId, stopPush } from "~/lib/push/subscriptions.server";
import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { getAuth } from "~/lib/auth/auth.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { logoutNoticeCookie } from "~/lib/auth/logout-notice.server";
import { clearLoginCodeCookies } from "~/lib/auth/login-code-cookie.server";
import { publicReading } from "~/lib/public-reading.server";
import { safeLocalPath } from "~/lib/display-lang.server";

async function loaderImplementation() {
  return redirect("/");
}

export async function action({ request }: Route.ActionArgs) {
  // Prevent cross-site POSTs from logging the member out (CSRF); check before deleting cookies.
  assertSameOrigin(request);
  // The consent screen of an AI connection offers "use another account": log out and return to the same signed request (only to /mcp/login, nowhere else).
  const form = await request.formData().catch(() => new FormData());
  if (webPushEnabled()) {
    const user = await getSessionUser(request);
    if (user) {
      const db = await getDb();
      const id = await currentPushId(db, user.id, { id: form.get("push-id"), secret: form.get("push-secret") });
      if (id) await stopPush(db, user.id, id, "logout");
    }
  }
  const next = String(form.get("next") ?? "");
  const target = next.length <= 16_500 ? safeLocalPath(next) : "/";
  const returnToConnection = target.startsWith("/mcp/login?");
  const auth = await getAuth();
  const res = await auth.api.signOut({ headers: request.headers, request, asResponse: true });
  const headers = new Headers(res.headers);
  clearLoginCodeCookies(request, headers);
  if (returnToConnection) return redirect(target, { headers });
  headers.append("Set-Cookie", logoutNoticeCookie(request, true));
  // Where reading needs no login, leaving a session leads back to the posts, with the notice on top; otherwise to the login screen.
  return redirect(publicReading() ? "/" : "/login", { headers });
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
