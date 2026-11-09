import { randomBytes } from "node:crypto";
import { magicLinkBrowser, readBrowserNonce, validBrowserNonce } from "./magic-link-browser.server";
import { parseEmail } from "~/lib/email";
function cookieName(request: Request, suffix = "code") {
  const prefix = new URL(request.url).protocol === "https:" ? "__Host-" : "";
  return `${prefix}tomola.login-${suffix}`;
}
function cookie(request: Request, suffix: string, value: string, maxAge = 900) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${cookieName(request, suffix)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
export function pendingLoginCode(request: Request): { id: string; nonce: string } | null {
  const prefix = `${cookieName(request)}=`;
  const cookies = (request.headers.get("cookie") ?? "").split(";").map(c => c.trim()).filter(c => c.startsWith(prefix));
  const id = cookies.length === 1 ? cookies[0].slice(prefix.length) : null;
  const nonce = readBrowserNonce(request);
  return validBrowserNonce(id) && nonce ? { id, nonce } : null;
}
// This cookie remembers only submitted input and a resend notice, never credentials.
export function rememberedLoginEmail(request: Request): { email: string; resent: boolean } | null {
  const prefix = `${cookieName(request, "email")}=`;
  const values = (request.headers.get("cookie") ?? "").split(";").map(c => c.trim()).filter(c => c.startsWith(prefix));
  if (values.length !== 1 || values[0].length > 2048) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(values[0].slice(prefix.length)));
    if (!value || typeof value !== "object" || !("email" in value) || typeof value.email !== "string" || !("resent" in value) || typeof value.resent !== "boolean") return null;
    const email = parseEmail(value.email);
    return email ? { email, resent: value.resent } : null;
  } catch { return null; }
}
export function clearLoginCodeCookies(request: Request, headers: Headers) {
  headers.append("Set-Cookie", cookie(request, "code", "", 0));
  headers.append("Set-Cookie", cookie(request, "email", "", 0));
}
export function prepareLoginCode(request: Request, email: string, resent = false) {
  const address = parseEmail(email);
  if (!address) throw new Error("Invalid login email");
  const browser = magicLinkBrowser(request);
  const id = randomBytes(32).toString("base64url");
  return { browser, id, cookie: cookie(request, "code", id), emailCookie: cookie(request, "email", encodeURIComponent(JSON.stringify({ email: address, resent }))) };
}
