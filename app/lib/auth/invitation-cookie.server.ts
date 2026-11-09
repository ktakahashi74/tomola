import { createHmac, timingSafeEqual } from "node:crypto";
import { authSecret } from "./secret.server";

export const INVITATION_COOKIE_TTL_SECONDS = 3600;
type BrowserRequest = Pick<Request, "url" | "headers">;
export function invitationCookieName(request: BrowserRequest): string {
  return `${new URL(request.url).protocol === "https:" ? "__Host-" : ""}tomola.invitation`;
}
function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`signup-invitation:${payload}`).digest("base64url");
}
function cookie(request: BrowserRequest, value: string, maxAge: number): string {
  return `${invitationCookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export function invitationCookie(request: BrowserRequest, id: string, secret = authSecret(), now = new Date()): string {
  const payload = `${id}.${Math.floor(now.getTime() / 1000) + INVITATION_COOKIE_TTL_SECONDS}`;
  return cookie(request, `${payload}.${signature(payload, secret)}`, INVITATION_COOKIE_TTL_SECONDS);
}
export function clearInvitationCookie(request: BrowserRequest, headers: Headers): void {
  headers.append("Set-Cookie", cookie(request, "", 0));
}
// Reject duplicates and enforce the signed expiry on the server, even if a client
// retains a cookie beyond Max-Age. The cookie carries no address or invite token.
export function readInvitationCookie(request: BrowserRequest, secret = authSecret(), now = new Date()): string | null {
  const prefix = `${invitationCookieName(request)}=`;
  const values = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(prefix));
  if (values.length !== 1 || values[0].length > 256) return null;
  const match = /^([a-f0-9-]{36})\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(values[0].slice(prefix.length));
  if (!match) return null;
  const [, id, expiry, supplied] = match;
  const seconds = Math.floor(now.getTime() / 1000);
  if (Number(expiry) <= seconds || Number(expiry) > seconds + INVITATION_COOKIE_TTL_SECONDS) return null;
  const expected = signature(`${id}.${expiry}`, secret);
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) ? id : null;
}
