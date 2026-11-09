import { useOperatorSettings } from "~/lib/operator-context";
import { participationCopy } from "~/lib/operator-settings";
import { publicReading } from "~/lib/public-reading.server";
import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { Button } from "~/components/ui/button";
import { LoginCodeForm } from "~/components/login-code-form";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { Form, Link, useLocation, useRevalidator, type MiddlewareFunction } from "react-router";
import { useEffect, useRef } from "react";
import { invitationCookie, clearInvitationCookie } from "~/lib/auth/invitation-cookie.server";
import { invitationVillage } from "~/lib/signup-village.server";
import { prepareLoginCode } from "~/lib/auth/login-code-cookie.server";
import { pendingLoginScreen, restartLoginCode } from "~/lib/auth/login-code-state.server";
import { submitLoginCode } from "~/lib/auth/login-code-action.server";
import { loginCodeSent } from "~/lib/auth/login-code-response.server";
import type { Route } from "./+types/invite";
import { GuestHeader } from "~/components/guest-header";
import { EntrySteps } from "~/components/entry-steps";
import { getAuth, isOriginRejected, isRejectedInput } from "~/lib/auth/auth.server";
import { getDb } from "~/lib/db/client.server";
import { enforceIpLimit } from "~/lib/http/limits.server";
import { findValidInvitationByToken, invitationSenderHandle } from "~/lib/invitations.server";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import { readInvitationNote } from "~/lib/invitation-note.server";
import { languageLabel } from "~/lib/language-label";
import { trialParticipationRequired } from "~/lib/notice-sources.server";

// Invitation URLs contain secret tokens. Send only the origin as Referer so
// native same-origin form POSTs work without exposing the invitation token.
export function headers() {
  return { "Cache-Control": "no-store", "Referrer-Policy": "strict-origin", "X-Robots-Tag": "noindex" };
}

export const middleware: MiddlewareFunction<Response>[] = [async ({ request, params }, next) => {
  const response = await next();
  if (request.method !== "GET" || !response.ok || !params.token) return response;
  const invitation = await findValidInvitationByToken(await getDb(), params.token);
  if (invitation) response.headers.append("Set-Cookie", invitationCookie(request, invitation.id));
  else clearInvitationCookie(request, response.headers);
  return response;
}];

// Invitation POSTs: 300 per IP per 15 minutes (AUTH_PAGE_IP_LIMIT; 429 on excess). Do not count GET page views.
async function loaderImplementation({ params, request }: Route.LoaderArgs) {
  const db = await getDb();
  const invitation = await findValidInvitationByToken(db, params.token);
  const from = invitation ? await invitationSenderHandle(db, invitation) : null;
  const note = invitation && from ? await readInvitationNote(db, invitation.id, getLocale(), new URL(request.url).searchParams.get("original") === "1") : null;
  return {
    publicReading: publicReading(),
    trialRequired: trialParticipationRequired(),
    email: invitation?.email ?? null,
    from,
    note: note ? { ...note,
      translationLabel: note.translated ? m.label_from_lang_machine({ lang: languageLabel(note.from) }) : null,
      unavailableLabel: note.unavailable ? m.label_no_translation() : null,
    } : null,
    village: invitation ? await invitationVillage(db, invitation) : null,
    codePending: invitation ? await pendingLoginScreen(db, request, invitation.email) : null,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const db = await getDb();
  await enforceIpLimit(db, request, "auth-page");
  const form = await request.formData();
  if (form.get("intent") === "login-restart") return restartLoginCode(request);
  if (form.get("intent") === "login-code") return submitLoginCode(request, form);
  const invitation = await findValidInvitationByToken(db, params.token);
  if (!invitation) return { sentTo: null, error: "invalid" as const };
  const auth = await getAuth();
  const pending = prepareLoginCode(request, invitation.email, form.get("intent") === "login-resend");
  const browser = pending.browser;
  try {
    // Passing request enables origin validation. asResponse: false makes rejection an exception instead of a Response.
    await auth.api.signInMagicLink({
      body: { email: invitation.email, metadata: { locale: getLocale(), browserNonce: browser.nonce, codeId: pending.id, invitation: true } },
      headers: request.headers,
      request,
      asResponse: false,
    });
  } catch (error) {
    // 403 origin rejection means the opened address differs from configuration. Other rejections indicate invalid input.
    if (isOriginRejected(error)) return { sentTo: null, error: "origin_mismatch" as const };
    if (isRejectedInput(error)) return { sentTo: null, error: "invalid" as const };
    throw error;
  }
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", browser.cookie); headers.append("Set-Cookie", pending.cookie);
  headers.append("Set-Cookie", pending.emailCookie);
  headers.append("Set-Cookie", invitationCookie(request, invitation.id));
  return loginCodeSent(request, { sentTo: invitation.email, error: null }, headers);
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: !loaderData?.email ? m.invite_unusable_title() : loaderData.codePending ? m.login_code_heading() : m.invite_title() }];
}

