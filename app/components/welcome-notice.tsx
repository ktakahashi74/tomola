import { useState } from "react";
import { Link, useLocation } from "react-router";
import { Button } from "~/components/ui/button";
import type { WelcomeData } from "~/lib/auth/welcome.server";

// Shown once after signing up. It names the next small things to do and counts nothing: no progress, no badges.
// The server drops its cookie on the page that shows it, so it does not come back.
// `passkeyOffer` is false on the pages where the ordinary passkey prompt is already shown, so the offer is not made twice.
export function WelcomeNotice({ welcome: { kind, text }, handle, passkeyOffer, villages }: { welcome: WelcomeData; handle: string; passkeyOffer: boolean; villages: boolean }) {
  const [dismissed, setDismissed] = useState(false);
  // It belongs to the page the member arrived on; moving to another page ends it.
  const { pathname } = useLocation();
  const [arrivedAt] = useState(pathname);
  if (dismissed || pathname !== arrivedAt) return null;
  if (kind === "article") {
    return <aside aria-label={text.label} className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
      <span>{text.joined}</span>
      <a href="#reply" className="underline">{text.replyLink}</a>
      <Link to="/connect" className="basis-full underline">{text.connectAi}</Link>
    </aside>;
  }
  return <aside aria-label={text.label} className="mb-4 space-y-2 rounded-lg border bg-muted/40 px-4 py-3 text-sm">
    <p className="font-semibold">{text.hello}</p>
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      <li><Link to={`/u/${handle}`} className="underline">{text.writeIntro}</Link></li>
      {villages && <li><Link to="/villages" className="underline">{text.seeVillages}</Link></li>}
      {passkeyOffer && <li><Link to="/settings#settings-passkeys" className="underline">{text.addPasskey}</Link></li>}
    </ul>
    <p><Link to="/connect" className="underline">{text.connectAi}</Link></p>
    <Button type="button" variant="link" className="h-auto p-0 ui-meta font-normal text-muted-foreground underline" onClick={() => setDismissed(true)}>{text.close}</Button>
  </aside>;
}
