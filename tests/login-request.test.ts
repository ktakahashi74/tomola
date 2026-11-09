import { createHmac, hkdfSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { seedRateLimit } from "./helpers/fixtures";
import { createAppAuth } from "~/lib/auth/auth.server";
import * as magicLink from "~/lib/auth/magic-link.server";
import { settleMagicLinkMail } from "~/lib/auth/magic-link.server";
import { createMailer, type Mailer } from "~/lib/mail/mail.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { createInvitation, markInvitationUsed } from "~/lib/invitations.server";
import { suspendedEmailHash } from "~/lib/suspended-email.server";
import { rateLimits, suspendedEmailHashes, verification } from "~/lib/db/schema";
import { LOGIN_LOOKUP_IP_LIMIT } from "~/lib/rate-limit.server";
import { pendingLoginScreen } from "~/lib/auth/login-code-state.server";
import { action as loginAction } from "~/routes/login";
import { action as mcpAction } from "~/routes/mcp-login";
import { addMember } from "./helpers/db";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
// The signed OAuth request is not what is under test here.
vi.mock("~/lib/mcp/consent.server", async importOriginal => ({
  ...(await importOriginal<typeof import("~/lib/mcp/consent.server")>()),
  consentRequestValid: async () => true,
  loadConsentRequest: async (_db: unknown, _auth: unknown, query: string) => ({ query, name: "Test client", clientId: "client" }),
}));

// Login requests are told whether the address is registered (member or invited), whether a mail was handed to the provider, or "later". The lookup allowance is per source address and
// shared by /login and /mcp/login; past it every address gets one answer and nothing is looked up or sent.
let h: RouteHarness;
const box = createMemoryMailbox();
let failing = false;
const mailer: Mailer = {
  ...createMailer(box.transport, "test@example.org"),
  send: async message => { if (failing) throw new Error("provider down"); await createMailer(box.transport, "test@example.org").send(message); },
};
let counter = 0;
const nextIp = () => `198.51.100.${(counter += 1)}`;
beforeAll(async () => {
  h = await setupRouteHarness();
  (globalThis as { __tomolaAuth?: Promise<unknown> }).__tomolaAuth = Promise.resolve(createAppAuth(h.db, { baseURL: BASE, secret: "test-secret-0123456789abcdef0123456789abcdef", mailer: () => mailer }));
  await addMember(h.db, "lr-member", "lr_member", { email: "lr-member@example.com" });
  await createInvitation(h.db, { email: "lr-invited@example.com" });
});
beforeEach(() => { process.env.TRUSTED_PROXY_HOPS = "1"; });
afterEach(() => { delete process.env.TRUSTED_PROXY_HOPS; failing = false; vi.restoreAllMocks(); });
afterAll(() => h.restore());

const login = (email: string, ip: string, cookie = "") => loginAction(h.args(h.request("/login", { form: { email, next: "/" }, headers: { "x-forwarded-for": ip, cookie } })));
const mcp = (email: string, ip: string) => mcpAction(h.args(h.request("/mcp/login?q=1", { form: { email, oauth_query: "q=1" }, headers: { "x-forwarded-for": ip } })));
const cookies = (value: unknown) => value instanceof Response ? value.headers.getSetCookie() : (value as { init?: { headers: Headers } }).init?.headers.getSetCookie() ?? [];
const sentTo = (email: string) => box.sent.filter(mail => mail.to === email).length;

it("sends to a member and to an invited address, and says so only after the provider accepted the mail", async () => {
  for (const email of ["lr-member@example.com", "lr-invited@example.com"]) {
    const before = sentTo(email);
    const result = await login(email, nextIp());
    expect(result).toMatchObject({ data: { status: "sent" } });
    expect(cookies(result).length).toBeGreaterThan(0);
    expect(sentTo(email)).toBe(before + 1);
  }
});

it("tells an unregistered address so, keeps it in the field, sends nothing, sets no cookie and leaves no token behind", async () => {
  const rows = await h.db.select().from(verification);
  const before = box.sent.length;
  for (const route of [login, mcp]) {
    const result = await route("Lr-Stranger@Example.com", nextIp());
    expect(result).toEqual({ status: "unregistered", email: "lr-stranger@example.com" });
    expect(cookies(result)).toEqual([]);
  }
  expect(box.sent.length).toBe(before);
  expect(await h.db.select().from(verification)).toEqual(rows);
});

const DECOY = "test@blackhole.postmarkapp.com";
const cookieHeader = (value: unknown) => cookies(value).map(line => line.split(";")[0]).join("; ");
const shape = (result: unknown) => (result as { data?: { status: string }; status?: string }).data?.status ?? (result as { status?: string }).status ?? (result instanceof Response ? `redirect:${result.status}` : "other");
const codeFrom = (text: string) => /(\d{3}) (\d{3})/.exec(text)!.slice(1).join("");
// Everything a person at the screen can see after asking for a login mail: the answer, the state the next page load reads, and the answer to a wrong code.
async function observe(route: typeof login | typeof mcp, email: string) {
  const ip = nextIp();
  const answer = await route(email, ip);
  const cookie = cookieHeader(answer);
  const screen = await pendingLoginScreen(h.db, h.request("/login", { headers: { "x-forwarded-for": ip, cookie } }));
  const wrong = await (route === login ? loginAction : mcpAction)(h.args(h.request(route === login ? "/login" : "/mcp/login?q=1", { form: { intent: "login-code", code: "000000", oauth_query: "q=1" }, headers: { "x-forwarded-for": ip, cookie } })));
  const afterWrong = await pendingLoginScreen(h.db, h.request("/login", { headers: { "x-forwarded-for": ip, cookie } }));
  const picked = (state: typeof screen) => state && { invalid: state.invalid, limited: state.limited, mailMinutes: state.mailMinutes, mailCount: state.mailCount };
  return {
    ip, cookie,
    seen: {
      answer: shape(answer), cookieNames: cookies(answer).map(line => line.split("=")[0]).sort(),
      screen: picked(screen), afterWrong: picked(afterWrong),
      wrong: wrong && { status: (wrong as { init?: { status: number } }).init?.status, data: (wrong as { data?: unknown }).data },
    },
  };
}

it("answers an invited address held by a suspended former member exactly like any invited address on both screens, in content and on the next page load", async () => {
  await createInvitation(h.db, { email: "lr-ordinary@example.com" });
  await createInvitation(h.db, { email: "lr-held@example.com" });
  await h.db.insert(suspendedEmailHashes).values({ hash: suspendedEmailHash("lr-held@example.com"), expiresAt: new Date(Date.now() + 86_400_000) });
  for (const route of [login, mcp]) {
    const ordinary = await observe(route, "lr-ordinary@example.com");
    const held = await observe(route, "lr-held@example.com");
    expect(ordinary.seen.answer).toBe("sent");
    expect(held.seen).toEqual(ordinary.seen);
    // No error before anything was typed, and one wrong code counts as one failure for both.
    expect(held.seen.screen).toMatchObject({ invalid: false });
    expect(held.seen.afterWrong).toMatchObject({ invalid: true });
  }
  await settleMagicLinkMail();
  expect(await markInvitationUsed(h.db, "lr-held@example.com")).toBe(0);
  // An address with no invitation is told so on both screens, whoever held it before.
  for (const route of [login, mcp]) expect(await route("lr-nobody@example.com", nextIp())).toMatchObject({ status: "unregistered" });
});

it("mails a held address nothing: one ordinary-looking mail goes to the decoy instead, with a code that completes no login, and no credential is kept", async () => {
  await createInvitation(h.db, { email: "lr-ordinary2@example.com" });
  await createInvitation(h.db, { email: "lr-held2@example.com" });
  await h.db.insert(suspendedEmailHashes).values({ hash: suspendedEmailHash("lr-held2@example.com"), expiresAt: new Date(Date.now() + 86_400_000) });
  const credentials = async () => (await h.db.select().from(verification)).filter(row => row.identifier.startsWith("magic-link:")).length;
  const logged: string[] = [];
  for (const spy of [vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info"), vi.spyOn(console, "log")]) spy.mockImplementation((...args: unknown[]) => { logged.push(args.join(" ")); });
  const sentBefore = box.sent.length;
  const before = await credentials();
  const ordinary = await observe(login, "lr-ordinary2@example.com");
  const afterOrdinary = await credentials();
  const held = await observe(login, "lr-held2@example.com");
  await settleMagicLinkMail();
  expect(afterOrdinary).toBe(before + 1);
  expect(await credentials()).toBe(afterOrdinary);
  const mails = box.sent.slice(sentBefore);
  expect(mails.map(mail => mail.to)).toEqual(["lr-ordinary2@example.com", DECOY]);
  const [real, decoy] = mails;
  expect(decoy.from).toBe(real.from);
  expect(decoy.subject).toBe(real.subject);
  expect(decoy.text.length).toBe(real.text.length);
  expect(decoy.text).not.toContain("lr-held2");
  // The decoy's code and link are not real: the code does not log the held address in, and the code row answers like any other.
  const answer = await loginAction(h.args(h.request("/login", { form: { intent: "login-code", code: codeFrom(decoy.text) }, headers: { "x-forwarded-for": held.ip, cookie: held.cookie } })));
  expect(answer).toMatchObject({ init: { status: 400 }, data: { status: "code_invalid" } });
  expect(ordinary.cookie).not.toBe("");
  // The held address, or a hash of it, is written nowhere.
  const tag = createHmac("sha256", Buffer.from(hkdfSync("sha256", "test-secret-0123456789abcdef0123456789abcdef", "", "tomola magic-link address v1", 32))).update("lr-held2@example.com").digest("hex");
  expect(logged.some(line => line.includes("lr-held2") || line.includes(tag.slice(0, 8)))).toBe(false);
  vi.restoreAllMocks();
});

it("says 'later' for a held address when the provider does not accept the decoy mail, as for any other address", async () => {
  await createInvitation(h.db, { email: "lr-held3@example.com" });
  await h.db.insert(suspendedEmailHashes).values({ hash: suspendedEmailHash("lr-held3@example.com"), expiresAt: new Date(Date.now() + 86_400_000) });
  failing = true;
  const rows = await h.db.select().from(verification);
  for (const route of [login, mcp]) {
    const result = await route("lr-held3@example.com", nextIp());
    expect(result).toEqual({ status: "later", email: "lr-held3@example.com" });
    expect(cookies(result)).toEqual([]);
  }
  expect(await h.db.select().from(verification)).toEqual(rows);
});

it("says 'later' when the provider does not accept the mail, without a cookie, a leftover token or a code", async () => {
  failing = true;
  const rows = await h.db.select().from(verification);
  for (const route of [login, mcp]) {
    const result = await route("lr-member@example.com", nextIp());
    expect(result).toEqual({ status: "later", email: "lr-member@example.com" });
    expect(cookies(result)).toEqual([]);
  }
  expect(await h.db.select().from(verification)).toEqual(rows);
});

it("uses the lookup allowance up to its 20th request, then answers every address alike without looking up or sending", async () => {
  const ip = nextIp();
  const known = vi.spyOn(magicLink, "isKnownAddress");
  const mailed = box.sent.length;
  const answers: unknown[] = [];
  for (let n = 0; n < LOGIN_LOOKUP_IP_LIMIT.limit; n++) answers.push(await login("lr-stranger@example.com", ip));
  expect(answers.every(answer => (answer as { status?: string }).status === "unregistered")).toBe(true);
  expect(known).toHaveBeenCalledTimes(LOGIN_LOOKUP_IP_LIMIT.limit);
  const credentials = await h.db.select().from(verification);
  const member = await login("lr-member@example.com", ip);
  const stranger = await login("lr-stranger@example.com", ip);
  const invited = await mcp("lr-invited@example.com", ip);
  expect(member).toEqual({ status: "later", email: "lr-member@example.com" });
  expect(stranger).toEqual({ status: "later", email: "lr-stranger@example.com" });
  expect(invited).toEqual({ status: "later", email: "lr-invited@example.com" });
  expect([member, stranger, invited].flatMap(cookies)).toEqual([]);
  expect(known).toHaveBeenCalledTimes(LOGIN_LOOKUP_IP_LIMIT.limit);
  expect(box.sent.length).toBe(mailed);
  expect(await h.db.select().from(verification)).toEqual(credentials);
  // A different source is unaffected.
  expect(await login("lr-member@example.com", nextIp())).toMatchObject({ data: { status: "sent" } });
});

it("shares the allowance between /login and /mcp/login", async () => {
  const ip = nextIp();
  for (let n = 0; n < LOGIN_LOOKUP_IP_LIMIT.limit; n++) expect(await (n % 2 ? mcp : login)("lr-stranger@example.com", ip)).toMatchObject({ status: "unregistered" });
  expect(await mcp("lr-stranger@example.com", ip)).toMatchObject({ status: "later" });
  expect(await login("lr-stranger@example.com", ip)).toMatchObject({ status: "later" });
});

it("does not let concurrent requests past the allowance", async () => {
  const ip = nextIp();
  const answers = await Promise.all(Array.from({ length: LOGIN_LOOKUP_IP_LIMIT.limit + 10 }, (_, n) => (n % 2 ? mcp : login)("lr-stranger@example.com", ip)));
  const statuses = answers.map(answer => (answer as { status: string }).status);
  expect(statuses.filter(status => status === "unregistered")).toHaveLength(LOGIN_LOOKUP_IP_LIMIT.limit);
  expect(statuses.filter(status => status === "later")).toHaveLength(10);
});

it("counts by source only: the key holds no address, and a spent allowance resets with its window", async () => {
  const ip = nextIp();
  await login("lr-member@example.com", ip);
  const keys = (await h.db.select().from(rateLimits)).map(row => row.key).filter(key => key.startsWith("login-lookup:"));
  expect(keys).toContain(`login-lookup:ip:${ip}`);
  expect(keys.join()).not.toMatch(/lr-member|example\.com/);
  const spent = nextIp();
  await seedRateLimit(h.db, `login-lookup:ip:${spent}`, LOGIN_LOOKUP_IP_LIMIT);
  expect(await login("lr-member@example.com", spent)).toMatchObject({ status: "later" });
  // The window is fixed: its counter row expires at the window's end, and the next window starts from zero.
  await h.db.delete(rateLimits);
  expect(await login("lr-member@example.com", spent)).toMatchObject({ data: { status: "sent" } });
});

it("does not need a source address: without one, nothing is counted here", async () => {
  delete process.env.TRUSTED_PROXY_HOPS;
  const lookups = async () => (await h.db.select().from(rateLimits)).filter(row => row.key.startsWith("login-lookup:")).map(row => `${row.key}:${row.count}`).sort();
  const before = await lookups();
  const result = await loginAction(h.args(h.request("/login", { form: { email: "lr-stranger@example.com", next: "/" } })));
  expect(result).toMatchObject({ status: "unregistered" });
  expect(await lookups()).toEqual(before);
});

it("still applies the sending limits after the lookup: a spent address allowance says 'later', not 'sent'", async () => {
  const ip = "203.0.113.77";
  await createInvitation(h.db, { email: "lr-capped@example.com" });
  const results: unknown[] = [];
  for (let n = 0; n < 6; n++) results.push(await login("lr-capped@example.com", ip));
  await settleMagicLinkMail();
  expect(results.slice(0, 5).every(result => (result as { data?: { status: string } }).data?.status === "sent")).toBe(true);
  expect(results[5]).toEqual({ status: "later", email: "lr-capped@example.com" });
  expect(sentTo("lr-capped@example.com")).toBe(5);
});

it("writes the source only, never the address, when it says 'later' for a spent allowance or 'unregistered'", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const ip = nextIp();
  await login("lr-log-stranger@example.com", ip);
  await seedRateLimit(h.db, `login-lookup:ip:${ip}`, LOGIN_LOOKUP_IP_LIMIT);
  await login("lr-log-stranger@example.com", ip);
  const lines = warn.mock.calls.map(call => String(call[0]));
  expect(lines).toContain(`[login] address not registered ip=${ip}`);
  expect(lines).toContain(`[login] lookup allowance spent ip=${ip}`);
  expect(lines.join("\n")).not.toMatch(/lr-log-stranger|example\.com/);
});

it("never reads as 'sent' when the sender recorded nothing", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { requestLoginLink } = await import("~/lib/auth/login-request.server");
  const result = await requestLoginLink({ db: h.db, request: h.request("/login", { headers: { "x-forwarded-for": nextIp() } }), email: "lr-member@example.com", send: async () => {} });
  expect(result).toBe("later");
  expect(error).toHaveBeenCalledWith("[magic-link] no delivery outcome was recorded");
});

it("warns once per process in production when there is no source address, and not elsewhere", async () => {
  vi.resetModules();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { requestLoginLink } = await import("~/lib/auth/login-request.server");
  const ask = () => requestLoginLink({ db: h.db, request: h.request("/login"), email: "lr-stranger@example.com", send: async () => {} });
  delete process.env.TRUSTED_PROXY_HOPS;
  await ask();
  expect(warn.mock.calls.map(call => String(call[0])).filter(line => line.includes("no trustworthy source address"))).toHaveLength(0);
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BETTER_AUTH_SECRET", "login-request-test-secret-0123456789");
  try { await ask(); await ask(); } finally { vi.unstubAllEnvs(); }
  expect(warn.mock.calls.map(call => String(call[0])).filter(line => line.includes("no trustworthy source address"))).toHaveLength(1);
});
