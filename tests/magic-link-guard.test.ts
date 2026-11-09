import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppAuth } from "~/lib/auth/auth.server";
import { addressHasher, settleMagicLinkMail } from "~/lib/auth/magic-link.server";
import { hashMagicLinkToken } from "~/lib/auth/plugins";
import { cleanupExpiredLimits, hitRateLimit } from "~/lib/rate-limit.server";
import { verification } from "~/lib/db/schema";
import { createMailer } from "~/lib/mail/mail.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { createInvitation } from "~/lib/invitations.server";
import { addMember, createTestDb } from "./helpers/db";
import { user } from "~/lib/db/schema";
import { setTestLocale } from "./stubs/paraglide-runtime";

// Use actual messages/*.json to inspect email URLs; ordinary tests stub messages to empty strings.
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const BASE = "http://localhost:5173";
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";

async function setup(opts: { now?: () => Date } = {}) {
  const db = await createTestDb();
  const box = createMemoryMailbox();
  const mailer = createMailer(box.transport, "tomola <no-reply@example.org>");
  const auth = createAppAuth(db, { baseURL: BASE, secret: SECRET, mailer: () => mailer, now: opts.now });
  // Request headers: X-Forwarded-For supplies the client IP when TRUSTED_PROXY_HOPS=1.
  const request = async (email: string, headers: Record<string, string> = {}) => {
    const res = await auth.api.signInMagicLink({ body: { email }, headers: new Headers(headers) });
    await settleMagicLinkMail();
    return res;
  };
  return { db, box, auth, request };
}

afterEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
  setTestLocale("en");
  vi.restoreAllMocks();
});

describe("who gets a magic link", () => {
  it("does not let one sender exhaust another sender's address/IP allowance, including IPv6 prefixes", async () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    const { db, box, request } = await setup();
    await addMember(db, "limit-owner", "limit_owner", { email: "owner@example.com" });
    for (let i = 0; i < 6; i++) await request("owner@example.com", { "x-forwarded-for": "2001:db8:1:1::1" });
    expect(box.sent).toHaveLength(5);
    await request("owner@example.com", { "x-forwarded-for": "2001:db8:1:1::2" });
    expect(box.sent).toHaveLength(5);
    for (let i = 0; i < 40; i++) await request("owner@example.com", { "x-forwarded-for": "2001:db8:1:1::1" });
    expect(await request("owner@example.com", { "x-forwarded-for": "2001:db8:2:2::1" })).toEqual({ status: true });
    expect(box.sent).toHaveLength(6);
    // The separate aggregate cap still prevents an email flood from many sources.
    for (let i = 0; i < 30; i++) await request("owner@example.com", { "x-forwarded-for": `198.51.100.${i + 1}` });
    expect(box.sent).toHaveLength(30);
  });
  it("sends to an existing member, and the URL in the mail points at the confirm page", async () => {
    const { db, box, request } = await setup();
    await addMember(db, "u1", "hana", { email: "hana@example.com" });
    expect(await request("hana@example.com")).toEqual({ status: true });
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]).toMatchObject({ to: "hana@example.com", from: "tomola <no-reply@example.org>" });
    expect(box.sent[0].text).toMatch(/http:\/\/localhost:5173\/auth\/confirm\?token=[A-Za-z0-9]+/);
  });

  it("sends to a user who has not finished onboarding (they can log in again)", async () => {
    const { db, box, request } = await setup();
    await db.insert(user).values({ id: "u2", name: "", email: "half@example.com", emailVerified: true });
    await request("half@example.com");
    expect(box.sent).toHaveLength(1);
  });

  it("sends to an address with a valid invitation, however the case is written", async () => {
    const { db, box, request } = await setup();
    await createInvitation(db, { email: "new@example.com" });
    await request("New@Example.com");
    expect(box.sent.map((m) => m.to)).toEqual(["new@example.com"]);
  });

  it("sends nothing to strangers, or to addresses whose invitation is expired or used, yet answers the same", async () => {
    const { db, box, request } = await setup();
    await addMember(db, "u1", "hana", { email: "hana@example.com" });
    await createInvitation(db, { email: "old@example.com", now: new Date("2020-01-01T00:00:00Z"), ttlDays: 1 });
    await createInvitation(db, { email: "used@example.com" });
    const { markInvitationUsed } = await import("~/lib/invitations.server");
    await markInvitationUsed(db, "used@example.com");
    const member = await request("hana@example.com");
    box.clear();
    const answers = [];
    for (const email of ["stranger@example.com", "old@example.com", "used@example.com"]) answers.push(await request(email));
    expect(box.sent).toEqual([]);
    // Respond identically to a member request, revealing no membership clue.
    for (const answer of answers) expect(answer).toEqual(member);
  });

  it("does not wait for the mail to be sent, so a member's request is not slower than a stranger's", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana", { email: "hana@example.com" });
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const sent: string[] = [];
    const auth = createAppAuth(db, {
      baseURL: BASE,
      secret: SECRET,
      mailer: () => ({ kind: "memory", from: "x", send: async (m) => (await slow, void sent.push(m.to)) }),
    });
    await expect(auth.api.signInMagicLink({ body: { email: "hana@example.com" }, headers: new Headers() })).resolves.toEqual({ status: true });
    expect(sent).toEqual([]);
    release();
    await settleMagicLinkMail();
    expect(sent).toEqual(["hana@example.com"]);
  });

  it("a failing mail transport is logged but does not change the answer", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana", { email: "hana@example.com" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = createAppAuth(db, { baseURL: BASE, secret: SECRET, mailer: () => ({ kind: "smtp", from: "x", send: async () => Promise.reject(new Error("connection refused")) }) });
    await expect(auth.api.signInMagicLink({ body: { email: "hana@example.com" }, headers: new Headers() })).resolves.toEqual({ status: true });
    await settleMagicLinkMail();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("sending failed");
    expect(error.mock.calls[0]).toHaveLength(1);
    expect(error.mock.calls.flat().join(" ")).not.toContain("hana@example.com");
  });

  it("is enforced inside the Better Auth callback, so the HTTP endpoint would not bypass it either", async () => {
    const { db, box, auth } = await setup();
    await addMember(db, "u1", "hana", { email: "hana@example.com" });
    const post = async (email: string) => {
      const res = await auth.handler(new Request(`${BASE}/api/auth/sign-in/magic-link`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email }) }));
      await settleMagicLinkMail();
      return { status: res.status, body: await res.json() };
    };
    const stranger = await post("stranger@example.com");
    expect(box.sent).toEqual([]);
    const member = await post("hana@example.com");
    expect(box.sent).toHaveLength(1);
    expect(stranger).toEqual(member);
  });
});

