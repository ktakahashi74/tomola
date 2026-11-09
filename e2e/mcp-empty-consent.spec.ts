import { oauthLoopback } from "./support/oauth-loopback";
import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { captureScreenshot, enMessages as m, state, useMember, waitForClientRoute } from "./helpers";

test("a request without a usable permission explains why it cannot be allowed and can be denied", async ({ page, request }) => {
  const loopback = await oauthLoopback();
  try {
  await useMember(page, "consent_empty@example.com");
  const { baseURL } = state();
  const redirect = loopback.redirectURI;
  const response = await request.post(`${baseURL}/api/auth/oauth2/register`, { data: {
    client_name: "Fictional empty-permission client", application_type: "native", redirect_uris: [redirect],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "offline_access",
  } });
  expect(response.status(), await response.text()).toBe(201);
  const clientId = (await response.json()).client_id as string;
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope: "offline_access",
    code_challenge_method: "S256", code_challenge: createHash("sha256").update("e".repeat(64)).digest("base64url"), state: "empty-permission" });
  await page.goto(`${baseURL}/api/auth/oauth2/authorize?${query}`);
  await expect(page).toHaveURL(/\/mcp\/consent\?/);
  await waitForClientRoute(page);
  for (const width of [1280, 1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await captureScreenshot(page, { fullPage: true }, `empty-consent-${width}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await expect(page.getByRole("button", { name: m.mcp_allow, exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveText(m.mcp_no_permissions);
  await page.getByRole("button", { name: m.mcp_deny, exact: true }).click();
  await expect(page).toHaveURL(url => url.origin + url.pathname === redirect && url.searchParams.get("error") === "access_denied" && !url.searchParams.has("code"));
  } finally { await loopback.close(); }
});
