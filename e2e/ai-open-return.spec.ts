import { readingActions } from "./helpers";
import fs from "node:fs";
import path from "node:path";
import { expect, request, type Browser, type Locator, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { AI_CHOICE_STORAGE_KEY, AI_OPEN_CHECK_DELAY_MS, AI_OPEN_CHECK_INTERVAL_MS, OPEN_IN_AI_TTL_SECONDS, CHATGPT_TEMPLATE, CLAUDE_TEMPLATE, serializeChoice } from "../app/lib/open-in-ai";
import { captureScreenshot, useMember, clientHeaders, enMessages as en, formatMessage, state  } from "./helpers";

const recovery = formatMessage(en.open_in_ai_not_read, { copy: en.open_in_ai_copy_md });
// The fixture adds a topic to the shared seed author, so it is opt-in like the other fixture suites.

const fixture = () => JSON.parse(fs.readFileSync(path.join(state().dir, "ai-open-return.json"), "utf8")) as { invite: string; topicId: number };
const photos = path.join(process.cwd(), ".data", "ai-open-return", "screenshots");

async function setup(browser: Browser, ip: string) {
  const clock = path.join(state().dir, "server-clock.txt");
  const savedClock = fs.readFileSync(clock, "utf8");
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders(ip) });
  const page = await context.newPage();
  const opened: string[] = [];
  const checked: boolean[] = [];
  await context.route("https://ai.example/**", async route => {
    const prompt = new URL(route.request().url()).searchParams.get("prompt")!;
    opened.push(prompt.match(/https?:\/\/[^\s]+/)![0]);
    await route.fulfill({ contentType: "text/html", body: "<title>Local AI fixture</title>" });
  });
  page.on("response", response => {
    if (new URL(response.url()).pathname === "/open-in-ai/status") void response.json().then(result => checked.push(result.read)).catch(() => {});
  });
  const ai = await request.newContext({ baseURL: state().baseURL, extraHTTPHeaders: clientHeaders(`${ip.slice(0, -1)}9`) });
  const close = async () => {
    try { await ai.dispose(); await context.close(); }
    finally { fs.writeFileSync(clock, savedClock); }
  };
  return { context, page, opened, checked, ai, close };
}

async function preferFixtureAI(page: Page) {
  await page.evaluate(({ key, choice }) => localStorage.setItem(key, choice), { key: AI_CHOICE_STORAGE_KEY, choice: serializeChoice({ provider: "custom", template: "https://ai.example/?prompt={prompt}" }) });
}
async function open(page: Page, entrance: Locator, opened: string[]) {
  // Existing member keys are deterministic within a second. Advance the test
  // server as well, keeping both clocks monotonic without waiting in real time.
  const clock = path.join(state().dir, "server-clock.txt");
  const offset = Math.max(Number(fs.readFileSync(clock, "utf8")), await page.evaluate(() => Date.now()) - Date.now()) + AI_OPEN_CHECK_INTERVAL_MS;
  fs.writeFileSync(clock, String(offset));
  await page.clock.setSystemTime(new Date(Date.now() + offset));
  const before = opened.length;
  await entrance.getByRole("button", { name: en.open_in_ai, exact: true }).click();
  await expect.poll(() => opened.length).toBe(before + 1);
  await page.bringToFront();
  return opened.at(-1)!;
}
async function photograph(page: Page, name: string) {
  fs.mkdirSync(photos, { recursive: true });
  await captureScreenshot(page, { path: path.join(photos, `${name}.png`) }, "e2e-ai-open-return");
}

