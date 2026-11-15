import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { clientHeaders, enMessages as en, state, useMember, waitForClientRoute } from "./helpers";

test("owners publish a speaking style and readers follow answer labels to its history", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const enabled = process.env.VILLAGE_NUSHI_VOICE === "1";
  await page.context().setExtraHTTPHeaders(clientHeaders("192.0.2.241"));
  await useMember(page, "zcn_flow_owner@example.com", "/v/chat-nushi-browser?lang=en");
  await waitForClientRoute(page);
  const management = page.locator("#village-management");
  const setting = management.locator("[data-nushi-voice-setting]");
  if (!enabled) {
    await expect(setting).toHaveCount(0);
    await expect(page.locator("#nushi-voice")).toHaveCount(0);
    expect((await page.request.post("/v/chat-nushi-browser", { form: { intent: "nushi-voice", voice: "Warm." } })).status()).toBe(404);
    expect((await page.request.get("/v/personal/zcn_flow_owner")).status()).toBe(404);
    return;
  }
  await management.locator(":scope > summary").click();
  const text = "Use a warm greeting and brief, polite sentences.";
  await setting.locator('textarea[name="voice"]').fill(text);
  await setting.getByRole("button", { name: en.save_changes, exact: true }).click();
  await expect(page.locator("[data-nushi-voice-text]")).toHaveText(text);
  const guest = await browser.newContext({ baseURL: state().baseURL, ignoreHTTPSErrors: true, serviceWorkers: "block", extraHTTPHeaders: clientHeaders("192.0.2.242") });
  try {
    const reader = await guest.newPage();
    await reader.goto("/v/chat-nushi-browser?lang=en");
    await expect(reader.locator("[data-nushi-voice-text]")).toHaveText(text);
    await expect(reader.locator("[data-nushi-voice-setting]")).toHaveCount(0);
    await reader.locator("#nushi-voice summary").click();
    await expect(reader.locator("#nushi-voice li").first()).toContainText("@zcn_flow_owner");
    await expect(reader.locator("#nushi-voice li").first()).toContainText(text);
    await page.goto("/t/new?village=chat-nushi-browser&lang=en");
    await waitForClientRoute(page);
    await page.getByLabel(en.field_body, { exact: true }).fill("@nushi orchard planting date");
    await page.getByRole("button", { name: en.submit_post, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/\d+/);
    const topic = new URL(page.url()).pathname;
    await expect(page.locator("[data-nushi-answer]")).toHaveCount(1, { timeout: 120_000 });
    const label = page.locator("[data-nushi-answer] [data-nushi-voice-link]");
    await expect(label).toHaveText(en.nushi_voice_owner_label);
    const href = await label.getAttribute("href");
    expect(href).toMatch(/^\/v\/chat-nushi-browser#nushi-voice-\d+$/);
    await reader.goto(`${topic}?lang=en`);
    await reader.locator("[data-nushi-voice-link]").click();
    await expect(reader).toHaveURL(new RegExp(`${href}$`));
    await expect(reader.locator(new URL(reader.url()).hash)).toContainText(text);
    await page.goto("/v/chat-nushi-browser?manage=1&lang=en");
    await setting.getByRole("button", { name: en.nushi_voice_clear, exact: true }).click();
    await expect(page.locator("[data-nushi-voice-text]")).toHaveText(en.nushi_voice_default);
    await reader.goto(href!);
    await expect(reader.locator(new URL(reader.url()).hash)).toContainText(text);
  } finally { await guest.close(); }
});

test("a personal village's holder edits a style without exposing the member page", async ({ page, browser }) => {
  test.skip(process.env.VILLAGE_NUSHI_VOICE !== "1", "Speaking styles are disabled");
  await page.context().setExtraHTTPHeaders(clientHeaders("192.0.2.243"));
  await useMember(page, "znushi_flow_owner@example.com", "/v/personal/znushi_flow_owner?lang=en");
  await waitForClientRoute(page);
  const setting = page.locator("#village-management [data-nushi-voice-setting]");
  await setting.locator('textarea[name="voice"]').fill("A polite personal village style.");
  await setting.getByRole("button", { name: en.save_changes, exact: true }).click();
  await expect(page.locator("[data-nushi-voice-text]")).toHaveText("A polite personal village style.");
  const guest = await browser.newContext({ baseURL: state().baseURL, ignoreHTTPSErrors: true, serviceWorkers: "block", extraHTTPHeaders: clientHeaders("192.0.2.244") });
  try {
    const reader = await guest.newPage();
    await reader.goto("/v/personal/znushi_flow_owner?lang=en");
    await expect(reader.locator("[data-nushi-voice-text]")).toHaveText("A polite personal village style.");
    await expect(reader.locator("#village-management")).toHaveCount(0);
    const member = await reader.request.get("/u/znushi_flow_owner", { maxRedirects: 0 });
    expect(member.status()).toBe(302);
    expect(member.headers().location).toContain("/login");
  } finally { await guest.close(); }
});
