import { DELETED_MEMBER_ID, isDeletedIdentity } from "../deleted-member";
import { isSuspendedDeletedAddress } from "../suspended-email.server";
import { createHmac, hkdfSync, randomBytes, randomInt } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { inArray, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { invitations, user, verification } from "~/lib/db/schema";
import { clientAddress } from "~/lib/http/client-ip.server";
import { normalizeEmail } from "~/lib/invitations.server";
import { mailDecoyTo, type Mailer } from "~/lib/mail/mail.server";
import { defaultUiLocale } from "~/lib/enabled-langs.server";
import { magicLinkMail, mailLocale } from "~/lib/mail/magic-link.server";
import { hitRateLimit, MAGIC_LINK_EMAIL_LIMIT, MAGIC_LINK_EMAIL_IP_LIMIT, MAGIC_LINK_IP_LIMIT } from "~/lib/rate-limit.server";
import { hashMagicLinkToken, type SendMagicLink } from "./plugins";
import { browserBindingIdentifier } from "./magic-link-browser.server";
import { issueLoginCode, loginCodeIdentifier, loginCodeLinkIdentifier } from "./login-code.server";
import { validBrowserNonce } from "./magic-link-browser.server";
import { magicLinkNextIdentifier } from "./magic-link-next.server";

// Email URLs point to the confirmation page /auth/confirm (app/routes/auth-confirm.tsx), rather than Better Auth's verification URL (/api/auth/magic-link/verify).
// Opening the URL does not consume the token; the page button's POST does. Return destinations stay beside the token hash in verification, never in mail.
export function confirmUrl(baseURL: string, token: string): string {
  const url = new URL("/auth/confirm", baseURL);
  url.searchParams.set("token", token);
  return url.toString();
}

// Whether a recipient may receive a magic link: an existing user (members and users still registering, so they can log in again) or a valid invitation.
// Check in a single statement so members and invitations do not require different numbers of queries.
export async function isKnownAddress(db: Db, email: string, now: Date = new Date()): Promise<boolean> {
  const address = normalizeEmail(email);
  // Only the reserved "departed member" identity is excluded here. An address held by a suspended former member answers like any invited address (the sender below withholds the mail),
  // so the login screens do not reveal that history.
  if (isDeletedIdentity(undefined, address)) return false;
  // db.execute return types differ by driver; both have rows.
  const result = (await db.execute(
    sql`select (exists (select 1 from ${user} where ${user.email} = ${address} and ${user.id} <> ${DELETED_MEMBER_ID})
      or exists (select 1 from ${invitations} where ${invitations.email} = ${address} and ${invitations.usedAt} is null and ${invitations.revokedAt} is null and ${invitations.expiresAt} > ${now})) as known`,
  )) as unknown as { rows: Array<{ known: boolean }> };
  return result.rows[0]?.known === true;
}

// A login screen asks for the outcome of its own request: it runs signInMagicLink inside this store, and the sender below records what happened and then waits for the
// mail provider to accept the message. Calls made outside a store (invitations, scripts, tests) keep the unobserved behaviour: the response never depends on the recipient.
export type MagicLinkOutcome = { result?: "sent" | "unregistered" | "later" };
export const magicLinkOutcome = new AsyncLocalStorage<MagicLinkOutcome>();

// Emails currently being sent. Only tests and process shutdown wait for completion.
const pending = new Set<Promise<void>>();
export async function settleMagicLinkMail(): Promise<void> {
  await Promise.allSettled([...pending]);
}

// Rate-limit keys and logged recipients use HMAC-SHA256 of the email address, not the address itself, keeping personal data out of tables and logs. Unknown-address requests are also counted,
// so anyone can create address entries in the table. Log only the prefix. Derive the key from BETTER_AUTH_SECRET with HKDF using distinct info for this purpose,
// preventing readers of the table or logs from hashing candidate addresses to match them, as they could with unkeyed SHA-256.
const ADDRESS_HKDF_INFO = "tomola magic-link address v1";
const addressKeys = new Map<string, Buffer>();
export function addressHasher(secret: string): (email: string) => string {
  let key = addressKeys.get(secret);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, "", ADDRESS_HKDF_INFO, 32));
    addressKeys.set(secret, key);
  }
  const hmacKey = key;
  return (email) => createHmac("sha256", hmacKey).update(email, "utf8").digest("hex");
}

