import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useRevalidator } from "react-router";
import { Button, buttonVariants } from "~/components/ui/button";
import { m } from "~/paraglide/messages.js";
import { PASSKEY_PROMPT_MAX_AGE } from "~/lib/passkey-prompt";
import { focusMain } from "~/lib/focus-main";
import { reauthenticationPath } from "~/lib/reauth";
import { passkeyNeedsActivation, usePasskeyReturn, withPasskeyReturn } from "~/lib/passkey-return";

const LINK_CLASS = "h-auto p-0 ui-meta font-normal text-muted-foreground underline";
export default function PasskeyPromptBody({ eligible, preference, fresh }: { eligible: boolean; preference: { cookieName: string; deferred: boolean }; fresh: boolean }) {
  const location = useLocation();
  // An older session cannot add a credential: registering first re-verifies by email, then returns here.
  const reauth = reauthenticationPath(withPasskeyReturn(`${location.pathname}${location.search}`, "prompt"));
  const [dismissed, setDismissed] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "added" | "failed" | "ready">("idle");
  const revalidator = useRevalidator();
  const pending = useRef(false);
  const registerButton = useRef<HTMLButtonElement>(null);
  const success = useRef<HTMLParagraphElement>(null);
  const restore = useRef(false);
  useLayoutEffect(() => {
    if (!restore.current) return;
    restore.current = false;
    if (state === "added") success.current?.focus({ preventScroll: true });
    else focusMain();
  }, [state, dismissed]);
  const register = useCallback(async (automatic = false) => {
    if (pending.current) return;
    pending.current = true;
    setState("busy");
    let leaving = false;
    try {
      const { addVerifiedPasskey } = await import("~/lib/passkeys.client");
      await addVerifiedPasskey();
      restore.current = true;
      setState("added");
      await revalidator.revalidate();
    } catch (error) {
      // The session aged past the freshness window while this page was open.
      if (error instanceof Error && error.message === "SESSION_NOT_FRESH") { leaving = true; window.location.assign(reauth); }
      else if (automatic && passkeyNeedsActivation(error)) {
        setState("ready");
        registerButton.current?.focus();
      }
      else setState("failed");
    } finally { if (!leaving) pending.current = false; }
  }, [reauth, revalidator]);
  usePasskeyReturn({ target: "prompt", fresh, enabled: eligible && !preference.deferred && !dismissed && state === "idle", onContinue: register });
  function later() {
    if (pending.current) return;
    const until = Date.now() + PASSKEY_PROMPT_MAX_AGE * 1000;
    document.cookie = `${preference.cookieName}=${until}; Path=/; SameSite=Lax; Max-Age=${PASSKEY_PROMPT_MAX_AGE}${window.location.protocol === "https:" ? "; Secure" : ""}`;
    restore.current = true;
    setDismissed(true);
  }
  if (state === "added") return <p ref={success} tabIndex={-1} role="status" className="mb-2 ui-meta text-muted-foreground">{m.passkey_prompt_success()}</p>;
  if (!eligible || preference.deferred || dismissed) return null;
  return <div role="region" aria-label={m.passkey_prompt_register()} className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 ui-meta text-muted-foreground">
    <span>{m.passkey_prompt()}</span>
    {fresh
      ? <Button ref={registerButton} variant="link" className={`h-auto p-0 ui-meta aria-disabled:opacity-50 font-normal text-muted-foreground underline ${state === "ready" ? "ring-3 ring-ring/50" : ""}`} onClick={() => void register()} aria-disabled={state === "busy"}>{m.passkey_prompt_register()}</Button>
      : <a href={reauth} className={buttonVariants({ variant: "link", className: LINK_CLASS })}>{m.passkey_prompt_register()}</a>}
    <Button variant="link" className="h-auto p-0 ui-meta aria-disabled:opacity-50 font-normal text-muted-foreground underline" onClick={later} aria-disabled={state === "busy"}>{m.passkey_prompt_later()}</Button>
    {state === "failed" && <p role="alert" className="text-destructive">{m.passkey_prompt_failed()}</p>}
  </div>;
}
