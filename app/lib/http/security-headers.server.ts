import { randomBytes } from "node:crypto";
import { createContext, type MiddlewareFunction } from "react-router";
import { isDevOrTest } from "~/lib/env.server";
import { getSessionCookie } from "better-auth/cookies";
import { publicReading } from "~/lib/public-reading.server";

// Security headers, attached to all responses by root middleware (app/root.tsx). Do not overwrite route-provided headers
// such as authentication pages' privacy headers or /preview's CSP, since routes choose stricter values.
//
// - Production CSP: default-src 'self'; script-src 'self' 'nonce-<per-request random value>'. React Router `<Scripts>`, `<ScrollRestoration>`, `<Links>`, and streamed
//   inline scripts use the nonce passed to ServerRouter by entry.server.tsx. style-src 'self' 'unsafe-inline' permits KaTeX's layout style attributes;
//   img-src 'self' data: prevents external images exposing readers' IPs to third parties; rendering turns external images into links (app/lib/markdown.server.ts);
//   font-src 'self' data: permits KaTeX fonts; connect-src 'self' also confines passkey/WebAuthn traffic to same-origin /api/auth;
//   worker-src 'self' for public/sw.js; manifest-src 'self' for public/manifest.webmanifest, both explicit despite default-src fallback; frame-ancestors 'none'; base-uri 'self'; form-action 'self'.
//   「AIで開く」 window.open navigation to external sites is outside CSP's scope, as is clipboard access.
// - Development (Vite HMR): omit CSP because React Refresh inline scripts and WebSockets cannot work with nonce and connect-src 'self'.
//   Browser tests running the production build (playwright.prod.config.ts) check production behavior. Strict-Transport-Security is also production-only.
// - X-Content-Type-Options: nosniff; Referrer-Policy: strict-origin-when-cross-origin; Permissions-Policy disables camera, microphone, geolocation, payment, and USB,
//   while allowing same-origin publickey-credentials-get/publickey-credentials-create for passkeys.
// - Production Strict-Transport-Security: one-year max-age; omit includeSubDomains to avoid affecting other subdomains.

export type SecurityHeaderOptions = {
  // Per-request random value (CSP nonce), needed when setting production CSP.
  nonce: string;
  // Whether this is production configuration, enabling CSP/HSTS.
  production: boolean;
  privateData?: boolean;
  pathname?: string;
};

// Authentication popups must retain their relationship with external clients.
// Match the router's case-insensitive paths and encoded static segments too.
export function authenticationFlow(pathname: string): boolean {
  let path = pathname;
  try { path = decodeURI(path); } catch { /* Invalid paths keep normal isolation. */ }
  path = path.replace(/\/_\.data$/, "/").replace(/\.data$/, "");
  return /^\/(?:api\/auth|mcp|login|logout|auth|invite|onboarding)(?:\/|$)/i.test(path);
}

// Per-request CSP nonce written by middleware and read by entry.server.tsx. Null if middleware did not run, which should never occur.
export const nonceContext = createContext<string | null>(null);

export function generateNonce(): string {
  return randomBytes(16).toString("base64");
}

export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

export const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "publickey-credentials-get=(self)",
  "publickey-credentials-create=(self)",
].join(", ");

export const HSTS = "max-age=31536000";

// Default Cache-Control for production HTML without one: a different CSP nonce is embedded in each response. Shared caches (CDNs/proxies) must never serve
// the same nonce-bearing document to another reader, since nonce reuse defeats CSP. private excludes shared caching; no-cache requires validation before reuse.
// Do not overwrite route-provided Cache-Control such as `no-store` or `private`.
export const HTML_CACHE_CONTROL = "private, no-cache";

export const isHtml = (headers: Headers): boolean => (headers.get("content-type") ?? "").toLowerCase().startsWith("text/html");

// Header list, attaching only headers absent from the response.
export function securityHeaders(opts: SecurityHeaderOptions): Record<string, string> {
  return {
    ...(opts.production ? { "Content-Security-Policy": contentSecurityPolicy(opts.nonce), "Strict-Transport-Security": HSTS } : {}),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
    ...(!authenticationFlow(opts.pathname ?? "/") ? { "Cross-Origin-Opener-Policy": "same-origin" } : {}),
  };
}

export function isProductionEnv(env: Record<string, string | undefined> = process.env): boolean {
  return !isDevOrTest(env);
}

// Add only absent headers to Headers. entry.server.tsx uses this for document responses that bypassed root middleware.
export function addSecurityHeaders(headers: Headers, opts: SecurityHeaderOptions): void {
  for (const [name, value] of Object.entries(securityHeaders(opts))) if (!headers.has(name)) headers.set(name, value);
  if (opts.production && isHtml(headers) && !headers.has("Cache-Control")) headers.set("Cache-Control", HTML_CACHE_CONTROL);
}

// Add only absent response headers. Copy immutable headers (Response.redirect/fetch responses) into a new Response.
export function withSecurityHeaders(response: Response, opts: SecurityHeaderOptions): Response {
  const extra = Object.entries(securityHeaders(opts)).filter(([name]) => !response.headers.has(name));
  if (opts.privateData) extra.push(["Cache-Control", "private, no-store"]);
  if (!opts.privateData && opts.production && isHtml(response.headers) && !response.headers.has("Cache-Control")) extra.push(["Cache-Control", HTML_CACHE_CONTROL]);
  if (extra.length === 0) return response;
  try {
    for (const [name, value] of extra) response.headers.set(name, value);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    for (const [name, value] of extra) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

// The catch-all route covers unknown paths with root middleware. entry.server.tsx retains a nonce and header fallback for document responses that bypass middleware.
// Outermost root middleware, covering other middleware responses too. Generate a nonce in context and attach response headers.
// Also covers data (.data) and resource-route responses (Markdown/JSON), all handled under the root.
export const securityHeadersMiddleware: MiddlewareFunction = async ({ context, request }, next) => {
  const nonce = generateNonce();
  context.set(nonceContext, nonce);
  const response = await next();
  // On the server, next() returns a Response (typed as unknown).
  const url = new URL(request.url);
  const documentPath = url.pathname.replace(/\/_\.data$/, "/").replace(/\.data$/, "");
  const publicStatic = /^\/(principles|why|name|connect|offline)\/?$/.test(documentPath);
  const memberOnly = /^\/(settings|notifications|drafts?|mod|admin|invites|onboarding|suspended|login|auth|mcp)(?:\/|$)/.test(documentPath);
  // Root data includes account appearance even on public information pages.
  // Document-only fetches still carry no member preference.
  const selectedRoutes = url.searchParams.get("_routes");
  const memberData = getSessionCookie(request) !== null && (!publicStatic || !selectedRoutes || selectedRoutes.split(",").includes("root"));
  const privateData = url.pathname.endsWith(".data") && (memberData || (!publicStatic && (memberOnly || !publicReading())));
  return response instanceof Response ? withSecurityHeaders(response, { nonce, production: isProductionEnv(), privateData, pathname: url.pathname }) : response;
};
