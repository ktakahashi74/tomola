import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createAppAuth } from "~/lib/auth/auth.server";
import { ALLOWED_AUTH_ENDPOINTS, isAllowedAuthEndpoint } from "~/lib/auth/endpoints.server";
import { session, user, verification } from "~/lib/db/schema";
import { createMailer } from "~/lib/mail/mail.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { action, loader } from "~/routes/api.auth";
import { addMember } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// /api/auth/* forwards only allowlisted endpoints to Better Auth; all others return 404.
const BASE = "http://localhost:5173";
let h: RouteHarness;
const box = createMemoryMailbox();
beforeAll(async () => {
  h = await setupRouteHarness();
  (globalThis as { __tomolaAuth?: Promise<unknown> }).__tomolaAuth = Promise.resolve(
    createAppAuth(h.db, { baseURL: BASE, secret: "test-secret-0123456789abcdef0123456789abcdef", mailer: () => createMailer(box.transport, "x@example.org") }),
  );
});
afterAll(() => h.restore());

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const init: RequestInit = { method, headers: { origin: BASE, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const request = new Request(`${BASE}${path}`, init);
  const args = h.args(request) as never;
  return (method === "GET" ? (await loader(args)) : action(args)) as Promise<Response>;
};

describe("Better Auth endpoints the app does not use", () => {
  const blocked: [string, string][] = [
    ["POST", "/api/auth/sign-in/magic-link"],
    ["GET", "/api/auth/magic-link/verify?token=abc&callbackURL=/"],
    ["GET", "/api/auth/get-session"],
    ["POST", "/api/auth/sign-out"],
    ["POST", "/api/auth/update-user"],
    ["POST", "/api/auth/change-email"],
    ["POST", "/api/auth/delete-user"],
    ["GET", "/api/auth/list-sessions"],
    ["POST", "/api/auth/revoke-session"],
    ["POST", "/api/auth/sign-in/email"],
    ["POST", "/api/auth/sign-up/email"],
    ["GET", "/api/auth/ok"],
    ["GET", "/api/auth/error"],
    ["GET", "/api/auth/reference"],
    ["GET", "/api/auth/open-api/generate-schema"],
    ["GET", "/api/auth"],
    ["GET", "/api/auth/"],
    ["POST", "/api/auth/"],
    ["GET", "/api/auth/passkey/list-user-passkeys"],
    ["POST", "/api/auth/passkey/delete-passkey"],
    ["POST", "/api/auth/passkey/update-passkey"],
  ];

  it.each(blocked)("%s %s is a 404", async (method, path) => {
    const res = await call(method, path, method === "POST" ? { email: "someone@example.com" } : undefined);
    expect(res.status).toBe(404);
  });

  it("the sign-in endpoint sends nothing and creates nothing, even for a member or an invited address", async () => {
    await addMember(h.db, "u1", "hana", { email: "hana@example.com" });
    const before = (await h.db.select().from(verification)).length;
    for (const email of ["hana@example.com", "stranger@example.com"]) {
      const res = await call("POST", "/api/auth/sign-in/magic-link", { email });
      expect(res.status).toBe(404);
    }
    expect(box.sent).toEqual([]);
    expect((await h.db.select().from(verification)).length).toBe(before);
  });

  it("the verify endpoint does not consume a real token, and opens no session", async () => {
    const token = await h.issueLink("ann@example.com");
    const credentials = await h.db.select().from(verification);
    const res = await call("GET", `/api/auth/magic-link/verify?token=${token}&callbackURL=/`);
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await h.db.select().from(user).where(eq(user.email, "ann@example.com"))).toHaveLength(0);
    expect(await h.db.select().from(session)).toHaveLength(0);
    expect(await h.db.select().from(verification)).toEqual(credentials);
  });

  it("does not match by case, trailing slash or dot segments", () => {
    const at = (path: string, method = "GET") => isAllowedAuthEndpoint(new Request(`${BASE}${path}`, { method }));
    for (const endpoint of ALLOWED_AUTH_ENDPOINTS) {
      expect(at(`/api/auth${endpoint.path}`, endpoint.method)).toBe(true);
      expect(at(`/api/auth${endpoint.path}/`, endpoint.method)).toBe(false);
      expect(at(`/api/auth${endpoint.path.toUpperCase()}`, endpoint.method)).toBe(false);
      expect(at(`/api/auth${endpoint.path}`, endpoint.method === "GET" ? "POST" : "GET")).toBe(false);
    }
    expect(at("/api/auth/passkey/../get-session")).toBe(false);
    expect(at("/api/authx/ok")).toBe(false);
    expect(at("/api/auth/%70asskey/generate-register-options")).toBe(false);
  });
});