test("member recovery appears only beside the clicked entrance, disappears after a read, and fits every width", async ({ browser }, testInfo) => {
  const publicMode = testInfo.config.metadata.publicReading === true;
  const f = fixture();
  const { page, opened, checked, ai, close } = await setup(browser, "10.89.0.1");
  try {
    await useMember(page, "ai_open_return@example.com");
    await page.goto(`/t/${f.topicId}?lang=en`);
    const byline = await readingActions(page);
    await byline.getByRole("button", { name: en.open_in_ai, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: en.open_in_ai_dialog_title });
    for (const name of [en.open_in_ai_chatgpt, en.open_in_ai_claude]) await expect(dialog.getByText(formatMessage(en.open_in_ai_provider_login, { name }), { exact: true })).toBeVisible();
    for (const template of [CHATGPT_TEMPLATE, CLAUDE_TEMPLATE]) await expect(dialog.getByText(template, { exact: true })).toHaveCount(0);
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await photograph(page, `choice-${width}`);
    }
    await dialog.getByRole("button", { name: en.cancel, exact: true }).click();
    await expect(page.locator("[data-base-ui-inert]")).toHaveCount(0);
    await preferFixtureAI(page);
    await page.clock.install();
    for (const width of [1366, 1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const actions = await readingActions(page);
      for (const [name, entrance] of [["actions", actions], ["reply", page.locator("#reply [data-reply-heading]")]] as const) {
        const before = checked.length;
        const url = await open(page, entrance, opened);
        expect(new URL(url).searchParams.has("k")).toBe(!publicMode);
        if (publicMode) {
          expect(new URL(url).searchParams.get("lang")).toBe("en");
          expect(new URL(url).searchParams.get("o")).toMatch(/^oar1\./);
        }
        await page.clock.fastForward(AI_OPEN_CHECK_DELAY_MS / 2);
        expect(checked.length).toBe(before);
        await expect(page.getByText(recovery, { exact: true })).toHaveCount(0);
        await page.clock.fastForward(AI_OPEN_CHECK_DELAY_MS);
        await expect(entrance.getByText(recovery, { exact: true })).toBeVisible();
        await expect(page.getByText(recovery, { exact: true })).toHaveCount(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width !== 1280) await photograph(page, `member-${name}-${width}`);
        expect((await ai.get(`${url}&utm_source=chatgpt.com`)).status()).toBe(200);
        await page.clock.fastForward(AI_OPEN_CHECK_INTERVAL_MS);
        await expect(entrance.getByText(recovery, { exact: true })).toHaveCount(0);
        const after = checked.length;
        await page.clock.fastForward(AI_OPEN_CHECK_INTERVAL_MS * 2);
        expect(checked.length).toBe(after);
      }
    }
    const url = await open(page, await readingActions(page), opened);
    expect((await ai.get(`${url}&utm_source=chatgpt.com`)).status()).toBe(200);
    const before = checked.length;
    await page.clock.fastForward(AI_OPEN_CHECK_DELAY_MS);
    await expect.poll(() => checked.length).toBe(before + 1);
    expect(checked.at(-1)).toBe(true);
    await expect(page.getByText(recovery, { exact: true })).toHaveCount(0);
    // Receipts stay in component memory, never HTML, storage, or request logs.
    const key = new URL(url).searchParams.get(publicMode ? "o" : "k")!;
    expect(await page.content()).not.toContain(key);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(key);
    expect(fs.readFileSync(state().logFile, "utf8")).not.toContain(key);
  } finally { await close(); }
});

