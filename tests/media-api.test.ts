import { createHash } from "node:crypto";
import sharp from "sharp";
import { DrizzleQueryError, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuth } from "~/lib/auth/auth.server";
import { apiTokens, drafts, media, oauthConsent, profiles, rateLimits } from "~/lib/db/schema";
import { handleMediaUpload } from "~/lib/api/media-api.server";
import { readApiMedia } from "~/lib/api/media-body.server";
import { MEDIA_LIMITS, MediaError } from "~/lib/media";
import * as processing from "~/lib/media-processing.server";
import { ANON_IP_LIMIT, hitRateLimit } from "~/lib/rate-limit.server";
import { createApiToken, revokeApiToken } from "~/lib/tokens.server";
import { loader as mediaFile } from "~/routes/media-file";
import { handleDraftCreate } from "~/lib/api/drafts-api.server";
import { authorizationRedirect } from "~/lib/mcp/consent.server";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { motionImage } from "./helpers/motion-images";

let h: RouteHarness, source: Buffer, uploadToken: string, draftToken: string, readToken: string;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("hana"); await h.signIn("somchai");
  source = await sharp({ create: { width: 32, height: 16, channels: 3, background: "blue" } }).png().toBuffer();
  const create = async (kind: "read" | "draft", mediaUpload = false) => {
    const result = await createApiToken(h.db, h.ids.hana, { name: "Local image fixture", kind, mediaUpload });
    if (!result.ok) throw new Error(result.error);
    return result.token;
  };
  uploadToken = await create("draft", true); draftToken = await create("draft"); readToken = await create("read");
});
afterAll(() => h.restore());
beforeEach(async () => { await h.db.delete(drafts); await h.db.delete(media); await h.db.delete(rateLimits); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function request(body: BodyInit = new Uint8Array(source), token: string | null = uploadToken, headers: Record<string, string> = {}) {
  return new Request(`${BASE}/api/media`, { method: "POST", body, headers: { ...(body instanceof FormData ? {} : { "content-type": "application/octet-stream" }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
}
const upload = (body?: BodyInit, token?: string | null, headers?: Record<string, string>) => handleMediaUpload(request(body, token, headers));
const counter = async (key: string) => (await h.db.select().from(rateLimits).where(eq(rateLimits.key, key)))[0]?.count ?? 0;
const charge = (key: string, cost: number, limit: number = MEDIA_LIMITS.hourly) => hitRateLimit(h.db, { key, cost, limit, windowSeconds: 3600 });
const sharedKey = () => `media:member:${h.ids.hana}`;
const apiKey = () => `media:api:${h.ids.hana}`;

async function oauth(scope: string) {
  const auth = await getAuth();
  const cookie = h.request("/", { as: "hana" }).headers.get("cookie")!;
  const redirect = "http://127.0.0.1:5597/callback";
  const registration = await auth.handler(new Request(`${BASE}/api/auth/oauth2/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Image fixture", application_type: "native", redirect_uris: [redirect], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none", scope }) }));
  expect(registration.status).toBe(201);
  const clientId = (await registration.json()).client_id;
  const verifier = "x".repeat(64);
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope, resource: `${BASE}/mcp`, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
  const authorization = await auth.handler(new Request(`${BASE}/api/auth/oauth2/authorize?${params}`, { headers: { cookie } }));
  const location = authorization.headers.get("location") ?? (await authorization.json()).url;
  const query = new URL(location, BASE).searchParams.toString();
  const headers = new Headers({ cookie, origin: BASE });
  const consent = await auth.api.oauth2Consent({ request: new Request(`${BASE}/mcp/consent`, { method: "POST", headers }), headers, body: { accept: true, scope, oauth_query: query } });
  const callback = new URL((await authorizationRedirect(consent))!, BASE);
  const result = await auth.handler(new Request(`${BASE}/api/auth/oauth2/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirect, code: callback.searchParams.get("code")!, code_verifier: verifier, resource: `${BASE}/mcp` }) }));
  expect(result.status, await result.clone().text()).toBe(200);
  return { token: (await result.json()).access_token as string, clientId };
}

describe("image API credentials and responses", () => {
  it("refuses existing read/draft tokens without the explicit permission and ignores sessions and URL credentials", async () => {
    for (const token of [readToken, draftToken]) {
      const response = await upload(undefined, token);
      expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ error: "forbidden", message: expect.any(String) });
    }
    const cookie = h.request("/", { as: "hana" }).headers.get("cookie")!;
    for (const headers of [{ cookie }, { authorization: "Bearer invalid" }, {}] as Record<string, string>[]) {
      const response = await upload(undefined, null, headers);
      expect(response.status).toBe(401); expect((await response.json()).error).toBe("unauthorized");
    }
    const query = new Request(`${BASE}/api/media?k=${uploadToken}`, { method: "POST", body: new Uint8Array(source) });
    expect((await handleMediaUpload(query)).status).toBe(401);
    expect(await h.db.select().from(media)).toEqual([]);
    expect(await h.db.select().from(rateLimits)).toEqual([]);
  });
  it("uploads with an explicitly enabled token, records last use and returns a stable image ID and Markdown", async () => {
    const first = await upload(); expect(first.status).toBe(201);
    const saved = await first.json();
    expect(saved).toMatchObject({ mediaId: expect.stringMatching(/^[a-f0-9]{64}$/), width: 32, height: 16, markdown: `![Describe the image](${saved.url})` });
    expect(saved.url).toContain(saved.mediaId);
    expect(await (await upload()).json()).toEqual(saved);
    expect(await h.db.select().from(media)).toHaveLength(1);
    expect((await h.db.select().from(apiTokens)).find(row => row.mediaUpload)?.lastUsedAt).toBeInstanceOf(Date);
    expect(first.headers.get("cache-control")).toContain("no-store");
    expect(first.headers.get("access-control-allow-origin")).toBeNull();
    expect((await upload(undefined, uploadToken, { origin: "https://client.example" })).status).toBe(201);
  });
  it("accepts only the separately granted OAuth media scope, and checks current consent on every upload", async () => {
    const old = await oauth("draft");
    expect((await upload(undefined, old.token)).status).toBe(403);
    await h.db.update(oauthConsent).set({ scopes: ["draft", "media"] }).where(eq(oauthConsent.clientId, old.clientId));
    expect((await upload(undefined, old.token)).status).toBe(403);
    const allowed = await oauth("media");
    expect((await upload(undefined, allowed.token)).status).toBe(201);
    const [grant] = await h.db.select().from(oauthConsent).where(eq(oauthConsent.clientId, allowed.clientId));
    expect(grant.lastUsedAt).toBeInstanceOf(Date);
    await h.db.update(oauthConsent).set({ scopes: ["draft"] }).where(eq(oauthConsent.id, grant.id));
    expect((await upload(undefined, allowed.token)).status).toBe(403);
    await h.db.delete(oauthConsent).where(eq(oauthConsent.id, grant.id));
    expect((await upload(undefined, allowed.token)).status).toBe(401);
  });
  it("refuses revoked credentials and suspended writers before consuming the body", async () => {
    const created = await createApiToken(h.db, h.ids.hana, { name: "Revoked", kind: "draft", mediaUpload: true });
    if (!created.ok) throw new Error(created.error);
    await revokeApiToken(h.db, h.ids.hana, created.summary.id);
    expect((await upload(undefined, created.token)).status).toBe(401);
    await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 3600_000) }).where(eq(profiles.userId, h.ids.hana));
    try { expect((await upload()).status).toBe(403); } finally { await h.db.update(profiles).set({ suspendedUntil: null }).where(eq(profiles.userId, h.ids.hana)); }
    expect(await h.db.select().from(rateLimits)).toEqual([]);
  });
  it("returns JSON 405 without CORS for other methods", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "PUT"]) {
      const result = await handleMediaUpload(new Request(`${BASE}/api/media`, { method }));
      expect(result.status).toBe(405); expect(result.headers.get("allow")).toBe("POST"); expect(result.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
  it("shares the anonymous IP allowance for missing and invalid credentials without reading image bodies", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const ip = "192.0.2.34", key = `ip:anon:${ip}`;
    await charge(key, ANON_IP_LIMIT.limit - 2, ANON_IP_LIMIT.limit);
    for (const [token, status] of [[null, 401], ["invalid", 401], [null, 429]] as const) {
      const req = request(undefined, token, { "x-forwarded-for": ip });
      const response = await handleMediaUpload(req);
      expect(response.status).toBe(status);
      expect(req.bodyUsed).toBe(false);
      expect((await response.json()).error).toBe(status === 429 ? "rate" : "unauthorized");
      if (status === 429) {
        expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
        expect(response.headers.get("x-ratelimit-limit")).toBe(String(ANON_IP_LIMIT.limit));
        expect(response.headers.get("x-ratelimit-remaining")).toBe("0");
        expect(response.headers.get("x-ratelimit-reset")).toMatch(/^\d+$/);
      }
    }
    expect(await counter(key)).toBe(ANON_IP_LIMIT.limit + 1);
    expect((await upload(undefined, draftToken, { "x-forwarded-for": ip })).status).toBe(403);
    expect((await upload(undefined, uploadToken, { "x-forwarded-for": ip })).status).toBe(201);
    expect(await counter(key)).toBe(ANON_IP_LIMIT.limit + 1);
    expect((await upload(undefined, null, { "x-forwarded-for": "192.0.2.35" })).status).toBe(401);
    expect(await counter("ip:anon:192.0.2.35")).toBe(1);
  });
  it("logs unexpected query failures without bound values, request credentials or URL parameters", async () => {
    const privateValue = "fictional-private-image-content";
    const cause = Object.assign(new Error(`Database refused ${privateValue}`), { code: "08006" });
    vi.spyOn(processing, "processUploadedMedia").mockRejectedValueOnce(new DrizzleQueryError("select $1", [privateValue], cause));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const req = new Request(`${BASE}/api/media?trace=${privateValue}`, request());
    const response = await handleMediaUpload(req);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "generic", message: "Image upload failed: generic." });
    expect(log).toHaveBeenCalledExactlyOnceWith("[media-api] unexpected error for POST /api/media:", "DrizzleQueryError: select $1\ncode: 08006");
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateValue);
    expect(JSON.stringify(log.mock.calls)).not.toContain(uploadToken);
  });
});

