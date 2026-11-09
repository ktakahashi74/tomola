

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createAuth } from "~/lib/auth/auth.server";
import { getSessionUser } from "~/lib/auth/session.server";
import { sessionCookieMiddleware } from "~/lib/auth/session-cookies.server";
import { session } from "~/lib/db/schema";
import { createInvitation } from "~/lib/invitations.server";
import { action as logoutAction } from "~/routes/logout";
import { createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

describe("sessions keep no IP address or user agent", () => {
  it("stores neither, even when the request carries both", async () => {
    const db = await createTestDb();
    const sent: string[] = [];
    const auth = createAuth(db, {
      baseURL: "http://localhost:5173",
      secret: "test-secret-0123456789abcdef0123456789abcdef",
      sendMagicLink: async ({ token }) => {
        sent.push(token);
      },
    });
    await createInvitation(db, { email: "a@example.com" });
    await auth.api.signInMagicLink({ body: { email: "a@example.com" }, headers: new Headers() });
    const res = await auth.api.magicLinkVerify({
      query: { token: sent[0] },
      headers: new Headers({ "x-forwarded-for": "203.0.113.5", "x-real-ip": "203.0.113.5", "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0" }),
      asResponse: true,
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(session);
    expect(rows).toHaveLength(1);
    expect(rows[0].ipAddress).toBeNull();
    expect(rows[0].userAgent).toBeNull();
  });
});

describe("session refresh and logout", () => {
  let h: RouteHarness;
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja" });
    await h.signIn("kim", { homeArea: "ja" });
  });
  afterAll(() => h.restore());

  const DAY = 24 * 3600 * 1000;
  const ageSession = async (handle: string, daysLeft: number) => {
    await h.db.update(session).set({ expiresAt: new Date(Date.now() + daysLeft * DAY) }).where(eq(session.userId, h.ids[handle]));
  };
  const runMiddleware = async (req: Request, next: () => Promise<Response>) =>
    (await sessionCookieMiddleware({ request: req, params: {}, context: {} } as never, next)) as Response;
  const sessionCookies = (res: Response) => res.headers.getSetCookie().filter((c) => c.startsWith("better-auth.session_token="));

  it("forwards a refreshed session cookie when the session is due (and moves the expiry out again)", async () => {
    await ageSession("hana", 5);
    const { loader } = await import("~/routes/settings");
    const req = h.request("/settings", { as: "hana" });
    const res = await runMiddleware(req, async () => {
      await loader(h.args(req));
      return new Response("page");
    });
    const cookies = sessionCookies(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/Max-Age=2592000/i);
    const [row] = await h.db.select().from(session).where(eq(session.userId, h.ids.hana));
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29.9 * DAY);
    // The new cookie value belongs to the same session; the token is unchanged.
    expect(cookies[0].split(";")[0]).toBe(h.request("/", { as: "hana" }).headers.get("cookie")!.split("; ").find((c) => c.startsWith("better-auth.session_token="))!.replace(/;$/, ""));
  });

  it("sends nothing while the session is fresh", async () => {
    const req = h.request("/settings", { as: "kim" });
    const res = await runMiddleware(req, async () => {
      await getSessionUser(req);
      return new Response("page");
    });
    expect(sessionCookies(res)).toEqual([]);
  });

  it("sends a single cookie even when the session is read several times in one request", async () => {
    await ageSession("kim", 3);
    const req = h.request("/", { as: "kim" });
    const res = await runMiddleware(req, async () => {
      await Promise.all([getSessionUser(req), getSessionUser(req), getSessionUser(req)]);
      await getSessionUser(req);
      return new Response("page");
    });
    expect(sessionCookies(res)).toHaveLength(1);
  });

  it("leaves a cookie the response sets itself alone (a new login must not be overwritten by the old session)", async () => {
    await ageSession("hana", 2);
    const req = h.request("/", { as: "hana" });
    const own = "better-auth.session_token=NEW-SESSION; Max-Age=2592000; Path=/; HttpOnly";
    const res = await runMiddleware(req, async () => {
      await getSessionUser(req);
      return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": own } });
    });
    expect(sessionCookies(res)).toEqual([own]);
    expect(res.status).toBe(303);
  });

  it("works on a response whose headers cannot be changed, and on data responses", async () => {
    await ageSession("kim", 1);
    const req = h.request("/t/1.data", { as: "kim" });
    const res = await runMiddleware(req, async () => {
      await getSessionUser(req);
      return Response.redirect("http://localhost:5173/login", 302);
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:5173/login");
    expect(sessionCookies(res)).toHaveLength(1);
  });

  it("does nothing outside a request's middleware, and passes non-Response values through", async () => {
    await expect(getSessionUser(h.request("/", { as: "hana" }))).resolves.toMatchObject({ email: "hana@example.com" });
    expect(await sessionCookieMiddleware({ request: h.request("/"), params: {}, context: {} } as never, async () => "not a response")).toBe("not a response");
  });

  it("logout is refused from another origin, and signs the member out from this one", async () => {
    const foreign = await h.outcome(() => logoutAction(h.args(h.request("/logout", { as: "hana", form: {}, headers: { origin: "https://evil.example" } }))));
    expect(foreign.status).toBe(403);
    expect(await h.db.select().from(session).where(eq(session.userId, h.ids.hana))).toHaveLength(1);
    const noOrigin = await h.outcome(() => logoutAction(h.args(new Request("http://localhost:5173/logout", { method: "POST", headers: { cookie: h.request("/", { as: "hana" }).headers.get("cookie")! } }))));
    expect(noOrigin.status).toBe(403);
    expect(await h.db.select().from(session).where(eq(session.userId, h.ids.hana))).toHaveLength(1);
    const ok = await h.outcome(() => logoutAction(h.args(h.request("/logout", { as: "hana", form: {} }))));
    expect(ok).toMatchObject({ status: 302, location: "/login" });
    expect(await h.db.select().from(session).where(eq(session.userId, h.ids.hana))).toHaveLength(0);
    expect((ok as unknown as { value: Response }).value.headers.getSetCookie().some((c) => /session_token=;/.test(c) || /Max-Age=0/i.test(c))).toBe(true);
  });
});
