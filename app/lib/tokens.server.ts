import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { apiTokens, API_TOKEN_KINDS, profiles } from "~/lib/db/schema";
import { MAX_ACTIVE_TOKENS, TOKEN_NAME_MAX } from "~/lib/token-limits";

// API tokens for reading and drafts. Plaintext is tml_<kind>_<32-random-bytes-as-base64url-43-characters>, shown only once at creation.
// Store only SHA-256 (hex) in the DB. Tokens are high-entropy random values, so they do not need slow password-style hashing
// (and lookup by hash does not reveal plaintext through comparison timing).
export type ApiTokenKind = (typeof API_TOKEN_KINDS)[number];

export { MAX_ACTIVE_TOKENS, TOKEN_NAME_MAX };
// Update last_used_at at most once per token per interval (one minute), rather than writing on every read.
export const LAST_USED_INTERVAL_MS = 60_000;

const TOKEN_PATTERN = /^tml_(read|draft)_[A-Za-z0-9_-]{43}$/;

export function isApiTokenKind(x: unknown): x is ApiTokenKind {
  return typeof x === "string" && (API_TOKEN_KINDS as readonly string[]).includes(x);
}

export function generateToken(kind: ApiTokenKind): string {
  return `tml_${kind}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

// Determine the kind from the plaintext shape. Return null for malformed input without querying the DB.
export function tokenKindOf(plaintext: string): ApiTokenKind | null {
  const match = TOKEN_PATTERN.exec(plaintext);
  return match ? (match[1] as ApiTokenKind) : null;
}

export type ApiTokenSummary = {
  id: number;
  name: string;
  kind: ApiTokenKind;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
};

function toSummary(row: typeof apiTokens.$inferSelect): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ApiTokenKind,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
  };
}

export type TokenError = "invalid_name" | "invalid_kind" | "invalid_expiry" | "too_many_tokens" | "no_member";

// Names must be nonempty single lines, at most 60 characters, with no control characters or newlines.
function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().normalize("NFC");
  if (name === "" || [...name].length > TOKEN_NAME_MAX || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) return null;
  return name;
}

// Create a token. Return plaintext only here; do not store it. Return too_many_tokens if MAX_ACTIVE_TOKENS valid tokens already exist.
// Count and insert in one transaction while locking the member's profile row so concurrent creation cannot exceed the limit.
export async function createApiToken(
  db: Db,
  userId: string,
  input: { name: unknown; kind: unknown; expiresInDays?: unknown },
  opts: { now?: Date } = {},
): Promise<{ ok: true; token: string; summary: ApiTokenSummary } | { ok: false; error: TokenError }> {
  const name = cleanName(input.name);
  if (name === null) return { ok: false, error: "invalid_name" };
  if (!isApiTokenKind(input.kind)) return { ok: false, error: "invalid_kind" };
  const kind = input.kind;
  const days = input.expiresInDays === undefined ? 90 : input.expiresInDays === null || input.expiresInDays === "none" ? null : [30, 90, 365, "30", "90", "365"].includes(input.expiresInDays as number) ? Number(input.expiresInDays) : NaN;
  if (days !== null && !Number.isFinite(days)) return { ok: false, error: "invalid_expiry" };
  const now = opts.now ?? new Date();
  const expiresAt = days === null ? null : new Date(now.getTime() + days * 86400_000);
  const token = generateToken(kind);
  return db.transaction(async (tx) => {
    const [member] = await tx.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (!member) return { ok: false as const, error: "no_member" as const };
    const [active] = await tx
      .select({ n: count() })
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now))));
    if (Number(active.n) >= MAX_ACTIVE_TOKENS) return { ok: false as const, error: "too_many_tokens" as const };
    const [row] = await tx
      .insert(apiTokens)
      .values({ userId, name, kind, tokenHash: hashToken(token), createdAt: now, expiresAt })
      .returning();
    return { ok: true as const, token, summary: toSummary(row) };
  });
}

// The member's own tokens, including revoked ones, newest first.
export async function listApiTokens(db: Db, userId: string): Promise<ApiTokenSummary[]> {
  const rows = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
  return rows.map(toSummary);
}

// Revoke the member's own token. For another member's token, a missing id, or an already revoked token, do nothing and return false without exposing existence.
export async function revokeApiToken(db: Db, userId: string, tokenId: number, opts: { now?: Date } = {}): Promise<boolean> {
  const rows = await db
    .update(apiTokens)
    .set({ revokedAt: opts.now ?? new Date() })
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  return rows.length > 0;
}

// Operator revocation of all a member's tokens, both read and draft, for compromise response. Leave already revoked tokens intact; return the number revoked.
// Invalidate signed 「AIで開く」 links separately by incrementing their generation (revokeOpenInAiLinks in open-in-ai.server.ts).
export async function revokeAllApiTokens(db: Db, userId: string, opts: { now?: Date } = {}): Promise<number> {
  const rows = await db
    .update(apiTokens)
    .set({ revokedAt: opts.now ?? new Date() })
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  return rows.length;
}

export type TokenAuth = { id: number; userId: string; name: string; kind: ApiTokenKind };

// Validate plaintext tokens (valid unless revoked). Return "invalid" without distinguishing malformed, missing, or revoked tokens.
// Update last_used_at on use, at most once per minute. The caller checks the kind (read or draft).
export async function authenticateToken(
  db: Db,
  plaintext: string,
  opts: { now?: Date } = {},
): Promise<{ ok: true; token: TokenAuth } | { ok: false; error: "invalid" }> {
  if (tokenKindOf(plaintext) === null) return { ok: false, error: "invalid" };
  const now = opts.now ?? new Date();
  const [row] = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, hashToken(plaintext)), isNull(apiTokens.revokedAt), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now))));
  if (!row || !isApiTokenKind(row.kind)) return { ok: false, error: "invalid" };
  if (row.lastUsedAt === null || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_INTERVAL_MS) {
    const threshold = new Date(now.getTime() - LAST_USED_INTERVAL_MS);
    // Include the condition in SQL so only one of simultaneous requests writes.
    await db
      .update(apiTokens)
      .set({ lastUsedAt: now })
      .where(and(eq(apiTokens.id, row.id), or(isNull(apiTokens.lastUsedAt), lte(apiTokens.lastUsedAt, threshold))));
  }
  return { ok: true, token: { id: row.id, userId: row.userId, name: row.name, kind: row.kind } };
}
