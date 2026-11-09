import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rateLimits, roles } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { handleDraftCreate } from "~/lib/api/drafts-api.server";
import { clearMemoryReadLimitsForTests, hitRateLimit, ANON_IP_LIMIT, AUTH_PAGE_IP_LIMIT, hitIpLimit, MEMBER_RATE_LIMITS, READ_RATE_LIMIT } from "~/lib/rate-limit.server";
import { createApiToken } from "~/lib/tokens.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Rate limits: session reads per member; notification, moderation, and appeal-review pages per member;
// unauthenticated requests per IP; login and authentication pages per IP.
const originalHops = process.env.TRUSTED_PROXY_HOPS;
let h: RouteHarness;
let readToken: string;
let draftToken: string;
const fromIp = (ip: string) => ({ "x-forwarded-for": ip });

beforeAll(async () => {
  process.env.TRUSTED_PROXY_HOPS = "1";
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja" });
  await h.signIn("moriko", { homeArea: "ja" });
  await h.db.insert(roles).values({ userId: h.ids.moriko, role: "moderator", lang: "ja" });
  const topic = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "話題", body: "本文" });
  if (!topic.ok) throw new Error("topic failed");
  const read = await createApiToken(h.db, h.ids.hana, { name: "r", kind: "read" });
  const draft = await createApiToken(h.db, h.ids.hana, { name: "d", kind: "draft" });
  if (!read.ok || !draft.ok) throw new Error("token failed");
  readToken = read.token;
  draftToken = draft.token;
});
beforeEach(async () => { await h.db.delete(rateLimits); clearMemoryReadLimitsForTests(h.db); });
afterAll(() => {
  h.restore();
  if (originalHops === undefined) delete process.env.TRUSTED_PROXY_HOPS;
  else process.env.TRUSTED_PROXY_HOPS = originalHops;
});

// Advance the counter to the cap to test boundaries without hundreds of real requests. Set the current window's row to count.
async function fill(key: string, rule: { limit: number; windowSeconds: number }, count = rule.limit) {
  if (key.startsWith("read:member:")) {
    clearMemoryReadLimitsForTests(h.db);
    for (let i = 0; i < count; i++) await hitRateLimit(h.db, { key, ...rule });
    return;
  }
  const windowMs = rule.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  await h.db
    .insert(rateLimits)
    .values({ key, windowStart, count, expiresAt: new Date(windowStart.getTime() + windowMs) })
    .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count } });
}
const countOf = async (key: string) => Number((await h.db.select({ c: rateLimits.count }).from(rateLimits).where(eq(rateLimits.key, key)))[0]?.c ?? 0);

describe("the limits", () => {
  it("are the documented values", () => {
    expect(READ_RATE_LIMIT).toEqual({ limit: 600, windowSeconds: 3600 });
    expect(ANON_IP_LIMIT).toEqual({ limit: 120, windowSeconds: 3600 });
    expect(AUTH_PAGE_IP_LIMIT).toEqual({ limit: 300, windowSeconds: 900 });
    for (const name of ["notifications", "mod", "mod-appeals"] as const) expect(MEMBER_RATE_LIMITS[name]).toEqual({ limit: 600, windowSeconds: 3600 });
  });
});

describe("hitIpLimit", () => {
  it("counts per IP (from X-Forwarded-For behind one proxy) and per name, and does not limit when there is no address", async () => {
    const request = (ip: string | null) => new Request("http://localhost:5173/x", { headers: ip ? fromIp(ip) : {} });
    expect(await hitIpLimit(h.db, request(null), "anon")).toBeNull();
    for (let i = 0; i < ANON_IP_LIMIT.limit; i++) expect((await hitIpLimit(h.db, request("198.51.100.1"), "anon"))!.allowed).toBe(true);
    expect((await hitIpLimit(h.db, request("198.51.100.1"), "anon"))!).toMatchObject({ allowed: false, limit: 120, retryAfterSeconds: expect.any(Number) });
    expect((await hitIpLimit(h.db, request("198.51.100.2"), "anon"))!.allowed).toBe(true);
    expect((await hitIpLimit(h.db, request("198.51.100.1"), "auth-page"))!.allowed).toBe(true);
    expect(await countOf("ip:anon:198.51.100.1")).toBe(121);
  });
});

