import { trialForm } from "./helpers/trial";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readingReturnCookieName, readingReturnMiddleware, readReadingReturn } from "~/lib/auth/reading-return.server";
import { action as signupAction } from "~/routes/onboarding";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("reader");
});
afterAll(() => { h.restore(); vi.unstubAllEnvs(); });

const remembered = (request: Request, value: string) => {
  request.headers.set("cookie", `${request.headers.get("cookie") ?? ""}; ${readingReturnCookieName(request)}=${value}`);
  return request;
};
const middleware = (request: Request, response = new Response("topic", { headers: { "Cache-Control": "private", "X-Robots-Tag": "noindex" } })) =>
  readingReturnMiddleware(h.args(request), async () => response) as Promise<Response>;
async function signup(request: Request): Promise<Response> {
  try { await signupAction(h.args(request)); }
  catch (response) { if (response instanceof Response) return response; throw response; }
  throw new Error("Expected signup to redirect");
}

describe("the temporary reading destination", () => {
  it("removes forced versions when writing a destination and when reading an older cookie", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    const path = "/t/42?orig=42&orig=7&tr=8&old=9&lang=ja&page=2";
    const request = h.request(path);
    const response = await middleware(request);
    const set = response.headers.getSetCookie().find(value => value.startsWith(`${readingReturnCookieName(request)}=`))!;
    expect(set.split(";")[0]).toBe(`${readingReturnCookieName(request)}=${encodeURIComponent("/t/42?lang=ja&page=2")}`);
    expect(readReadingReturn(remembered(h.request("/onboarding"), encodeURIComponent(path)))).toBe("/t/42?lang=ja&page=2");
    expect(readReadingReturn(remembered(h.request("/onboarding"), encodeURIComponent("/t/42?orig=42&tr=7&old=8")))).toBe("/t/42");
  });

  it("remembers only the topic document and query for one day, preserving cache headers on HTTP and HTTPS", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    for (const scheme of ["http", "https"]) {
      const request = new Request(`${scheme}://localhost:5173/t/42.data?lang=ja&page=2&_routes=routes%2Ftopic#reply`);
      const response = await middleware(request);
      expect(response.headers.get("Cache-Control")).toBe("private");
      const set = response.headers.getSetCookie().find(value => value.startsWith(`${readingReturnCookieName(request)}=`))!;
      expect(set).toContain("=%2Ft%2F42%3Flang%3Dja%26page%3D2;");
      for (const flag of ["Path=/", "SameSite=Lax", "HttpOnly", "Max-Age=86400"]) expect(set).toContain(flag);
      expect(set.includes("; Secure")).toBe(scheme === "https");
      expect(set.startsWith("__Host-")).toBe(scheme === "https");
      expect(set).not.toContain("_routes");
      expect(set).not.toContain("reply");
    }
  });

  it("does not remember member reads, private mode, failed reads, non-topic routes, twins or HEAD requests", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    const noCookie = async (request: Request, response?: Response) => {
      expect((await middleware(request, response)).headers.getSetCookie()).toEqual([]);
    };
    await noCookie(h.request("/t/42", { as: "reader" }));
    await noCookie(h.request("/t/42"), new Response("Not found", { status: 404 }));
    for (const path of ["/", "/settings", "/t/new", "/t/42.md", "/t/42/objections"]) await noCookie(h.request(path));
    await noCookie(new Request("http://localhost:5173/t/42", { method: "HEAD" }));
    vi.stubEnv("PUBLIC_READING", "");
    await noCookie(h.request("/t/42"));
  });

  it("rejects foreign destinations, non-topic locations, duplicate cookies and broken encodings", () => {
    for (const value of ["https://evil.example/t/42", "//evil.example/t/42", "/settings", "/t/42.md", "/t/42/objections", "/t/nope", "/\\evil.example/t/42", "/a/..//evil.example/t/42"]) {
      expect(readReadingReturn(remembered(h.request("/onboarding"), encodeURIComponent(value))), value).toBeNull();
    }
    for (const value of ["%", "%E0%A4%A", "x".repeat(2049)]) expect(readReadingReturn(remembered(h.request("/onboarding"), value))).toBeNull();
    const duplicate = remembered(h.request("/onboarding"), "%2Ft%2F42");
    duplicate.headers.set("cookie", `${duplicate.headers.get("cookie")}; ${readingReturnCookieName(duplicate)}=%2Ft%2F43`);
    expect(readReadingReturn(duplicate)).toBeNull();
    expect(readReadingReturn(remembered(h.request("/onboarding"), "%2Ft%2F42%3Flang%3Dja%23reply"))).toBe("/t/42?lang=ja");
  });

  it("preserves the reading cookie on form errors, uses it after signup, and clears it on completion and duplicates", async () => {
    await h.signIn("reading_signup", { profile: false });
    const req = (handle: string) => remembered(h.request("/onboarding", { as: "reading_signup", form: { ...trialForm, handle, homeArea: "en" } }), "%2Ft%2F42%3Flang%3Dja");
    expect(await signupAction(h.args(req("!")))).toMatchObject({ error: "invalid_handle" });
    for (let n = 0; n < 2; n++) {
      const response = await signup(req("reading_signup"));
      expect(response.headers.get("location")).toBe("/t/42?lang=ja");
      expect(response.headers.getSetCookie()).toContain("tomola.reading-return=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    }
  });

  it("gives an explicit return path priority and falls back home for unsafe reading cookies", async () => {
    for (const [index, raw] of ["https://evil.example/t/42", "/settings", "%", "/t/42?lang=ja"].entries()) {
      const handle = `reading_next_${index}`;
      await h.signIn(handle, { profile: false });
      const next = index === 3 ? "/t/43?lang=en#reply" : "/";
      const request = remembered(h.request(`/onboarding?${new URLSearchParams({ next })}`, { as: handle, form: { ...trialForm, handle, homeArea: "en" } }), index === 2 ? raw : encodeURIComponent(raw));
      const response = await signup(request);
      expect(response.headers.get("location")).toBe(next);
      expect(response.headers.getSetCookie()).toContain("tomola.reading-return=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    }
  });
});
