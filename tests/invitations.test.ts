

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createAuth } from "~/lib/auth/auth.server";
import { invitations, user } from "~/lib/db/schema";
import {
  createInvitation,
  findValidInvitationByToken,
  invitationSenderHandle,
  hashInvitationToken,
  listInvitations,
  markInvitationUsed,
  normalizeEmail,
  pruneExpiredInvitationRecipients,
  revokeInvitation,
} from "~/lib/invitations.server";
import { createProfile } from "~/lib/profiles.server";
import { createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

describe("invitations", () => {
  it("tells the invitation page who sent it, and nothing when there is no sender or no profile", async () => {
    const db = await createTestDb();
    await db.insert(user).values([{ id: "sender", name: "Sender", email: "sender@example.com" }, { id: "bare", name: "Bare", email: "bare@example.com" }]);
    await createProfile(db, "sender", { handle: "aiko", homeArea: "ja" });
    const fromMember = await createInvitation(db, { email: "a@example.com", createdBy: "sender" });
    const fromCli = await createInvitation(db, { email: "b@example.com" });
    const fromBare = await createInvitation(db, { email: "c@example.com", createdBy: "bare" });
    expect(await invitationSenderHandle(db, (await findValidInvitationByToken(db, fromMember.token))!)).toBe("aiko");
    expect(await invitationSenderHandle(db, (await findValidInvitationByToken(db, fromCli.token))!)).toBeNull();
    expect(await invitationSenderHandle(db, (await findValidInvitationByToken(db, fromBare.token))!)).toBeNull();
  });
  it("only lets the issuer or an operator revoke, and never consumes a revoked invitation", async () => {
    const db = await createTestDb();
    await db.insert(user).values([{ id: "issuer", name: "Issuer", email: "issuer@example.com" }, { id: "stranger", name: "Stranger", email: "stranger@example.com" }]);
    const invite = await createInvitation(db, { email: "revoked@example.com", createdBy: "issuer" });
    const [row] = await listInvitations(db, { createdBy: "issuer" });
    expect(await revokeInvitation(db, "stranger", row.id)).toBe(false);
    expect(await findValidInvitationByToken(db, invite.token)).not.toBeNull();
    expect(await revokeInvitation(db, "issuer", row.id)).toBe(true);
    expect(await findValidInvitationByToken(db, invite.token)).toBeNull();
    expect(await markInvitationUsed(db, invite.email)).toBe(0);
    expect((await listInvitations(db, { createdBy: "issuer" }))[0].status).toBe("revoked");
    await createInvitation(db, { email: "operator-revoke@example.com" });
    const other = (await listInvitations(db)).find(r => r.email === "operator-revoke@example.com")!;
    expect(await revokeInvitation(db, "stranger", other.id, { operator: true })).toBe(true);
  });
  it("removes only unused recipient addresses thirty days after expiry", async () => {
    const db = await createTestDb();
    const now = new Date("2030-01-01");
    for (const [email, days] of [["old@example.com", 32], ["used@example.com", 32], ["recent@example.com", 30]] as const) await createInvitation(db, { email, now: new Date(now.getTime() - days * 86400_000), ttlDays: 1 });
    const [used] = await db.select().from(invitations).where(eq(invitations.email, "used@example.com"));
    await db.update(invitations).set({ usedAt: now }).where(eq(invitations.id, used.id));
    await pruneExpiredInvitationRecipients(db, now);
    const rows = await db.select().from(invitations);
    expect(rows.filter(row => row.email === null)).toHaveLength(1);
    expect(rows.find(row => row.id === used.id)?.email).toBe("used@example.com");
    expect(rows.find(row => row.email === "recent@example.com")).toBeDefined();
  });
  it("normalizes email", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
  });

  it("creates an invitation that can be found by token", async () => {
    const db = await createTestDb();
    const inv = await createInvitation(db, { email: "Alice@example.com" });
    expect(inv.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(inv.email).toBe("alice@example.com");
    expect((await findValidInvitationByToken(db, inv.token))?.email).toBe("alice@example.com");
  });

  it("does not return expired invitations", async () => {
    const db = await createTestDb();
    const now = new Date("2026-10-01T00:00:00Z");
    const inv = await createInvitation(db, { email: "b@example.com", ttlDays: 1, now });
    const later = new Date("2026-10-03T00:00:00Z");
    expect(await findValidInvitationByToken(db, inv.token, later)).toBeNull();
  });

  it("does not return used invitations", async () => {
    const db = await createTestDb();
    const inv = await createInvitation(db, { email: "c@example.com" });
    expect(await markInvitationUsed(db, "c@example.com")).toBe(1);
    expect(await findValidInvitationByToken(db, inv.token)).toBeNull();
  });

  it("returns null for unknown tokens", async () => {
    const db = await createTestDb();
    expect(await findValidInvitationByToken(db, "nope")).toBeNull();
  });
});

describe("invitation tokens are stored as hashes", () => {
  it("keeps only the SHA-256 of the token; the plaintext is returned once and is nowhere in the table", async () => {
    const db = await createTestDb();
    const inv = await createInvitation(db, { email: "hash@example.com" });
    const [row] = await db.select().from(invitations).where(eq(invitations.email, "hash@example.com"));
    expect(row.tokenHash).toBe(hashInvitationToken(inv.token));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // Matches SQL sha256 too; the migration uses the same expression.
    const res = (await db.execute(sql`select encode(sha256(convert_to(${inv.token}, 'UTF8')), 'hex') as h`)) as unknown as { rows: Array<{ h: string }> };
    expect(res.rows[0].h).toBe(row.tokenHash);
    expect(JSON.stringify(row)).not.toContain(inv.token);
    // Supplying the stored hash as a token cannot find the invitation.
    expect(await findValidInvitationByToken(db, row.tokenHash)).toBeNull();
    expect((await findValidInvitationByToken(db, inv.token))?.id).toBe(row.id);
  });
});

describe("markInvitationUsed", () => {
  it("uses exactly one valid invitation and says how many it used", async () => {
    const db = await createTestDb();
    await createInvitation(db, { email: "x@example.com" });
    await createInvitation(db, { email: "x@example.com" });
    expect(await markInvitationUsed(db, "X@example.com", { usedBy: "u1" })).toBe(1);
    expect(await markInvitationUsed(db, "x@example.com", { usedBy: "u2" })).toBe(1);
    expect(await markInvitationUsed(db, "x@example.com", { usedBy: "u3" })).toBe(0);
    const rows = await db.select().from(invitations).orderBy(invitations.usedBy);
    expect(rows.map((r) => r.usedBy)).toEqual(["u1", "u2"]);
    expect(rows.every((r) => r.usedAt !== null)).toBe(true);
  });

  it("does not use expired or already used invitations, or another address's", async () => {
    const db = await createTestDb();
    await createInvitation(db, { email: "old@example.com", now: new Date("2020-01-01T00:00:00Z"), ttlDays: 1 });
    await createInvitation(db, { email: "other@example.com" });
    expect(await markInvitationUsed(db, "old@example.com")).toBe(0);
    expect(await markInvitationUsed(db, "nobody@example.com")).toBe(0);
    expect((await db.select().from(invitations).where(eq(invitations.email, "other@example.com")))[0].usedAt).toBeNull();
  });

  it("lets only one of several concurrent callers use a single invitation", async () => {
    const db = await createTestDb();
    await createInvitation(db, { email: "race@example.com" });
    const counts = await Promise.all(Array.from({ length: 8 }, (_, i) => markInvitationUsed(db, "race@example.com", { usedBy: `u${i}` })));
    expect(counts.filter((n) => n === 1)).toHaveLength(1);
    expect(counts.filter((n) => n === 0)).toHaveLength(7);
    const [row] = await db.select().from(invitations);
    expect(row.usedBy).toMatch(/^u[0-7]$/);
  });
});

describe("signing up with an invitation", () => {
  const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
  async function setup() {
    const db = await createTestDb();
    const sent: { email: string; token: string }[] = [];
    const auth = createAuth(db, {
      baseURL: "http://localhost:5173",
      secret: SECRET,
      sendMagicLink: async ({ email, token }) => {
        sent.push({ email, token });
      },
    });
    const link = async (email: string) => {
      await auth.api.signInMagicLink({ body: { email }, headers: new Headers() });
      return sent.at(-1)!.token;
    };
    const verify = (token: string) => auth.api.magicLinkVerify({ query: { token }, headers: new Headers(), asResponse: true });
    return { db, auth, link, verify };
  }

  it("records which user the invitation created, and uses the invitation", async () => {
    const { db, link, verify } = await setup();
    await createInvitation(db, { email: "alice@example.com" });
    expect((await verify(await link("alice@example.com"))).status).toBe(200);
    const [u] = await db.select().from(user).where(eq(user.email, "alice@example.com"));
    const [inv] = await db.select().from(invitations);
    expect(inv.usedBy).toBe(u.id);
    expect(inv.usedAt).not.toBeNull();
  });

  it("creates exactly one user when two links for the same address are verified at the same time, with one invitation", async () => {
    const { db, link, verify } = await setup();
    await createInvitation(db, { email: "race@example.com" });
    const tokens = [await link("race@example.com"), await link("race@example.com")];
    await Promise.allSettled(tokens.map((t) => verify(t)));
    expect(await db.select().from(user).where(eq(user.email, "race@example.com"))).toHaveLength(1);
    const [inv] = await db.select().from(invitations);
    expect(inv.usedBy).not.toBeNull();
  });

  it("creates nobody when the invitation was used up by someone else in between", async () => {
    const { db, link, verify } = await setup();
    await createInvitation(db, { email: "late@example.com" });
    const token = await link("late@example.com");
    expect(await markInvitationUsed(db, "late@example.com")).toBe(1);
    const res = await verify(token);
    expect(res.status).not.toBe(200);
    expect(await db.select().from(user).where(eq(user.email, "late@example.com"))).toHaveLength(0);
  });
});

describe("the operator's invitation list", () => {
  let h: RouteHarness;
  const saved = process.env.OPERATOR_EMAILS;
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja" });
    await h.signIn("somchai", { homeArea: "th", readLangs: ["th"] });
  });
  afterAll(() => {
    h.restore();
    if (saved === undefined) delete process.env.OPERATOR_EMAILS;
    else process.env.OPERATOR_EMAILS = saved;
  });

  it("invitation pages exclude secret tokens from Referer and storage", async () => {
    const expected = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
    expect((await import("~/routes/invite")).headers()).toEqual({ ...expected, "Referrer-Policy": "strict-origin" });
    expect((await import("~/routes/admin-invitations")).headers()).toEqual(expected);
  });

  it("the link a member creates is built from BETTER_AUTH_URL, never from the request's own address", async () => {
    const saved = process.env.BETTER_AUTH_URL;
    try {
      process.env.BETTER_AUTH_URL = "https://forum.example.org/";
      const { action } = await import("~/routes/invites-new");
      const request = new Request("http://evil.example/invites/new", {
        method: "POST",
        headers: { origin: "https://forum.example.org", cookie: h.request("/", { as: "hana" }).headers.get("cookie")! },
        body: new URLSearchParams({ email: "someone@example.com" }),
      });
      const res = (await action(h.args(request))) as { url: string };
      expect(res.url).toMatch(/^https:\/\/forum\.example\.org\/invite\/[A-Za-z0-9_-]{43}$/);
    } finally {
      if (saved === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = saved;
    }
  });

  it("refuses the member's own normalized address without creating an invitation", async () => {
    const { action } = await import("~/routes/invites-new");
    const before = await h.db.select().from(invitations);
    for (const email of ["hana@example.com", " HANA@EXAMPLE.COM "]) {
      expect(await action(h.args(h.request("/invites/new", { as: "hana", form: { email } })))).toEqual({ url: null, error: "self_invitation" });
    }
    expect(await h.db.select().from(invitations)).toEqual(before);
  });

  it("does not disclose whether another invitee is already a member", async () => {
    const { action } = await import("~/routes/invites-new");
    for (const email of ["somchai@example.com", "unknown-invitee@example.com"]) {
      expect(await action(h.args(h.request("/invites/new", { as: "hana", form: { email } })))).toEqual({ url: expect.stringMatching(/\/invite\/[A-Za-z0-9_-]{43}$/), error: null });
    }
  });

  it("is for operators only: visitors go to the login, other members get 404", async () => {
    const { loader } = await import("~/routes/admin-invitations");
    process.env.OPERATOR_EMAILS = "hana@example.com";
    expect(await h.outcome(async () => (await loader(h.args(h.request("/admin/invitations")))))).toMatchObject({ status: 302, location: "/login?next=%2Fadmin%2Finvitations" });
    expect(await h.outcome(async () => (await loader(h.args(h.request("/admin/invitations", { as: "somchai" })))))).toMatchObject({ status: 404 });
    process.env.OPERATOR_EMAILS = "";
    expect(await h.outcome(async () => (await loader(h.args(h.request("/admin/invitations", { as: "hana" })))))).toMatchObject({ status: 404 });
  });

  it("limits a member's invitation history to cancellation information, without linking invitees to accounts", async () => {
    const { loader } = await import("~/routes/invites-new");
    await createInvitation(h.db, { email: "private-invitee@example.com", createdBy: h.ids.hana });
    await markInvitationUsed(h.db, "private-invitee@example.com", { usedBy: h.ids.somchai });
    const result = await loader(h.args(h.request("/invites/new", { as: "hana" })));
    const row = result.invitations.find(invitation => invitation.email === "private-invitee@example.com")!;
    expect(row).toMatchObject({ id: expect.any(String), email: "private-invitee@example.com", status: "used" });
    expect(row).not.toHaveProperty("usedByHandle");
    expect(row).not.toHaveProperty("usedByExists");
    expect(JSON.stringify(row)).not.toContain("somchai");
  });

  it("lists who invited whom, the dates, and who used each invitation — never the links", async () => {
    const { loader } = await import("~/routes/admin-invitations");
    process.env.OPERATOR_EMAILS = "hana@example.com";
    const hana = h.ids.hana;
    const valid = await createInvitation(h.db, { email: "new@example.com", createdBy: hana, now: new Date(Date.now() + 1000) });
    await createInvitation(h.db, { email: "cli@example.com", now: new Date("2020-01-01T00:00:00Z"), ttlDays: 1 });
    const res = await h.outcome(async () => (await loader(h.args(h.request("/admin/invitations", { as: "hana" })))));
    expect(res.status).toBe(200);
    const rows = (res.value as { rows: Awaited<ReturnType<typeof listInvitations>> }).rows;
    const byEmail = Object.fromEntries(rows.map((r) => [r.email, r]));
    expect(byEmail["new@example.com"]).toMatchObject({ inviterHandle: "hana", status: "valid", usedAt: null, usedByHandle: null });
    expect(byEmail["cli@example.com"]).toMatchObject({ inviterHandle: null, status: "expired" });
    // The invitation consumed by signIn() has used_by pointing to that user and includes the handle.
    expect(byEmail["somchai@example.com"]).toMatchObject({ status: "used", usedByHandle: "somchai", usedByExists: true });
    expect(byEmail["hana@example.com"]).toMatchObject({ status: "used", usedByHandle: "hana" });
    // Newest first.
    expect(rows[0].email).toBe("new@example.com");
    expect(JSON.stringify(res.value)).not.toContain(valid.token);
  });

  it("tells apart a user with no display name yet and an invitation used without any account", async () => {
    const { db } = h;
    await createInvitation(db, { email: "noprofile@example.com" });
    await createInvitation(db, { email: "ghost@example.com" });
    await db.insert(user).values({ id: "np", name: "", email: "noprofile@example.com", emailVerified: true });
    expect(await markInvitationUsed(db, "noprofile@example.com", { usedBy: "np" })).toBe(1);
    expect(await markInvitationUsed(db, "ghost@example.com", { usedBy: "missing-user" })).toBe(1);
    const rows = await listInvitations(db);
    const byEmail = Object.fromEntries(rows.map((r) => [r.email, r]));
    expect(byEmail["noprofile@example.com"]).toMatchObject({ status: "used", usedByHandle: null, usedByExists: true });
    expect(byEmail["ghost@example.com"]).toMatchObject({ status: "used", usedByHandle: null, usedByExists: false });
    await createProfile(db, "np", { handle: "np", homeArea: "ja", readLangs: ["ja"] });
    expect((await listInvitations(db)).find((r) => r.email === "noprofile@example.com")?.usedByHandle).toBe("np");
  });
});
