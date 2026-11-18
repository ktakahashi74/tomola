import { createHash } from "node:crypto";
import sharp from "sharp";
import { enMessages as en } from "../e2e/helpers";
import { oauthLoopback } from "../e2e/support/oauth-loopback";
import { test, expect, useMember, watchCsp, waitForClientRoute } from "./helpers";

test("image upload permission is opt-in for personal tokens and OAuth consent under production CSP", async ({ page, request }) => {
  const watch = await watchCsp(page);
  await useMember(page, "media_prod@example.com");
  await page.goto("/settings/tokens");
  await waitForClientRoute(page);
  const bytes = await sharp({ create: { width: 16, height: 8, channels: 3, background: "green" } }).png().toBuffer();
  const send = (token?: string) => page.request.post("/api/media", { headers: { "content-type": "image/png", ...(token ? { authorization: `Bearer ${token}` } : {}) }, data: bytes });
  expect((await send()).status()).toBe(401);
  for (const allowed of [false, true]) {
    await page.getByRole("radio", { name: en.tokens_kind_draft, exact: true }).check();
    const permission = page.getByRole("checkbox", { name: en.media_upload_permission, exact: true });
    await expect(permission).not.toBeChecked();
    await expect(page.getByText(en.media_upload_help, { exact: true })).toBeVisible();
    await page.getByLabel(en.tokens_name, { exact: true }).fill(allowed ? "Image fixture enabled" : "Draft fixture only");
    if (allowed) await permission.check();
    await page.getByRole("button", { name: en.tokens_create, exact: true }).click();
    await expect(page.getByRole("row").filter({ hasText: allowed ? "Image fixture enabled" : "Draft fixture only" })).toBeVisible();
    const shown = page.getByRole("status").locator("code");
    await expect(shown).toHaveText(/^tml_draft_/);
    const token = (await shown.textContent())!;
    const response = await send(token);
    expect(response.status(), await response.text()).toBe(allowed ? 201 : 403);
    if (allowed) {
      const external = await request.post("/api/media", { headers: { authorization: `Bearer ${token}`, origin: "https://client.example", "content-type": "image/png" }, data: bytes });
      expect(external.status(), await external.text()).toBe(201);
    }
    await expect(page.getByRole("row").filter({ hasText: allowed ? "Image fixture enabled" : "Draft fixture only" })).toContainText(allowed ? en.media_upload_permission : en.tokens_kind_draft_short);
    if (!allowed) await expect(page.getByRole("row").filter({ hasText: "Draft fixture only" })).not.toContainText(en.media_upload_permission);
  }
  const loopback = await oauthLoopback();
  try {
    for (const allowed of [false, true]) {
      const registration = await request.post("/api/auth/oauth2/register", { data: { client_name: allowed ? "Image client enabled" : "Image client unselected", application_type: "native", redirect_uris: [loopback.redirectURI], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "draft media" } });
      expect(registration.status()).toBe(201);
      const clientId = (await registration.json()).client_id;
      const verifier = "v".repeat(64);
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: loopback.redirectURI, response_type: "code", scope: "draft media", resource: new URL("/mcp", page.url()).href, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
      await page.goto(`/api/auth/oauth2/authorize?${params}`);
      const permission = page.getByRole("checkbox", { name: en.media_upload_permission, exact: true });
      await expect(permission).not.toBeChecked();
      await expect(page.getByText(en.media_upload_help, { exact: true })).toBeVisible();
      if (allowed) await permission.check();
      const origin = new URL(page.url()).origin;
      await page.getByRole("button", { name: en.mcp_allow, exact: true }).click();
      await expect(page).toHaveURL(url => url.href.startsWith(loopback.redirectURI) && url.searchParams.has("code"));
      const code = new URL(page.url()).searchParams.get("code")!;
      const exchanged = await request.post("/api/auth/oauth2/token", { form: { grant_type: "authorization_code", client_id: clientId, redirect_uri: loopback.redirectURI, code, code_verifier: verifier, resource: `${origin}/mcp` } });
      expect(exchanged.status()).toBe(200);
      const token = await exchanged.json();
      expect(token.scope.split(" ").includes("media")).toBe(allowed);
      const response = await request.post("/api/media", { headers: { authorization: `Bearer ${token.access_token}`, "content-type": "image/png" }, data: bytes });
      expect(response.status()).toBe(allowed ? 201 : 403);
      await page.goto("/settings/connections");
      const connection = page.getByRole("main").locator("section").filter({ hasText: clientId });
      if (allowed) await expect(connection).toContainText(en.media_upload_permission);
      else await expect(connection).not.toContainText(en.media_upload_permission);
    }
  } finally { await loopback.close(); }
  expect(watch.violations).toEqual([]); expect(watch.pageErrors).toEqual([]); expect(watch.hydrationWarnings).toEqual([]);
});
