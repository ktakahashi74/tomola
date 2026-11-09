import { isDevOrTest } from "~/lib/env.server";

// Single public-site base: BETTER_AUTH_URL without trailing slash, default http://localhost:5173 in development/tests if absent.
// Used by invitation URLs (UI 「招待」, `pnpm invite`, E2E seed), Better Auth baseURL, CSRF origin checks (csrf.server.ts) and external-image checks (markdown.server.ts).
// Production startup-checks.server.ts requires BETTER_AUTH_URL with https.
export const DEV_SITE_URL = "http://localhost:5173";

export function siteUrl(env: Record<string, string | undefined> = process.env): string {
  const value = env.BETTER_AUTH_URL?.trim();
  if (value) return value.replace(/\/+$/, "");
  if (isDevOrTest(env)) return DEV_SITE_URL;
  throw new Error("BETTER_AUTH_URL is required unless NODE_ENV is development or test");
}

// Invitation URL with plaintext token returned only once at creation.
export function inviteUrl(token: string, env: Record<string, string | undefined> = process.env): string {
  return `${siteUrl(env)}/invite/${token}`;
}
