import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { authSecret } from "~/lib/auth/secret.server";
import type { Db } from "~/lib/db/client.server";
import { verification } from "~/lib/db/schema";
import { canonicalReadResource, verifyOpenInAiToken } from "~/lib/open-in-ai.server";
import { aiOpenLinkExpiresAt, OPEN_IN_AI_TTL_SECONDS } from "~/lib/open-in-ai";
import { siteUrl } from "~/lib/md/urls.server";

export const AI_OPEN_RECEIPT_PREFIX = "ai-open-read:";
const MARKER_PREFIX = "oar1";
const keys = new Map<string, Buffer>();
function mac(message: string, secret: string): Buffer {
  let key = keys.get(secret);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, "", "tomola ai-open receipt v1", 32));
    keys.set(secret, key);
  }
  return createHmac("sha256", key).update(message).digest();
}

function resourceHash(resource: string): string | null {
  let url: URL;
  try { url = new URL(resource, siteUrl("")); } catch { return null; }
  // The marker is inert and cannot become part of a delegated read credential.
  if (url.searchParams.getAll("o").length > 1 || url.searchParams.has("k")) return null;
  url.searchParams.delete("o");
  const canonical = canonicalReadResource(url.href);
  return canonical === null ? null : createHash("sha256").update(siteUrl(canonical)).digest("hex");
}

// A random, resource-bound receipt capability, with no identity and no read rights.
export function signAiOpenMarker(resource: string, opts: { now?: Date; secret?: string } = {}): string {
  const digest = resourceHash(resource);
  if (digest === null) throw new RangeError("Invalid read resource");
  const expiry = Math.floor((opts.now ?? new Date()).getTime() / 1000) + OPEN_IN_AI_TTL_SECONDS;
  const message = `${MARKER_PREFIX}.${expiry}.${randomBytes(24).toString("base64url")}.${digest}`;
  return `${message}.${mac(message, opts.secret ?? authSecret()).toString("base64url")}`;
}

export function verifyAiOpenMarker(marker: string, resource: string, opts: { now?: Date; secret?: string } = {}): Date | null {
  if (marker.length > 512) return null;
  const parts = marker.split(".");
  if (parts.length !== 5) return null;
  const [prefix, expiry, nonce, digest, signature] = parts;
  if (prefix !== MARKER_PREFIX || !/^\d{1,12}$/.test(expiry) || !/^[A-Za-z0-9_-]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(digest)) return null;
  const given = Buffer.from(signature, "base64url");
  const expected = mac(parts.slice(0, -1).join("."), opts.secret ?? authSecret());
  if (given.toString("base64url") !== signature || given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Number(expiry) <= now || Number(expiry) > now + OPEN_IN_AI_TTL_SECONDS + 60 || resourceHash(resource) !== digest) return null;
  return new Date(Number(expiry) * 1000);
}

function receiptId(capability: string): string {
  return `${AI_OPEN_RECEIPT_PREFIX}${createHash("sha256").update(capability).digest("hex")}`;
}

// Caller has already authenticated the signed read key or verified a public marker.
// A deterministic primary key makes repeats and concurrent reads one row. No identity
// or request metadata is stored; ordinary verification expiry cleanup removes it.
export async function rememberAiOpenRead(db: Db, capability: string, expiresAt: Date): Promise<void> {
  const identifier = receiptId(capability);
  await db.insert(verification).values({ id: identifier, identifier, value: "read", expiresAt }).onConflictDoNothing({ target: verification.id });
}

export async function aiOpenWasRead(db: Db, link: string, opts: { now?: Date; secret?: string } = {}): Promise<boolean> {
  if (link.length > 8192) return false;
  let url: URL;
  try { url = new URL(link); } catch { return false; }
  if (url.origin !== new URL(siteUrl("")).origin || url.username || url.password || url.hash) return false;
  const key = url.searchParams.get("k");
  const marker = url.searchParams.get("o");
  if ((key !== null) === (marker !== null)) return false;
  if (key !== null) {
    if (!(await verifyOpenInAiToken(db, key, { ...opts, resource: link })).ok) return false;
  } else if (!verifyAiOpenMarker(marker!, link, opts)) return false;
  const [row] = await db.select({ id: verification.id }).from(verification).where(and(eq(verification.id, receiptId(key ?? marker!)), gt(verification.expiresAt, opts.now ?? new Date()))).limit(1);
  return row !== undefined;
}

export function signedAiOpenExpiry(link: string): Date {
  // Only called after authenticateRead has validated this delegated key.
  return new Date(aiOpenLinkExpiresAt(link)!);
}
