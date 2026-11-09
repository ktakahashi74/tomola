import { oauthLoopback } from "./support/oauth-loopback";
import { expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { test } from "./editor-fixture";
import { enMessages as en, jaMessages as ja, useMember, waitForClientRoute, formatMessage } from "./helpers";

async function checkFooter(page: import("@playwright/test").Page, messages: typeof en) {
  const link = page.getByRole("contentinfo").getByRole("link", { name: messages.footer_connect, exact: true });
  await expect(link).toHaveAttribute("href", "/connect");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  return link;
}

for (const [lang, locale, messages] of [["ja", "ja-JP", ja], ["en", "en-US", en]] as const) {
  test(`a visitor follows the footer to the short connection page (${lang})`, async ({ browser }) => {
    const context = await browser.newContext({ locale });
    try {
      const page = await context.newPage();
      await page.goto("/");
      await waitForClientRoute(page);
      await (await checkFooter(page, messages)).click();
      await expect(page).toHaveURL(/\/connect$/);
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { level: 1, name: messages.footer_connect, exact: true })).toBeVisible();
      await expect(main.getByText(formatMessage(messages.connect_prompt, { site: new URL(page.url()).host }), { exact: true })).toBeVisible();
      await expect(main.getByText(messages.connect_internet, { exact: true })).toBeVisible();
      await expect(main.getByText(messages.connect_publish, { exact: true })).toBeVisible();
      const offline = main.getByRole("region", { name: messages.connect_offline_heading, exact: true });
      await expect(offline.getByRole("listitem")).toHaveCount(2);
      await expect(offline.getByText(formatMessage(messages.connect_copy_post, { open: messages.open_in_ai, copy: messages.open_in_ai_copy_md }), { exact: true })).toBeVisible();
      const publicReading = test.info().project.metadata.publicReading;
      await expect(offline.locator("code").filter({ hasText: /\/mcp\/public$/ })).toHaveCount(publicReading ? 1 : 0);
      await expect(offline.locator("code").filter({ hasText: /\/mcp$/ })).toHaveCount(1);
      for (const role of ["navigation", "button"] as const) await expect(main.getByRole(role)).toHaveCount(0);
      await expect(main.locator("details")).toHaveCount(0);
      await expect(main.locator('a[href="/settings/connections"]')).toHaveCount(0);
      await expect(main.getByText(messages.connect_connections_empty, { exact: true })).toHaveCount(0);
      for (const id of ["connect-own", "connect-once", "connect-automation", "connect-terminal-heading", "connect-browser-heading", "connect-manual-heading", "connect-examples-heading"]) await expect(main.locator(`[id="${id}"]`)).toHaveCount(0);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      const response = await page.request.get("/connect");
      expect(response.headers()["cache-control"]).toContain("no-store");
      const steps = await (await page.request.get("/connect.md")).text();
      expect(steps).toContain("Streamable HTTP");
      expect(steps).toContain("tools/list");
      expect(steps).toContain("tomola_latest");
      expect(steps).toContain("/.well-known/oauth-protected-resource/mcp");
      expect(steps).toContain("Nonmembers cannot make drafts");
      const guide = await (await page.request.get("/llms.txt")).text();
      expect(guide).toContain("/connect.md");
      const next = lang === "en" ? ja : en;
      await page.locator("header").getByRole("combobox", { name: messages.language_select, exact: true }).click();
      await page.getByRole("listbox").getByRole("option", { name: lang === "en" ? "日本語" : "English", exact: true }).click();
      await expect(main.getByText(next.connect_internet, { exact: true })).toBeVisible();
    } finally { await context.close(); }
  });
}

