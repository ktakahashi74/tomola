import { useEffect, useState } from "react";
import { Form } from "react-router";
import { Button } from "~/components/ui/button";
import { CopyTextButton } from "~/components/copy-text-button";
import { m } from "~/paraglide/messages.js";

export function googleBrowserBlocked(ua: string, standalone: boolean): boolean {
  return standalone || /Line\/|\bFBAN\b|\bFBAV\b|FB_IAB|Messenger|Instagram|LinkedIn|\bLIAPP\b|KAKAOTALK|NAVER[^\n]*inapp|MicroMessenger|; wv\)/i.test(ua);
}

// Wait for client detection before showing the button: standalone mode is not
// available to SSR. No Google scripts, fonts or images are loaded.
export function GoogleLogin({ next, link = false }: { next?: string; link?: boolean }) {
  const [browser, setBrowser] = useState<{ blocked: boolean; url: string } | null>(null);
  useEffect(() => {
    const detect = () => setBrowser({ blocked: googleBrowserBlocked(navigator.userAgent, window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true), url: window.location.href });
    const mode = window.matchMedia("(display-mode: standalone)");
    detect();
    mode.addEventListener("change", detect);
    return () => mode.removeEventListener("change", detect);
  }, []);
  if (!browser) return null;
  if (browser.blocked) return <div className="space-y-2" data-google-browser-note>
    <p className="ui-help">{m.google_open_browser()}</p>
    <CopyTextButton text={browser.url} label={m.google_copy_url()} copiedLabel={m.google_url_copied()} />
  </div>;
  return <Form method="post" reloadDocument className="space-y-2">
    <input type="hidden" name="intent" value={link ? "google-link" : "google-login"} />
    {next && <input type="hidden" name="next" value={next} />}
    <Button type="submit" variant="outline">{link ? m.google_connect() : m.google_continue()}</Button>
  </Form>;
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
