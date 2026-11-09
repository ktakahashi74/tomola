import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { Field, FieldLabel } from "~/components/ui/field";
import { Checkbox } from "~/components/ui/checkbox";
import { Button } from "~/components/ui/button";
import { data, Form, redirect } from "react-router";
import { bindAuthToDatabase, getAuth } from "~/lib/auth/auth.server";
import { eq } from "drizzle-orm";
import { oauthClient } from "~/lib/db/schema";
import { requireMember, getSessionUser, getCredentialSessionFresh } from "~/lib/auth/session.server";
import { getDb } from "~/lib/db/client.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { getWriter } from "~/lib/members.server";
import { authorizationRedirect, consentRequestValid, loadConsentRequest } from "~/lib/mcp/consent.server";
import { AuthorizationExpired } from "~/components/mcp-expired";
import { m } from "~/paraglide/messages.js";
import { GuestHeader } from "~/components/guest-header";
import type { Route } from "./+types/mcp-consent";
import { reauthenticationUrl, withCredentialSession } from "~/lib/auth/credential-session.server";
export const headers = () => ({ "Cache-Control": "private, no-store" });
export function meta() { return [{ title: m.mcp_connect_title() }]; }
async function loaderImplementation({ request }: Route.LoaderArgs) {
  const query = new URL(request.url).searchParams.toString();
  const auth = await getAuth();
  const signedIn = Boolean(await getSessionUser(request));
  // A request that no longer verifies is the usual end of a slow connection, not a bad one: say so, and say that the login stands.
  if (!(await consentRequestValid(auth, query))) return { expired: true as const, signedIn };
  const consent = await loadConsentRequest(await getDb(), auth, query);
  if (!signedIn) throw redirect(`/mcp/login?${query}`);
  const { profile } = await requireMember(request);
  // A login older than 24 hours is checked before the allow button, not after it: the person confirms their address first and then allows once (the address is filled in).
  if (!(await getCredentialSessionFresh(request))) throw redirect(reauthenticationUrl(`/mcp/consent?${query}`));
  return { ...consent, who: `@${profile.handle}` };
}
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { db, user } = await requireMember(request);
  const auth = await getAuth();
  const form = await request.formData();
  const signed = String(form.get("oauth_query") ?? "");
  if (!(await consentRequestValid(auth, signed))) return { expired: true as const, signedIn: true };
  const consent = await loadConsentRequest(db, auth, signed);
  const accept = form.get("accept") === "yes";
  let scope = form.getAll("scope").map(String);
  // Keeping the connection (a refresh token) is not a choice: without it the connection ends after 15 minutes. It is given whenever it was asked for.
  if (accept && consent.scopes.includes("offline_access") && !scope.includes("offline_access")) scope = [...scope, "offline_access"];
  if (scope.some((item) => !consent.scopes.includes(item))) throw data("Invalid scope", { status: 400 });
  // Keeping the connection alone is not a permission: at least one real one (read or draft) must be chosen.
  if (accept && scope.every((item) => item === "offline_access")) throw data("Select a permission", { status: 400 });
  if (accept && scope.includes("draft") && !(await getWriter(db, user.id)).ok) throw data("Draft permission unavailable", { status: 403 });
  const approve = async (tx: typeof db, transactional: typeof auth) => {
    await tx.select({ id: oauthClient.id }).from(oauthClient).where(eq(oauthClient.clientId, consent.clientId)).for("no key update");
    return transactional.api.oauth2Consent({ request, headers: request.headers, body: { accept, ...(accept ? { scope: scope.join(" ") } : {}), oauth_query: consent.query } });
  };
  const result = accept
    ? await withCredentialSession(db, user.id, request, `/mcp/consent?${consent.query}`, approve)
    : await db.transaction(tx => approve(tx, bindAuthToDatabase(auth, tx)));
  const next = await authorizationRedirect(result);
  if (!next) throw data("Authorization failed", { status: 400 });
  throw redirect(next);
}
export default function McpConsent({ loaderData, actionData }: Route.ComponentProps) {
  if ("expired" in loaderData) return <AuthorizationExpired signedIn={loaderData.signedIn === true} />;
  if (actionData && "expired" in actionData) return <AuthorizationExpired signedIn={actionData.signedIn === true} />;
  const keeps = loaderData.scopes.includes("offline_access");
  const hasPermissions = loaderData.scopes.some(scope => scope !== "offline_access");
  return <><GuestHeader /><main className="space-y-4"><h1 className="text-2xl font-bold">{m.mcp_connect_title()}</h1><p>{m.mcp_consent_intro({ who: loaderData.who, client: loaderData.name })}</p>
    <Form method="post" className="space-y-3"><input type="hidden" name="oauth_query" value={loaderData.query} />
      {loaderData.scopes.filter((scope) => scope !== "offline_access").map((scope) => <Field key={scope} orientation="horizontal" className="min-w-0 w-auto"><FieldLabel className="flex items-center gap-2 " key={scope}><Checkbox name="scope" value={scope} defaultChecked />{scope === "read" ? m.mcp_scope_read() : m.mcp_scope_draft()}</FieldLabel></Field>)}
      {hasPermissions && keeps && <><input type="hidden" name="scope" value="offline_access" /><p>{m.mcp_scope_offline({ settings: m.settings_connections_link() })}</p></>}
      {!hasPermissions && <p role="alert">{m.mcp_no_permissions()}</p>}
      <div className="mt-4 flex flex-wrap gap-3">{hasPermissions && <Button name="accept" value="yes" type="submit">{m.mcp_allow()}</Button>}<Button variant="outline" name="accept" value="no" type="submit">{m.mcp_deny()}</Button></div>
      {hasPermissions && <p className="ui-help text-muted-foreground">{m.mcp_after_allow()}</p>}
    </Form>
    <p className="ui-help text-muted-foreground">{m.mcp_wait_note()}</p>
    <p>{m.mcp_disclosure()}</p><p>{m.mcp_private_records()}</p>
    <details className="ui-help"><summary className="cursor-pointer ui-meta">{m.mcp_details_summary()}</summary>
      <div className="mt-2 space-y-2"><p>{m.mcp_client_warning()}</p>
        <dl><dt>{m.mcp_client_identity()}</dt><dd className="break-all">{loaderData.clientId}</dd><dt>{m.mcp_client_website()}</dt><dd>{loaderData.uri ?? (loaderData.registration === "dcr" ? m.mcp_no_website() : m.mcp_no_website_declared())}</dd>
          <dt>{m.mcp_redirect_origin()}</dt><dd className="break-all">{loaderData.redirectOrigin}</dd><dt>{m.mcp_registration()}</dt><dd>{loaderData.registration === "cimd" ? m.mcp_registration_cimd() : m.mcp_registration_dcr()}</dd></dl>
      </div>
    </details>
    <Form method="post" action="/logout" className="ui-help text-muted-foreground"><input type="hidden" name="next" value={`/mcp/login?${loaderData.query}`} /><p>{m.mcp_switch_account({ who: loaderData.who })} <Button type="submit" variant="link" className="h-auto p-0 align-baseline">{m.mcp_switch_account_button()}</Button></p></Form>
  </main></>;
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
