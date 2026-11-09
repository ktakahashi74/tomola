import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { loader } from "~/routes/navigation-header";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import * as limits from "~/lib/rate-limit.server";

let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("nav_ready");
  await h.signIn("nav_pending", { profile: false });
});
afterAll(() => { h.restore(); vi.unstubAllEnvs(); });

function privateResponse(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Vary")).toContain("Cookie");
  expect(response.headers.get("Vary")).toContain("Accept-Language");
}

it("returns only guest navigation to unsigned-in and incomplete accounts, even in private reading mode", async () => {
  vi.stubEnv("PUBLIC_READING", "");
  for (const as of [undefined, "nav_pending"]) {
    const response = await loader(h.args(h.request("/navigation-header", as ? { as } : {})));
    privateResponse(response);
    expect(await response.json()).toEqual({ reader: true });
  }
});

it("returns the current member's navigation without sharing it or selecting an account from a query", async () => {
  const response = await loader(h.args(h.request("/navigation-header?email=other@example.com", { as: "nav_ready" })));
  privateResponse(response);
  const value = await response.json();
  expect(value).toMatchObject({ reader: false, handle: "nav_ready", userId: h.ids.nav_ready, apiDrafts: 0, unreadNotifications: 0 });
  expect(value).not.toHaveProperty("homeLayout");
  expect(JSON.stringify(value)).not.toContain("other@example.com");
  expect(JSON.stringify(value)).not.toContain(h.ids.nav_pending);
});

it("gives the same guest answer for queried addresses and an invalid session", async () => {
  for (const email of ["nav_ready@example.com", "unknown@example.com"]) {
    const response = await loader(h.args(h.request(`/navigation-header?${new URLSearchParams({ email })}`, { headers: { cookie: "better-auth.session_token=invalid" } })));
    privateResponse(response);
    expect(await response.json()).toEqual({ reader: true });
  }
});

it("does not spend a public read on anonymous navigation, even when the read quota is exhausted", async () => {
  vi.stubEnv("PUBLIC_READING", "1");
  const rate = vi.spyOn(limits, "hitPublicReadLimit").mockResolvedValue({ allowed: false, count: 601, limit: 600, remaining: 0, resetAt: new Date(), retryAfterSeconds: 60 });
  try {
    const response = await loader(h.args(h.request("/navigation-header")));
    privateResponse(response);
    expect(await response.json()).toEqual({ reader: true });
    expect(rate).not.toHaveBeenCalled();
  } finally { rate.mockRestore(); vi.unstubAllEnvs(); }
});
