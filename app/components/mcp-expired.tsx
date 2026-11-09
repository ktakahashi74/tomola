import { Link } from "react-router";
import { GuestHeader } from "~/components/guest-header";
import { m } from "~/paraglide/messages.js";

// What /mcp/login and /mcp/consent show when the signed request of an AI connection no longer verifies. In practice it is the request outliving its signature (the person took
// longer than ten minutes, or the AI that asked has long stopped waiting), so the way on is with the AI, not on this screen.
export function AuthorizationExpired({ signedIn }: { signedIn: boolean }) {
  return <>
    <GuestHeader />
    <main className="space-y-4">
      <h1 className="text-2xl font-bold">{m.mcp_expired_title()}</h1>
      <p>{m.mcp_expired_body()}</p>
      {signedIn && <p>{m.mcp_expired_signed_in()}</p>}
      <p><Link to="/" className="underline ui-help">{m.confirm_home()}</Link></p>
    </main>
  </>;
}
