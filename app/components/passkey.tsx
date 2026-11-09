import { Button } from "~/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { m } from "~/paraglide/messages.js";
import { usePasskeySupport } from "~/lib/use-passkey-support";

// A thin rule with "or" in it, between two ways of getting in.
export function OrDivider() {
  return <div className="flex items-center gap-3 ui-help text-muted-foreground"><span aria-hidden="true" className="h-px flex-1 bg-border" />{m.login_or()}<span aria-hidden="true" className="h-px flex-1 bg-border" /></div>;
}

// A successful passkey login adds the session cookie, then returns to the loader-validated destination.
// `or` puts the "or" rule before or after the button, shown only when the browser supports passkeys (so a bare rule never appears).
// `conditional` also offers the member's passkeys from the email field's autofill list (autocomplete="username webauthn"); the button stays as the plain way.
export function PasskeyLogin({ next = "/", or, conditional = false }: { next?: string; or?: "before" | "after"; conditional?: boolean }) {
  const supported = usePasskeySupport();
  const navigate = useNavigate();
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const pending = useRef(false);
  useEffect(() => {
    if (!supported || !conditional) return;
    let alive = true, started = false;
    // The offer starts when the person first goes into the email field: browsers show the passkey list there, and a login page that is only looked at asks nothing of the authenticator.
    async function offer() {
      try {
        if (!(await PublicKeyCredential.isConditionalMediationAvailable?.())) return;
        const { authClient } = await import("~/lib/auth/client");
        const res = await authClient.signIn.passkey({ autoFill: true });
        // A cancelled or replaced request comes back as an error; only a real sign-in moves on.
        if (alive && !res.error && res.data) await navigate(next, { replace: true });
      } catch { /* The autofill offer is optional. */ }
    }
    function onFocus(event: FocusEvent) {
      if (started || !(event.target instanceof HTMLInputElement) || !event.target.autocomplete.split(" ").includes("webauthn")) return;
      started = true;
      void offer();
    }
    document.addEventListener("focusin", onFocus);
    // The field may already have focus when the page becomes interactive.
    if (document.activeElement instanceof HTMLInputElement && document.activeElement.autocomplete.split(" ").includes("webauthn")) { started = true; void offer(); }
    return () => { alive = false; document.removeEventListener("focusin", onFocus); };
  }, [supported, conditional, next, navigate]);
  if (!supported) return null;
  async function login() {
    if (pending.current) return;
    pending.current = true;
    setState("busy");
    try {
      const { authClient } = await import("~/lib/auth/client");
      const res = await authClient.signIn.passkey();
      if (res.error || !res.data) {
        setState("failed");
        return;
      }
      await navigate(next, { replace: true });
    } catch {
      setState("failed");
    } finally { pending.current = false; }
  }
  return (
    <div className="space-y-2">
      {or === "before" && <OrDivider />}
      <Button type="button" className="aria-disabled:opacity-50" onClick={() => void login()} aria-disabled={state === "busy"} variant="outline">
        {m.login_passkey()}
      </Button>
      {state === "failed" && (
        <p role="alert" className="text-destructive">
          {m.login_passkey_failed()}
        </p>
      )}
      {or === "after" && <OrDivider />}
    </div>
  );
}
