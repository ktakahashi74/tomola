import { isDeletedIdentity } from "../deleted-member";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomInt, randomUUID } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { rateLimits, verification } from "~/lib/db/schema";
import { hashMagicLinkToken } from "./plugins";
import { addressHasher } from "./magic-link.server";
import { browserNonceDigest, validBrowserNonce } from "./magic-link-browser.server";

export const loginCodeLinkIdentifier = (token: string) => `magic-link-code-link:${hashMagicLinkToken(token)}`;
export const loginCodeIdentifier = (id: string) => `magic-link-code:${id}`;
const key = (nonce: string, code: string) => Buffer.from(hkdfSync("sha256", nonce, code, "tomola login code v1", 32));
type Envelope = { iv: string; tag: string; ciphertext: string; address: string; browser?: string; failures: number };
const DAY_MS = 86_400_000;
// IP comes from clientAddress, including its already normalized IPv6 /64.
// Browser secrets bind decryption, but cannot serve as an abuse budget.
const failureKeys = (value: Envelope, ip: string | null) => ({
  address: `magic-link-code:email:${value.address}`,
  source: `magic-link-code:email-ip:${createHash("sha256").update(`${value.address}:${ip ?? "unknown"}`).digest("hex")}`,
});
async function failureCount(db: Db, key: string, now: Date) {
  const [row] = await db.select({ count: sql<number>`coalesce(sum(${rateLimits.count}), 0)` }).from(rateLimits)
    .where(and(eq(rateLimits.key, key), gt(rateLimits.expiresAt, now)));
  return Number(row.count);
}

// Only the mail composer receives the plaintext code. A database reader cannot
// test guesses without the browser's 256-bit secret.
export async function issueLoginCode(db: Db, input: { id: string; email: string; token: string; nonce: string; secret: string }): Promise<string> {
  if (isDeletedIdentity(undefined, input.email)) throw new Error("Invalid account");
  const code = randomInt(1_000_000).toString().padStart(6, "0");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(input.nonce, code), iv);
  cipher.setAAD(Buffer.from(input.id));
  const ciphertext = Buffer.concat([cipher.update(input.token, "utf8"), cipher.final()]);
  const envelope: Envelope = { iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url"), address: addressHasher(input.secret)(input.email), browser: browserNonceDigest(input.nonce), failures: 0 };
  const [credential] = await db.select().from(verification).where(eq(verification.identifier, `magic-link:${hashMagicLinkToken(input.token)}`));
  await db.insert(verification).values({ id: randomUUID(), identifier: loginCodeIdentifier(input.id), value: JSON.stringify(envelope), expiresAt: credential?.expiresAt ?? new Date(Date.now() + 900_000) });
  await db.insert(verification).values({ id: randomUUID(), identifier: loginCodeLinkIdentifier(input.token), value: input.id, expiresAt: credential?.expiresAt ?? new Date(Date.now() + 900_000) });
  return code;
}

export async function decodeLoginCode(db: Db, input: { id: string; code: string; nonce: string | null; ip: string | null; now?: Date }): Promise<string | null> {
  if (!validBrowserNonce(input.nonce) || !validBrowserNonce(input.id)) return null;
  const nonce = input.nonce;
  const normalized = input.code.length <= 64 ? input.code.replace(/[\s-]/g, "") : "";
  return db.transaction(async tx => {
    const now = input.now ?? new Date();
    const [row] = await tx.select().from(verification).where(eq(verification.identifier, loginCodeIdentifier(input.id))).for("update");
    if (!row || row.expiresAt <= now) return null;
    const value = JSON.parse(row.value) as Envelope;
    const keys = failureKeys(value, input.ip);
    // Different codes and sources must share the recipient's aggregate lock.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${keys.address}, 0))`);
    if (value.failures >= 5 || await failureCount(tx, keys.source, now) >= 20 || await failureCount(tx, keys.address, now) >= 100) return null;
    let token: string | null = null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key(nonce, normalized), Buffer.from(value.iv, "base64url"));
      decipher.setAAD(Buffer.from(input.id));
      decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
      token = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]).toString("utf8");
    } catch { /* A failed authentication tag is an incorrect code or browser. */ }
    if (token !== null) {
      const [credential] = await tx.select().from(verification).where(and(eq(verification.identifier, `magic-link:${hashMagicLinkToken(token)}`), gt(verification.expiresAt, now)));
      return credential && !isDeletedIdentity(undefined, JSON.parse(credential.value).email) ? token : null;
    }
    for (const limitKey of [keys.address, keys.source]) {
      await tx.insert(rateLimits).values({ key: limitKey, windowStart: now, count: 1, expiresAt: new Date(now.getTime() + DAY_MS) })
        .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } });
      await tx.delete(rateLimits).where(and(eq(rateLimits.key, limitKey), lt(rateLimits.expiresAt, now)));
    }
    await tx.update(verification).set({ value: JSON.stringify({ ...value, failures: value.failures + 1 }) }).where(eq(verification.id, row.id));
    return null;
  });
}

// A warning can accompany the generic rejection, with the same counter rules
// for every recipient. Never consult membership when composing an error.
export type LoginCodeLimit = "code" | "address" | null;
export async function loginCodeState(db: Db, id: string, ip: string | null): Promise<{ invalid: boolean; limited: LoginCodeLimit }> {
  const [row] = await db.select().from(verification).where(eq(verification.identifier, loginCodeIdentifier(id)));
  if (!row || row.expiresAt <= new Date()) return { invalid: true, limited: null };
  const value = JSON.parse(row.value) as Envelope;
  const keys = failureKeys(value, ip), now = new Date();
  const limited = await failureCount(db, keys.source, now) >= 20 || await failureCount(db, keys.address, now) >= 100;
  return { invalid: value.failures > 0, limited: limited ? "address" : value.failures >= 5 ? "code" : null };
}
export async function loginCodeLimited(db: Db, id: string, ip: string | null): Promise<LoginCodeLimit> {
  return (await loginCodeState(db, id, ip)).limited;
}