export default function Invite({ loaderData, actionData }: Route.ComponentProps) {
  const policy = useOperatorSettings().participation;
  const revalidator = useRevalidator();
  const location = useLocation();
  const pending = loaderData.note?.pending;
  const polling = useRef<{ key: string; deadline: number } | null>(null);
  useEffect(() => {
    if (!pending) { polling.current = null; return; }
    const key = `${location.pathname}${location.search}`;
    if (polling.current?.key !== key) polling.current = { key, deadline: Date.now() + 45_000 };
    const deadline = polling.current.deadline;
    // Revalidation replaces the revalidator object. Keep the deadline across
    // those renders so a stalled worker cannot keep this tab polling forever.
    const timer = setInterval(() => {
      if (Date.now() >= deadline) { clearInterval(timer); return; }
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 2000);
    return () => clearInterval(timer);
  }, [pending, revalidator, location.pathname, location.search]);
  const noteParams = new URLSearchParams(location.search);
  if (loaderData.note?.translated) noteParams.set("original", "1"); else noteParams.delete("original");
  const noteSearch = noteParams.toString();
  const codeError = actionData && "status" in actionData && actionData.status === "code_invalid";
  const heading = !loaderData.email ? m.invite_unusable_title() : loaderData.codePending ? m.login_code_heading() : loaderData.from ? m.invite_title_from({ handle: loaderData.from }) : m.invite_title();
  return (
    <>
    <GuestHeader />
    <main className="space-y-4">
      {loaderData.email && <EntrySteps current={loaderData.codePending ? 2 : 1} />}
      <h1 className="text-2xl font-bold">{heading}</h1>
      {loaderData.note && <div className="space-y-1" data-invitation-note>
        {loaderData.codePending && loaderData.from && <p className="ui-meta text-muted-foreground">{m.invite_title_from({ handle: loaderData.from })}</p>}
        <p className="break-words" dir="auto" lang={loaderData.note.lang}>{loaderData.note.text}</p>
        {loaderData.note.available && <p className="ui-meta text-muted-foreground">
          {loaderData.note.translated ? <span>{loaderData.note.translationLabel}</span> : m.reading_lang_original({ name: languageLabel(loaderData.note.from) })}{" · "}
          <Link to={`${location.pathname}${noteSearch ? `?${noteSearch}` : ""}`} rel="nofollow" preventScrollReset className="underline">{loaderData.note.translated ? m.show_original() : m.show_translation()}</Link>
        </p>}
        {loaderData.note.unavailable && <p className="ui-meta text-muted-foreground">{loaderData.note.unavailableLabel}</p>}
      </div>}
      {loaderData.village && <p className="break-words">{m.invite_village({ village: loaderData.village.name })}</p>}
      {!loaderData.email ? <><p>{m.invite_invalid()}</p><Link to="/login" className="underline">{m.invite_invalid_login()}</Link></> : loaderData.codePending ? <>
        <p className="break-words">{m.invite_sent({ email: loaderData.codePending.email })}</p>
        <LoginCodeForm key={loaderData.codePending.revision} state={loaderData.codePending} invalid={!!codeError} limited={actionData && "limited" in actionData ? actionData.limited : undefined} invitation />
        {actionData && "error" in actionData && actionData.error === "origin_mismatch" && <p className="text-destructive">{m.auth_origin_mismatch()}</p>}
      </> : <>
      <p><span className="block">{m.entry_intro()}</span><span className="block">{m.invite_about()}</span></p>
      {loaderData.publicReading && <p className="ui-help text-muted-foreground">{m.public_reading_onboarding()}</p>}
      <Form method="post" className="space-y-2">
          <p>{m.invite_for({ email: loaderData.email })}</p>
          <p className="ui-help text-muted-foreground">{m.invite_next()}</p>
          {actionData && "error" in actionData && actionData.error === "invalid" && <p className="text-destructive">{m.invite_invalid()}</p>}
          {actionData && "error" in actionData && actionData.error === "origin_mismatch" && <p className="text-destructive">{m.auth_origin_mismatch()}</p>}
          {loaderData.trialRequired && <p className="ui-help text-muted-foreground">{participationCopy(policy, getLocale()).invitationRestriction}</p>}
          <Button type="submit">
            {m.invite_submit()}
          </Button>
        </Form>
      {/* The reason the site was made is already linked from the row above and the foot of the page. */}
      {loaderData.publicReading && <p className="ui-help text-muted-foreground">{m.invite_read_first()}{" "}<Link to="/" className="underline">{m.invite_read_posts()}</Link></p>}
      </>}
    </main>
    </>
  );
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