describe("session reads of the Markdown and JSON endpoints", () => {
  const changes = async (as: string, ip = "203.0.113.10") => (await (await import("~/routes/changes-md")).loader(h.args(h.request("/changes.md", { as, headers: fromIp(ip) })))) as Awaited<Promise<Response>>;
  const manifest = async (as: string, ip = "203.0.113.10") => (await (await import("~/routes/manifest")).loader(h.args(h.request("/manifest.json", { as, headers: fromIp(ip) })))) as Awaited<Promise<Response>>;

  it("are counted per member (600 an hour) and answer 429 with Retry-After beyond that, for /changes.md and /manifest.json alike", async () => {
    const first = await changes("hana");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-ratelimit-limit")).toBe("600");
    expect(first.headers.get("x-ratelimit-remaining")).toBe("599");
    await fill(`read:member:${h.ids.hana}`, READ_RATE_LIMIT);
    for (const res of [await changes("hana"), await manifest("hana")]) {
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    expect(await (await manifest("hana")).json()).toMatchObject({ error: "rate_limited" });
    // Other members are unaffected; another credential shares this member's cap.
    expect((await changes("moriko")).status).toBe(200);
    const viaToken = (await (await import("~/routes/changes-md")).loader(h.args(h.request("/changes.md", { headers: { authorization: `Bearer ${readToken}`, ...fromIp("203.0.113.10") } })))) as Awaited<Promise<Response>>;
    expect((await viaToken).status).toBe(429);
  });
});

describe("requests without valid credentials, per IP", () => {
  const latest = (headers: Record<string, string>, as?: string) => (import("~/routes/latest-md").then(async (m) => (await m.loader(h.args(h.request("/latest.md", { as, headers }))))) as Promise<Response>);

  it("count missing and invalid credentials (not valid ones), and answer 429 instead of 401 beyond 120 an hour", async () => {
    const ip = "192.0.2.50";
    const before = await countOf(`ip:anon:${ip}`);
    expect((await latest(fromIp(ip))).status).toBe(401);
    expect((await latest({ ...fromIp(ip), authorization: "Bearer tml_read_wrong" })).status).toBe(401);
    expect((await latest({ ...fromIp(ip), authorization: "Bearer" })).status).toBe(401);
    expect(await countOf(`ip:anon:${ip}`)).toBe(before + 3);
    // Do not count valid token or session credentials.
    expect((await latest({ ...fromIp(ip), authorization: `Bearer ${readToken}` })).status).toBe(200);
    expect((await latest(fromIp(ip), "moriko")).status).toBe(200);
    expect(await countOf(`ip:anon:${ip}`)).toBe(before + 3);
    await fill(`ip:anon:${ip}`, ANON_IP_LIMIT);
    const limited = await latest(fromIp(ip));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(await limited.text()).toContain("rate_limited");
    expect((await latest({ ...fromIp(ip), authorization: "Bearer tml_read_wrong" })).status).toBe(429);
    // An authenticated request passes even from the same IP.
    expect((await latest({ ...fromIp(ip), authorization: `Bearer ${readToken}` })).status).toBe(200);
    // A different IP is unaffected.
    expect((await latest(fromIp("192.0.2.51"))).status).toBe(401);
    // Requests without an obtainable IP are not counted and still return 401.
    expect((await latest({})).status).toBe(401);
  });

  it("applies to POST /api/drafts too (a missing or invalid draft token)", async () => {
    const ip = "192.0.2.60";
    const post = (headers: Record<string, string>) =>
      handleDraftCreate(new Request("http://localhost:5173/api/drafts", { method: "POST", headers: { "content-type": "text/markdown", ...headers }, body: "---\ntype: topic\ntitle: T\nlang: ja\n---\nbody" }), { db: h.db });
    expect((await post(fromIp(ip))).status).toBe(401);
    expect((await post({ ...fromIp(ip), authorization: "Bearer tml_draft_wrong" })).status).toBe(401);
    expect(await countOf(`ip:anon:${ip}`)).toBe(2);
    expect((await post({ ...fromIp(ip), authorization: `Bearer ${draftToken}` })).status).toBe(201);
    expect(await countOf(`ip:anon:${ip}`)).toBe(2);
    await fill(`ip:anon:${ip}`, ANON_IP_LIMIT);
    const limited = await post({ ...fromIp(ip), authorization: "Bearer tml_draft_wrong" });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
  });
});

describe("member pages: /notifications, /mod, /mod/appeals", () => {
  const cases: Array<[string, string, string, () => Promise<{ loader: (a: never) => unknown; action: (a: never) => unknown }>, "hana" | "moriko"]> = [
    ["notifications", "notifications", "/notifications", () => import("~/routes/notifications") as never, "hana"],
    ["mod", "mod", "/mod", () => import("~/routes/mod") as never, "moriko"],
    ["mod-appeals", "mod-appeals", "/mod/appeals", () => import("~/routes/mod-appeals") as never, "moriko"],
  ];
  for (const [name, action, path, load, as] of cases) {
    it(`${path}: 600 an hour per member, then 429 (loader and action), other members are not affected`, async () => {
      const mod = await load();
      const get = () => h.outcome(async () => (await mod.loader(h.args(h.request(path, { as })))));
      expect((await get()).status).toBe(200);
      const key = `member:${action}:${h.ids[as]}`;
      expect(await countOf(key)).toBe(1);
      await fill(key, MEMBER_RATE_LIMITS[name as keyof typeof MEMBER_RATE_LIMITS]);
      expect((await get()).status).toBe(429);
      const post = await h.outcome(() => mod.action(h.args(h.request(path, { as, form: { intent: "read-all" } }))));
      expect(post.status).toBe(429);
      // Different members, hana and moriko, have separate counters.
      const other = as === "hana" ? "moriko" : "hana";
      if (name === "notifications") expect((await h.outcome(async () => (await mod.loader(h.args(h.request(path, { as: other })))))).status).toBe(200);
      // A new window permits requests again.
      await h.db.delete(rateLimits).where(and(eq(rateLimits.key, key)));
      expect((await get()).status).toBe(200);
    });
  }
});

describe("login and authentication submissions, per IP (opening the pages is not counted)", () => {
  const pages: Array<[string, () => Promise<{ loader: (a: never) => unknown; action: (a: never) => unknown }>, string, Record<string, string>, Record<string, string>]> = [
    ["/login", () => import("~/routes/login") as never, "/login", {}, { email: "a@example.com" }],
    ["/invite/<token>", () => import("~/routes/invite") as never, "/invite/abc", { token: "abc" }, {}],
    ["/auth/confirm", () => import("~/routes/auth-confirm") as never, "/auth/confirm?token=abcdefghijkl", {}, { token: "abcdefghijkl" }],
  ];
  for (const [label, load, path, params, form] of pages) {
    it(`${label}: a GET writes nothing and is never limited; a POST is counted, 300 per 15 minutes per IP, then 429; another IP is not affected`, async () => {
      const mod = await load();
      const ip = `192.0.2.${100 + pages.findIndex((p) => p[0] === label)}`;
      const get = (address: string) => h.outcome(async () => (await mod.loader(h.args(h.request(path, { headers: fromIp(address) }), params))));
      const post = (address: string) => h.outcome(() => mod.action(h.args(h.request(path, { form, headers: fromIp(address) }), params)));
      // GET does not count or write a row; it remains accessible at the cap.
      expect((await get(ip)).status).toBe(200);
      expect(await countOf(`ip:auth-page:${ip}`)).toBe(0);
      await fill(`ip:auth-page:${ip}`, AUTH_PAGE_IP_LIMIT);
      expect((await get(ip)).status).toBe(200);
      expect(await countOf(`ip:auth-page:${ip}`)).toBe(AUTH_PAGE_IP_LIMIT.limit);
      // POST counts and returns 429 beyond the cap.
      expect((await post(ip)).status).toBe(429);
      expect(await countOf(`ip:auth-page:${ip}`)).toBe(AUTH_PAGE_IP_LIMIT.limit + 1);
      // A different IP has a separate counter and passes, without 429; its count is 1.
      expect((await post("192.0.2.200")).status).not.toBe(429);
      expect(await countOf("ip:auth-page:192.0.2.200")).toBeGreaterThanOrEqual(1);
    });
  }
});