describe("bounded image input and storage", () => {
  it("accepts a single multipart file and detects its contents independently of the declared type and filename", async () => {
    const form = new FormData(); form.append("image", new File([new Uint8Array(source)], "untrusted.html", { type: "text/html" }));
    expect((await upload(form)).status).toBe(201);
    expect(JSON.stringify(await h.db.select().from(media))).not.toContain("untrusted.html");
    const second = new FormData(); second.append("image", new File([new Uint8Array(source)], "a.png")); second.append("other", new File([new Uint8Array(source)], "b.png"));
    const response = await upload(second); expect(response.status).toBe(400); expect((await response.json()).error).toBe("generic");
  });
  it.each(["gif", "webp"] as const)("returns motion and still URLs and dimensions for %s with stable repeat results", async format => {
    const motion = await motionImage(format, 3, 32, 16);
    const response = await upload(new Uint8Array(motion.bytes), undefined, { "content-type": `image/${format}` }); expect(response.status).toBe(201);
    const saved = await response.json();
    expect(saved).toMatchObject({ width: 32, height: 16, posterWidth: 32, posterHeight: 16, posterUrl: expect.stringMatching(/^\/media\//), markdown: `[![Describe the image](${saved.posterUrl})](${saved.url})` });
    expect(await (await upload(new Uint8Array(motion.bytes))).json()).toEqual(saved);
    expect(await counter(apiKey())).toBe(4); expect(await counter(sharedKey())).toBe(4);
  });
  it("rejects unsupported types and damaged images with stable JSON errors, charging failed attempts", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [body, type] of [["<svg/>", "image/svg+xml"], ["not an image", "image/png"], ["text", "text/plain"]]) {
      const response = await upload(body, undefined, { "content-type": type });
      expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: expect.stringMatching(/^(type|generic)$/), message: expect.any(String) });
    }
    expect(await counter(sharedKey())).toBe(3); expect(await counter(apiKey())).toBe(3);
    expect(log).not.toHaveBeenCalled();
  });
  it("rejects a known oversize before reading and cancels a chunked oversize without waiting for EOF", async () => {
    let read = 0, cancelled = false;
    const stream = () => new ReadableStream<Uint8Array>({ pull(controller) { read++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const sent = (headers: Record<string, string>) => new Request(`${BASE}/api/media`, { method: "POST", headers: { "content-type": "image/png", ...headers }, body: stream(), duplex: "half" } as RequestInit);
    await expect(readApiMedia(sent({ "content-length": String(MEDIA_LIMITS.inputBytes + 1) }))).rejects.toMatchObject({ code: "too_large" }); expect(read).toBe(0);
    await expect(readApiMedia(sent({}))).rejects.toMatchObject({ code: "too_large" }); expect(read).toBe(11); expect(cancelled).toBe(true);
    const result = await upload(undefined, undefined, { "content-length": String(MEDIA_LIMITS.inputBytes + 1) }); expect(result.status).toBe(413); expect((await result.json()).error).toBe("too_large");
  });
  it("bounds multipart headers before reading the rest of a streaming body", async () => {
    let pulls = 0, cancelled = false;
    const body = new ReadableStream({ pull(controller) { pulls++; if (pulls === 1) controller.enqueue(Buffer.from('--test\r\nContent-Disposition: form-data; name="image"; filename="x"\r\nX-Long: ' + "x".repeat(8300))); else controller.enqueue(new Uint8Array(100)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const req = new Request(`${BASE}/api/media`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=test" }, body, duplex: "half" } as RequestInit);
    await expect(readApiMedia(req)).rejects.toMatchObject({ code: "too_large" }); expect(pulls).toBe(1); expect(cancelled).toBe(true);
  });
  it.each(["quota", "member_bytes", "site_bytes"] as const)("preserves atomic storage admission for %s", async code => {
    const owner = code === "site_bytes" ? h.ids.somchai : h.ids.hana;
    const n = code === "quota" ? MEDIA_LIMITS.storedCount : 1;
    await h.db.insert(media).values(Array.from({ length: n }, (_, i) => ({ id: createHash("sha256").update(`storage-${i}`).digest("hex"), uploadedBy: owner, bytes: Buffer.from([0]), mime: "image/webp", width: 1, height: 1, byteSize: 1 })));
    // Exercise the real SQL admission boundary without allocating 10 GiB of fixtures.
    const key = code === "site_bytes" ? "siteStoredBytes" : "memberStoredBytes";
    const original = MEDIA_LIMITS[key];
    if (code !== "quota") Object.defineProperty(MEDIA_LIMITS, key, { value: 1 });
    try {
      const response = await upload(); expect(response.status).toBe(409); expect((await response.json()).error).toBe(code); expect(await h.db.select().from(media)).toHaveLength(n);
    } finally { Object.defineProperty(MEDIA_LIMITS, key, { value: original }); }
  });
  it("reports decoder admission as busy without charging either allowance", async () => {
    vi.spyOn(processing, "processUploadedMedia").mockRejectedValueOnce(new MediaError("generic", 503));
    const response = await upload(); expect(response.status).toBe(503); expect((await response.json()).error).toBe("busy"); expect(response.headers.get("retry-after")).toBe("1"); expect(await h.db.select().from(rateLimits)).toEqual([]);
  });
});

describe("shared allowances and draft privacy", () => {
  it("enforces the API allowance inside the browser/member allowance, including failed uploads", async () => {
    await charge(apiKey(), MEDIA_LIMITS.apiHourly - 1);
    expect((await upload("damaged")).status).toBe(400);
    const response = await upload(); expect(response.status).toBe(429); expect((await response.json()).error).toBe("rate"); expect(response.headers.get("retry-after")).toMatch(/^\d+$/); expect(response.headers.get("x-ratelimit-limit")).toBe(String(MEDIA_LIMITS.apiHourly));
    expect(await counter(sharedKey())).toBe(1);
  });
  it("shares the member counter with browser uploads and refuses a pair that exceeds the remaining allowance", async () => {
    await charge(sharedKey(), MEDIA_LIMITS.hourly - 1);
    const motion = await motionImage("gif", 3, 32, 16);
    expect((await upload(new Uint8Array(motion.bytes))).status).toBe(429);
    expect(await counter(sharedKey())).toBe(MEDIA_LIMITS.hourly + 1);
    expect(await h.db.select().from(media)).toEqual([]);
    const response = await upload(); expect(response.status).toBe(429); expect(response.headers.get("x-ratelimit-limit")).toBe(String(MEDIA_LIMITS.hourly));
  });
  it("does not admit two concurrent uploads into the last API allowance", async () => {
    await charge(apiKey(), MEDIA_LIMITS.apiHourly - 1);
    const responses = await Promise.all([upload(), upload()]); expect(responses.map(res => res.status).sort()).toEqual([201, 429]);
  });
  it("serves a draft-only image only to its owner, even with public reading and conditional requests", async () => {
    const saved = await (await upload()).json();
    const response = await handleDraftCreate(new Request(`${BASE}/api/drafts`, { method: "POST", headers: { authorization: `Bearer ${uploadToken}`, "content-type": "text/markdown" }, body: `---\ntype: topic\ntitle: Image draft\n---\n${saved.markdown}` }));
    expect(response.status).toBe(201);
    vi.stubEnv("PUBLIC_READING", "1");
    for (const member of [undefined, "somchai", "hana"]) {
      const headers = h.request("/", { as: member }).headers;
      const fetched = await mediaFile({ request: new Request(BASE + saved.url, { headers }) }); expect(fetched.status).toBe(member === "hana" ? 200 : 404);
      headers.set("if-none-match", "*");
      expect((await mediaFile({ request: new Request(BASE + saved.url, { headers }) })).status).toBe(member === "hana" ? 304 : 404);
    }
  });
});
