// /api/auth/* is passed to Better Auth's HTTP handler (app/routes/api.auth.ts). Better Auth also provides endpoints the app does not use
// (/sign-in/magic-link, /magic-link/verify, /update-user, /get-session, /sign-out, …). Exposing them directly would bypass the app's screens
// and their invitation checks, confirmation page, rate limits, and member display-name rules. Allowlist only endpoints the app actually uses
// and return 404 for all others without passing them to the handler.
//   - For magic-link login, the /login and /invite/:token actions call auth.api.signInMagicLink directly, and /auth/confirm
//     calls auth.api.magicLinkVerify directly. No HTTP endpoints are used.
//   - Session reads and logout also call auth.api directly on the server (app/lib/auth/session.server.ts, app/routes/logout.tsx).
//   - The browser calls only the two passkey login endpoints. Registration uses /passkeys with mandatory user verification and existing-key proof;
//     deletion uses the signed /settings action. Better Auth's registration, listing, deletion and renaming HTTP endpoints remain closed.
// To add an endpoint, add its method and path here. Matching is exact, including case and trailing slashes.

export const AUTH_BASE_PATH = "/api/auth";

// OAuth's machine endpoints and signed authorize entry only. Consent/login stay behind the application screens.
export const OAUTH_AUTH_ENDPOINTS: readonly { method: "GET" | "POST"; path: string }[] = [
  { method: "GET", path: "/oauth2/authorize" },
  { method: "POST", path: "/oauth2/token" },
  { method: "POST", path: "/oauth2/register" },
  { method: "POST", path: "/oauth2/revoke" },
  { method: "GET", path: "/jwks" },
  { method: "GET", path: "/.well-known/oauth-authorization-server" },
  { method: "GET", path: "/.well-known/oauth-protected-resource" },
];
export function isOAuthAuthEndpoint(request: Request): boolean {
  const path = new URL(request.url).pathname.slice(AUTH_BASE_PATH.length);
  return OAUTH_AUTH_ENDPOINTS.some((endpoint) => endpoint.method === request.method && endpoint.path === path);
}

export const ALLOWED_AUTH_ENDPOINTS: readonly { method: "GET" | "POST"; path: string }[] = [
  // Passkey login only. The plugin's registration verifier does not enforce the enrollment barriers.
  { method: "GET", path: "/passkey/generate-authenticate-options" },
  { method: "POST", path: "/passkey/verify-authentication" },
];

export function isAllowedAuthEndpoint(request: Request): boolean {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(`${AUTH_BASE_PATH}/`)) return false;
  const path = pathname.slice(AUTH_BASE_PATH.length);
  const method = request.method.toUpperCase();
  return [...ALLOWED_AUTH_ENDPOINTS, ...OAUTH_AUTH_ENDPOINTS].some((endpoint) => endpoint.method === method && endpoint.path === path);
}
