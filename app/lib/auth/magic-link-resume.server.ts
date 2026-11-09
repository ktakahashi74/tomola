import { eq } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { verification } from "~/lib/db/schema";
import { consentRequestValid } from "~/lib/mcp/consent.server";
import { getAuth } from "./auth.server";
import { matchesMagicLinkBrowser } from "./magic-link-browser.server";
import { magicLinkNextIdentifier } from "./magic-link-next.server";

// The way back to the AI connection a login link was asked for while connecting, for the browser that asked for the link and only while the AI's signed request still verifies.
// Another browser, or a request that has run out, gets nothing: the destination carries the signed request, so it is never handed to a browser that did not ask for the link.
// Normally the AI request expires before the login link. This fallback also covers configurations with a longer request lifetime; the browser binding may already have expired.
export async function resumableAiConnection(db: Db, request: Request, token: string): Promise<string | null> {
  const [row] = await db.select({ value: verification.value }).from(verification).where(eq(verification.identifier, magicLinkNextIdentifier(token)));
  const next = row?.value;
  if (typeof next !== "string" || !next.startsWith("/mcp/login?")) return null;
  if (!(await matchesMagicLinkBrowser(db, request, token, { ignoreExpiry: true }))) return null;
  return await consentRequestValid(await getAuth(), next.slice("/mcp/login?".length)) ? next : null;
}
