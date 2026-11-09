import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { settingsReturnFromRequest } from "~/lib/settings-return.server";
import { action, loader } from "~/routes/settings";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("shell_settings"); });
afterAll(() => h.restore());

it("keeps the original reading path through settings saves", async () => {
  const returnTo = "/t/7?lang=en&page=2#c-9";
  const path = `/settings?${new URLSearchParams({ returnTo })}`;
  expect(await loader(h.args(h.request(path, { as: "shell_settings" })))).toHaveProperty("returnTo", returnTo);
  const result = await h.outcome(() => action(h.args(h.request(path, { as: "shell_settings", form: { intent: "email-pref", emailPref: "daily" } }))));
  expect(result.status).toBe(302);
  const saved = new URL(result.location!, "http://localhost:5173");
  expect(saved.searchParams.get("returnTo")).toBe(returnTo);
  expect(saved.hash).toBe("#settings-email");
  expect(await loader(h.args(h.request(result.location!, { as: "shell_settings" })))).toHaveProperty("returnTo", returnTo);
});

it("recovers a local referrer but never remembers an external or malformed destination", async () => {
  expect(await loader(h.args(h.request("/settings", { as: "shell_settings", headers: { Referer: "http://localhost:5173/following?asks=1" } })))).toHaveProperty("returnTo", "/following?asks=1");
  for (const returnTo of ["https://outside.example/t/1", "//outside.example/t/1", "/\\outside.example", "/settings", "/a/..//outside.example"]) {
    const path = `/settings?${new URLSearchParams({ returnTo })}`;
    const value = await loader(h.args(h.request(path, { as: "shell_settings", headers: { Referer: "https://outside.example/" } })));
    expect(value).toHaveProperty("returnTo", null);
  }
});

it("uses the configured public origin behind a forwarded HTTPS proxy and rejects other referrers", () => {
  vi.stubEnv("BETTER_AUTH_URL", "https://forum.example.org");
  try {
    const request = (referer: string, forwardedHost = "forum.example.org") => new Request("http://127.0.0.1:3000/settings", { headers: {
      referer, "x-forwarded-proto": "https", "x-forwarded-host": forwardedHost, "x-forwarded-for": "192.0.2.1",
    } });
    expect(settingsReturnFromRequest(request("https://forum.example.org/notifications?lang=ja"))).toBe("/notifications?lang=ja");
    expect(settingsReturnFromRequest(request("http://127.0.0.1:3000/t/1"))).toBeNull();
    expect(settingsReturnFromRequest(request("https://outside.example/t/1", "outside.example"))).toBeNull();
  } finally { vi.unstubAllEnvs(); }
});
