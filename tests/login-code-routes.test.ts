import { seedRateLimit } from "./helpers/fixtures";
import { beforeAll, afterAll, expect, it } from "vitest";
import { action as loginAction } from "~/routes/login";
import { action as inviteAction } from "~/routes/invite";
import { action as mcpAction } from "~/routes/mcp-login";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); });
afterAll(() => h.restore());
it("rejects foreign and missing origins on code, resend, and restart POSTs at every entry", async () => {
  for (const [path, action] of [["/login", loginAction], ["/invite/unknown", inviteAction], ["/mcp/login", mcpAction]] as const) {
    for (const intent of ["login-code", "login-resend", "login-restart"]) {
      const result = await h.outcome(() => action(h.args(h.request(path, { form: { intent, code: "123456" }, headers: { origin: "https://foreign.example" } }), { token: "unknown" })));
      expect(result.status).toBe(403);
      const missing = new Request(`http://localhost:5173${path}`, { method: "POST", body: new URLSearchParams({ intent, code: "123456" }) });
      expect((await h.outcome(() => action(h.args(missing, { token: "unknown" })))).status).toBe(403);
    }
  }
});
it("enforces the auth-page IP cap on code POSTs", async () => {
  process.env.TRUSTED_PROXY_HOPS = "1";
  try {
    const { AUTH_PAGE_IP_LIMIT } = await import("~/lib/rate-limit.server");
    const req = () => h.request("/login", { form: { intent: "login-code", code: "123456" }, headers: { "x-forwarded-for": "198.51.100.61" } });
    await seedRateLimit(h.db, "ip:auth-page:198.51.100.61", AUTH_PAGE_IP_LIMIT);
    expect((await h.outcome(() => loginAction(h.args(req())))).status).toBe(429);
  } finally { delete process.env.TRUSTED_PROXY_HOPS; }
});

it("code and link racing on separate connections create exactly one session", async () => {
  const { prepareLoginCode } = await import("~/lib/auth/login-code-cookie.server");
  const { issueLoginCode } = await import("~/lib/auth/login-code.server");
  const { action: confirmAction } = await import("~/routes/auth-confirm");
  const { session, user } = await import("~/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const token = await h.issueLink("race@example.com", "/settings?race=1");
  const pending = prepareLoginCode(h.request("/login", { headers: { cookie: h.linkCookie(token) } }), "race@example.com");
  const code = await issueLoginCode(h.db, { id: pending.id, email: "race@example.com", token, nonce: pending.browser.nonce, secret: "test-secret-0123456789abcdef0123456789abcdef" });
  const cookie = `${h.linkCookie(token)}; ${pending.cookie.split(";")[0]}`;
  const results = await Promise.all([
    h.outcome(() => loginAction(h.args(h.request("/login", { form: { intent: "login-code", code }, headers: { cookie } })))),
    h.outcome(() => confirmAction(h.args(h.request("/auth/confirm", { form: { token }, headers: { cookie } })))),
  ]);
  expect(results.map(r => r.status).sort()).toEqual([303, 400]);
  const [member] = await h.db.select().from(user).where(eq(user.email, "race@example.com"));
  expect(await h.db.select().from(session).where(eq(session.userId, member.id))).toHaveLength(1);
});
