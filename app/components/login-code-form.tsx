import { useEffect, useId, useLayoutEffect, useRef, type FormEvent } from "react";
import { Form, useNavigation } from "react-router";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Field, FieldLabel } from "~/components/ui/field";
import type { PendingLoginScreen } from "~/lib/auth/login-code-state.server";
import { m } from "~/paraglide/messages.js";
export function LoginCodeForm({ state, invalid = false, limited = state.limited, hiddenFields = {}, invitation = false, resentNotice = true }: { state: PendingLoginScreen; invalid?: boolean; limited?: PendingLoginScreen["limited"]; hiddenFields?: Record<string, string>; invitation?: boolean; resentNotice?: boolean }) {
  const navigation = useNavigation();
  const errorId = useId();
  const codeInvalid = invalid || state.invalid;
  const hidden = Object.entries(hiddenFields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />);
  const busy = navigation.state !== "idle";
  const submitting = useRef(false), restarting = useRef(false);
  const limitNotice = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!busy) { submitting.current = false; restarting.current = false; } }, [busy]);
  useLayoutEffect(() => { if (limited) limitNotice.current?.focus(); }, [limited]);
  useEffect(() => () => {
    if (restarting.current) requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>('main input:not([type="hidden"]), main button[type="submit"]');
      target?.focus();
    });
  }, []);
  function submit(event: FormEvent<HTMLFormElement>) {
    if (busy || submitting.current) { event.preventDefault(); return; }
    submitting.current = true;
    restarting.current = new FormData(event.currentTarget).get("intent") === "login-restart";
  }
  return <div className="space-y-4">
    {state.resent && resentNotice && <p role="status">{m.login_resent()}</p>}
    {limited ? <Alert ref={limitNotice} tabIndex={-1} variant="destructive"><AlertDescription>{limited === "address" ? m.login_code_limited_address() : m.login_code_limited()}</AlertDescription></Alert> : (
      <Form onSubmit={submit} method="post" className="space-y-3">
        <input type="hidden" name="intent" value="login-code" />
        <Field className="min-w-0 w-auto"><FieldLabel className="block">{m.login_code_label()}<Input aria-invalid={codeInvalid || undefined} aria-describedby={codeInvalid ? errorId : undefined} name="code" inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={64} /></FieldLabel></Field>
        {codeInvalid && <Alert id={errorId} role="alert" variant="destructive"><AlertDescription>{m.login_code_invalid()}</AlertDescription></Alert>}
        <Button type="submit" className="aria-disabled:opacity-50" aria-disabled={busy}>{invitation ? m.invite_code_submit() : m.login_code_submit()}</Button>
      </Form>
    )}
    <p className="ui-help text-muted-foreground">{m.login_link_note()}</p>
    <div className="space-y-3 border-t pt-4">
      <div className="flex flex-wrap gap-2">
        <Form onSubmit={submit} method="post">{hidden}<input type="hidden" name="intent" value="login-resend" /><Button type="submit" aria-disabled={busy} variant={limited === "code" ? "default" : "outline"} className="h-auto max-w-full whitespace-normal aria-disabled:opacity-50">{m.login_resend()}</Button></Form>
        <Form onSubmit={submit} method="post"><input type="hidden" name="intent" value="login-restart" /><Button type="submit" aria-disabled={busy} variant="ghost" className="h-auto max-w-full whitespace-normal aria-disabled:opacity-50">{m.login_restart()}</Button></Form>
      </div>
      {invitation && <p className="ui-help text-muted-foreground">{m.invite_no_mail_note()}</p>}
      <details className="ui-help text-muted-foreground">
        <summary className="cursor-pointer ui-meta">{m.login_mail_help_heading()}</summary>
        <ul className="mt-2 list-disc space-y-2 ps-5">
          <li>{m.login_mail_help_spam()}</li>
          <li>{m.login_mail_help_limit({ minutes: state.mailMinutes, count: state.mailCount })}</li>
        </ul>
      </details>
    </div>
  </div>;
}
