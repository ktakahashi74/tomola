import { randomUUID } from "node:crypto";
import { isAPIError } from "better-auth/api";
import { inArray, eq } from "drizzle-orm";
import { redirect, redirectDocument } from "react-router";
import { getDb } from "~/lib/db/client.server";
import { verification } from "~/lib/db/schema";
import { getProfile, rememberUiLocale } from "~/lib/profiles.server";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { negotiateUiLocale, uiLocaleCookie } from "~/lib/http/locale.server";
import { getAuth } from "./auth.server";
import { browserBindingIdentifier, matchesMagicLinkBrowser } from "./magic-link-browser.server";
import { magicLinkNextIdentifier, readMagicLinkNext } from "./magic-link-next.server";
import { loginCodeIdentifier, loginCodeLinkIdentifier } from "./login-code.server";
import { clearLoginCodeCookies } from "./login-code-cookie.server";
import { clearReadingReturn } from "./reading-return.server";
import { hashMagicLinkToken } from "./plugins";
export const LOGIN_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "strict-origin", "X-Robots-Tag": "noindex" };
export const magicLinkUsedIdentifier = (token: string) => `magic-link-used:${hashMagicLinkToken(token)}`;
export const magicLinkOwnerHash = (userId: string) => hashMagicLinkToken(userId);
const confirmations = new Map<string, Promise<void>>();

export async function waitForMagicLinkCompletion(token: string): Promise<boolean> {
  const pending = confirmations.get(magicLinkUsedIdentifier(token));
  if (!pending) return false;
  await pending;
  return true;
}

// Both entry points use Better Auth's atomic token consumption. A simultaneous
// link/code request can create only one session, even on separate connections.
export async function completeMagicLink(request: Request, token: string): Promise<Response | null> {
  // Serialize local confirmations through marker insertion as well as token use.
  // Better Auth still enforces atomic consumption across separate processes.
  const key = magicLinkUsedIdentifier(token);
  const previous = confirmations.get(key);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  confirmations.set(key, pending);
  try {
    await previous;
    return await verifyMagicLink(request, token);
  } finally {
    release();
    if (confirmations.get(key) === pending) confirmations.delete(key);
  }
}

async function verifyMagicLink(request: Request, token: string): Promise<Response | null> {
  const db = await getDb();
  if (!(await matchesMagicLinkBrowser(db, request, token))) return null;
  const [credential] = await db.select({ expiresAt: verification.expiresAt }).from(verification)
    .where(eq(verification.identifier, `magic-link:${hashMagicLinkToken(token)}`));
  if (!credential || credential.expiresAt <= new Date()) return null;
  let res: Response;
  try {
    res = await (await getAuth()).api.magicLinkVerify({ query: { token }, headers: request.headers, request, asResponse: true });
  } catch (error) { if (isAPIError(error)) return null; throw error; }
  if (res.status !== 200) return null;
  const body = await res.json() as { user?: { id?: unknown } };
  if (typeof body.user?.id !== "string") return null;
  // Retain hashes for the token and its owner, without raw IDs or destinations.
  await db.insert(verification).values({ id: randomUUID(), identifier: magicLinkUsedIdentifier(token), value: magicLinkOwnerHash(body.user.id), expiresAt: new Date(credential.expiresAt.getTime() + 86_400_000) });
  const headers = new Headers(LOGIN_HEADERS);
  for (const cookie of res.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  clearLoginCodeCookies(request, headers);
  const next = await readMagicLinkNext(db, token);
  const mappings = await db.select().from(verification).where(eq(verification.identifier, loginCodeLinkIdentifier(token)));
  await db.delete(verification).where(inArray(verification.identifier, [browserBindingIdentifier(token), magicLinkNextIdentifier(token), loginCodeLinkIdentifier(token), ...mappings.map(row => loginCodeIdentifier(row.value))]));
  const profile = await getProfile(db, body.user.id);
  if (profile) clearReadingReturn(request, headers);
  const ui = negotiateUiLocale(request, enabledLangs());
  if (profile && (ui.source === "cookie" || ui.source === "accept-language")) {
    await rememberUiLocale(db, body.user.id, profile.uiLocale, ui.locale);
  }
  // Login may introduce an account language unknown to the guest's client runtime.
  const savedUi = negotiateUiLocale(request, enabledLangs(), profile?.uiLocale);
  if (savedUi.source === "profile") headers.append("Set-Cookie", uiLocaleCookie(request, savedUi.locale));
  return (savedUi.locale !== ui.locale ? redirectDocument : redirect)(profile ? next : next === "/" ? "/onboarding" : `/onboarding?${new URLSearchParams({ next })}`, { status: 303, headers });
}