test("public readers receive fresh inert markers and see recovery only until the AI reads", async ({ browser }) => {

  const f = fixture();
  const { page, opened, checked, ai, close } = await setup(browser, "10.89.0.2");
  try {
    await page.goto(`/t/${f.topicId}?lang=en`);
    await expect(page.getByRole("button", { name: en.open_in_ai, exact: true }).first()).toBeVisible();
    await page.locator(".reading-toc-sidebar [data-reading-actions]").getByRole("button", { name: en.open_in_ai, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: en.open_in_ai_dialog_title });
    await expect(dialog.getByText("The prompt includes this page’s public Markdown URL. Anyone can read it without signing in to tomola. Your choice is saved in this browser only.", { exact: true })).toBeVisible();
    await expect(dialog.getByText(en.open_in_ai_dialog_help, { exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: en.cancel, exact: true }).click();
    await preferFixtureAI(page);
    await page.clock.install();
    const entrance = page.locator(".reading-toc-sidebar [data-reading-actions]");
    const delayed = await open(page, entrance, opened);
    const marker = new URL(delayed).searchParams.get("o")!;
    expect(marker).toBeTruthy();
    expect(new URL(delayed).searchParams.has("k")).toBe(false);
    await page.clock.fastForward(AI_OPEN_CHECK_DELAY_MS);
    await expect(entrance.getByText(recovery, { exact: true })).toBeVisible();
    expect((await ai.get(delayed)).status()).toBe(200);
    await page.clock.fastForward(AI_OPEN_CHECK_INTERVAL_MS);
    await expect(page.getByText(recovery, { exact: true })).toHaveCount(0);
    const immediate = await open(page, entrance, opened);
    expect(new URL(immediate).searchParams.get("o")).not.toBe(marker);
    expect((await ai.get(immediate)).status()).toBe(200);
    const before = checked.length;
    await page.clock.fastForward(AI_OPEN_CHECK_DELAY_MS);
    await expect.poll(() => checked.length).toBe(before + 1);
    expect(checked.at(-1)).toBe(true);
    await expect(page.getByText(recovery, { exact: true })).toHaveCount(0);
    expect(await page.content()).not.toContain(marker);
    expect(fs.readFileSync(state().logFile, "utf8")).not.toContain(marker);
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/?lang=en");
      const home = page.locator("main").filter({ has: page.getByRole("button", { name: en.open_in_ai, exact: true }) });
      await open(page, home, opened);
      await page.clock.fastForward(AI_OPEN_CHECK_DELAY_MS);
      await expect(home.getByText(recovery, { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await photograph(page, `public-home-${width}`);
    }
  } finally { await close(); }
});

test("checks pause while hidden, stop at expiry, reset on menu use, and skip failed public issuance", async ({ browser }) => {

  const { page, opened, checked, close } = await setup(browser, "10.89.0.3");
  try {
    await page.goto(`/t/${fixture().topicId}?lang=en`);
    await expect(page.getByRole("button", { name: en.open_in_ai, exact: true }).first()).toBeVisible();
    await preferFixtureAI(page);
    await page.clock.install();
    const entrance = page.locator(".reading-toc-sidebar [data-reading-actions]");
    await open(page, entrance, opened);
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
    await page.clock.fastForward(AI_OPEN_CHECK_DELAY_MS);
    expect(checked).toHaveLength(0);
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
    await expect(entrance.getByText(recovery, { exact: true })).toBeVisible();
    await page.clock.fastForward(OPEN_IN_AI_TTL_SECONDS * 1000);
    const after = checked.length;
    await page.clock.fastForward(AI_OPEN_CHECK_INTERVAL_MS);
    expect(checked.length).toBe(after);
    await expect(entrance.getByText(recovery, { exact: true })).toBeVisible();
    await entrance.getByRole("button", { name: en.open_in_ai_menu, exact: true }).click();
    await expect(page.getByText(recovery, { exact: true })).toHaveCount(0);
    // Isolate failed issuance from the menu check and its animation clock.
    await page.goto(page.url());
    await expect(entrance.getByRole("button", { name: en.open_in_ai, exact: true })).toBeVisible();
    await page.route("**/open-in-ai/link", route => route.fulfill({ status: 429, json: { error: "rate_limited" } }));
    const fallback = await open(page, entrance, opened);
    expect(new URL(fallback).searchParams.has("o")).toBe(false);
    await page.clock.fastForward(AI_OPEN_CHECK_DELAY_MS + AI_OPEN_CHECK_INTERVAL_MS);
    expect(checked.length).toBe(after);
    await expect(page.getByText(recovery, { exact: true })).toHaveCount(0);
  } finally { await close(); }
});
