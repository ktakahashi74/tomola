import { oauthLoopback } from "./support/oauth-loopback";
import { createHash } from "node:crypto";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { waitForClientRoute, useMember, clientHeaders, enMessages, jaMessages, state  } from "./helpers";
import { enableSigningAuthenticator } from "./signing-helper";

test("OAuth consent, owned drafts, unsigned confirmation and immediate revocation in English and Japanese", async ({ page, browser, request }) => {
  test.setTimeout(180_000);
  const { baseURL, mcpInvite } = state();
  const loopback = await oauthLoopback();
  try {
  await page.context().setExtraHTTPHeaders(clientHeaders("127.0.0.31"));
  await useMember(page, "mcp@example.com");
  await page.goto("/settings");
  const advanced = page.locator("#settings-advanced");
  if (await advanced.getAttribute("open") === null) await advanced.locator(":scope > summary").click();
  await page.getByRole("link", { name: enMessages.settings_connections_link, exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/connections$/);
  await expect(page.locator("code").filter({ hasText: `${baseURL}/mcp` })).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: enMessages.mcp_connections_link, exact: true })).toHaveAttribute("href", "/connect");
  const verifier = "v".repeat(64);
  const register = async (request: APIRequestContext, name: string) => {
    const response = await request.post(`${baseURL}/api/auth/oauth2/register`, { data: { client_name: name, client_uri: "https://fictional.example.org", application_type: "native", redirect_uris: [loopback.redirectURI], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "read draft offline_access" } });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()).client_id as string;
  };
  const authorizeUrl = (clientId: string) => {
    const parameters = new URLSearchParams({ client_id: clientId, redirect_uri: loopback.redirectURI, response_type: "code", scope: "read draft offline_access", state: "browser-fixture", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), resource: `${baseURL}/mcp` });
    return `${baseURL}/api/auth/oauth2/authorize?${parameters}`;
  };
  const start = async (target: Page, clientId: string) => {
    await target.goto(authorizeUrl(clientId));
    await expect(target).toHaveURL(/\/mcp\/consent\?/);
  };
  const exchange = async (target: Page, clientId: string) => {
    await target.waitForURL(url => url.origin + url.pathname === loopback.redirectURI && url.searchParams.has("code"));
    const callback = new URL(target.url());
    expect(callback.searchParams.get("iss")).toBe(`${baseURL}/api/auth`);
    expect(callback.searchParams.get("state")).toBe("browser-fixture");
    const response = await request.post(`${baseURL}/api/auth/oauth2/token`, { form: { grant_type: "authorization_code", client_id: clientId, redirect_uri: loopback.redirectURI, code: callback.searchParams.get("code")!, code_verifier: verifier, resource: `${baseURL}/mcp` } });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()).access_token as string;
  };
  const call = (request: APIRequestContext, token: string, name: string, arguments_: object = {}) => request.post(`${baseURL}/mcp`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": name },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: arguments_, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "Not an identity authority", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } },
  });
  const first = await register(request, "Fictional first client");
  const opener = await page.context().newPage();
  try {
    await opener.route("https://oauth-client.example/**", route => route.fulfill({ contentType: "text/html", body: "<title>OAuth client fixture</title>" }));
    await opener.goto("https://oauth-client.example/start");
    const opened = opener.waitForEvent("popup");
    await opener.evaluate(url => { Object.assign(window, { oauthPopup: window.open(url) }); }, authorizeUrl(first));
    const popup = await opened;
    await expect(popup).toHaveURL(/\/mcp\/consent\?/);
    await expect(popup.getByRole("heading", { name: enMessages.mcp_connect_title })).toBeVisible();
    expect(await opener.evaluate(() => (Reflect.get(window, "oauthPopup") as Window | null)?.closed)).toBe(false);
    const reauth = await popup.goto(`${baseURL}/login?reauth=1`);
    expect(reauth!.headers()["cross-origin-opener-policy"]).toBeUndefined();
    expect(await opener.evaluate(() => (Reflect.get(window, "oauthPopup") as Window | null)?.closed)).toBe(false);
    await popup.close();
  } finally { await opener.close(); }
  expect((await page.request.get("/settings")).headers()["cross-origin-opener-policy"]).toBe("same-origin");
  await start(page, first);
  await expect(page.getByRole("heading", { name: enMessages.mcp_connect_title })).toBeVisible();
  await expect(page.locator("header").getByRole("link", { name: enMessages.site_name, exact: true })).toBeVisible();
  await expect(page.getByText("Fictional first client")).toBeVisible();
  // The technical identity of the app is behind a disclosure, not in the way of the decision.
  await expect(page.getByText(first, { exact: true })).toBeHidden();
  await page.getByText(enMessages.mcp_details_summary, { exact: true }).click();
  await expect(page.getByText(first, { exact: true })).toBeVisible();
  await expect(page.getByText(enMessages.mcp_client_warning, { exact: true })).toBeVisible();
  // Keeping the connection is not a choice: it is a line of text, not a checkbox.
  await expect(page.getByText(enMessages.mcp_scope_offline.replace("{settings}", enMessages.settings_connections_link), { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(2);
  await page.getByRole("checkbox", { name: enMessages.mcp_scope_draft, exact: true }).uncheck();
  await page.getByRole("button", { name: enMessages.mcp_allow, exact: true }).click();
  const firstToken = await exchange(page, first);
  expect((await call(page.request, firstToken, "tomola_latest")).status()).toBe(200);
  expect((await call(page.request, firstToken, "tomola_draft_create", { kind: "topic", body: "scope blocked" })).status()).toBe(403);

  const japanese = await browser.newContext({ locale: "ja-JP", storageState: await page.context().storageState(), extraHTTPHeaders: clientHeaders("127.0.0.32") });
  try {
    const ja = await japanese.newPage();
    const second = await register(request, "Fictional second client");
    await start(ja, second);
    await expect(ja.locator("html")).toHaveAttribute("lang", "ja");
    await expect(ja.getByRole("heading", { name: jaMessages.mcp_connect_title })).toBeVisible();
    await expect(ja.getByText(jaMessages.mcp_disclosure, { exact: true })).toBeVisible();
    await ja.getByRole("button", { name: jaMessages.mcp_allow, exact: true }).click();
    const token = await exchange(ja, second);
    const created = await call(ja.request, token, "tomola_draft_create", { kind: "topic", lang: "en", title: "MCP signed publication", body: "Prepared only by the second client." });
    expect(created.status()).toBe(200);
    const result = await created.json();
    expect(result.result.isError).not.toBe(true);
    const draft = JSON.parse(result.result.content[0].text.split("\n---\n").at(-1));
    expect(draft).toMatchObject({ clientId: second, version: 1 });
    expect(new URL(draft.approvalUrl).searchParams.has("k")).toBe(false);
    const updated = await call(ja.request, token, "tomola_draft_update", { id: draft.id, body: "Last updated by the second client." });
    expect(updated.status()).toBe(200);
    expect((await updated.json()).result.isError).not.toBe(true);
    await ja.goto(draft.approvalUrl);
    // This scenario reads existing text without typing; wait for the approval handler to finish loading.
    await waitForClientRoute(ja);
    await expect(ja.getByRole("textbox", { name: jaMessages.field_body, exact: true })).toHaveValue("Last updated by the second client.");
    await ja.getByRole("button", { name: jaMessages.draft_publish, exact: true }).click();
    await expect(ja.getByRole("dialog", { name: jaMessages.signing_heading, exact: true })).toContainText(second);
    await ja.getByRole("dialog", { name: jaMessages.signing_heading }).getByRole("button", { name: jaMessages.confirm_publish, exact: true }).click();
    await ja.waitForURL(/\/t\/(\d+)\?posted=\1$/);
    await expect(ja.getByRole("heading", { name: "MCP signed publication", exact: true })).toBeVisible();

    await ja.goto("/settings/connections");
    await expect(ja.getByRole("heading", { name: jaMessages.mcp_connections_title })).toBeVisible();
    await expect(ja.locator("code").filter({ hasText: `${baseURL}/mcp` })).toBeVisible();
    await expect(ja.getByRole("main").getByRole("link", { name: jaMessages.mcp_connections_link, exact: true })).toHaveAttribute("href", "/connect");
    const connection = ja.locator("section").filter({ has: ja.getByRole("heading", { name: "Fictional second client", exact: true }) });
    await expect(connection.getByText(second, { exact: true })).toBeVisible();
    await expect(connection.locator("time[datetime]")).toBeVisible();
    await connection.getByRole("button", { name: jaMessages.mcp_revoke, exact: true }).click();
    await expect(ja.getByRole("status")).toHaveText(jaMessages.mcp_revoked);
    expect((await call(ja.request, token, "tomola_latest")).status()).toBe(401);
    expect((await call(page.request, firstToken, "tomola_latest")).status()).toBe(200);
  } finally { await japanese.close(); }
  } finally { await loopback.close(); }
});

