import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addSecurityHeaders,
  contentSecurityPolicy,
  generateNonce,
  HSTS,
  HTML_CACHE_CONTROL,
  nonceContext,
  PERMISSIONS_POLICY,
  securityHeaders,
  securityHeadersMiddleware,
  withSecurityHeaders,
} from "~/lib/http/security-headers.server";

it("omits COOP throughout authentication while retaining it on reading and settings responses", async () => {
  for (const path of ["/login?reauth=1", "/login/", "/LOGIN", "/log%69n", "/auth/confirm?token=fixture", "/api/auth/oauth2/authorize", "/mcp/login", "/mcp/consent.data", "/invite/fixture", "/onboarding", "/logout"]) {
    const response = await securityHeadersMiddleware({ request: new Request(`https://forum.example${path}`), context: new RouterContextProvider(), params: {} } as never,
      (async () => new Response("auth")) as never) as Response;
    expect(response.headers.has("Cross-Origin-Opener-Policy"), path).toBe(false);
    const headers = new Headers();
    addSecurityHeaders(headers, { nonce: "n", production: true, pathname: new URL(`https://forum.example${path}`).pathname });
    expect(headers.has("Cross-Origin-Opener-Policy"), `fallback ${path}`).toBe(false);
  }
  for (const path of ["/", "/t/1", "/settings", "/login-other", "/mcp-other", "/invite-other"]) {
    const response = await securityHeadersMiddleware({ request: new Request(`https://forum.example${path}`), context: new RouterContextProvider(), params: {} } as never,
      (async () => new Response("reading")) as never) as Response;
    expect(response.headers.get("Cross-Origin-Opener-Policy"), path).toBe("same-origin");
  }
});