test("a member sees the footer link too", async ({ page }) => {
  await useMember(page, "ai_connect_member@example.com");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await waitForClientRoute(page);
    await expect(await checkFooter(page, en)).toBeVisible();
  }
  // Both the menu and the AI chooser lead to the persistent connection guidance.
  await page.getByRole("button", { name: en.open_in_ai, exact: true }).first().click();
  const chooser = page.getByRole("dialog", { name: en.open_in_ai_dialog_title, exact: true });
  await expect(chooser.getByRole("link", { name: en.connect_keep_using_link, exact: true })).toHaveAttribute("href", "/connect");
  await chooser.getByRole("button", { name: en.cancel, exact: true }).click();
  await page.getByRole("button", { name: en.open_in_ai_menu, exact: true }).first().click();
  const connect = page.getByRole("menuitem", { name: en.connect_keep_using_link, exact: true });
  await expect(connect).toHaveAttribute("href", "/connect");
  await connect.click();
  await expect(page).toHaveURL(/\/connect$/);
  await page.goto("/t/new");
  await waitForClientRoute(page);
  await page.getByRole("button", { name: en.ai_write_button, exact: true }).click();
  const draftLink = page.getByRole("link", { name: en.connect_draft_link, exact: true });
  await expect(draftLink).toBeVisible();
  await expect(draftLink).toHaveAttribute("href", "/connect");
  await page.goto("/settings");
  const ai = page.getByRole("region", { name: en.settings_ai_section_heading, exact: true });
  await expect(ai.getByRole("link", { name: en.footer_connect, exact: true })).toHaveAttribute("href", "/connect");
  await page.goto("/connect");
  await waitForClientRoute(page);
  await expect(page.getByRole("heading", { level: 1, name: en.footer_connect, exact: true })).toBeVisible();
});


test("a member sees only their connection count through connecting and removing", async ({ page, request, browser }) => {
  const loopback = await oauthLoopback();
  try {
  await useMember(page, "connect_count@example.com");
  await page.goto("/connect");
  await expect(page.getByText(en.connect_connections_empty, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: en.connect_connections_manage, exact: true })).toHaveAttribute("href", "/settings/connections");
  const redirect = loopback.redirectURI;
  const registration = await request.post("/api/auth/oauth2/register", { data: {
    client_name: "Fictional count client", application_type: "native", redirect_uris: [redirect],
    grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "read",
  } });
  expect(registration.status()).toBe(201);
  const clientId = (await registration.json()).client_id;
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope: "read", state: "count",
    code_challenge_method: "S256", code_challenge: createHash("sha256").update("c".repeat(64)).digest("base64url") });
  await page.goto(`/api/auth/oauth2/authorize?${query}`);
  await expect(page.getByRole("heading", { name: en.mcp_connect_title, exact: true })).toBeVisible();
  await page.getByRole("button", { name: en.mcp_allow, exact: true }).click();
  await expect(page).toHaveURL(url => url.href.startsWith(redirect) && url.searchParams.has("code"));
  await page.goto("/connect");
  await expect(page.getByText(formatMessage(en.connect_connections_count, { count: 1 }), { exact: true })).toBeVisible();
  const guest = await browser.newContext();
  try {
    const other = await guest.newPage();
    await other.goto("/connect");
    await expect(other.getByRole("main").locator('a[href="/settings/connections"]')).toHaveCount(0);
    await useMember(other, "connect_count_other@example.com");
    await other.goto("/connect");
    await expect(other.getByText(en.connect_connections_empty, { exact: true })).toBeVisible();
  } finally { await guest.close(); }
  await page.getByRole("link", { name: en.connect_connections_manage, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: en.mcp_connections_title, exact: true })).toBeVisible();
  const client = page.getByRole("main").locator("section").filter({ has: page.getByRole("heading", { name: "Fictional count client", exact: true }) });
  await client.getByRole("button", { name: en.mcp_revoke, exact: true }).click();
  await expect(page.getByText(en.mcp_connections_empty, { exact: true })).toBeVisible();
  await page.goto("/connect");
  await expect(page.getByText(en.connect_connections_empty, { exact: true })).toBeVisible();
  } finally { await loopback.close(); }
});
