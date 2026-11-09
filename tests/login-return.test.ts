import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAppAuth } from "~/lib/auth/auth.server";
import { requireUser } from "~/lib/auth/session.server";
import { settleMagicLinkMail } from "~/lib/auth/magic-link.server";
import { createMailer } from "~/lib/mail/mail.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { action, loader } from "~/routes/login";
import { action as confirmAction, loader as confirmLoader } from "~/routes/auth-confirm";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", () => ({ m: new Proxy({}, {
  get: (_target, key) => (params?: { url?: string }) => key === "mail_magic_link_body" ? params?.url ?? "" : "",
}) }));

let h: RouteHarness;
const box = createMemoryMailbox();
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("returner");
  (globalThis as { __tomolaAuth?: Promise<unknown> }).__tomolaAuth = Promise.resolve(createAppAuth(h.db, {
    baseURL: BASE,
    secret: "test-secret-0123456789abcdef0123456789abcdef",
    mailer: () => createMailer(box.transport, "x@example.org"),
  }));
});
afterAll(() => h.restore());

describe("login return destination", () => {
  it.each(["GET", "HEAD"])("preserves the path and query for a logged-out %s", async (method) => {
    const request = new Request(`${BASE}/t/123?page=1`, { method });
    expect(await h.outcome(() => requireUser(request))).toMatchObject({ status: 302, location: "/login?next=%2Ft%2F123%3Fpage%3D1" });
  });

  it("does not preserve a write destination or add next for the home page", async () => {
    for (const request of [h.request("/"), h.request("/t/123", { form: { body: "x" } })]) {
      expect(await h.outcome(() => requireUser(request))).toMatchObject({ status: 302, location: "/login" });
    }
  });

  it.each([
    ["/t/123.data?page=1&_routes=routes%2Ftopic", "/t/123?page=1"],
    ["/t/123.data?_routes=root&_routes=routes%2Ftopic&page=1&lang=ja", "/t/123?page=1&lang=ja"],
    ["/t/123.data?orig=123&orig=7&tr=8&old=9&_routes=routes%2Ftopic&page=1&lang=ja", "/t/123?page=1&lang=ja"],
    ["/settings.data?tab=profile", "/settings?tab=profile"],
    ["/_.data?_routes=routes%2Fhome", "/"],
    ["/_.data?page=1&_routes=root", "/"],
  ])("returns single-fetch %s to document %s", async (path, destination) => {
    for (const method of ["GET", "HEAD"]) {
      const request = new Request(`${BASE}${path}`, { method });
      expect(await h.outcome(() => requireUser(request))).toMatchObject({
        status: 302,
        location: destination === "/" ? "/login" : `/login?next=${encodeURIComponent(destination)}`,
      });
    }
  });

  it("returns a safe destination to the login form and redirects an already logged-in user there", async () => {
    const path = "/login?next=%2Ft%2F123%3Fpage%3D1";
    expect(await loader(h.args(h.request(path)))).toEqual({ next: "/t/123?page=1", codePending: null, loggedOut: false, reauth: false });
    expect(await h.outcome(async () => (await loader(h.args(h.request(path, { as: "returner" })))))).toMatchObject({ status: 302, location: "/t/123?page=1" });
  });

  it("marks a destination that is a member's page, so the login screen can say that such pages are for members", async () => {
    expect(await loader(h.args(h.request("/login?next=%2Fu%2Faiko")))).toMatchObject({ next: "/u/aiko", membersOnlyTarget: true });
    expect(await loader(h.args(h.request("/login?next=%2Ft%2F1")))).not.toHaveProperty("membersOnlyTarget");
  });

  it.each(["//evil.example", "https://evil.example", "/\\evil.example", "/a/..//evil.example"])("rejects an unsafe destination %s", async (next) => {
    const path = `/login?next=${encodeURIComponent(next)}`;
    expect(await loader(h.args(h.request(path)))).toEqual({ next: "/", codePending: null, loggedOut: false, reauth: false });
    expect(await h.outcome(async () => (await loader(h.args(h.request(path, { as: "returner" })))))).toMatchObject({ status: 302, location: "/" });
  });

  it.each(["/t/123?page=1", "https://evil.example", "//evil.example"])("stores %s privately across the real login email and confirmation", async (next) => {
    const sent = await action(h.args(h.request("/login", { form: { email: "returner@example.com", next } })));
    await settleMagicLinkMail();
    const cookie = (sent as unknown as { init: { headers: Headers } }).init.headers.getSetCookie()[0].split(";")[0];
    const link = box.sent.at(-1)!.text.match(/https?:\/\/\S+/)![0];
    const url = new URL(link);
    const destination = next.startsWith("/t/") ? next : "/";
    expect(url.searchParams.has("next")).toBe(false);
    const page = await confirmLoader(h.args(new Request(link, { headers: { cookie } }))) as unknown as { data: { token: string } };
    expect(page.data).not.toHaveProperty("next");
    const response = await confirmAction(h.args(h.request("/auth/confirm", { headers: { cookie }, form: page.data }))) as Response;
    expect(response.headers.get("location")).toBe(destination);
  });
});
