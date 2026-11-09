import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { AI_OPEN_RECEIPT_PREFIX, aiOpenWasRead, rememberAiOpenRead, signAiOpenMarker, verifyAiOpenMarker } from "~/lib/ai-open-return.server";
import { aiOpenLinkExpiresAt, OPEN_IN_AI_TTL_SECONDS } from "~/lib/open-in-ai";
import { signOpenInAiToken } from "~/lib/open-in-ai.server";
import { createTopic } from "~/lib/entries.server";
import { verification } from "~/lib/db/schema";
import { serveThreadMd } from "~/lib/md/twin.server";
import { hitRateLimit, IP_RATE_LIMITS } from "~/lib/rate-limit.server";
import { action as issue } from "~/routes/open-in-ai-link";
import { action as status, loader as statusGet } from "~/routes/open-in-ai-status";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

const t0 = new Date("2026-10-10T00:00:00Z");
const secret = "receipt-test-purpose-separated-secret";
describe("inert public AI-open markers", () => {
  it("verifies the signature, expiry and exact resource without binding an identity", () => {
    const opts = { now: t0, secret };
    const marker = signAiOpenMarker("/latest.md?lang=en", opts);
    const expiresAt = new Date(t0.getTime() + OPEN_IN_AI_TTL_SECONDS * 1000);
    expect(verifyAiOpenMarker(marker, "/latest.txt?lang=en&page=1", opts)).toEqual(expiresAt);
    expect(verifyAiOpenMarker(marker, "/latest.md?lang=ja", opts)).toBeNull();
    expect(verifyAiOpenMarker(marker, "/latest.md?lang=en", { ...opts, secret: "other" })).toBeNull();
    expect(verifyAiOpenMarker(marker, "/latest.md?lang=en", { ...opts, now: expiresAt })).toBeNull();
    for (const broken of ["", "unknown", marker.replace("oar1", "oai2"), `${marker}!`, marker.slice(0, -2), marker.replace(/\.[^.]+$/, ".invalid")]) {
      expect(verifyAiOpenMarker(broken, "/latest.md?lang=en", opts)).toBeNull();
    }
    expect(signAiOpenMarker("/latest.md?lang=en", opts)).not.toBe(marker);
    expect(aiOpenLinkExpiresAt(`${BASE}/latest.md?o=${marker}`)).toBe(expiresAt.getTime());
    expect(aiOpenLinkExpiresAt("broken")).toBeNull();
    expect(aiOpenLinkExpiresAt(`${BASE}/latest.md`)).toBeNull();
  });
});

