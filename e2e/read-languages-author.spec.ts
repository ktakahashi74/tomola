import fs from "node:fs";
import path from "node:path";
import { expect, request, test, type Page } from "@playwright/test";
import { captureScreenshot, formatMessage, state, uiMessages, useMember, waitForClientRoute } from "./helpers";

test("only the author sees how many translated body languages have been read", async ({ page }) => {
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "read-languages-author.json"), "utf8")) as Record<string, number>;
  const memberPath = "/u/reach_writer";
  await useMember(page, "reach_writer@example.com", memberPath);
  await waitForClientRoute(page);
  for (const width of [1280, 1100, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await captureScreenshot(page, { path: `owner-${width}.png`, fullPage: true }, "read-languages-author");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  const messages = await uiMessages(page);
  for (const [name, count] of [["seen", 2], ["one", 1]] as const) {
    const row = page.locator("#posts li, #village li").filter({ has: page.locator(`a[href="/t/${fixture[name]}"]`) });
    await expect(row.locator("[data-read-language-count]")).toHaveAttribute("data-read-language-count", String(count));
    await expect(row.locator("[data-read-language-count]")).toHaveText(formatMessage(messages.member_page_read_languages, { count }));
  }
  await expect(page.locator("#posts li, #village li").filter({ has: page.locator(`a[href="/t/${fixture.unseen}"]`) }).locator("[data-read-language-count]")).toHaveCount(0);
  await expect(page.locator("[data-read-language-count]")).toHaveCount(2);

  await useMember(page, "reach_reader@example.com", memberPath);
  await expect(page.locator("[data-read-language-count]")).toHaveCount(0);
  expect(await (await page.request.get(memberPath)).text()).not.toContain("readLanguageCount");
  const anonymous = await request.newContext({ baseURL: state().baseURL });
  try {
    const response = await anonymous.get(memberPath, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(new URL(response.headers().location, state().baseURL).pathname).toBe("/login");
    expect(await response.text()).not.toContain("readLanguageCount");
  } finally {
    await anonymous.dispose();
  }
});

test("a writer's translated view stays uncounted until a later member or anonymous reader sees it", async ({ page, browser }, testInfo) => {
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "read-languages-author.json"), "utf8")) as Record<string, number>;
  const memberPath = "/u/reach_self_writer";
  const count = (id: number) => page.locator("#posts li, #village li").filter({ has: page.locator(`a[href="/t/${id}"]`) }).locator("[data-read-language-count]");
  async function readTranslated(target: Page, id: number, open: () => Promise<unknown>) {
    const report = target.waitForResponse(response => response.url().includes(`/t/${id}/translations?lang=fr`) && response.request().method() === "POST" && response.request().postDataJSON()?.intent === "seen" && response.ok());
    await open();
    await expect(target.locator(`#p-${id} .longread`)).toHaveAttribute("lang", "fr");
    await report;
  }
  const id = fixture.self_member;
  await readTranslated(page, id, () => useMember(page, "reach_self_writer@example.com", `/t/${id}?lang=fr`));
  await page.goto(memberPath);
  await expect(count(id)).toHaveCount(0);
  await captureScreenshot(page, { path: "author-first.png", fullPage: true }, "read-languages-author-fix1");
  await readTranslated(page, id, () => useMember(page, "reach_self_reader@example.com", `/t/${id}?lang=fr`));
  await useMember(page, "reach_self_writer@example.com", memberPath);
  await expect(count(id)).toHaveAttribute("data-read-language-count", "1");
  await captureScreenshot(page, { path: "another-reader.png", fullPage: true }, "read-languages-author-fix1");

  if (testInfo.config.metadata.publicReading) {
    const guestId = fixture.self_anonymous;
    await readTranslated(page, guestId, () => page.goto(`/t/${guestId}?lang=fr`));
    await page.goto(memberPath);
    await expect(count(guestId)).toHaveCount(0);
    const guest = await browser.newContext({ baseURL: state().baseURL, locale: "en-US" });
    try {
      const guestPage = await guest.newPage();
      await readTranslated(guestPage, guestId, () => guestPage.goto(`/t/${guestId}?lang=fr`));
    } finally { await guest.close(); }
    await page.goto(memberPath);
    await expect(count(guestId)).toHaveAttribute("data-read-language-count", "1");
  }
});
