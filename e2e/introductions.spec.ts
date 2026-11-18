import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, clientHeaders, enMessages as en, messageTitleField, restoreMember, signUp, state, waitForFormReady } from "./helpers";

test("members discover introductions through welcome and member pages while anonymous readers use the member-page gate", async ({ browser }) => {
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "introductions.json"), "utf8")) as { invite: string; otherId: number; otherHandle: string };
  const writerContext = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("10.8.65.1") });
  const otherContext = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("10.8.65.2") });
  const guest = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("10.8.65.3") });
  try {
    const writer = await writerContext.newPage();
    const other = await otherContext.newPage();
    const handle = "intro_list_writer";
    await signUp(writer, fixture.invite, `${handle}@example.com`, { handle, mainLang: "en" });
    const welcome = writer.getByRole("complementary", { name: en.welcome_label, exact: true });
    const welcomeLinks = welcome.locator("li a");
    await expect(welcomeLinks.nth(0)).toHaveAttribute("href", `/u/${handle}`);
    await expect(welcomeLinks.nth(1)).toHaveAttribute("href", "/introductions");
    await welcome.getByRole("link", { name: en.introductions_read, exact: true }).click();
    await expect(writer.getByRole("heading", { level: 1 })).toHaveText(en.introductions_title);
    const prompt = writer.locator("[data-introduction-prompt]");
    await expect(prompt.getByRole("link", { name: en.member_page_write_intro, exact: true })).toHaveAttribute("href", "/t/new?intro=1");
    await expect(prompt.locator("p")).toBeVisible();
    const otherRow = writer.locator(`#q-${fixture.otherId}`);
    await expect(otherRow.locator(".topic-title")).toHaveText("Books and walks");
    await expect(otherRow.locator("img")).toHaveCount(0);
    await otherRow.locator(`a[href="/u/${fixture.otherHandle}"]`).click();
    await expect(writer.getByRole("link", { name: en.introductions_read, exact: true })).toHaveAttribute("href", "/introductions");
    await writer.getByRole("link", { name: en.introductions_read, exact: true }).click();
    await otherRow.locator(".topic-title").click();
    await expect(writer).toHaveURL(new RegExp(`/t/${fixture.otherId}(?:\\?.*)?$`));
    await writer.goto(`/u/${handle}`);
    await expect(writer.getByRole("link", { name: en.introductions_read, exact: true })).toBeVisible();
    await restoreMember(other, state().dir, `${fixture.otherHandle}@example.com`, fixture.otherHandle, `/u/${handle}`);
    await expect(other.getByRole("link", { name: en.introductions_read, exact: true })).toHaveCount(0);
    await writer.getByRole("link", { name: en.member_page_write_intro, exact: true }).click();
    await waitForFormReady(writer.locator("form", { has: messageTitleField(writer) }));
    await expect(writer.locator('input[name="intro"]')).toBeChecked();
    const body = "I enjoy discussions about languages and local history.";
    await writer.getByLabel(en.field_body, { exact: true }).fill(body);
    await writer.getByRole("button", { name: en.submit_post, exact: true }).click();
    await expect(writer).toHaveURL(/\/t\/\d+(?:\?.*)?$/);
    const topicPath = new URL(writer.url()).pathname;
    const topicId = topicPath.split("/").at(-1)!;
    for (const page of [writer, other]) {
      await page.goto(`/u/${handle}`);
      await expect(page.getByRole("link", { name: en.introductions_read, exact: true })).toBeVisible();
      await page.getByRole("link", { name: en.introductions_read, exact: true }).click();
      const ownRow = page.locator(`#q-${topicId}`);
      await expect(ownRow.locator(".topic-title")).toContainText(body);
      await expect(ownRow.locator(".topic-title")).toHaveAttribute("data-remark", "true");
      await expect(ownRow.locator(`a[href="/u/${handle}"]`)).toBeVisible();
      await expect(page.locator(`#q-${fixture.otherId}`)).toBeVisible();
      await expect(page.locator("[data-introduction-prompt]")).toHaveCount(0);
    }
    await expect(writer.locator(".topic-row").first()).toHaveAttribute("id", `q-${topicId}`);
    for (const width of [1366, 390]) {
      await writer.setViewportSize({ width, height: 900 });
      expect(await writer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await captureScreenshot(writer, { path: `introductions-${width}.png`, fullPage: true }, "introductions");
    }
    await writer.locator(`#q-${topicId} .topic-title`).click();
    await expect(writer).toHaveURL(new RegExp(`${topicPath}(?:\\?.*)?$`));
    for (const suffix of [".md", ".txt"]) expect((await writer.request.get(`/introductions${suffix}`)).status()).toBe(404);
    const visitor = await guest.newPage();
    for (const target of ["/introductions", `/u/${handle}`]) {
      const response = await guest.request.get(`${state().baseURL}${target}`, { maxRedirects: 0 });
      expect(response.status()).toBe(302);
      expect(response.headers()["cache-control"]).toContain("private");
      const login = new URL(response.headers().location, state().baseURL);
      expect(login.pathname).toBe("/login");
      expect(login.searchParams.get("next")).toBe(target);
      await visitor.goto(`${state().baseURL}${target}`);
      await expect(visitor).toHaveURL(/\/login\?/);
      await expect(visitor.locator(".topic-row")).toHaveCount(0);
    }
  } finally {
    await writerContext.close();
    await otherContext.close();
    await guest.close();
  }
});