// Magic-link delivery (Better Auth's sendMagicLink). Both the Better Auth HTTP endpoint (/api/auth/sign-in/magic-link,
// closed by app/lib/auth/endpoints.server.ts) and direct auth.api calls must pass through here.
//   Before returning, while the caller waits: count email/IP pairs, recipients and source IPs. Obtain the IP according to trusted-proxy settings
//   (app/lib/http/client-ip.server.ts); omit the per-IP limit if unavailable. Count rejected requests too, then return immediately.
//   Afterward, without waiting: check the recipient (existing user or valid invitation), compose the email, and send it.
// To prevent response timing from revealing membership, run the same counter updates before returning for every address.
// If rate-limited or the recipient is unknown, send nothing and throw no exception, so the caller responds as if sent. Only record the outcome.
// The login screens are the exception: they say whether the address is registered (app/lib/auth/login-request.server.ts checks that first, behind its own
// per-source allowance), and they run this inside magicLinkOutcome, so the result is recorded for them and the mail is awaited. Callers outside it keep the behaviour above.
// Before calling sendMagicLink, Better Auth writes a verification row with the token hash as identifier (with the plugin's magic-link: namespace) and the email address as value.
// Delete that row when not sending, since anyone could otherwise leave rows for unknown addresses. Sent rows remain until the token is consumed or expires after 15 minutes
// (hitRateLimit removes expired rows).
export function createMagicLinkSender(deps: {
  db: Db;
  baseURL: string;
  // BETTER_AUTH_SECRET, from which the recipient HMAC key is derived.
  secret: string;
  mailer: () => Mailer;
  now?: () => Date;
  // Recipient check, replaceable in tests.
  isKnown?: (db: Db, email: string, now: Date) => Promise<boolean>;
  // Where the stand-in mail for a held address goes (see below); defaults to MAIL_DECOY_TO.
  decoyTo?: () => string | null;
}): SendMagicLink {
  const addressHash = addressHasher(deps.secret);
  const tag = (email: string) => addressHash(email).slice(0, 8);
  return async ({ email: rawEmail, token, metadata }, ctx) => {
    const { db } = deps;
    const now = deps.now?.() ?? new Date();
    const email = normalizeEmail(rawEmail);
    const ip = ctx?.headers ? clientAddress(ctx.headers) : ctx?.request ? clientAddress(ctx.request) : null;
    const byPair = await hitRateLimit(db, { key: `magic-link:email-ip:${addressHash(`${email}:${ip ?? "unknown"}`)}`, ...MAGIC_LINK_EMAIL_IP_LIMIT, now });
    const byIp = ip === null ? null : await hitRateLimit(db, { key: `magic-link:ip:${ip}`, ...MAGIC_LINK_IP_LIMIT, now });
    // A source already denied by its own allowance cannot consume another
    // browser's recipient-wide delivery budget by repeating rejected requests.
    const byEmail = byPair.allowed && (!byIp || byIp.allowed)
      ? await hitRateLimit(db, { key: `magic-link:email:${addressHash(email)}`, ...MAGIC_LINK_EMAIL_LIMIT, now }) : null;
    const limited = !byPair.allowed || (byEmail && !byEmail.allowed) ? "address" : byIp && !byIp.allowed ? "ip" : null;

    const observed = magicLinkOutcome.getStore();
    // `keepCode` leaves the code rows in place. A held address keeps them so the code screen behaves exactly as it does for an ordinary invited address.
    const cleanup = async (keepCode = false) => {
      const identifiers = [`magic-link:${hashMagicLinkToken(token)}`, browserBindingIdentifier(token), magicLinkNextIdentifier(token)];
      if (observed && !keepCode && validBrowserNonce(metadata?.codeId)) identifiers.push(loginCodeIdentifier(metadata.codeId), loginCodeLinkIdentifier(token));
      try {
        await db.delete(verification).where(inArray(verification.identifier, identifiers));
      } catch (error) {
        console.error("[magic-link] could not remove the unused token");
      }
    };
    // A screen that asked for the outcome is told "later" without a code being prepared; the others still prepare one so nothing differs by recipient.
    if (observed && limited) {
      console.warn(`[magic-link] not sent: rate limited (${limited}) address=${tag(email)} ip=${ip ?? "unknown"}`);
      await cleanup();
      observed.result = "later";
      return;
    }

    // Prepare a code even for unknown/rate-limited recipients, before checking
    // eligibility. The requesting page receives no recipient-dependent result.
    const code = !isDeletedIdentity(undefined, email) && validBrowserNonce(metadata?.browserNonce) && validBrowserNonce(metadata?.codeId)
      ? await issueLoginCode(db, { id: metadata.codeId, email, token, nonce: metadata.browserNonce, secret: deps.secret })
      : null;
    let held = false;
    const job: Promise<void> = (async () => {
      const refuse = async (why: string) => {
        console.warn(`[magic-link] not sent: ${why} address=${tag(email)} ip=${ip ?? "unknown"}`);
        await cleanup();
      };
      try {
        if (limited) return await refuse(`rate limited (${limited})`);
        if (isDeletedIdentity(undefined, email) || !(await (deps.isKnown ?? isKnownAddress)(db, email, now))) {
          await refuse("no member or invitation");
          if (observed) observed.result = "unregistered";
          return;
        }
        // The address of a member who left while suspended may be invited but cannot register. Nothing is mailed to it, and it is not logged (not even a hash). The screens still say
        // "sent", and the sender takes the same path and the same wait as for any invited address: one ordinary-looking login mail (same sender, subject kind and size, a code and link
        // that are not real) goes to a decoy address that the provider accepts and does not deliver. The credential, the browser binding and the return row are dropped, so no
        // code or link can ever complete a login for this address; the code rows stay, so the code screen answers as it does for an ordinary address.
        if (await isSuspendedDeletedAddress(db, email, now)) {
          held = true;
          console.warn(`[magic-link] not sent: address held after a suspended departure ip=${ip ?? "unknown"}`);
          await cleanup(true);
          const decoy = (deps.decoyTo ?? mailDecoyTo)();
          if (!decoy) throw new Error("MAIL_DECOY_TO is not set");
          const locale = mailLocale(metadata?.locale) ?? defaultUiLocale();
          const fakeToken = randomBytes(token.length).toString("base64url").slice(0, token.length);
          const fakeCode = randomInt(1_000_000).toString().padStart(6, "0");
          await deps.mailer().send(magicLinkMail({ to: decoy, url: confirmUrl(deps.baseURL, fakeToken), locale, code: fakeCode, invitation: metadata?.invitation === true }));
          if (observed) observed.result = "sent";
          return;
        }
        const url = confirmUrl(deps.baseURL, token);
        const locale = mailLocale(metadata?.locale) ?? defaultUiLocale();
        await deps.mailer().send(magicLinkMail({ to: email, url, locale, code: code ?? "", invitation: metadata?.invitation === true }));
        if (observed) observed.result = "sent";
      } catch (error) {
        // Synchronous mailer() exceptions reach here too. Keep the caller's response unchanged; only record the delivery failure.
        console.error(held ? "[magic-link] sending failed" : `[magic-link] sending failed for address=${tag(email)}`);
        if (observed) {
          await cleanup();
          observed.result = "later";
        }
      }
    })().finally(() => {
      pending.delete(job);
    });
    pending.add(job);
    // Only a screen that asked for the outcome waits for the provider; every other caller returns at once, as before.
    if (observed) await job;
  };
}