describe("AI-open receipts and same-origin status", () => {
  let h: RouteHarness;
  let path: string;
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("ai_reader");
    const topic = await createTopic(h.db, h.ids.ai_reader, { lang: "ja", title: "Receipt fixture", body: "Public receipt fixture body" });
    if (!topic.ok) throw new Error(topic.error);
    path = `/t/${topic.id}.md?lang=ja`;
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  });
  afterAll(() => { h.restore(); vi.unstubAllEnvs(); });
  const query = (url: string, headers?: Record<string, string>) => status(h.args(h.request("/open-in-ai/status", { form: { url }, headers })));
  const link = async (as?: string) => (await (await issue(h.args(h.request("/open-in-ai/link", { as, form: { path } })))).json()).url as string;

  it("records a member delegation once, storing only its digest and expiry", async () => {
    const url = await link("ai_reader");
    const key = new URL(url).searchParams.get("k")!;
    expect(await (await query(url)).json()).toEqual({ read: false });
    expect((await serveThreadMd(new Request(url), new URL(url).pathname.split("/").at(-1)!.replace(".md", ""))).status).toBe(200);
    expect(await (await query(url)).json()).toEqual({ read: true });
    const identifier = `${AI_OPEN_RECEIPT_PREFIX}${createHash("sha256").update(key).digest("hex")}`;
    const [before] = await h.db.select().from(verification).where(eq(verification.identifier, identifier));
    await Promise.all(Array.from({ length: 3 }, () => rememberAiOpenRead(h.db, key, before.expiresAt)));
    const rows = await h.db.select().from(verification).where(eq(verification.identifier, identifier));
    expect(rows).toEqual([before]);
    expect(before.value).toBe("read");
    expect(before.expiresAt.getTime()).toBe(aiOpenLinkExpiresAt(url));
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(JSON.stringify(rows)).not.toContain(h.ids.ai_reader);
    expect(JSON.stringify(rows)).not.toContain("ai_reader@example.com");
  });

  it("issues fresh public markers, observes anonymous reads, and preserves Markdown and headers", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    const url = await link();
    const marker = new URL(url).searchParams.get("o")!;
    expect(marker).toBeTruthy();
    expect(new URL(url).searchParams.has("k")).toBe(false);
    expect(new URL(await link()).searchParams.get("o")).not.toBe(marker);
    expect(await (await query(url)).json()).toEqual({ read: false });
    const id = new URL(url).pathname.split("/").at(-1)!.replace(".md", "");
    const baseline = await serveThreadMd(h.request(path), id);
    const read = await serveThreadMd(new Request(url), id);
    expect(read.status).toBe(baseline.status);
    expect([...read.headers]).toEqual([...baseline.headers]);
    expect(await read.text()).toBe(await baseline.text());
    expect(await (await query(url)).json()).toEqual({ read: true });
    const rows = await h.db.select().from(verification).where(and(like(verification.identifier, `${AI_OPEN_RECEIPT_PREFIX}%`), eq(verification.identifier, `${AI_OPEN_RECEIPT_PREFIX}${createHash("sha256").update(marker).digest("hex")}`)));
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("read");
    expect(JSON.stringify(rows)).not.toMatch(/ai_reader|example\.com|userId|userAgent|cookie|127\.0\.0\.1/);
    expect(JSON.stringify(rows)).not.toContain(marker);
  });

  it("silently ignores malformed, expired and wrong-signature public markers", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    const id = path.split("/").at(-1)!.split(".")[0];
    const baseline = await (await serveThreadMd(h.request(path), id)).text();
    const before = await h.db.select().from(verification).where(like(verification.identifier, `${AI_OPEN_RECEIPT_PREFIX}%`));
    for (const marker of ["bad", signAiOpenMarker(path, { now: new Date(Date.now() - OPEN_IN_AI_TTL_SECONDS * 1000) }), signAiOpenMarker(path, { secret: "wrong" })]) {
      const url = `${BASE}${path}&o=${marker}`;
      const res = await serveThreadMd(new Request(url), id);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(baseline);
      expect(await (await query(url)).json()).toEqual({ read: false });
    }
    expect(await h.db.select().from(verification).where(like(verification.identifier, `${AI_OPEN_RECEIPT_PREFIX}%`))).toEqual(before);
  });

  it("does not grant reads or issuance when public reading is disabled", async () => {
    vi.stubEnv("PUBLIC_READING", "");
    expect(await h.outcome(() => issue(h.args(h.request("/open-in-ai/link", { form: { path } }))))).toMatchObject({ status: 302, location: "/login" });
    const url = `${BASE}${path}&o=${signAiOpenMarker(path)}`;
    expect((await serveThreadMd(new Request(url), path.split("/").at(-1)!.split(".")[0])).status).toBe(401);
    expect(new URL(await link("ai_reader")).searchParams.has("k")).toBe(true);
  });

  it("gives the same private answer for every unknown, invalid or expired capability", async () => {
    // A matching database row is insufficient: possession must still be verified.
    await rememberAiOpenRead(h.db, "unknown", new Date(Date.now() + OPEN_IN_AI_TTL_SECONDS * 1000));
    const past = new Date(Date.now() - OPEN_IN_AI_TTL_SECONDS * 1000);
    const expired = signOpenInAiToken({ resource: path, userId: h.ids.ai_reader, generation: 0, now: past });
    const validUrl = await link("ai_reader");
    for (const url of ["", "not a URL", `${BASE}${path}&k=unknown`, `${BASE}${path}&o=unknown`, `${BASE}${path}&k=${expired}`, validUrl.replace("lang=ja", "lang=en"), validUrl.replace(BASE, "https://other.example"), `${validUrl}&o=unknown`]) {
      const res = await query(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await res.json()).toEqual({ read: false });
    }
    expect(await aiOpenWasRead(h.db, validUrl, { now: new Date(aiOpenLinkExpiresAt(validUrl)!) })).toBe(false);
  });

  it("rejects external origins and GET, without exposing capabilities", async () => {
    expect((await h.outcome(() => query("unknown", { origin: "https://outside.example" }))).status).toBe(403);
    expect((await h.outcome(() => issue(h.args(h.request("/open-in-ai/link", { form: { path }, headers: { origin: "https://outside.example" } }))))).status).toBe(403);
    expect((await statusGet()).status).toBe(405);
    expect(await (await statusGet()).json()).toEqual({ read: false });
  });

  it("limits public issuance and status independently using the existing IP limiter", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    const ip = "10.89.1.1";
    for (const name of ["ai-open-link", "ai-open-status"] as const) {
      const rule = IP_RATE_LIMITS[name];
      const now = new Date();
      const rate = await hitRateLimit(h.db, { key: `ip:${name}:${ip}`, ...rule, now });
      const { rateLimits } = await import("~/lib/db/schema");
      await h.db.update(rateLimits).set({ count: rule.limit }).where(eq(rateLimits.key, `ip:${name}:${ip}`));
      expect(rate.allowed).toBe(true);
    }
    const headers = { "x-forwarded-for": ip };
    expect((await issue(h.args(h.request("/open-in-ai/link", { form: { path }, headers })))).status).toBe(429);
    const res = await query("unknown", headers);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ read: false });
  });
});
