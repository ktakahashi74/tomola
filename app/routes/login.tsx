import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { Field, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { LoginCodeForm } from "~/components/login-code-form";
import { IosStandaloneLoginNote } from "~/components/ios-standalone-login-note";
import { LoginRequestNotice, LOGIN_REQUEST_NOTICE_ID, loginRequestNoticeShown } from "~/components/login-request-notice";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { useEffect, useRef } from "react";
import { Form, Link, redirect, useNavigate, useNavigation, useRevalidator } from "react-router";
import { rememberedLoginEmail, prepareLoginCode } from "~/lib/auth/login-code-cookie.server";
import { pendingLoginScreen, restartLoginCode } from "~/lib/auth/login-code-state.server";
import { submitLoginCode } from "~/lib/auth/login-code-action.server";
import { loginCodeSent } from "~/lib/auth/login-code-response.server";
import { requestLoginLink } from "~/lib/auth/login-request.server";
import type { Route } from "./+types/login";
import { GuestHeader } from "~/components/guest-header";
import { PasskeyLogin } from "~/components/passkey";
import { getAuth, isOriginRejected, isRejectedInput } from "~/lib/auth/auth.server";
import { getSessionUser } from "~/lib/auth/session.server";
import { getDb } from "~/lib/db/client.server";
import { getProfile } from "~/lib/profiles.server";
import { passkey } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { publicReading } from "~/lib/public-reading.server";
import { parseEmail } from "~/lib/email";
import { enforceIpLimit } from "~/lib/http/limits.server";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import { hasLogoutNotice } from "~/lib/auth/logout-notice.server";
import { safeLocalPath } from "~/lib/display-lang.server";

// Document responses must retain the code error's privacy headers too.
export function headers({ actionHeaders }: Route.HeadersArgs) {
  return actionHeaders;
}

// Login/authentication POSTs: 300 per IP per 15 minutes (AUTH_PAGE_IP_LIMIT; 429 on excess). Do not count GET page views; they write no DB rows.
// Magic-link sending has separate per-email and per-IP limits.
// What a re-verification is for, told from the page it returns to (the screens that ask for it all send the member back to themselves).
function reauthPurpose(next: string): "tokens" | "mcp" | "passkey" {
  const path = next.split(/[?#]/)[0];
  if (path === "/settings/tokens") return "tokens";
  if (path.startsWith("/mcp/")) return "mcp";
  return "passkey";
}

async function loaderImplementation({ request }: Route.LoaderArgs) {
  const next = safeLocalPath(new URL(request.url).searchParams.get("next"));
  const reauth = new URL(request.url).searchParams.get("reauth") === "1";
  const member = await getSessionUser(request);
  const db = await getDb();
  const codePending = await pendingLoginScreen(db, request);
  if (!reauth && member && (!codePending || parseEmail(codePending.email) === parseEmail(member.email))) throw redirect(next);
  // A re-verification is for a member who is logged in: the screen names them and what it is for, and puts the passkey first when they have one.
  const verifying = reauth && member && (!codePending || parseEmail(codePending.email) === parseEmail(member.email)) ? {
    email: member.email,
    handle: (await getProfile(db, member.id))?.handle ?? null,
    purpose: reauthPurpose(next),
    // During an AI connection the check is for the account that is logged in; someone who wants another account can leave and return to the same request (the logout screen allows only /mcp/login).
    ...(next.startsWith("/mcp/consent?") ? { switchNext: `/mcp/login?${next.slice("/mcp/consent?".length)}` } : {}),
    hasPasskey: (await db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, member.id)).limit(1)).length > 0,
  } : null;
  // The extra fields are present only when they apply, so an ordinary login screen carries nothing more than before.
  return {
    next, reauth, codePending, loggedOut: hasLogoutNotice(request),
    ...(verifying ? { verifying } : {}),
    ...(publicReading() ? { publicReading: true } : {}),
    ...(/^\/u\//.test(next) ? { membersOnlyTarget: true } : {}),
    ...(new URL(request.url).searchParams.get("account-deleted") === "1" ? { accountDeleted: true } : {}),
  };
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const remembered = intent === "login-resend" || intent === "login-code" || intent === "login-restart";
  const email = remembered ? rememberedLoginEmail(request)?.email : parseEmail(String(form.get("email") ?? ""));
  const member = await getSessionUser(request);
  const reauth = form.get("reauth") === "1" || new URL(request.url).searchParams.get("reauth") === "1";
  if (!reauth && member && (!email || email === parseEmail(member.email))) {
    throw redirect(safeLocalPath(String(form.get("next") ?? "")));
  }
  await enforceIpLimit(await getDb(), request, "auth-page");
  if (intent === "login-restart") return restartLoginCode(request);
  if (intent === "login-code") return submitLoginCode(request, form);
  const resent = intent === "login-resend";
  const next = safeLocalPath(String(form.get("next") ?? ""));
  if (!email) return { status: "invalid" as const };
  const auth = await getAuth();
  const pending = prepareLoginCode(request, email, resent);
  const browser = pending.browser;
  let result: Awaited<ReturnType<typeof requestLoginLink>>;
  try {
    // Passing request enables origin validation. asResponse: false makes rejection an exception instead of a Response.
    result = await requestLoginLink({
      db: await getDb(), request, email,
      send: () => auth.api.signInMagicLink({
        // metadata.locale writes the email in this screen's language (app/lib/mail/magic-link.server.ts).
        body: { email, metadata: { locale: getLocale(), browserNonce: browser.nonce, codeId: pending.id, next } },
        headers: request.headers,
        request,
        asResponse: false,
      }),
    });
  } catch (error) {
    // 403 origin rejection indicates a mismatch between the opened address and configuration, rather than invalid input.
    if (isOriginRejected(error)) return { status: "origin_mismatch" as const };
    if (isRejectedInput(error)) return { status: "invalid" as const };
    throw error;
  }
  // Not reachable today (no signed-in address is passed here); kept so that a later change cannot fall through to "sent".
  if (result === "already") throw redirect(next);
  // Nothing was sent, so no cookie changes: an earlier code, if any, stays as it was. The address stays in the field.
  if (result === "unregistered" || result === "later") return { status: result, email };
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", browser.cookie); headers.append("Set-Cookie", pending.cookie);
  headers.append("Set-Cookie", pending.emailCookie);
  return loginCodeSent(request, { status: "sent" as const }, headers);
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData && "verifying" in loaderData ? m.reauth_title() : loaderData?.codePending ? m.login_code_heading() : m.login_title() }];
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const previousAction = useRef(actionData);
  // A loader revalidation clears route action data. Keep its result on return,
  // but let a new submission or navigation clear the previous screen's error.
  useEffect(() => {
    if (navigation.state !== "idle") previousAction.current = undefined;
    else if (actionData !== undefined) previousAction.current = actionData;
  }, [actionData, navigation.state]);
  const screenAction = actionData ?? (navigation.state === "idle" ? previousAction.current : undefined);
  const revalidator = useRevalidator();
  const refreshing = useRef(false);
  const lastRefresh = useRef(-Infinity);
  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (document.visibilityState !== "visible" || refreshing.current || revalidator.state !== "idle") return;
      // Focus and visibility events can arrive together; keep one request per return.
      const now = performance.now();
      if (now - lastRefresh.current < 1000) {
        retry ??= setTimeout(() => { retry = undefined; refresh(); }, 1000 - (now - lastRefresh.current));
        return;
      }
      lastRefresh.current = now;
      refreshing.current = true;
      void revalidator.revalidate().finally(() => { refreshing.current = false; });
    };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) refresh(); };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", restored);
    return () => {
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", restored);
    };
  }, [revalidator]);
  const verifying = "verifying" in loaderData ? loaderData.verifying : null;
  const heading = verifying ? m.reauth_title() : loaderData.codePending ? m.login_code_heading() : m.login_title();
  return (
    <>
    {verifying ? <header className="mb-6 border-b pb-3"><Link to="/" className="logo"><span aria-hidden /><span>{m.site_name()}</span></Link></header> : <GuestHeader />}
    <main className="space-y-4">
      {loaderData.accountDeleted && <p role="status">{m.account_delete_complete()}</p>}
      {loaderData.loggedOut && <p role="status">{m.logged_out()}</p>}
      {!verifying && ("membersOnlyTarget" in loaderData) && !loaderData.codePending && <MembersOnlyNotice />}
      <h1 className="text-2xl font-bold">{heading}</h1>
      {verifying && <p>{(verifying.purpose === "tokens" ? m.reauth_for_tokens : verifying.purpose === "mcp" ? m.reauth_for_mcp : m.reauth_for_passkey)({ who: verifying.handle ? `@${verifying.handle}` : verifying.email })}</p>}
      {!verifying && !loaderData.codePending && <p>{m.entry_intro()}</p>}
      <IosStandaloneLoginNote />
      {!loaderData.codePending && screenAction?.status === "code_invalid" && <p role="alert" className="text-destructive">{m.login_code_invalid()}</p>}
      {loaderData.codePending ? <>
        <LoginRequestNotice status={screenAction?.status} />
        <p className="break-words">{m.login_sent({ email: loaderData.codePending.email })}</p>
        <LoginCodeForm key={loaderData.codePending.revision} state={loaderData.codePending} resentNotice={screenAction?.status !== "later"} invalid={screenAction?.status === "code_invalid"} limited={screenAction && "limited" in screenAction ? screenAction.limited : undefined} hiddenFields={{ next: loaderData.next, ...(loaderData.reauth ? { reauth: "1" } : {}) }} />
        {screenAction?.status === "origin_mismatch" && <p role="alert" className="text-destructive">{m.auth_origin_mismatch()}</p>}
      </> : <>
      {verifying?.hasPasskey && <PasskeyLogin next={loaderData.next} or="after" />}
      <Form method="post" className="space-y-2">
          <input type="hidden" name="next" value={loaderData.next} />
          {loaderData.reauth && <input type="hidden" name="reauth" value="1" />}
          <Field className="min-w-0 w-auto"><FieldLabel className="block">
            {m.login_email()}
            <Input aria-invalid={screenAction?.status === "invalid" || screenAction?.status === "unregistered" || undefined} aria-describedby={screenAction?.status === "invalid" ? "login-email-error" : loginRequestNoticeShown(screenAction?.status) ? LOGIN_REQUEST_NOTICE_ID : undefined} name="email" type="email" autoComplete={verifying ? "email" : "username webauthn"} required {...(verifying ? { readOnly: true, defaultValue: verifying.email } : screenAction && "email" in screenAction ? { defaultValue: screenAction.email } : {})} className="block w-full" />
          </FieldLabel></Field>
          {screenAction?.status === "invalid" && <p id="login-email-error" role="alert" className="text-destructive">{m.login_invalid_email()}</p>}
          {screenAction?.status === "origin_mismatch" && <p role="alert" className="text-destructive">{m.auth_origin_mismatch()}</p>}
          <LoginRequestNotice status={screenAction?.status} />
          <Button type="submit">
            {verifying ? m.reauth_submit() : m.login_submit()}
          </Button>
        </Form>
      {!verifying && <>
        <PasskeyLogin next={loaderData.next} or="before" conditional />
        <p className="ui-help text-muted-foreground"><span className="block">{m.login_invitation_short()}</span>{("publicReading" in loaderData) && <span className="block">{m.login_reading_note()}</span>}</p>
      </>}
      </>}
      {verifying?.switchNext && <Form method="post" action="/logout" className="ui-help text-muted-foreground"><input type="hidden" name="next" value={verifying.switchNext} /><p>{m.mcp_switch_account({ who: verifying.handle ? `@${verifying.handle}` : verifying.email })} <Button type="submit" variant="link" className="h-auto p-0 align-baseline">{m.mcp_switch_account_button()}</Button></p></Form>}
      {/* Leaving without confirming: back to the screen that asked. */}
      {loaderData.reauth && <p><Link to={loaderData.next} className="underline ui-help">{m.reauth_cancel()}</Link></p>}
    </main>
    </>
  );
}

// Said when a link to a member's page sent a visitor here: the page is not broken, it is for members.
function MembersOnlyNotice() {
  const navigate = useNavigate();
  return <p role="note" className="ui-help text-muted-foreground">
    {m.login_members_only()}{" "}
    <Link to="/" className="underline" onClick={event => { if (window.history.length > 1) { event.preventDefault(); void navigate(-1); } }}>{m.login_members_only_back()}</Link>
  </p>;
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