describe("rate limits", () => {
  it("allows 5 per address in 15 minutes and sends nothing more, for any spelling of the address", async () => {
    let now = new Date("2026-10-01T00:00:10Z");
    const { db, box, request } = await setup({ now: () => now });
    await addMember(db, "u1", "hana", { email: "hana@example.com" });
    await addMember(db, "u2", "kim", { email: "kim@example.com" });
    const answers = [];
    for (const email of ["hana@example.com", "HANA@example.com", "hana@example.com", "Hana@example.com", "hana@example.com", "hana@example.com", "Hana@Example.com"]) answers.push(await request(email));
    expect(box.sent.filter((m) => m.to === "hana@example.com")).toHaveLength(5);
    // Rate-limited requests get the same response, hiding the limit decision.
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    // Other recipients are unaffected.
    await request("kim@example.com");
    expect(box.sent.filter((m) => m.to === "kim@example.com")).toHaveLength(1);
    // Sending resumes in a new 15-minute window.
    now = new Date("2026-10-01T00:15:05Z");
    await request("hana@example.com");
    expect(box.sent.filter((m) => m.to === "hana@example.com")).toHaveLength(6);
  });

  it("allows 20 per IP in 15 minutes when a trusted proxy reports the address", async () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    const { db, box, request } = await setup({ now: () => new Date("2026-10-01T00:00:10Z") });
    for (let i = 0; i < 22; i++) await addMember(db, `u${i}`, `member${i}`, { email: `m${i}@example.com` });
    for (let i = 0; i < 22; i++) await request(`m${i}@example.com`, { "x-forwarded-for": "198.51.100.9" });
    expect(box.sent).toHaveLength(20);
    // Another IP can send.
    await request("m20@example.com", { "x-forwarded-for": "198.51.100.10" });
    expect(box.sent).toHaveLength(21);
    // Forging extra leftmost X-Forwarded-For values cannot evade limits; use only the rightmost address added by the proxy.
    await request("m21@example.com", { "x-forwarded-for": "203.0.113.77, 198.51.100.9" });
    expect(box.sent).toHaveLength(21);
  });

  it("does not read X-Forwarded-For when no proxy is trusted, and then has no IP to limit by", async () => {
    const { db, box, request } = await setup({ now: () => new Date("2026-10-01T00:00:10Z") });
    for (let i = 0; i < 22; i++) await addMember(db, `u${i}`, `member${i}`, { email: `m${i}@example.com` });
    // With hops=0, ignore forged headers. Without a socket address in this test, no IP limit applies.
    for (let i = 0; i < 22; i++) await request(`m${i}@example.com`, { "x-forwarded-for": "198.51.100.9" });
    expect(box.sent).toHaveLength(22);
  });

  it("keeps no email address in the rate limit table", async () => {
    const { db, request } = await setup();
    await request("anyone@example.com");
    const { rateLimits } = await import("~/lib/db/schema");
    const keys = (await db.select({ key: rateLimits.key }).from(rateLimits)).map((r) => r.key);
    expect(keys).toHaveLength(2);
    expect(keys.some(key => /^magic-link:email:[0-9a-f]{64}$/.test(key))).toBe(true);
    expect(keys.some(key => /^magic-link:email-ip:[0-9a-f]{64}$/.test(key))).toBe(true);
    // Use keyed SHA-256, not an unkeyed hash that permits matching candidate email addresses; a different secret produces a different key.
    const { createHash } = await import("node:crypto");
    const addressKey = keys.find(key => key.startsWith("magic-link:email:"))!;
    expect(addressKey).not.toBe(`magic-link:email:${createHash("sha256").update("anyone@example.com").digest("hex")}`);
    expect(addressHasher(SECRET)("anyone@example.com")).toBe(addressKey.split(":")[2]);
    expect(addressHasher("another-secret-0123456789abcdef0123456789")("anyone@example.com")).not.toBe(addressKey.split(":")[2]);
    expect(addressHasher(SECRET)("anyone@example.com")).not.toBe(addressHasher(SECRET)("someone@example.com"));
  });

  it("counts requests that were refused, and sends nothing for a stranger without using up the member's quota", async () => {
    const { db, box, request } = await setup({ now: () => new Date("2026-10-01T00:00:10Z") });
    await addMember(db, "u1", "hana", { email: "hana@example.com" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 8; i++) await request("hana@example.com");
    expect(box.sent).toHaveLength(5);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0][0])).toContain("rate limited");
    // Do not log plaintext email addresses.
    expect(warn.mock.calls.flat().join(" ")).not.toContain("hana@example.com");
  });
});