test("MCP login offers passkeys and returns to the requested AI connection", async ({ browser, request }) => {
  const loopback = await oauthLoopback();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await useMember(page, "ux_edit@example.com", "/settings");
    await enableSigningAuthenticator(page);
    await page.getByRole("button", { name: enMessages.settings_passkeys_add, exact: true }).click();
    await expect(page.getByText(enMessages.settings_passkeys_added, { exact: true })).toBeVisible();
    const { baseURL } = state();
    const registration = await request.post(`${baseURL}/api/auth/oauth2/register`, { data: { client_name: "Fictional passkey client", application_type: "native", redirect_uris: [loopback.redirectURI], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "read" } });
    expect(registration.status()).toBe(201);
    const clientId = (await registration.json()).client_id;
    const parameters = new URLSearchParams({ client_id: clientId, redirect_uri: loopback.redirectURI, response_type: "code", scope: "read", state: "passkey-connection", code_challenge_method: "S256", code_challenge: createHash("sha256").update("v".repeat(64)).digest("base64url"), resource: `${baseURL}/mcp` });
    await context.clearCookies();
    await page.goto(`${baseURL}/api/auth/oauth2/authorize?${parameters}`);
    await expect(page).toHaveURL(/\/mcp\/login\?/);
    await expect(page.getByRole("heading", { name: enMessages.mcp_connect_title, exact: true })).toBeVisible();
    await expect(page.locator("header").getByRole("link", { name: enMessages.site_name, exact: true })).toBeVisible();
    await page.getByRole("button", { name: enMessages.login_passkey, exact: true }).click();
    await expect(page).toHaveURL(/\/mcp\/consent\?/);
    await expect(page.getByText("Fictional passkey client")).toBeVisible();
  } finally { await context.close(); await loopback.close(); }
});

test("a connection request that no longer verifies is shown as expired, not as a bad request", async ({ page }) => {
  await page.goto("/mcp/login?client_id=gone&sig=expired");
  await expect(page.getByRole("heading", { name: enMessages.mcp_expired_title, exact: true })).toBeVisible();
  await expect(page.getByText(enMessages.mcp_expired_body, { exact: true })).toBeVisible();
  await page.goto("/mcp/consent?client_id=gone&sig=expired");
  await expect(page.getByRole("heading", { name: enMessages.mcp_expired_title, exact: true })).toBeVisible();
});


test("anonymous MCP follows the site reading mode without OAuth discovery", async ({ request }, testInfo) => {
  const post = (method: string, params: object = {}) => request.post("/mcp/public", {
    headers: { accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...(method === "tools/call" ? { "Mcp-Name": (params as { name: string }).name } : {}) },
    data: { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "Browser fixture", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } },
  });
  const response = await post("tools/list");
  expect(response.headers()["www-authenticate"]).toBeUndefined();
  if (!testInfo.project.metadata.publicReading) {
    expect(response.status()).toBe(404);
    return;
  }
  expect(response.status()).toBe(200);
  expect((await response.json()).result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["tomola_latest", "tomola_privacy", "tomola_thread"]);

});
