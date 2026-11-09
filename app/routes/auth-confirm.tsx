import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { Field, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { useEffect, useRef } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/auth-confirm";
import { GuestHeader } from "~/components/guest-header";
import { completeMagicLink, magicLinkOwnerHash, magicLinkUsedIdentifier, waitForMagicLinkCompletion } from "~/lib/auth/complete-magic-link.server";
import { getSessionUser } from "~/lib/auth/session.server";
import { parseEmail } from "~/lib/email";
import { matchesMagicLinkBrowser } from "~/lib/auth/magic-link-browser.server";
import { hashMagicLinkToken } from "~/lib/auth/plugins";
import { magicLinkNextIsAiConnection } from "~/lib/auth/magic-link-next.server";
import { resumableAiConnection } from "~/lib/auth/magic-link-resume.server";
import { inArray } from "drizzle-orm";
import { verification } from "~/lib/db/schema";
import { MAGIC_LINK_MINUTES } from "~/lib/mail/magic-link.server";
import { getDb } from "~/lib/db/client.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceIpLimit } from "~/lib/http/limits.server";
import { m } from "~/paraglide/messages.js";

// Magic-link confirmation page (email URL: /auth/confirm?token=…).
// GET displays a button only in the requesting browser, without consuming the token, so email security scanners and link previews cannot consume the single-use token
// by opening the URL first. Same-origin button POST requires the requesting
// browser's secret before calling magicLinkVerify, then redirects with cookies.
// The token appears in the URL. Prevent storage/indexing and send only the
// origin as Referer, preserving native same-origin confirmation POSTs.
const PAGE_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "strict-origin", "X-Robots-Tag": "noindex" };

// Better Auth generates 32-letter tokens. Reject clearly malformed tokens without attempting verification.
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;

type LinkState = "usable" | "used" | "expired" | "other-browser" | "unknown";

// Read token state only. Neither GET nor classification consumes a link.
async function linkState(request: Request, token: string): Promise<LinkState> {
  if (!TOKEN_FORMAT.test(token)) return "unknown";
  const db = await getDb();
  await waitForMagicLinkCompletion(token);
  const credentialId = `magic-link:${hashMagicLinkToken(token)}`;
  const usedId = magicLinkUsedIdentifier(token);
  const rows = await db.select({ identifier: verification.identifier, expiresAt: verification.expiresAt }).from(verification)
    .where(inArray(verification.identifier, [credentialId, usedId]));
  const now = new Date();
  const credential = rows.find(row => row.identifier === credentialId);
  // A confirmation may start between the initial wait and this read.
  if (!rows.length && await waitForMagicLinkCompletion(token)) return linkState(request, token);
  if (credential && credential.expiresAt > now && await matchesMagicLinkBrowser(db, request, token)) return "usable";
  if (rows.some(row => row.identifier === usedId && row.expiresAt > now)) return "used";
  if (credential && credential.expiresAt <= now) return "expired";
  return credential ? "other-browser" : "unknown";
}

async function belongsToCurrentMember(request: Request, token: string): Promise<boolean> {
  if (!TOKEN_FORMAT.test(token)) return false;
  const member = await getSessionUser(request);
  if (!member) return false;
  await waitForMagicLinkCompletion(token);
  const db = await getDb();
  const usedId = magicLinkUsedIdentifier(token);
  const rows = await db.select({ identifier: verification.identifier, value: verification.value, expiresAt: verification.expiresAt }).from(verification)
    .where(inArray(verification.identifier, [`magic-link:${hashMagicLinkToken(token)}`, usedId]));
  const used = rows.find(row => row.identifier === usedId && row.expiresAt > new Date());
  if (used) return used.value === magicLinkOwnerHash(member.id);
  const credential = rows.find(row => row.identifier !== usedId);
  if (!credential) return false;
  try {
    const record: unknown = JSON.parse(credential.value);
    if (!record || typeof record !== "object" || !("type" in record) || record.type !== "magic-link" || !("email" in record) || typeof record.email !== "string") return false;
    const email = parseEmail(record.email);
    return email !== null && email === parseEmail(member.email);
  } catch { return false; }
}

export function headers() {
  return PAGE_HEADERS;
}

