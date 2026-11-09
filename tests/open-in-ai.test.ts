import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { profiles, user } from "~/lib/db/schema";
import { OPEN_IN_AI_TTL_SECONDS, revokeOpenInAiLinks, signOpenInAiToken, verifyOpenInAiToken } from "~/lib/open-in-ai.server";
import { addMember, createTestDb } from "./helpers/db";

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const t0 = new Date("2026-10-01T00:00:00Z");
const after = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

async function setup() {
  const db = await createTestDb();
  await addMember(db, "u1", "hana");
  return db;
}
const sign = (over: Partial<Parameters<typeof signOpenInAiToken>[0]> = {}) => signOpenInAiToken({ resource: "/t/1.md", userId: "u1", generation: 0, now: t0, secret: SECRET, ...over });

describe("signed open-in-AI tokens", () => {
  it("has the form oai2 with a resource digest, valid for five minutes", () => {
    const token = sign();
    const [version, userId, expires, generation, digest, signature] = token.split(".");
    expect(version).toBe("oai2");
    expect(userId).toBe("u1");
    expect(Number(expires)).toBe(t0.getTime() / 1000 + OPEN_IN_AI_TTL_SECONDS);
    expect(OPEN_IN_AI_TTL_SECONDS).toBe(300);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(generation).toBe("0");
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Identical input produces the same signature because HMAC is deterministic; different keys produce different signatures.
    expect(sign()).toBe(token);
    expect(sign({ secret: "another-secret-0123456789abcdef0123456789" })).not.toBe(token);
  });

  it("binds followed-post delegation to the unread or all-post view", async () => {
    const db = await setup();
    for (const [resource, other] of [["/following.md", "/following.md?all=1"], ["/following.md?all=1", "/following.md"]]) {
      const token = sign({ resource });
      expect(await verifyOpenInAiToken(db, token, { resource, now: after(60), secret: SECRET })).toMatchObject({ ok: true });
      expect(await verifyOpenInAiToken(db, token, { resource: other, now: after(60), secret: SECRET })).toEqual({ ok: false, error: "scope_mismatch" });
    }
  });

  it("accepts a fresh token and returns the member's profile", async () => {
    const db = await setup();
    const res = await verifyOpenInAiToken(db, sign(), { resource: "/t/1.md", now: after(60), secret: SECRET });
    expect(res).toMatchObject({ ok: true, userId: "u1", profile: { handle: "hana" } });
  });

  it("rejects an expired token (at the expiry itself too) and accepts one second before", async () => {
    const db = await setup();
    const token = sign();
    expect(await verifyOpenInAiToken(db, token, { resource: "/t/1.md", now: after(OPEN_IN_AI_TTL_SECONDS - 1), secret: SECRET })).toMatchObject({ ok: true });
    expect(await verifyOpenInAiToken(db, token, { resource: "/t/1.md", now: after(OPEN_IN_AI_TTL_SECONDS), secret: SECRET })).toEqual({ ok: false, error: "expired" });
    expect(await verifyOpenInAiToken(db, token, { resource: "/t/1.md", now: after(OPEN_IN_AI_TTL_SECONDS + 86_400), secret: SECRET })).toEqual({ ok: false, error: "expired" });
  });

  it("rejects a token whose expiry is further away than the TTL (plus 60 seconds of clock skew), even with a valid signature", async () => {
    const db = await setup();
    // An issuing clock far in the future is rejected even with a valid MAC.
    const far = signOpenInAiToken({ resource: "/t/1.md", userId: "u1", generation: 0, now: after(23 * 24 * 3600), secret: SECRET });
    expect(await verifyOpenInAiToken(db, far, { resource: "/t/1.md", now: t0, secret: SECRET })).toEqual({ ok: false, error: "malformed" });
    // Allow up to 60 seconds of clock skew when the issuing clock is slightly ahead.
    const skewed = signOpenInAiToken({ resource: "/t/1.md", userId: "u1", generation: 0, now: after(60), secret: SECRET });
    expect(await verifyOpenInAiToken(db, skewed, { resource: "/t/1.md", now: t0, secret: SECRET })).toMatchObject({ ok: true });
    const tooFar = signOpenInAiToken({ resource: "/t/1.md", userId: "u1", generation: 0, now: after(62), secret: SECRET });
    expect(await verifyOpenInAiToken(db, tooFar, { resource: "/t/1.md", now: t0, secret: SECRET })).toEqual({ ok: false, error: "malformed" });
  });

  it("stops working when the generation is bumped, even within the expiry; new links carry the new generation", async () => {
    const db = await setup();
    const old = sign();
    expect(await revokeOpenInAiLinks(db, "u1")).toBe(true);
    expect((await db.select().from(profiles).where(eq(profiles.userId, "u1")))[0].openInAiGeneration).toBe(1);
    expect(await verifyOpenInAiToken(db, old, { resource: "/t/1.md", now: after(60), secret: SECRET })).toEqual({ ok: false, error: "revoked" });
    expect(await verifyOpenInAiToken(db, sign({ generation: 1 }), { resource: "/t/1.md", now: after(60), secret: SECRET })).toMatchObject({ ok: true });
    expect(await revokeOpenInAiLinks(db, "ghost")).toBe(false);
  });

  it("rejects a tampered user, expiry, generation or signature, and a token made with another key", async () => {
    const db = await setup();
    await addMember(db, "u2", "somchai");
    const token = sign();
    const [version, , expires, generation, digest, signature] = token.split(".");
    const tampered = [
      `${version}.u2.${expires}.${generation}.${digest}.${signature}`,
      `${version}.u1.${Number(expires) + 86_400}.${generation}.${digest}.${signature}`,
      `${version}.u1.${expires}.1.${digest}.${signature}`,
      `${version}.u1.${expires}.${generation}.${digest.startsWith("a") ? "b" : "a"}${digest.slice(1)}.${signature}`,
      `${version}.u1.${expires}.${generation}.${digest}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`,
      sign({ secret: "another-secret-0123456789abcdef0123456789" }),
    ];
    for (const bad of tampered) expect(await verifyOpenInAiToken(db, bad, { resource: "/t/1.md", now: after(60), secret: SECRET }), bad).toEqual({ ok: false, error: "bad_signature" });
  });

  it("rejects malformed tokens", async () => {
    const db = await setup();
    const token = sign();
    const [, , expires, generation, digest, signature] = token.split(".");
    for (const bad of ["", "oai1", "oai1.u1.1.0", "oai2.u1.1.0.x", `oai2..${expires}.${generation}.${digest}.${signature}`, `oai2.u1.x.${generation}.${digest}.${signature}`, `oai2.u1.${expires}.-1.${digest}.${signature}`, `oai2.u1.${expires}.${generation}.${digest}.${signature}=`, `oai2.u1.${expires}.${generation}.!!!`, `tml_read_${"a".repeat(43)}`]) {
      const res = await verifyOpenInAiToken(db, bad, { resource: "/t/1.md", now: after(60), secret: SECRET });
      expect(res.ok, bad).toBe(false);
    }
  });

  it("rejects a token of a user who is no longer a member, or who has no profile", async () => {
    const db = await setup();
    const token = sign();
    await db.delete(profiles).where(eq(profiles.userId, "u1"));
    expect(await verifyOpenInAiToken(db, token, { resource: "/t/1.md", now: after(60), secret: SECRET })).toEqual({ ok: false, error: "no_member" });
    await db.delete(user).where(eq(user.id, "u1"));
    expect(await verifyOpenInAiToken(db, token, { resource: "/t/1.md", now: after(60), secret: SECRET })).toEqual({ ok: false, error: "no_member" });
  });

  it("reads a user id that contains dots", async () => {
    const db = await createTestDb();
    await addMember(db, "a.b.c", "dotty");
    const token = sign({ userId: "a.b.c" });
    expect(await verifyOpenInAiToken(db, token, { resource: "/t/1.md", now: after(60), secret: SECRET })).toMatchObject({ ok: true, userId: "a.b.c" });
  });

  it("binds the exact page, language and filters while allowing equivalent text aliases", async () => {
    const db = await setup();
    const token = sign({ resource: "/t/1.md?page=2&lang=en&sentences=1" });
    const verify = (resource: string) => verifyOpenInAiToken(db, token, { resource, now: after(60), secret: SECRET });
    expect(await verify("/t/1.txt?sentences=1&lang=en&page=2")).toMatchObject({ ok: true });
    for (const resource of ["/t/2.md?page=2&lang=en&sentences=1", "/t/1.md?page=3&lang=en&sentences=1", "/t/1.md?page=2&lang=ja&sentences=1", "/t/1.md?page=2&lang=en", "/t/1.md?page=2&page=2&lang=en&sentences=1", "https://outside.example/t/1.md?page=2&lang=en&sentences=1"]) {
      expect(await verify(resource), resource).toEqual({ ok: false, error: "scope_mismatch" });
    }
  });

  it("rejects the previously accepted broad oai1 format and private resources", async () => {
    const db = await setup();
    expect(await verifyOpenInAiToken(db, sign().replace(/^oai2\./, "oai1."), { resource: "/t/1.md", now: after(60), secret: SECRET })).toEqual({ ok: false, error: "malformed" });
    for (const resource of ["/settings/export", "/settings/stances", "/admin/export", "//outside.example/t/1.md", "/t/1.md?lang=en&lang=ja"]) {
      expect(() => sign({ resource }), resource).toThrow("Invalid read resource");
    }
  });
});
