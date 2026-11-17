import { Form } from "react-router";
import { Button } from "~/components/ui/button";
import { CopyTextButton } from "~/components/copy-text-button";
import { m } from "~/paraglide/messages.js";

// Server data keeps the first render stable. CSS selects the standalone note
// before scripts run; neither variant loads Google scripts, fonts or images.
export function GoogleLogin({ browser, next, link = false }: { browser: { blocked: boolean; url: string }; next?: string; link?: boolean }) {
  return <div className="google-login">
    {!browser.blocked && <Form method="post" reloadDocument className="google-login-form space-y-2">
      <input type="hidden" name="intent" value={link ? "google-link" : "google-login"} />
      {next && <input type="hidden" name="next" value={next} />}
      <Button type="submit" variant="outline">{link ? m.google_connect() : m.google_continue()}</Button>
    </Form>}
    <div className={`space-y-2${browser.blocked ? "" : " google-login-standalone"}`} data-google-browser-note>
      <p className="ui-help">{m.google_open_browser()}</p>
      <CopyTextButton text={browser.url} label={m.google_copy_url()} copiedLabel={m.google_url_copied()} />
    </div>
  </div>;
}

export function GoogleLoginError({ error, email }: { error: string | null; email?: string | null }) {
  if (!error) return null;
  const reason = error === "google_unverified" ? m.google_unverified() : error === "google_unmanaged" ? m.google_unmanaged() : m.google_failed();
  return <div role="alert" className="space-y-1 ui-help">
    <p>{reason}</p>
    {email && <p>{m.google_invitation_email({ email })}</p>}
    <p>{m.google_email_fallback()}</p>
  </div>;
}
