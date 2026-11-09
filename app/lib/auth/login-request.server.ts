import type { Db } from "~/lib/db/client.server";
import { clientAddress } from "~/lib/http/client-ip.server";
import { normalizeEmail } from "~/lib/invitations.server";
import { hitRateLimit, LOGIN_LOOKUP_IP_LIMIT } from "~/lib/rate-limit.server";
import { isKnownAddress, magicLinkOutcome } from "./magic-link.server";

// In production a missing source address means the deployment's entry is wrong (client-ip.server.ts), and the lookup allowance silently does not apply. Say so once per process.
let warnedNoSource = false;
function warnNoSourceAddress(): void {
  if (warnedNoSource || process.env.NODE_ENV !== "production") return;
  warnedNoSource = true;
  console.warn("[login] no trustworthy source address for a login request; the lookup allowance is not applied");
}

// What a login screen is told after asking for a login email. "sent": the mail provider accepted the message. "unregistered": the address is neither a member's nor invited.
// "later": nothing was sent for a reason the screen does not give (a limit, a failed delivery). "already": the member is logged in with this very address, so no mail is needed.
export type LoginRequestResult = "sent" | "unregistered" | "later" | "already";

// The one path from a login screen (/login, /mcp/login) to a login email. Order:
//   1. normalize the address;
//   2. a member already logged in with the same address needs no mail (the caller sends them on; /mcp/login lands on the consent screen, which checks how recent the login is);
//   3. count the request against the source's lookup allowance, whatever the address is; past it, answer "later" without looking anything up or sending;
//   4. member or invitation? if neither, "unregistered";
//   5. + 6. the sender (app/lib/auth/magic-link.server.ts) applies the per-address, per-pair and per-source sending limits, makes the code, and waits for the provider.
// `send` calls auth.api.signInMagicLink; its exceptions (rejected origin or input) pass through untouched.
export async function requestLoginLink(input: {
  db: Db;
  request: Request;
  email: string;
  signedInEmail?: string | null;
  send: () => Promise<unknown>;
}): Promise<LoginRequestResult> {
  const email = normalizeEmail(input.email);
  if (input.signedInEmail && normalizeEmail(input.signedInEmail) === email) return "already";
  // Without a trustworthy source address (client-ip.server.ts) there is nothing to count, as with the other per-source limits.
  const ip = clientAddress(input.request);
  if (ip === null) warnNoSourceAddress();
  else {
    const lookup = await hitRateLimit(input.db, { key: `login-lookup:ip:${ip}`, ...LOGIN_LOOKUP_IP_LIMIT });
    if (!lookup.allowed) {
      // The source only: neither the address nor a hash of it is written.
      console.warn(`[login] lookup allowance spent ip=${ip}`);
      return "later";
    }
  }
  if (!(await isKnownAddress(input.db, email))) {
    console.warn(`[login] address not registered ip=${ip ?? "unknown"}`);
    return "unregistered";
  }
  const outcome: { result?: "sent" | "unregistered" | "later" } = {};
  await magicLinkOutcome.run(outcome, input.send);
  // A sender that recorded nothing must never read as "sent".
  if (outcome.result === undefined) console.error("[magic-link] no delivery outcome was recorded");
  return outcome.result ?? "later";
}
