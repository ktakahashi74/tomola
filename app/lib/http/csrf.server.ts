import { data } from "react-router";
import { authBaseURL } from "~/lib/auth/auth.server";

// CSRF defense for state-changing resource routes (browser POSTs): require requests originating from this site.
// Also used for API writes authenticated by browser sessions, but not token-authenticated APIs.
//
// - If Origin exists, it must match BETTER_AUTH_URL's origin (http://localhost:5173 in development). "null" also mismatches.
// - Without Origin, require Sec-Fetch-Site: same-origin.
// - Without either, reject non-browser clients or old browsers that cannot occur for normal POSTs.
// Skip GET, HEAD, and OPTIONS, which do not change state.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function siteOrigin(baseUrl: string = authBaseURL()): string {
  return new URL(baseUrl).origin;
}

export function isSameOriginRequest(request: Request, expected: string = siteOrigin()): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === expected;
  const site = request.headers.get("sec-fetch-site");
  return site === "same-origin";
}

// Throw 403 for external origins. Call first in resource-route actions, before authentication or input parsing.
export function assertSameOrigin(request: Request, expected?: string): void {
  if (!isSameOriginRequest(request, expected)) throw data("Forbidden", { status: 403 });
}