describe("the login and invitation screens say what happened to the request", () => {
  it("/login says 'sent' only for a delivered mail, tells a stranger the address is not registered, and says 'later' once the allowance is spent", async () => {
    const { setupRouteHarness } = await import("./helpers/route-harness");
    const h = await setupRouteHarness();
    try {
      const box = createMemoryMailbox();
      const mailer = createMailer(box.transport, "tomola <no-reply@example.org>");
      const g = globalThis as { __tomolaAuth?: Promise<unknown> };
      g.__tomolaAuth = Promise.resolve(createAppAuth(h.db, { baseURL: "http://localhost:5173", secret: SECRET, mailer: () => mailer }));
      await addMember(h.db, "u1", "hana", { email: "hana@example.com" });
      const { action } = await import("~/routes/login");
      const submit = (email: string) => action(h.args(h.request("/login", { form: { email } })));
      setTestLocale("ja");
      const member = await submit("hana@example.com");
      const stranger = await submit("stranger@example.com");
      await settleMagicLinkMail();
      expect(member).toMatchObject({ data: { status: "sent" } });
      expect(stranger).toEqual({ status: "unregistered", email: "stranger@example.com" });
      expect(box.sent.map((m) => m.to)).toEqual(["hana@example.com"]);
      expect(box.sent[0].subject).toBe("tomolaのログイン");
      // Real issuance and delivery bind the emailed token before sending. A
      // same-origin victim click cannot log in without the requesting cookie.
      const { action: confirm } = await import("~/routes/auth-confirm");
      const token = tokenIn(box.sent[0].text);
      const browserCookie = (member as { init: { headers: Headers } }).init.headers.getSetCookie()[0];
      expect(browserCookie).toContain("HttpOnly; SameSite=Lax; Max-Age=900");
      expect(JSON.stringify(member)).not.toContain("browserNonce");
      expect((await h.outcome(() => confirm(h.args(h.request("/auth/confirm", { form: { token } }))))).status).toBe(400);
      expect((await h.outcome(() => confirm(h.args(h.request("/auth/confirm", { form: { token }, headers: { cookie: browserCookie.split(";")[0] } }))))).status).toBe(303);
      for (let i = 0; i < 6; i++) await submit("hana@example.com");
      expect(await submit("hana@example.com")).toEqual({ status: "later", email: "hana@example.com" });
      // Invalid input has a different response, unrelated to membership.
      expect(await submit("not-an-email")).toEqual({ status: "invalid" });
      // The invite page uses the same send guard; a valid invited recipient receives the message.
      setTestLocale("en");
      const invite = await createInvitation(h.db, { email: "new@example.com" });
      const { action: inviteAction } = await import("~/routes/invite");
      const invitation = await inviteAction(h.args(h.request(`/invite/${invite.token}`, { form: {} }), { token: invite.token }));
      expect(invitation).toMatchObject({ data: { sentTo: "new@example.com", error: null } });
      await settleMagicLinkMail();
      expect(box.sent.at(-1)).toMatchObject({ to: "new@example.com", subject: "Signing up for tomola" });
      const invitedToken = tokenIn(box.sent.at(-1)!.text);
      const invitedCookie = (invitation as { init: { headers: Headers } }).init.headers.getSetCookie()[0].split(";")[0];
      expect((await h.outcome(() => confirm(h.args(h.request("/auth/confirm", { form: { token: invitedToken }, headers: { cookie: invitedCookie } }))))).status).toBe(303);
    } finally {
      h.restore();
    }
  });
});

