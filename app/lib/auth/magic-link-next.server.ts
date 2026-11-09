import { createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { verification } from "~/lib/db/schema";
import { safeLocalPath } from "~/lib/display-lang.server";

// A 3,300-code-point share may use twelve URL-encoded characters per code point.
// Keep room for /t/new and parameter names; discard excess without rejecting login.
export const MAGIC_LINK_NEXT_MAX_LENGTH = 40_000;
export const magicLinkNextIdentifier = (token: string) => `magic-link-next:${createHash("sha256").update(token, "utf8").digest("base64url")}`;

export function safeMagicLinkNext(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > MAGIC_LINK_NEXT_MAX_LENGTH) return "/";
  const next = safeLocalPath(raw);
  return next.length <= MAGIC_LINK_NEXT_MAX_LENGTH ? next : "/";
}

// Read the post-login destination only after token verification and the requesting-browser check.
// The expired-link GET uses resumableAiConnection instead, checking the browser binding and the AI request's signature before exposing a return link.
export async function readMagicLinkNext(db: Db, token: string): Promise<string> {
  const [row] = await db.select({ value: verification.value }).from(verification)
    .where(and(eq(verification.identifier, magicLinkNextIdentifier(token)), gt(verification.expiresAt, new Date())));
  return safeMagicLinkNext(row?.value);
}

// Whether the destination saved for a login link is the login of an AI connection (/mcp/login), answered as a yes or no only: the destination itself carries the AI's signed request
// and is never shown to a browser other than the one that asked. Expiry is not checked, so a link that has run out can still be told apart.
export async function magicLinkNextIsAiConnection(db: Db, token: string): Promise<boolean> {
  const [row] = await db.select({ value: verification.value }).from(verification).where(eq(verification.identifier, magicLinkNextIdentifier(token)));
  return typeof row?.value === "string" && row.value.startsWith("/mcp/login?");
}
