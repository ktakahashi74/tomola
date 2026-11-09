import { useOperatorSettings } from "~/lib/operator-context";
import { data, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/settings-delete-account";
import { requireMember } from "~/lib/auth/session.server";
import { getDb } from "~/lib/db/client.server";
import { withCredentialSession } from "~/lib/auth/credential-session.server";
import { getAuth } from "~/lib/auth/auth.server";
import { clearLoginCodeCookies } from "~/lib/auth/login-code-cookie.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { accountDeletionKey, completedAccountDeletion, AccountDeletionError, deleteAccount, deletionVillages } from "~/lib/account-delete.server";
import { SigningFailureResponse, withSignedWrite } from "~/lib/signing.server";
import { SignedForm } from "~/components/signed-form";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { NativeSelect, NativeSelectOption } from "~/components/ui/native-select";
import { Field, FieldError, FieldLabel } from "~/components/ui/field";
import { RETENTION } from "~/lib/retention";
import { m } from "~/paraglide/messages.js";

export const meta = () => [{ title: m.account_delete_title() }];
export async function loader({ request }: Route.LoaderArgs) {
  const { db, profile, user } = await requireMember(request);
  return withCredentialSession(db, user.id, request, "/settings/delete-account", async tx => data({ handle: profile.handle, signPosts: profile.signPosts, completionKey: accountDeletionKey(user.id), villages: await deletionVillages(tx, user.id) }, { headers: { "Cache-Control": "private, no-store" } }));
}
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await request.formData();
  const receipt = String(form.get("completion-key") ?? "");
  if (await completedAccountDeletion(await getDb(), receipt)) return deletionComplete(request);
  const { db, user } = await requireMember(request);
  if (form.get("intent") !== "delete-account") throw new Response("Invalid request", { status: 400 });
  const confirmation = String(form.get("confirmation") ?? "");
  const posts = String(form.get("posts") ?? "keep");
  if (!["keep", "delete"].includes(posts)) return data({ error: "invalid" }, { status: 400 });
  const villages = Object.fromEntries([...form].filter(([key]) => key.startsWith("village:")).map(([key, value]) => [key.slice(8), String(value)]));
  try {
    await deleteAccount(db, user.id, { confirmation, posts: posts as "keep" | "delete", villages }, {
      execute: (mutate, lock) => db.transaction(async tx => {
        await lock(tx);
        return withCredentialSession(tx, user.id, request, "/settings/delete-account", fresh => withSignedWrite(fresh, user.id, request, form, mutate));
      }),
    });
  } catch (error) {
    if (error instanceof AccountDeletionError) return data({ error: error.code, villageErrors: error.villageIds }, { status: error.code === "village_changed" ? 409 : 400 });
    if (error instanceof SigningFailureResponse) return data({ error: "signature" }, { status: error.status });
    if (error instanceof Response) throw error;
    // The request journal retains a non-sensitive failure code for operators.
    console.warn("[account-delete] account deletion request failed");
    return data({ error: "failed" }, { status: 503 });
  }
  return deletionComplete(request);
}

async function deletionComplete(request: Request) {
  // Use the normal logout cookie handling after all server credentials are gone.
  const response = await (await getAuth()).api.signOut({ headers: request.headers, request, asResponse: true });
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Clear-Site-Data", '"cache", "storage"');
  clearLoginCodeCookies(request, headers);
  return redirect("/login?account-deleted=1", { headers });
}

export default function DeleteAccount({ loaderData, actionData }: Route.ComponentProps) {
  const operator = useOperatorSettings();
  const error = actionData?.error;
  const villageErrors = actionData && "villageErrors" in actionData && Array.isArray(actionData.villageErrors) ? actionData.villageErrors : [];
  const pending = useNavigation().state !== "idle";
  return <main className="max-w-2xl space-y-5">
    <h1 className="text-2xl font-bold">{m.account_delete_title()}</h1>
    <p>{m.account_delete_intro()}</p>
    <p>{m.account_delete_export_help()} <Link to="/settings/export" reloadDocument className="underline">{m.settings_export_link()}</Link></p>
    <p>{m.account_delete_removed_help()}</p>
    <p>{m.account_delete_chat_help()}</p>
    {error && error !== "village_required" && <p role="alert" className="text-destructive">{error === "confirmation" ? m.account_delete_error_confirmation() : error === "village_changed" ? m.account_delete_error_village() : error === "signature" ? m.signing_failed() : error === "failed" ? m.account_delete_error_failed({ email: operator.privacyEmail }) : m.account_delete_error_invalid()}</p>}
    <SignedForm signatureRequired={loaderData.signPosts} method="post" className="space-y-5">
      <input type="hidden" name="intent" value="delete-account" />
      <input type="hidden" name="completion-key" value={loaderData.completionKey} />
      <fieldset className="space-y-3">
        <legend className="font-semibold">{m.account_delete_posts_title()}</legend>
        <label className="flex gap-2"><input type="radio" name="posts" value="keep" defaultChecked />{m.account_delete_keep()}</label>
        <label className="flex gap-2"><input type="radio" name="posts" value="delete" />{m.account_delete_remove()}</label>
        <p className="ui-help">{m.account_delete_posts_help({ days: RETENTION.deletedEntryDays })}</p>
      </fieldset>
      {loaderData.villages.length > 0 && <fieldset className="space-y-4"><legend className="font-semibold">{m.account_delete_villages()}</legend>
        {loaderData.villages.map(village => {
          const required = !village.otherOwners && village.members.length > 0;
          const invalid = villageErrors.includes(village.id);
          const errorId = `village-${village.id}-error`;
          return <div key={village.id} className="space-y-2">
          <p className="font-medium">{village.name}</p>
          {(village.otherOwners || village.members.length) ? <Field data-invalid={invalid || undefined}><FieldLabel htmlFor={`village-${village.id}`}>{village.name}</FieldLabel><NativeSelect id={`village-${village.id}`} name={`village:${village.id}`} required={required} defaultValue={village.otherOwners ? "transfer" : ""} aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : undefined}>{required && <NativeSelectOption value="" disabled>{m.account_delete_village_choose()}</NativeSelectOption>}{village.otherOwners ? <NativeSelectOption value="transfer">{m.account_delete_transfer()}</NativeSelectOption> : village.members.map(member => <NativeSelectOption key={member.id} value={`member:${member.id}`}>{m.account_delete_transfer_member({ handle: member.handle })}</NativeSelectOption>)}<NativeSelectOption value="end">{m.account_delete_end()}</NativeSelectOption></NativeSelect>{invalid && <FieldError id={errorId}>{m.account_delete_village_required()}</FieldError>}</Field>
            : <><input type="hidden" name={`village:${village.id}`} value="end" /><p>{m.account_delete_end_only()}</p></>}
        </div>; })}
      </fieldset>}
      <Field><FieldLabel htmlFor="account-delete-confirmation">{m.account_delete_confirmation({ handle: loaderData.handle })}</FieldLabel><Input id="account-delete-confirmation" name="confirmation" required autoComplete="off" /></Field>
      <div className="flex gap-3"><Button type="submit" variant="destructive" disabled={pending}>{m.account_delete_confirm()}</Button><Link to="/settings" className="underline">{m.cancel()}</Link></div>
    </SignedForm>
  </main>;
}