const tokenIn = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)![1];
const verificationRows = async (db: Awaited<ReturnType<typeof createTestDb>>) => db.select().from(verification);

describe("the verification rows Better Auth writes before it calls us", () => {
  it("are removed when nothing is sent: unknown address, expired or used invitation, rate limited", async () => {
    // Better Auth expiry uses the real clock plus 15 minutes. Set the window time to one second after the current 15-minute window starts.
    // A future time would clean up these rows as expired.
    const { db, box, request } = await setup({ now: () => new Date(Math.floor(Date.now() / 900_000) * 900_000 + 1000) });
    await addMember(db, "u1", "hana", { email: "hana@example.com" });
    await createInvitation(db, { email: "old@example.com", now: new Date("2020-01-01T00:00:00Z"), ttlDays: 1 });
    await createInvitation(db, { email: "used@example.com" });
    const { markInvitationUsed } = await import("~/lib/invitations.server");
    await markInvitationUsed(db, "used@example.com");
    for (const email of ["stranger@example.com", "old@example.com", "used@example.com", "stranger2@example.com"]) await request(email);
    expect(box.sent).toEqual([]);
    expect(await verificationRows(db)).toEqual([]);
    // Only the five sent rows remain; rejected requests leave no rows.
    for (let i = 0; i < 8; i++) await request("hana@example.com");
    expect(box.sent).toHaveLength(5);
    expect(await verificationRows(db)).toHaveLength(5);
    // The same IP limit applies.
    process.env.TRUSTED_PROXY_HOPS = "1";
    for (let i = 0; i < 22; i++) await addMember(db, `m${i}`, `member${i}`, { email: `m${i}@example.com` });
    const before = (await verificationRows(db)).length;
    for (let i = 0; i < 22; i++) await request(`m${i}@example.com`, { "x-forwarded-for": "198.51.100.9" });
    expect(box.sent).toHaveLength(25);
    expect((await verificationRows(db)).length - before).toBe(20);
  });

  it("stay, usable on the confirm page, when the mail was sent; the row is keyed by the app's own hash of the token", async () => {
    const { db, box, auth, request } = await setup();
    await addMember(db, "u1", "hana", { email: "hana@example.com" });
    await request("hana@example.com");
    const token = tokenIn(box.sent[0].text);
    const rows = await verificationRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].identifier).toBe(`magic-link:${hashMagicLinkToken(token)}`);
    expect(JSON.parse(rows[0].value)).toMatchObject({ email: "hana@example.com" });
    const res = await auth.api.magicLinkVerify({ query: { token }, headers: new Headers(), asResponse: true });
    expect(res.status).toBe(200);
    expect(await verificationRows(db)).toEqual([]);
    // The token cannot be used a second time.
    expect((await auth.api.magicLinkVerify({ query: { token }, headers: new Headers(), asResponse: true })).status).not.toBe(200);
  });

  it("the hash is SHA-256 in base64url without padding, the value Better Auth's own default gives", () => {
    expect(hashMagicLinkToken("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    expect(hashMagicLinkToken("")).toBe("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU");
  });

  it("expired rows, magic link and passkey challenge alike, are swept by maintenance; live ones stay", async () => {
    const db = await createTestDb();
    const now = new Date("2026-10-01T00:00:00Z");
    const row = (identifier: string, value: string, expiresAt: Date) => ({ id: identifier, identifier, value, expiresAt });
    await db.insert(verification).values([
      row("expired-link", JSON.stringify({ email: "x@example.com" }), new Date("2026-09-30T23:59:00Z")),
      row("expired-challenge", JSON.stringify({ type: "authentication", expectedChallenge: "c" }), new Date("2026-09-30T23:55:00Z")),
      row("live-link", JSON.stringify({ email: "y@example.com" }), new Date("2026-10-01T00:10:00Z")),
    ]);
    await hitRateLimit(db, { key: "sweep:test", limit: 5, windowSeconds: 60, now });
    expect(await verificationRows(db)).toHaveLength(3);
    await cleanupExpiredLimits(db, now);
    expect((await verificationRows(db)).map((r) => r.identifier)).toEqual(["live-link"]);
  });
});