// Confirmation POSTs consume tokens and are limited to 300 per IP per 15 minutes (AUTH_PAGE_IP_LIMIT; 429 on excess). GET page views count neither requests nor token use.
async function loaderImplementation({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const reason = await linkState(request, token);
  // "other-browser" gets the same screen whoever is logged in here: sending a member on only when the link is theirs would tell anyone holding a link whose it is.
  if (reason !== "usable" && reason !== "other-browser" && await belongsToCurrentMember(request, token)) throw redirect("/", { headers: PAGE_HEADERS });
  // Present only when it applies, so an ordinary login link carries nothing more than before.
  const aiConnection = reason !== "usable" && TOKEN_FORMAT.test(token) && await magicLinkNextIsAiConnection(await getDb(), token);
  // A link that has run out, opened in the browser that asked for it, while the AI's request is still valid: the way back to that request.
  const resume = aiConnection && reason === "expired" ? await resumableAiConnection(await getDb(), request, token) : null;
  return data(
    { token: reason === "usable" ? token : null, reason, minutes: MAGIC_LINK_MINUTES, ...(aiConnection ? { aiConnection: true as const } : {}), ...(resume ? { resume } : {}) },
    { headers: PAGE_HEADERS },
  );
}

export async function action({ request }: Route.ActionArgs) {
  // Reject token consumption from cross-site POSTs (login CSRF).
  assertSameOrigin(request);
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  // Remember expiry before rate-limit cleanup can remove expired rows.
  const before = await linkState(request, token);
  await enforceIpLimit(await getDb(), request, "auth-page");
  if (before === "usable") {
    const response = await completeMagicLink(request, token);
    if (response) return response;
  }
  const after = await linkState(request, token);
  const reason = after === "unknown" && before === "expired" ? "expired" : after === "usable" ? "unknown" : after;
  if (reason !== "other-browser" && await belongsToCurrentMember(request, token)) throw redirect("/", { headers: PAGE_HEADERS });
  const aiConnection = TOKEN_FORMAT.test(token) && await magicLinkNextIsAiConnection(await getDb(), token);
  const resume = aiConnection && reason === "expired" ? await resumableAiConnection(await getDb(), request, token) : null;
  return data({ status: "invalid" as const, reason, ...(aiConnection ? { aiConnection: true as const } : {}), ...(resume ? { resume } : {}) }, { status: 400, headers: PAGE_HEADERS });
}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.confirm_title() }, { name: "robots", content: "noindex" }];
}

export default function AuthConfirm({ loaderData, actionData }: Route.ComponentProps) {
  const invalid = loaderData.token === null || actionData?.status === "invalid";
  const reason = actionData?.reason ?? loaderData.reason;
  // The link was asked for while connecting an AI: the way on is the browser window the AI opened, not a new login here.
  const aiConnection = actionData?.status === "invalid" ? "aiConnection" in actionData : "aiConnection" in loaderData;
  const resume = actionData?.status === "invalid" ? ("resume" in actionData ? actionData.resume : null) : ("resume" in loaderData ? loaderData.resume : null);
  const heading = reason === "used" ? m.confirm_used_heading() : reason === "expired" ? m.confirm_expired_heading()
    : reason === "other-browser" ? m.confirm_unusable_heading() : m.confirm_unknown_heading();
  // Disable the button while submitting. Tokens are single-use.
  // Also guard with a ref to block an immediate second click before state updates. Re-enable after completion when an error returns.
  const navigation = useNavigation();
  const submitted = useRef(false);
  useEffect(() => {
    if (navigation.state === "idle") submitted.current = false;
  }, [navigation.state]);
  return (
    <>
    <GuestHeader />
    <main className="space-y-4">
      <h1 className="text-2xl font-bold">{invalid ? heading : m.confirm_title()}</h1>
      {invalid ? (
        <>
          {reason === "used" ? <p>{m.confirm_used()}</p>
            : reason === "expired" ? <p>{aiConnection ? m.confirm_mcp_expired() : m.confirm_expired({ minutes: loaderData.minutes })}</p>
            : reason === "other-browser" ? <p>{aiConnection ? m.confirm_mcp_other_browser() : m.confirm_invalid_hint()}</p>
            : <p className="ui-help text-muted-foreground">{m.confirm_invalid({ minutes: loaderData.minutes })}</p>}
          {!aiConnection && <>
          <h2 className="text-xl font-semibold">{m.confirm_restart_heading()}</h2>
          <Form method="post" action="/login" className="space-y-2">
            <Field className="min-w-0 w-auto"><FieldLabel className="block">
              {m.login_email()}
              <Input name="email" type="email" required className="block w-full" />
            </FieldLabel></Field>
            <Button type="submit">{m.login_submit()}</Button>
          </Form></>}
          {resume && <p><a href={resume} className="underline">{m.confirm_mcp_resume()}</a></p>}
          {(reason === "other-browser" || aiConnection) && <p><Link to="/" className="underline ui-help">{m.confirm_home()}</Link></p>}
        </>
      ) : (
        <Form method="post" className="space-y-3" onSubmit={(event) => {
            if (submitted.current) event.preventDefault();
            else submitted.current = true;
          }}>
          <p>{m.confirm_intro()}</p>
          <input type="hidden" name="token" value={loaderData.token ?? ""} />
          <Button type="submit" disabled={navigation.state !== "idle"} className="disabled:opacity-60">
            {m.confirm_submit()}
          </Button>
        </Form>
      )}
    </main>
    </>
  );
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
