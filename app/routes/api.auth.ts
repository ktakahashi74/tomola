import type { Route } from "./+types/api.auth";
import { authBaseURL, createAppAuth, getAuth } from "~/lib/auth/auth.server";
import { isAllowedAuthEndpoint, isOAuthAuthEndpoint } from "~/lib/auth/endpoints.server";
import { handleOAuthHttp } from "~/lib/mcp/oauth-http.server";
import { clientAddress } from "~/lib/http/client-ip.server";
import { getDb } from "~/lib/db/client.server";
import { hitRateLimit, PASSKEY_IP_LIMIT, rateLimitHeaders } from "~/lib/rate-limit.server";
import { eq } from "drizzle-orm";
import { passkey } from "~/lib/db/schema";
import { lockSigningMember } from "~/lib/signing.server";
import { getMailer } from "~/lib/mail/mail.server";
import { clearReadingReturn } from "~/lib/auth/reading-return.server";

// Better Auth HTTP handler. Forward only the passkey login and OAuth endpoints on the explicit allowlist; all others return 404.
// Limit allowed endpoints to 60 requests per IP per 15 minutes: anyone may request passkey options, and each call creates a DB row.
// Better Auth's own IP-based limiter does not work when IP storage is disabled. Skip rate limiting when the IP is unavailable.
async function handle(request: Request) {
  if (!isAllowedAuthEndpoint(request)) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (isOAuthAuthEndpoint(request)) {
    const baseURL = authBaseURL();
    const expected = new URL(baseURL);
    if (new URL(request.url).host !== expected.host || (request.headers.has("host") && request.headers.get("host") !== expected.host) || (request.headers.has("origin") && request.headers.get("origin") !== expected.origin)) return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "private, no-store" } });
    const db = await getDb();
    const ip = clientAddress(request);
    if (ip !== null) {
      const rate = await hitRateLimit(db, { key: `oauth:ip:${ip}`, limit: 120, windowSeconds: 900 });
      if (!rate.allowed) return Response.json({ error: "rate_limited" }, { status: 429, headers: { ...rateLimitHeaders(rate), "Cache-Control": "private, no-store" } });
    }
    const response = await handleOAuthHttp(request, db, await getAuth(), baseURL);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  const ip = clientAddress(request);
  if (ip !== null) {
    const rate = await hitRateLimit(await getDb(), { key: `passkey:ip:${ip}`, ...PASSKEY_IP_LIMIT });
    if (!rate.allowed) return Response.json({ error: "rate_limited" }, { status: 429, headers: { ...rateLimitHeaders(rate), "Cache-Control": "no-store" } });
  }
  const auth = await getAuth();
  if (request.method === "POST" && new URL(request.url).pathname.endsWith("/passkey/verify-authentication")) {
    let credentialId: unknown;
    try { credentialId = (await request.clone().json())?.response?.id; } catch { return auth.handler(request); }
    if (typeof credentialId === "string") {
      const db = await getDb();
      const [key] = await db.select({ userId: passkey.userId }).from(passkey).where(eq(passkey.credentialID, credentialId));
      if (key) return db.transaction(async tx => {
        await lockSigningMember(tx, key.userId);
        await tx.select({ id: passkey.id }).from(passkey).where(eq(passkey.credentialID, credentialId as string)).for("update");
        // Use this transaction's adapter: the login counter cannot race with signing or registration on another connection.
        const options = auth.options;
        if (typeof options.baseURL !== "string" || typeof options.secret !== "string") throw new Error("Passkey login requires an explicit origin and secret");
        return createAppAuth(tx, { baseURL: options.baseURL, secret: options.secret, mailer: getMailer }).handler(request);
      });
    }
  }
  return auth.handler(request);
}

export async function loader({ request }: Route.LoaderArgs) {
  return handle(request);
}

export async function action({ request }: Route.ActionArgs) {
  const response = await handle(request);
  if (response.ok && new URL(request.url).pathname.endsWith("/passkey/verify-authentication")) {
    const headers = new Headers(response.headers);
    clearReadingReturn(request, headers);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
}
