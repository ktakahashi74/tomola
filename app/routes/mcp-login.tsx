import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { Field, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { LoginCodeForm } from "~/components/login-code-form";
import { data, Form, redirect } from "react-router";
import { getAuth } from "~/lib/auth/auth.server";
import { rememberedLoginEmail, prepareLoginCode } from "~/lib/auth/login-code-cookie.server";
import { pendingLoginScreen, restartLoginCode } from "~/lib/auth/login-code-state.server";
import { submitLoginCode } from "~/lib/auth/login-code-action.server";
import { loginCodeSent } from "~/lib/auth/login-code-response.server";
import { requestLoginLink } from "~/lib/auth/login-request.server";
import { LoginRequestNotice, LOGIN_REQUEST_NOTICE_ID, loginRequestNoticeShown } from "~/components/login-request-notice";
import { getSessionUser } from "~/lib/auth/session.server";
import { getDb } from "~/lib/db/client.server";
import { parseEmail } from "~/lib/email";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceIpLimit } from "~/lib/http/limits.server";
import { getActiveMember } from "~/lib/members.server";
import { loadConsentRequest, authorizationRedirect, consentRequestValid } from "~/lib/mcp/consent.server";
import { AuthorizationExpired } from "~/components/mcp-expired";
import { getCredentialSessionFresh } from "~/lib/auth/session.server";
import { GuestHeader } from "~/components/guest-header";
import { PasskeyLogin } from "~/components/passkey";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import type { Route } from "./+types/mcp-login";
export function meta() { return [{ title: m.mcp_connect_title() }]; }

export function headers({ actionHeaders }: Route.HeadersArgs) {
  const headers = new Headers(actionHeaders);
  headers.set("Cache-Control", "private, no-store");
  return headers;
}
async function loaderImplementation({ request }: Route.LoaderArgs) {
  const auth = await getAuth();
  const db = await getDb();
  const query = new URL(request.url).searchParams.toString();
  const member = await getSessionUser(request);
  // A request that no longer verifies is the usual end of a slow connection, not a bad one: say so, and say that the login stands.
  if (!(await consentRequestValid(auth, query))) return { expired: true as const, signedIn: Boolean(member) };
  const consent = await loadConsentRequest(db, auth, query);
  if (member) {
    if (!(await getActiveMember(db, member.id))) throw redirect("/onboarding");
    // A login older than 24 hours never lets the provider issue a code from here, even when a consent exists: the consent screen asks for the check first.
    if (!(await getCredentialSessionFresh(request))) throw redirect(`/mcp/consent?${consent.query}`);
    const result = await auth.api.oauth2Continue({ request, headers: request.headers, body: { postLogin: true, oauth_query: consent.query } });
    const next = await authorizationRedirect(result);
    if (!next || new URL(next, request.url).searchParams.has("error")) throw data("Authorization continuation failed", { status: 400 });
    throw redirect(next);
  }
  return { ...consent, codePending: await pendingLoginScreen(db, request) };
}
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const auth = await getAuth();
  const db = await getDb();
  await enforceIpLimit(db, request, "auth-page");
  const form = await request.formData();
  if (form.get("intent") === "login-restart") return restartLoginCode(request);
  if (form.get("intent") === "login-code") return submitLoginCode(request, form);
  const signed = String(form.get("oauth_query") ?? "");
  if (!(await consentRequestValid(auth, signed))) return { status: "expired" as const, signedIn: Boolean(await getSessionUser(request)) };
  const consent = await loadConsentRequest(db, auth, signed);
  const resent = form.get("intent") === "login-resend";
  const email = resent ? rememberedLoginEmail(request)?.email : parseEmail(String(form.get("email") ?? ""));
  if (!email) return { status: "invalid" as const };
  const pending = prepareLoginCode(request, email, resent);
  const browser = pending.browser;
  const member = await getSessionUser(request);
  const result = await requestLoginLink({
    db, request, email, signedInEmail: member?.email,
    send: () => auth.api.signInMagicLink({ request, headers: request.headers, body: { email, metadata: { locale: getLocale(), next: `/mcp/login?${consent.query}`, browserNonce: browser.nonce, codeId: pending.id } } }),
  });
  // Already logged in with this address: no mail. The screen's loader carries on to the consent screen, which asks for a recent login when it needs one.
  if (result === "already") throw redirect(`/mcp/login?${consent.query}`, { status: 303, headers: { "Cache-Control": "no-store" } });
  // Nothing was sent, so no cookie changes. The address stays in the field.
  if (result === "unregistered" || result === "later") return { status: result, email };
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", browser.cookie); headers.append("Set-Cookie", pending.cookie);
  headers.append("Set-Cookie", pending.emailCookie);
  return loginCodeSent(request, { status: "sent" as const }, headers);
}
export default function McpLogin({ loaderData, actionData }: Route.ComponentProps) {
  if ("expired" in loaderData) return <AuthorizationExpired signedIn={loaderData.signedIn === true} />;
  if (actionData?.status === "expired") return <AuthorizationExpired signedIn={actionData.signedIn === true} />;
  return <main className="space-y-4"><GuestHeader /><h1 className="text-2xl font-bold">{m.mcp_connect_title()}</h1><p>{m.mcp_login_client({ name: loaderData.name })}</p>
    <p className="ui-help text-muted-foreground">{m.mcp_wait_note()}</p>
    <details className="ui-help"><summary className="cursor-pointer ui-meta">{m.mcp_details_summary()}</summary><div className="mt-2 space-y-2"><p>{m.mcp_client_warning()}</p><code className="break-all">{loaderData.clientId}</code></div></details>
    <PasskeyLogin next={`/mcp/login?${loaderData.query}`} />
    {loaderData.codePending ? <><h2 className="text-xl font-semibold">{m.login_code_heading()}</h2><p className="break-words">{m.login_sent({ email: loaderData.codePending.email })}</p><LoginRequestNotice status={actionData?.status} mcp /><LoginCodeForm key={loaderData.codePending.revision} state={loaderData.codePending} resentNotice={actionData?.status !== "later"} invalid={actionData?.status === "code_invalid"} limited={actionData && "limited" in actionData ? actionData.limited : undefined} hiddenFields={{ oauth_query: loaderData.query }} /></> : <><Form method="post">
      <input type="hidden" name="oauth_query" value={loaderData.query} /><Field className="min-w-0 w-auto"><FieldLabel >{m.login_email()}<Input type="email" name="email" required aria-invalid={actionData?.status === "unregistered" || undefined} aria-describedby={loginRequestNoticeShown(actionData?.status) ? LOGIN_REQUEST_NOTICE_ID : undefined} {...(actionData && "email" in actionData ? { defaultValue: actionData.email } : {})} /></FieldLabel></Field>
      {actionData?.status === "invalid" && <p>{m.login_invalid_email()}</p>}<LoginRequestNotice status={actionData?.status} mcp /><Button type="submit">{m.login_submit()}</Button>
    </Form></>}</main>;
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