describe("what the caller waits for", () => {
  it("is the same for a member, a stranger and an invitee: the address check and the mail run after the answer", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana", { email: "hana@example.com" });
    await createInvitation(db, { email: "new@example.com" });
    const box = createMemoryMailbox();
    const mailer = createMailer(box.transport, "tomola <no-reply@example.org>");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let checks = 0;
    const auth = createAppAuth(db, {
      baseURL: BASE,
      secret: SECRET,
      mailer: () => mailer,
      isKnown: async (_db, email) => {
        checks++;
        await gate;
        return email !== "stranger@example.com";
      },
    });
    const answers: unknown[] = [];
    for (const email of ["hana@example.com", "stranger@example.com", "new@example.com"]) {
      // Return the response even before checking blocked recipients.
      answers.push(await auth.api.signInMagicLink({ body: { email }, headers: new Headers() }));
    }
    expect(answers).toEqual([{ status: true }, { status: true }, { status: true }]);
    expect(box.sent).toEqual([]);
    release();
    await settleMagicLinkMail();
    expect(checks).toBe(3);
    expect(box.sent.map((m) => m.to).sort()).toEqual(["hana@example.com", "new@example.com"]);
    // Delete the unknown-recipient row; only the two sent rows remain.
    expect(await verificationRows(db)).toHaveLength(2);
  });

  it("a mailer that throws at once (not only one that rejects) changes nothing for the caller", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana", { email: "hana@example.com" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = createAppAuth(db, {
      baseURL: BASE,
      secret: SECRET,
      mailer: () => {
        throw new Error("smtp is misconfigured");
      },
    });
    const member = await auth.api.signInMagicLink({ body: { email: "hana@example.com" }, headers: new Headers() });
    const stranger = await auth.api.signInMagicLink({ body: { email: "stranger@example.com" }, headers: new Headers() });
    await settleMagicLinkMail();
    expect(member).toEqual({ status: true });
    expect(stranger).toEqual(member);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]).toHaveLength(1);
  });
});
