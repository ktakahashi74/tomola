import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { createAuth } from "~/lib/auth/auth.server";
import { magicLinkBrowser } from "~/lib/auth/magic-link-browser.server";
import { issueLoginCode, decodeLoginCode, loginCodeState } from "~/lib/auth/login-code.server";
import { verification, rateLimits } from "~/lib/db/schema";
import { clientAddress } from "~/lib/http/client-ip.server";
import { createInvitation } from "~/lib/invitations.server";
import { createTestDb } from "./helpers/db";

const BASE = "http://localhost:5173";
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const EMAIL = "code@example.com";
async function setup(email = EMAIL) {
  const db = await createTestDb();
  await createInvitation(db, { email });
  let token = "";
  const auth = createAuth(db, { baseURL: BASE, secret: SECRET, sendMagicLink: async args => { token = args.token; } });
  const browser = magicLinkBrowser(new Request(BASE));
  await auth.api.signInMagicLink({ body: { email, metadata: { browserNonce: browser.nonce } }, headers: new Headers() });
  const id = randomBytes(32).toString("base64url");
  const code = await issueLoginCode(db, { id, email, token, nonce: browser.nonce, secret: SECRET });
  return { db, auth, browser, id, code, token, email };
}
const IP = "192.0.2.11";
const decode = (h: Awaited<ReturnType<typeof setup>>, code = h.code, nonce: string | null = h.browser.nonce, now?: Date) => decodeLoginCode(h.db, { id: h.id, code, nonce, now, ip: IP });
async function freshCode(h: Awaited<ReturnType<typeof setup>>) {
  const id = randomBytes(32).toString("base64url"), nonce = randomBytes(32).toString("base64url");
  const code = await issueLoginCode(h.db, { id, email: h.email, token: h.token, nonce, secret: SECRET });
  return { id, nonce, code };
}

it("keeps the twenty-failure source allowance across nonce and IPv6 host changes", async () => {
  const h = await setup();
  const source = (suffix: number) => clientAddress(new Headers({ "x-forwarded-for": `2001:db8:1:2::${suffix}` }), { hops: 1 });
  for (let i = 0; i < 20; i++) {
    const issued = await freshCode(h);
    await decodeLoginCode(h.db, { ...issued, code: "not-a-code", ip: source(i + 1) });
  }
  const issued = await freshCode(h);
  expect(await decodeLoginCode(h.db, { ...issued, ip: source(99) })).toBeNull();
  expect((await loginCodeState(h.db, issued.id, source(99))).limited).toBe("address");
  expect(await decodeLoginCode(h.db, { ...issued, ip: "2001:db8:1:3::/64" })).toBe(h.token);
  expect((await h.auth.api.magicLinkVerify({ query: { token: h.token }, headers: new Headers(), asResponse: true })).status).toBe(200);
});

it("caps concurrent failures at one hundred across fresh browsers and source IPs, without blocking the link", async () => {
  const h = await setup();
  const attempts = [];
  for (let i = 0; i < 120; i++) attempts.push({ ...await freshCode(h), ip: `192.0.2.${30 + i % 10}` });
  await Promise.all(attempts.map(issued => decodeLoginCode(h.db, { ...issued, code: "not-a-code" })));
  const issued = await freshCode(h);
  expect(await decodeLoginCode(h.db, { ...issued, ip: "198.51.100.1" })).toBeNull();
  expect((await loginCodeState(h.db, issued.id, "198.51.100.1")).limited).toBe("address");
  const totals = await h.db.select().from(rateLimits);
  expect(totals.filter(row => row.key.startsWith("magic-link-code:email:")).reduce((sum, row) => sum + row.count, 0)).toBe(100);
  expect(totals.filter(row => row.key.startsWith("magic-link-code:email-ip:")).reduce((sum, row) => sum + row.count, 0)).toBe(100);
  expect((await h.auth.api.magicLinkVerify({ query: { token: h.token }, headers: new Headers(), asResponse: true })).status).toBe(200);
});