it("isolates the opener and prevents storage of private single-fetch data while preserving anonymous reading", async () => {
  vi.stubEnv("PUBLIC_READING", "1");
  try {
    const call = async (path: string, cookie?: string) => securityHeadersMiddleware({
      request: new Request(`https://forum.example.org${path}`, { headers: cookie ? { cookie } : {} }),
      params: {}, context: new RouterContextProvider(),
    } as never, (async () => new Response("data", { headers: { "Content-Type": "text/x-script", "Cache-Control": "private" } })) as never) as Promise<Response>;
    for (const path of ["/settings.data", "/notifications.data?_routes=routes/notifications", "/_.data?_routes=routes/member-layout"]) {
      const response = await call(path, "better-auth.session_token=present");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect((await call("/settings.data")).headers.get("Cache-Control")).toBe("private, no-store");
    expect((await call("/t/1.data")).headers.get("Cache-Control")).toBe("private");
    expect(securityHeaders({ nonce: "n", production: true })["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  } finally { vi.unstubAllEnvs(); }
});

it("treats name and why single-fetch responses as public static documents in both reading modes", async () => {
  try {
    for (const mode of ["", "1"]) {
      vi.stubEnv("PUBLIC_READING", mode);
      for (const path of ["/why.data", "/name.data", "/name/.data"]) {
        const response = await securityHeadersMiddleware({
          request: new Request(`https://forum.example.org${path}`, { headers: { cookie: "better-auth.session_token=present" } }),
          params: {}, context: new RouterContextProvider(),
        } as never, (async () => new Response("public document", { headers: { "Content-Type": "text/x-script", "Cache-Control": "private" } })) as never) as Response;
        expect(response.headers.get("Cache-Control"), `${mode}: ${path}`).toBe("private");
      }
    }
  } finally { vi.unstubAllEnvs(); }
});

// Security headers (app/lib/http/security-headers.server.ts). Actual responses, including working nonce-bearing scripts and no console CSP violations, are checked by
// browser tests running the production build in e2e-prod/.
describe("the Content-Security-Policy", () => {
  it("is the specified policy, with the nonce only in script-src", () => {
    const csp = contentSecurityPolicy("abc123");
    expect(csp.split("; ")).toEqual([
      "default-src 'self'",
      "script-src 'self' 'nonce-abc123'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ]);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp.match(/nonce-/g)).toHaveLength(1);
  });

  it("makes a new, unguessable nonce for every request (base64, at least 128 bits)", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => generateNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe("securityHeaders", () => {
  it("in production adds the CSP and HSTS to the headers every response gets", () => {
    const h = securityHeaders({ nonce: "n1", production: true });
    expect(h["Content-Security-Policy"]).toBe(contentSecurityPolicy("n1"));
    expect(h["Strict-Transport-Security"]).toBe(HSTS);
    expect(HSTS).toBe("max-age=31536000");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Permissions-Policy"]).toBe(PERMISSIONS_POLICY);
  });

  it("outside production sends no CSP (Vite's HMR needs inline scripts and a WebSocket) and no HSTS, but keeps the rest", () => {
    const h = securityHeaders({ nonce: "n1", production: false });
    expect(Object.keys(h).sort()).toEqual(["Cross-Origin-Opener-Policy", "Permissions-Policy", "Referrer-Policy", "X-Content-Type-Options"]);
  });

  it("turns camera, microphone, geolocation, payment and USB off, and keeps passkeys working on the site's own origin", () => {
    const parts = PERMISSIONS_POLICY.split(", ");
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) expect(parts).toContain(`${feature}=()`);
    expect(parts).toContain("publickey-credentials-get=(self)");
    expect(parts).toContain("publickey-credentials-create=(self)");
  });
});

describe("withSecurityHeaders", () => {
  it("does not overwrite a header the route set itself (the stricter no-referrer of the login pages, the CSP of /preview)", () => {
    const res = withSecurityHeaders(
      new Response("x", { headers: { "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff" } }),
      { nonce: "n", production: true },
    );
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("Strict-Transport-Security")).toBe(HSTS);
    expect(res.headers.get("Permissions-Policy")).toBe(PERMISSIONS_POLICY);
  });

  it("works on a response whose headers cannot be changed (a redirect), keeping its status and Location", () => {
    const res = withSecurityHeaders(Response.redirect("https://forum.example.org/login", 302), { nonce: "n", production: true });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://forum.example.org/login");
    expect(res.headers.get("Content-Security-Policy")).toContain("nonce-n");
  });
});

describe("addSecurityHeaders (documents that bypass the root middleware, such as a 404)", () => {
  it("adds the same headers to a Headers object, keeping the ones already set", () => {
    const headers = new Headers({ "Referrer-Policy": "no-referrer", "Content-Type": "text/html" });
    addSecurityHeaders(headers, { nonce: "abc", production: true });
    expect(headers.get("Content-Security-Policy")).toBe(contentSecurityPolicy("abc"));
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("Strict-Transport-Security")).toBe(HSTS);
    expect(headers.get("Content-Type")).toBe("text/html");
    const dev = new Headers();
    addSecurityHeaders(dev, { nonce: "abc", production: false });
    expect(dev.has("Content-Security-Policy")).toBe(false);
    expect(dev.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

// Production HTML must not enter shared caches because its nonce differs per response. Preserve route-provided Cache-Control.
describe("the Cache-Control of HTML documents in production", () => {
  const html = (extra: Record<string, string> = {}) => ({ "Content-Type": "text/html; charset=utf-8", ...extra });

  it("is private, no-cache when the document has none", () => {
    expect(HTML_CACHE_CONTROL).toBe("private, no-cache");
    const res = withSecurityHeaders(new Response("<html></html>", { headers: html() }), { nonce: "n", production: true });
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    const headers = new Headers(html());
    addSecurityHeaders(headers, { nonce: "n", production: true });
    expect(headers.get("Cache-Control")).toBe("private, no-cache");
  });

  it("keeps the Cache-Control a route set itself (no-store, private)", () => {
    for (const value of ["no-store", "private", "private, no-store"]) {
      const res = withSecurityHeaders(new Response("<html></html>", { headers: html({ "Cache-Control": value }) }), { nonce: "n", production: true });
      expect(res.headers.get("Cache-Control")).toBe(value);
      const headers = new Headers(html({ "Cache-Control": value }));
      addSecurityHeaders(headers, { nonce: "n", production: true });
      expect(headers.get("Cache-Control")).toBe(value);
    }
  });

  it("is not added to anything but HTML (JSON, plain text, redirects) and not outside production", () => {
    for (const type of ["application/json", "text/plain; charset=utf-8", "text/markdown"]) {
      expect(withSecurityHeaders(new Response("x", { headers: { "Content-Type": type } }), { nonce: "n", production: true }).headers.has("Cache-Control")).toBe(false);
    }
    expect(withSecurityHeaders(Response.redirect("https://forum.example.org/login", 302), { nonce: "n", production: true }).headers.has("Cache-Control")).toBe(false);
    expect(withSecurityHeaders(new Response("<html></html>", { headers: html() }), { nonce: "n", production: false }).headers.has("Cache-Control")).toBe(false);
  });

  it("is added by the root middleware to an HTML response (a resource route that answers HTML) and left alone otherwise", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const context = new RouterContextProvider();
    const call = async (init: ResponseInit) =>
      (await securityHeadersMiddleware({ request: new Request("https://forum.example.org/"), params: {}, context } as never, (async () => new Response("<p>x</p>", init)) as never)) as Response;
    expect((await call({ headers: html() })).headers.get("Cache-Control")).toBe("private, no-cache");
    expect((await call({ headers: html({ "Cache-Control": "no-store" }) })).headers.get("Cache-Control")).toBe("no-store");
    vi.unstubAllEnvs();
  });
});

describe("the root middleware", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function run(next: () => Promise<unknown>) {
    const context = new RouterContextProvider();
    const res = await securityHeadersMiddleware({ request: new Request("https://forum.example.org/"), params: {}, context } as never, next as never);
    return { res: res as Response, context };
  }

  it("puts a nonce in the context for entry.server.tsx, and the same nonce in the CSP of the response, in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { res, context } = await run(async () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }));
    const nonce = context.get(nonceContext);
    expect(nonce).toBeTruthy();
    expect(res.headers.get("Content-Security-Policy")).toBe(contentSecurityPolicy(nonce!));
    expect(res.headers.get("Strict-Transport-Security")).toBe(HSTS);
  });

  it("uses a different nonce for every request", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const a = await run(async () => new Response("a"));
    const b = await run(async () => new Response("b"));
    expect(a.context.get(nonceContext)).not.toBe(b.context.get(nonceContext));
    expect(a.res.headers.get("Content-Security-Policy")).not.toBe(b.res.headers.get("Content-Security-Policy"));
  });

  it("treats an unset NODE_ENV as production, like the other checks do", async () => {
    vi.stubEnv("NODE_ENV", "");
    delete process.env.NODE_ENV;
    const { res } = await run(async () => new Response("x"));
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self' 'nonce-");
  });

  it("sends no CSP and no HSTS in development and test, and still the other headers", async () => {
    for (const NODE_ENV of ["development", "test"]) {
      vi.stubEnv("NODE_ENV", NODE_ENV);
      const { res } = await run(async () => new Response("x"));
      expect(res.headers.get("Content-Security-Policy")).toBeNull();
      expect(res.headers.get("Strict-Transport-Security")).toBeNull();
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });

  it("adds the headers to errors, redirects and plain-text twins as well, and passes a non-Response through", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await run(async () => new Response("nope", { status: 404 }))).res.headers.get("Content-Security-Policy")).toBeTruthy();
    expect((await run(async () => Response.redirect("https://forum.example.org/login", 302))).res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await run(async () => new Response("# md", { headers: { "Content-Type": "text/plain; charset=utf-8" } }))).res.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    const passed = { not: "a response" };
    expect((await run(async () => passed)).res).toBe(passed);
  });
});
