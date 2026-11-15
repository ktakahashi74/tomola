import { oauthLoopback } from "./support/oauth-loopback";
import { expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { test } from "./editor-fixture";
import { REPLY_MORE_SYMBOL } from "../app/lib/reply-more";
import { enMessages as en, jaMessages as ja, useMember, waitForClientRoute, formatMessage, captureScreenshot } from "./helpers";

async function checkFooter(page: import("@playwright/test").Page, messages: typeof en) {
  const link = page.getByRole("contentinfo").getByRole("link", { name: messages.footer_connect, exact: true });
  await expect(link).toHaveAttribute("href", "/connect");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  return link;
}

for (const [lang, locale, messages] of [["ja", "ja-JP", ja], ["en", "en-US", en]] as const) {
  test(`a visitor follows the footer and copies the connection addresses (${lang})`, async ({ browser }) => {
    const context = await browser.newContext({ locale });
    await context.addInitScript(() => {
      const copied: string[] = [];
      Object.defineProperty(window, "copiedAddresses", { value: copied });
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
    });
    try {
      const page = await context.newPage();
      await page.goto("/");
      await waitForClientRoute(page);
      await (await checkFooter(page, messages)).click();
      await expect(page).toHaveURL(/\/connect$/);
      const main = page.getByRole("main");
      const publicReading = Boolean(test.info().project.metadata.publicReading);
      const origin = new URL(page.url()).origin;
      const urls = publicReading ? [`${origin}/mcp/public`, `${origin}/mcp`] : [`${origin}/mcp`];
      await expect(main.getByRole("heading", { level: 1, name: messages.footer_connect, exact: true })).toBeVisible();
      await expect(main.getByText(formatMessage(messages.connect_prompt, { site: new URL(page.url()).host }), { exact: true })).toBeVisible();
      await expect(main.getByText(messages.connect_internet, { exact: true })).toBeVisible();
      await expect(main.getByText(formatMessage(messages.connect_publish, { title: messages.mcp_connect_title, allow: messages.mcp_allow }), { exact: true })).toBeVisible();
      await expect(main.getByText(formatMessage(messages.connect_write_without_connection, { write: messages.ai_write_button, more: REPLY_MORE_SYMBOL }), { exact: true })).toBeVisible();
      await expect(main.getByRole("group").first()).toHaveAccessibleName(publicReading ? messages.connect_public_address : messages.connect_members_address);
      const offline = main.getByRole("region", { name: messages.connect_offline_heading, exact: true });
      await expect(offline.getByText(formatMessage(messages.connect_copy_post, { open: messages.open_in_ai, copy: messages.open_in_ai_copy_md }), { exact: true })).toBeVisible();
      await expect(offline.locator("code")).toHaveCount(0);
      await expect(main.locator("code")).toHaveText(urls);
      await expect(main.getByRole("navigation")).toHaveCount(0);
      await expect(main.locator("details")).toHaveCount(0);
      await expect(main.locator('a[href="/settings/connections"]')).toHaveCount(0);
      await expect(main.getByText(messages.connect_connections_read_only, { exact: true })).toHaveCount(0);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await captureScreenshot(page, { path: `${publicReading ? "A" : "C"}-${lang}-${width}.png`, fullPage: true }, "connect");
      }
      const groups = main.getByRole("group");
      for (let index = 0; index < urls.length; index++) {
        const group = groups.nth(index);
        const button = group.getByRole("button");
        await expect(button).toBeEnabled();
        await button.focus();
        await page.keyboard.press(index === 0 ? "Enter" : "Space");
        await expect(button).toHaveText(messages.connect_address_copied);
        await expect(group.getByRole("status")).toHaveText(messages.connect_address_copied);
        await expect(group).not.toHaveAttribute("aria-live");
        expect(await page.evaluate(() => (window as unknown as { copiedAddresses: string[] }).copiedAddresses.at(-1))).toBe(await group.locator("code").textContent());
        await expect(button).toHaveText(messages.connect_copy_address);
        await expect(group.getByRole("status")).toBeEmpty();
      }
      if (urls.length > 1) {
        await groups.first().getByRole("button").click();
        await expect(groups.first().getByRole("status")).toHaveText(messages.connect_address_copied);
        await groups.nth(1).getByRole("button").click();
        await expect(groups.nth(1).getByRole("status")).toHaveText(messages.connect_address_copied);
        await expect(groups.first().getByRole("button")).toHaveText(messages.connect_copy_address);
        await expect(groups.first().getByRole("status")).toBeEmpty();
        await expect(groups.nth(1).getByRole("button")).toHaveText(messages.connect_copy_address);
        await expect(groups.nth(1).getByRole("status")).toBeEmpty();
      }
      // A refusal or an unavailable API must keep the selectable address and avoid success feedback.
      for (const unavailable of [false, true]) {
        await page.evaluate(missing => {
          Object.defineProperty(navigator, "clipboard", { configurable: true, value: missing ? undefined : { writeText: async () => { throw new Error("Clipboard denied"); } } });
        }, unavailable);
        const group = groups.first();
        const button = group.getByRole("button");
        await button.click();
        await expect(group.getByRole("status")).toHaveText(messages.connect_copy_failed);
        await expect(button).toHaveText(messages.connect_copy_address);
        await expect(group.locator("pre")).toHaveCSS("user-select", "all");
        await expect(group.locator("code")).toHaveText(urls[0]);
      }
      const response = await page.request.get("/connect");
      expect(response.headers()["cache-control"]).toContain("no-store");
      for (const path of ["/connect.md", "/help/mcp.md"]) {
        const steps = await (await page.request.get(path)).text();
        expect(steps).toContain("tomola_draft_list");
        expect(steps).toContain("Nonmembers cannot make drafts");
        expect(steps).toContain("does not authorize changes");
      }
      const next = lang === "en" ? ja : en;
      await page.locator("header").getByRole("combobox", { name: messages.language_select, exact: true }).click();
      await page.getByRole("listbox").getByRole("option", { name: lang === "en" ? "日本語" : "English", exact: true }).click();
      await expect(main.getByText(next.connect_internet, { exact: true })).toBeVisible();
    } finally { await context.close(); }
  });

  test(`a member gets their account address first and a read-only alternative when available (${lang})`, async ({ browser }) => {
    const context = await browser.newContext({ locale });
    try {
      const page = await context.newPage();
      await useMember(page, `connect_page_${lang}@example.com`, "/connect");
      await waitForClientRoute(page);
      const main = page.getByRole("main");
      const publicReading = Boolean(test.info().project.metadata.publicReading);
      const origin = new URL(page.url()).origin;
      await expect(main.getByText(formatMessage(messages.connect_member_prompt, { site: new URL(page.url()).host }), { exact: true })).toBeVisible();
      await expect(main.locator("code")).toHaveText(publicReading ? [`${origin}/mcp`, `${origin}/mcp/public`] : [`${origin}/mcp`]);
      await expect(main.getByRole("group").first()).toHaveAccessibleName(messages.connect_public_address);
      await expect(main.getByRole("group", { name: messages.connect_read_only_address, exact: true })).toHaveCount(publicReading ? 1 : 0);
      await expect(main.getByText(messages.connect_connections_empty, { exact: true })).toBeVisible();
      await expect(main.getByText(messages.connect_connections_read_only, { exact: true })).toBeVisible();
      await expect(main.getByText(formatMessage(messages.connect_write_without_connection, { write: messages.ai_write_button, more: REPLY_MORE_SYMBOL }), { exact: true })).toBeVisible();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await captureScreenshot(page, { path: `B-${publicReading ? "open" : "closed"}-${lang}-${width}.png`, fullPage: true }, "connect");
      }
    } finally { await context.close(); }
  });
}

test("copy buttons stay disabled without scripts while addresses remain selectable", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto("/connect");
    const groups = page.getByRole("main").getByRole("group");
    expect(await groups.count()).toBeGreaterThan(0);
    for (const group of await groups.all()) {
      await expect(group.getByRole("button")).toBeDisabled();
      await expect(group.locator("code")).toBeVisible();
      await expect(group.locator("pre")).toHaveCSS("user-select", "all");
    }
  } finally { await context.close(); }
});

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
