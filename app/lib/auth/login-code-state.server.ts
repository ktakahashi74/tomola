import { redirect } from "react-router";
import type { Db } from "~/lib/db/client.server";
import { normalizeEmail } from "~/lib/invitations.server";
import { MAGIC_LINK_EMAIL_LIMIT } from "~/lib/rate-limit.server";
import { clearLoginCodeCookies, pendingLoginCode, rememberedLoginEmail } from "./login-code-cookie.server";
import { loginCodeState } from "./login-code.server";
import { LOGIN_HEADERS } from "./complete-magic-link.server";
import { clientAddress } from "~/lib/http/client-ip.server";

// Page state is read-only and independent of whether the address is a member.
export async function pendingLoginScreen(db: Db, request: Request, expectedEmail?: string) {
  const pending = pendingLoginCode(request);
  const remembered = rememberedLoginEmail(request);
  if (!pending || !remembered || (expectedEmail !== undefined && normalizeEmail(expectedEmail) !== normalizeEmail(remembered.email))) return null;
  return {
    ...remembered, revision: pending.id, ...await loginCodeState(db, pending.id, clientAddress(request)),
    mailMinutes: MAGIC_LINK_EMAIL_LIMIT.windowSeconds / 60, mailCount: MAGIC_LINK_EMAIL_LIMIT.limit,
  };
}
export type PendingLoginScreen = NonNullable<Awaited<ReturnType<typeof pendingLoginScreen>>>;

// Call only after the route's origin and auth-page IP checks. Existing links survive.
export function restartLoginCode(request: Request) {
  const headers = new Headers(LOGIN_HEADERS);
  clearLoginCodeCookies(request, headers);
  const url = new URL(request.url);
  // Single-fetch actions carry the transport URL; redirect to the document.
  if (url.pathname.endsWith(".data")) {
    url.pathname = url.pathname.replace(/\.data$/, "");
    url.searchParams.delete("_routes");
  }
  return redirect(`${url.pathname}${url.search}`, { status: 303, headers });
}
