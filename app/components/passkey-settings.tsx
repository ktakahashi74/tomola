import { withSettingsReturn } from "~/lib/settings-return";
import { Button, buttonVariants } from "~/components/ui/button";
import { Field, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { useCallback, useRef, useState } from "react";
import { Form, useRevalidator } from "react-router";
import { m } from "~/paraglide/messages.js";
import { SignedForm } from "~/components/signed-form";
import { reauthenticationPath } from "~/lib/reauth";
import { passkeyNeedsActivation, usePasskeyReturn, withPasskeyReturn } from "~/lib/passkey-return";
import { usePasskeySupport } from "~/lib/use-passkey-support";

export type PasskeySummary = { id: string; name: string | null; createdAt: string | null; backedUp: boolean };

// Passkeys in /settings: list, add through the browser dialog, and remove through a form POST.
export function PasskeySettings({ passkeys, fresh, saved, returnTo }: { passkeys: PasskeySummary[]; fresh: boolean; saved: "passkey-added" | "passkey-removed" | null; returnTo?: string | null }) {
  const supported = usePasskeySupport();
  const revalidator = useRevalidator();
  const [name, setName] = useState("");
  const [state, setState] = useState<{ status: "idle" | "busy" | "added" | "error" | "ready"; message?: string }>({ status: "idle" });
  const pending = useRef(false);
  const addButton = useRef<HTMLButtonElement>(null);
  // An older session cannot add a credential: adding first re-verifies by email, then returns here.
  const reauth = reauthenticationPath(withPasskeyReturn(withSettingsReturn("/settings#settings-passkeys", returnTo), "settings"));
  const add = useCallback(async (automatic = false) => {
    if (pending.current) return;
    pending.current = true;
    setState({ status: "busy" });
    let leaving = false;
    try {
      const { addVerifiedPasskey } = await import("~/lib/passkeys.client");
      await addVerifiedPasskey(name.trim());
      setName("");
      setState({ status: "added" });
      await revalidator.revalidate();
    } catch (error) {
      // The session aged past the freshness window while this page was open.
      if (error instanceof Error && error.message === "SESSION_NOT_FRESH") { leaving = true; window.location.assign(reauth); }
      else if (automatic && passkeyNeedsActivation(error)) {
        setState({ status: "ready" });
        addButton.current?.focus();
      }
      else setState({ status: "error", message: m.settings_passkeys_error_generic() });
    } finally { if (!leaving) pending.current = false; }
  }, [name, reauth, revalidator]);
  usePasskeyReturn({ target: "settings", fresh, ready: supported, enabled: state.status === "idle", onContinue: add });
  return (
    <section id="settings-passkeys" aria-labelledby="settings-passkeys-heading" className="scroll-mt-4 space-y-3">
      <h3 id="settings-passkeys-heading" className="text-lg font-semibold">{m.settings_passkeys_heading()}</h3>
      <p className="ui-help text-muted-foreground">{m.settings_passkeys_intro()}</p>
      {saved === "passkey-removed" && (
        <div className="space-y-2">
        <p role="status" className="text-success">
          <span>{m.settings_passkeys_removed()}</span>
        </p>
        <p className="ui-help">{m.settings_passkeys_sessions_hint()}</p>
        <Form method="post" action={withSettingsReturn("/settings#settings-sessions", returnTo)}>
          <input type="hidden" name="intent" value="revoke-other-sessions" />
          <Button type="submit" variant="outline">{m.settings_sessions_revoke()}</Button>
        </Form>
        </div>
      )}
      {state.status === "added" && (
        <p role="status" className="text-success">
          <span>{m.settings_passkeys_added()}</span>
        </p>
      )}
      {passkeys.length === 0 ? (
        <p>{m.settings_passkeys_none()}</p>
      ) : (
        <ul className="divide-y">
          {passkeys.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="font-semibold">{p.name || m.settings_passkeys_unnamed()}</span>
              {p.createdAt && <span className="ui-meta text-muted-foreground">{m.settings_passkeys_created({ date: p.createdAt.slice(0, 10) })}</span>}
              {p.backedUp && <span className="ui-meta text-muted-foreground">{m.settings_passkeys_synced()}</span>}
              <SignedForm signatureRequired method="post" action={withSettingsReturn("/settings#settings-passkeys", returnTo)} className="ms-auto" onSubmit={(e) => {
                  if (!window.confirm(m.settings_passkeys_remove_confirm())) e.preventDefault();
                }}>
                <input type="hidden" name="intent" value="delete-passkey" />
                <input type="hidden" name="passkeyId" value={p.id} />
                <Button type="submit" disabled={passkeys.length <= 1} className="text-sm" variant="destructive">
                  {m.settings_passkeys_remove()}
                </Button>
              </SignedForm>
            </li>
          ))}
        </ul>
      )}
      {passkeys.length === 1 && <p className="ui-help text-muted-foreground">{m.passkey_last_required()}</p>}
      {supported && !fresh ? (
        <p><a href={reauth} className={buttonVariants()}>{m.settings_passkeys_add()}</a></p>
      ) : supported ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field className="min-w-0 w-auto"><FieldLabel className="block">
            {m.settings_passkeys_name_label()}
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="block" />
          </FieldLabel></Field>
          <Button ref={addButton} type="button" className={`aria-disabled:opacity-50 ${state.status === "ready" ? "ring-3 ring-ring/50" : ""}`} onClick={() => void add()} aria-disabled={state.status === "busy"}>
            {m.settings_passkeys_add()}
          </Button>
        </div>
      ) : (
        <p className="ui-help text-muted-foreground">{m.settings_passkeys_unsupported()}</p>
      )}
      {state.status === "error" && (
        <p role="alert" className="text-destructive">
          {state.message}
        </p>
      )}
    </section>
  );
}
