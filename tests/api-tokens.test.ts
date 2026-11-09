import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { apiTokens, user } from "~/lib/db/schema";
import {
  authenticateToken,
  createApiToken,
  generateToken,
  hashToken,
  LAST_USED_INTERVAL_MS,
  listApiTokens,
  MAX_ACTIVE_TOKENS,
  revokeApiToken,
  tokenKindOf,
} from "~/lib/tokens.server";
import { addMember, createTestDb } from "./helpers/db";

const t0 = new Date("2026-10-01T00:00:00Z");

async function setup() {
  const db = await createTestDb();
  await addMember(db, "u1", "hana");
  await addMember(db, "u2", "somchai");
  return db;
}

describe("token format", () => {
  it("is tml_<kind>_<43 chars of base64url> and differs every time", () => {
    const a = generateToken("read");
    const b = generateToken("read");
    expect(a).toMatch(/^tml_read_[A-Za-z0-9_-]{43}$/);
    expect(generateToken("draft")).toMatch(/^tml_draft_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(tokenKindOf(a)).toBe("read");
    expect(tokenKindOf(generateToken("draft"))).toBe("draft");
    for (const bad of ["", "tml_read_short", `tml_write_${"a".repeat(43)}`, `${a}x`, `x${a}`, a.replace("tml_read_", "tml_read_!")]) expect(tokenKindOf(bad), bad).toBeNull();
  });

  it("hashes with SHA-256 in hex", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("createApiToken, listApiTokens and revokeApiToken", () => {
  it("returns the plaintext once and stores only its hash", async () => {
    const db = await setup();
    const res = await createApiToken(db, "u1", { name: "  my laptop ", kind: "read" }, { now: t0 });
    if (!res.ok) throw new Error(res.error);
    expect(res.token).toMatch(/^tml_read_/);
    expect(res.summary).toMatchObject({ name: "my laptop", kind: "read", createdAt: t0, lastUsedAt: null, revokedAt: null });
    const rows = await db.select().from(apiTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashToken(res.token));
    expect(JSON.stringify(rows[0])).not.toContain(res.token);
    // The list contains no plaintext token.
    const listed = await listApiTokens(db, "u1");
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(res.token);
    expect(await listApiTokens(db, "u2")).toEqual([]);
  });

  it("validates the name and the kind", async () => {
    const db = await setup();
    for (const name of ["", "   ", "a\nb", "a\u0000b", "x".repeat(61), 5, null, undefined]) {
      expect(await createApiToken(db, "u1", { name, kind: "read" }), String(name)).toEqual({ ok: false, error: "invalid_name" });
    }
    expect((await createApiToken(db, "u1", { name: "x".repeat(60), kind: "read" })).ok).toBe(true);
    for (const kind of ["write", "", "READ", undefined, 1]) expect(await createApiToken(db, "u1", { name: "n", kind })).toEqual({ ok: false, error: "invalid_kind" });
    expect(await createApiToken(db, "ghost", { name: "n", kind: "read" })).toEqual({ ok: false, error: "no_member" });
  });

  it("allows at most 20 active tokens per user; revoked ones do not count", async () => {
    const db = await setup();
    const tokens: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_TOKENS; i++) {
      const res = await createApiToken(db, "u1", { name: `t${i}`, kind: i % 2 ? "draft" : "read" });
      if (!res.ok) throw new Error(res.error);
      tokens.push(res.token);
    }
    expect(MAX_ACTIVE_TOKENS).toBe(20);
    expect(await createApiToken(db, "u1", { name: "one too many", kind: "read" })).toEqual({ ok: false, error: "too_many_tokens" });
    // Other members are unaffected.
    expect((await createApiToken(db, "u2", { name: "mine", kind: "read" })).ok).toBe(true);
    const [first] = await listApiTokens(db, "u1");
    expect(await revokeApiToken(db, "u1", first.id)).toBe(true);
    expect((await createApiToken(db, "u1", { name: "after revoke", kind: "read" })).ok).toBe(true);
    expect(await createApiToken(db, "u1", { name: "full again", kind: "read" })).toEqual({ ok: false, error: "too_many_tokens" });
  });

  it("does not exceed the limit when two creations race at 19 tokens", async () => {
    const db = await setup();
    for (let i = 0; i < MAX_ACTIVE_TOKENS - 1; i++) await createApiToken(db, "u1", { name: `t${i}`, kind: "read" });
    const results = await Promise.all([createApiToken(db, "u1", { name: "a", kind: "read" }), createApiToken(db, "u1", { name: "b", kind: "read" })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await listApiTokens(db, "u1")).filter((t) => t.revokedAt === null)).toHaveLength(MAX_ACTIVE_TOKENS);
  });

  it("revokes only the owner's own token (IDOR): someone else's id, a missing id and a repeat change nothing", async () => {
    const db = await setup();
    const mine = await createApiToken(db, "u1", { name: "mine", kind: "read" });
    if (!mine.ok) throw new Error(mine.error);
    // u2 cannot revoke u1's token even knowing its ID.
    expect(await revokeApiToken(db, "u2", mine.summary.id)).toBe(false);
    expect((await authenticateToken(db, mine.token)).ok).toBe(true);
    expect(await revokeApiToken(db, "u1", 999_999)).toBe(false);
    const when = new Date("2026-10-02T00:00:00Z");
    expect(await revokeApiToken(db, "u1", mine.summary.id, { now: when })).toBe(true);
    expect(await authenticateToken(db, mine.token)).toEqual({ ok: false, error: "invalid" });
    // A second revocation does nothing and leaves the revocation timestamp unchanged.
    expect(await revokeApiToken(db, "u1", mine.summary.id, { now: new Date("2026-10-03T00:00:00Z") })).toBe(false);
    expect((await listApiTokens(db, "u1"))[0].revokedAt).toEqual(when);
  });
});

describe("authenticateToken", () => {
  it("accepts the plaintext of an active token and reports its owner and kind", async () => {
    const db = await setup();
    const res = await createApiToken(db, "u1", { name: "reader", kind: "read" });
    if (!res.ok) throw new Error(res.error);
    expect(await authenticateToken(db, res.token)).toEqual({ ok: true, token: { id: res.summary.id, userId: "u1", name: "reader", kind: "read" } });
  });

  it("rejects malformed, unknown and altered tokens without telling them apart", async () => {
    const db = await setup();
    const res = await createApiToken(db, "u1", { name: "reader", kind: "read" });
    if (!res.ok) throw new Error(res.error);
    const altered = res.token.slice(0, -1) + (res.token.endsWith("A") ? "B" : "A");
    for (const bad of ["", "tml_read_", generateToken("read"), altered, res.token.replace("tml_read_", "tml_draft_"), res.token.toUpperCase()]) {
      expect(await authenticateToken(db, bad), bad).toEqual({ ok: false, error: "invalid" });
    }
  });

  it("updates last_used_at at most once a minute", async () => {
    const db = await setup();
    const res = await createApiToken(db, "u1", { name: "reader", kind: "read" }, { now: t0 });
    if (!res.ok) throw new Error(res.error);
    const lastUsed = async () => (await db.select({ at: apiTokens.lastUsedAt }).from(apiTokens).where(eq(apiTokens.id, res.summary.id)))[0].at;
    expect(await lastUsed()).toBeNull();
    const first = new Date(t0.getTime() + 5_000);
    await authenticateToken(db, res.token, { now: first });
    expect(await lastUsed()).toEqual(first);
    // Do not update usage within one minute.
    await authenticateToken(db, res.token, { now: new Date(first.getTime() + 30_000) });
    await authenticateToken(db, res.token, { now: new Date(first.getTime() + LAST_USED_INTERVAL_MS - 1) });
    expect(await lastUsed()).toEqual(first);
    // Update after one minute.
    const later = new Date(first.getTime() + LAST_USED_INTERVAL_MS);
    await authenticateToken(db, res.token, { now: later });
    expect(await lastUsed()).toEqual(later);
  });

  it("stops working when the owner is deleted (cascade)", async () => {
    const db = await setup();
    const res = await createApiToken(db, "u1", { name: "reader", kind: "read" });
    if (!res.ok) throw new Error(res.error);
    await db.delete(user).where(eq(user.id, "u1"));
    expect(await authenticateToken(db, res.token)).toEqual({ ok: false, error: "invalid" });
  });
});
