import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, jaMessages as ja, state, useMember, waitForHydration } from "./helpers";

test.use({ locale: "ja-JP" });

const fixture = () => JSON.parse(fs.readFileSync(path.join(state().dir, "edit-history.json"), "utf8")) as { topic: number; reply: number };
async function evidence(page: import("@playwright/test").Page, name: string) {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await captureScreenshot(page, { path: `${name}-ja-${width}.png`, fullPage: true }, "edit-history");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
}

test("owned history lists originals and changes, confirms deletion and leaves no deleted text", async ({ page, browser }) => {
  const { topic, reply } = fixture();
  await useMember(page, "history_screen_author@example.com", `/t/${topic}`);
  await waitForHydration(page);
  const topicHistory = page.locator("[data-article-details]").locator(`a[href='/t/${topic}/history']`);
  await expect(topicHistory).toBeVisible();
  await expect(page.locator(`a[href='/c/${reply}/history']`)).toBeVisible();
  await evidence(page, "after-header");
  await topicHistory.click();
  await expect(page.getByRole("heading", { name: ja.history_title })).toBeVisible();
  await evidence(page, "after-index");
  const versions = page.locator(`ol[aria-label='${ja.history_title}'] a`);
  const middle = await versions.nth(1).getAttribute("href");
  expect(middle).toBeTruthy();
  await page.goto(`${middle}`);
  await expect(page.locator("[data-history-version]")).toContainText(ja.history_updated);
  const active = page.locator('ol a[aria-current="page"]');
  await expect(active).toHaveAttribute("href", middle!);
  await expect(page.locator("[data-history-version] time")).toHaveAttribute("datetime", (await active.locator("time").getAttribute("datetime"))!);
  await expect(page.getByRole("link", { name: ja.open_in_ai_noscript, exact: true })).toHaveAttribute("href", `${middle}.md`);
  await expect(page.locator("[data-history-diff] del").last()).toBeVisible();
  await expect(page.locator("[data-history-diff] ins").last()).toBeVisible();
  await evidence(page, "after-diff");
  const original = await page.locator("[data-history-original] > pre").innerText();
  await page.getByRole("link", { name: ja.history_delete, exact: true }).click();
  await expect(page.getByText(ja.history_delete_confirm, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: ja.history_delete, exact: true }).click();
  await expect(page.getByText(ja.history_deleted, { exact: false })).toBeVisible();
  await expect(page.locator("[data-history-original]")).toHaveCount(0);
  await expect(page.getByText(original, { exact: true })).toHaveCount(0);
  await evidence(page, "after-deleted");
  const deleted = await page.request.get(`${middle}.md`);
  expect(deleted.status()).toBe(200);
  expect(await deleted.text()).not.toContain(original);
  await page.goto(`/t/${topic}/history/current`);
  await expect(page.locator("[data-history-diff]")).not.toContainText(original);
  await useMember(page, "history_screen_reader@example.com", `/t/${topic}/history/current`);
  await expect(page.getByRole("link", { name: ja.history_delete, exact: true })).toHaveCount(0);
  await page.goto(`/c/${reply}/history/current`);
  await expect(page.locator("[data-history-original]")).toBeVisible();
  const context = await browser.newContext({ javaScriptEnabled: false, locale: "ja-JP" });
  try {
    const native = await context.newPage();
    await useMember(native, "history_screen_author@example.com", `/t/${topic}/history`);
    await native.locator(`ol[aria-label='${ja.history_title}'] a`).first().click();
    await expect(native.locator("[data-history-version]")).toContainText(ja.history_posted);
    const source = await native.locator("[data-history-original] > pre").innerText();
    await native.getByRole("link", { name: ja.history_delete, exact: true }).click();
    await expect(native.getByText(ja.history_delete_confirm, { exact: true })).toBeVisible();
    await native.getByRole("button", { name: ja.history_delete, exact: true }).click();
    await expect(native.locator("[data-history-original]")).toHaveCount(0);
    await expect(native.getByText(source, { exact: true })).toHaveCount(0);
    await expect(native.getByText(ja.history_deleted, { exact: false }).first()).toBeVisible();
  } finally { await context.close(); }
});

test("anonymous history follows public reading and provides Markdown without writer controls", async ({ page, browser }) => {
  const { topic, reply } = fixture();
  await page.goto(`/t/${topic}/history`);
  await expect(page.getByRole("heading", { name: ja.history_title })).toBeVisible();
  await expect(page.getByRole("link", { name: ja.history_delete, exact: true })).toHaveCount(0);
  for (const url of [`/t/${topic}/history.md`, `/t/${topic}/history/current.md`, `/c/${reply}/history.md`, `/c/${reply}/history/current.md`]) {
    const result = await page.request.get(url);
    expect(result.status()).toBe(200);
    expect(await result.text()).toContain("revision");
  }
  const context = await browser.newContext({ javaScriptEnabled: false, locale: "ja-JP" });
  try {
    const native = await context.newPage();
    await native.goto(`${state().baseURL}/t/${topic}/history`);
    await native.locator(`a[href='/t/${topic}/history/current']`).click();
    await expect(native.locator("[data-history-original]")).toBeVisible();
  } finally { await context.close(); }
});

test("initial corrections stay in one version until time or a reader reaction closes grace", async ({ page, browser }) => {
  const other = await browser.newContext();
  const reader = await other.newPage();
  const clock = path.join(state().dir, "server-clock.txt");
  const previous = fs.readFileSync(clock, "utf8");
  const headers = { origin: state().baseURL };
  try {
    await useMember(page, "history_screen_grace_author@example.com");
    await useMember(reader, "history_screen_grace_reader@example.com");
    const create = async () => {
      const response = await page.request.post("/t/new", { headers, form: { title: "猶予の確認", body: "最初の本文。", lang: "ja" }, maxRedirects: 0 });
      expect(response.status()).toBe(302);
      const match = /\/t\/(\d+)/.exec(response.headers().location ?? "");
      expect(match).toBeTruthy(); return match![1];
    };
    const edit = async (id: string, body: string) => {
      await page.goto(`/t/${id}/edit`);
      await waitForHydration(page);
      await page.locator('textarea[name="body"]').fill(body);
      await page.getByRole("button", { name: ja.save_changes, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/t/${id}\\?edited=`));
    };
    const first = await create();
    await edit(first, "猶予内の本文。");
    await expect(page.locator(`a[href='/t/${first}/history']`)).toHaveCount(0);
    fs.writeFileSync(clock, String(Number(previous) + 31 * 60_000));
    await edit(first, "猶予後の本文。");
    await expect(page.locator("[data-article-details]").locator(`a[href='/t/${first}/history']`)).toBeVisible();
    fs.writeFileSync(clock, previous);
    const second = await create();
    await edit(second, "反応前の修正。");
    for (const on of ["1", "0"]) {
      const vote = await reader.request.post("/vote", { headers, form: { entryId: second, on } });
      expect(vote.status()).toBe(200);
    }
    await edit(second, "取り消された反応の後の修正。");
    await expect(page.locator("[data-article-details]").locator(`a[href='/t/${second}/history']`)).toBeVisible();
  } finally { fs.writeFileSync(clock, previous); await other.close(); }
});
