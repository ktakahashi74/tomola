import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { verification } from "~/lib/db/schema";

const NONCE_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("base64url");
export const browserBindingIdentifier = (token: string) => `magic-link-browser:${digest(token)}`;
export const browserNonceDigest = digest;
export const validBrowserNonce = (nonce: unknown): nonce is string => typeof nonce === "string" && NONCE_FORMAT.test(nonce);

function cookieName(request: Request): string {
  return new URL(request.url).protocol === "https:" ? "__Host-tomola.magic-link-browser" : "tomola.magic-link-browser";
}

export function readBrowserNonce(request: Request): string | null {
  const prefix = `${cookieName(request)}=`;
  const cookies = (request.headers.get("cookie") ?? "").split(";").map((value) => value.trim()).filter((value) => value.startsWith(prefix));
  if (cookies.length !== 1) return null;
  const value = cookies[0].slice(prefix.length);
  return validBrowserNonce(value) ? value : null;
}

// Reuse a browser secret for outstanding links. Never send it in the email URL,
// page data or HTML. The provider stores only its hash beside each token hash.
export function magicLinkBrowser(request: Request): { nonce: string; cookie: string } {
  const nonce = readBrowserNonce(request) ?? randomBytes(32).toString("base64url");
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return { nonce, cookie: `${cookieName(request)}=${nonce}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900${secure}` };
}

// With ignoreExpiry the binding of a link that has run out still counts, which tells the browser that asked for a link from any other (it never makes the link usable).
export async function matchesMagicLinkBrowser(db: Db, request: Request, token: string, options: { ignoreExpiry?: boolean } = {}): Promise<boolean> {
  const nonce = readBrowserNonce(request);
  if (!nonce) return false;
  const [binding] = await db.select({ value: verification.value }).from(verification)
    .where(and(eq(verification.identifier, browserBindingIdentifier(token)), options.ignoreExpiry ? undefined : gt(verification.expiresAt, new Date())));
  if (!binding || !validBrowserNonce(binding.value)) return false;
  return timingSafeEqual(Buffer.from(binding.value), Buffer.from(browserNonceDigest(nonce)));
}