describe("email code", () => {
  it("requires the requesting browser secret even with the correct code", async () => {
    const h = await setup();
    expect(await decode(h, h.code, null)).toBeNull();
    expect(await decode(h, h.code, randomBytes(32).toString("base64url"))).toBeNull();
    expect(await decode(h)).toBe(h.token);
  });
  it("expires after fifteen minutes and shares single use with the link in either order", async () => {
    const h = await setup();
    expect(await decode(h)).toBe(h.token);
    expect(await decode(h, h.code, h.browser.nonce, new Date(Date.now() + 900_001))).toBeNull();
    const res = await h.auth.api.magicLinkVerify({ query: { token: h.token }, headers: new Headers(), asResponse: true });
    expect(res.status).toBe(200);
    expect(await decode(h)).toBeNull();
    const second = await setup("second@example.com");
    const token = await decode(second);
    expect(token).toBe(second.token);
    expect((await second.auth.api.magicLinkVerify({ query: { token: token! }, headers: new Headers(), asResponse: true })).status).toBe(200);
    expect((await second.auth.api.magicLinkVerify({ query: { token: second.token }, headers: new Headers(), asResponse: true })).status).not.toBe(200);
  });
  it("blocks the code after five wrong entries while leaving the link usable", async () => {
    const h = await setup();
    expect(await decode(h)).toBe(h.token);
    const wrong = h.code === "000000" ? "999999" : "000000";
    for (let i = 0; i < 5; i++) {
      expect(await decode(h, wrong)).toBeNull();
      if (i === 3) expect(await decode(h)).toBe(h.token);
    }
    expect(await decode(h)).toBeNull();
    expect((await h.auth.api.magicLinkVerify({ query: { token: h.token }, headers: new Headers(), asResponse: true })).status).toBe(200);
  });
  it("blocks twenty wrong entries across fresh requests for the same hashed address", async () => {
    const h = await setup();
    for (let n = 0; n < 5; n++) {
      h.id = randomBytes(32).toString("base64url");
      h.code = await issueLoginCode(h.db, { id: h.id, email: h.email, token: h.token, nonce: h.browser.nonce, secret: SECRET });
      expect(await decode(h)).toBe(n < 5 ? h.token : null);
      const wrong = h.code === "000000" ? "999999" : "000000";
      for (let i = 0; i < 4; i++) expect(await decode(h, wrong)).toBeNull();
    }
    expect(await decode(h)).toBeNull();
    h.id = randomBytes(32).toString("base64url");
    h.code = await issueLoginCode(h.db, { id: h.id, email: h.email, token: h.token, nonce: h.browser.nonce, secret: SECRET });
    expect(await decode(h)).toBeNull();
    const browser = magicLinkBrowser(new Request(BASE));
    const id = randomBytes(32).toString("base64url");
    const code = await issueLoginCode(h.db, { id, email: h.email, token: h.token, nonce: browser.nonce, secret: SECRET });
    expect(await decodeLoginCode(h.db, { id, code, nonce: browser.nonce, ip: IP })).toBeNull();
    expect(await decodeLoginCode(h.db, { id, code, nonce: browser.nonce, ip: "198.51.100.1" })).toBe(h.token);
    expect(await loginCodeState(h.db, id, "198.51.100.1")).toEqual({ invalid: false, limited: null });
    expect((await loginCodeState(h.db, h.id, IP)).limited).toBe("address");
    expect((await h.auth.api.magicLinkVerify({ query: { token: h.token }, headers: new Headers(), asResponse: true })).status).toBe(200);
  });
});

it("serializes concurrent wrong entries on one code and across codes for the same address", async () => {
  const h = await setup();
  const wrong = h.code === "000000" ? "999999" : "000000";
  await Promise.all(Array.from({ length: 10 }, () => decode(h, wrong)));
  const [row] = await h.db.select().from(verification).where(eq(verification.identifier, `magic-link-code:${h.id}`));
  expect(JSON.parse(row.value).failures).toBe(5);
  expect(await decode(h)).toBeNull();
  const requests = [];
  for (let n = 0; n < 4; n++) {
    const id = randomBytes(32).toString("base64url");
    const code = await issueLoginCode(h.db, { id, email: h.email, token: h.token, nonce: h.browser.nonce, secret: SECRET });
    requests.push({ ...h, id, code });
  }
  await Promise.all(requests.flatMap(r => Array.from({ length: 5 }, () => decode(r, r.code === "000000" ? "999999" : "000000"))));
  const { rateLimits } = await import("~/lib/db/schema");
  const limits = await h.db.select().from(rateLimits);
  expect(limits.filter(r => r.key.startsWith("magic-link-code:email:")).reduce((n, r) => n + r.count, 0)).toBe(20);
  expect(limits.filter(r => r.key.startsWith("magic-link-code:email-ip:")).reduce((n, r) => n + r.count, 0)).toBe(20);
  expect(limits.every(r => /^magic-link-code:email(?:-ip)?:[a-f0-9]{64}$/.test(r.key))).toBe(true);
});

it("does not reset the address cap at midnight and permits codes after the last failure expires", async () => {
  const h = await setup();
  const start = new Date(Date.now() + 1000);
  await h.db.update(verification).set({ expiresAt: new Date(start.getTime() + 3 * 86400_000) });
  for (let n = 0; n < 4; n++) {
    const id = randomBytes(32).toString("base64url");
    const code = await issueLoginCode(h.db, { id, email: h.email, token: h.token, nonce: h.browser.nonce, secret: SECRET });
    for (let i = 0; i < 5; i++) await decode({ ...h, id, code }, code === "000000" ? "999999" : "000000", h.browser.nonce, start);
  }
  expect(await decode(h, h.code, h.browser.nonce, new Date(start.getTime() + 3600_000))).toBeNull();
  expect(await decode(h, h.code, h.browser.nonce, new Date(start.getTime() + 86400_001))).toBe(h.token);
});
