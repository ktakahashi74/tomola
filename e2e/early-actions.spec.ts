import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { state, uiMessages, useMember, waitForClientRoute } from "./helpers";
import { beforeHydration } from "./support/prehydration";
import { earlySettings, pressAcrossHydration } from "./support/early-actions";
import type { EarlyFixture } from "./seed-early-actions";

test.use({ serviceWorkers: "block" });
const fixture = (): EarlyFixture => JSON.parse(fs.readFileSync(path.join(state().dir, "early-actions.json"), "utf8"));

test("early settings selections and disclosures survive hydration", async ({ page }) => {
  await useMember(page, "early_settings@example.com");
  await earlySettings(page);
});

test("parent links navigate before and during hydration and retain client navigation", async ({ page }) => {
  await useMember(page, "early_parent@example.com");
  const { topicId, firstId, lastId } = fixture().parent;
  const source = `/t/${topicId}?page=2`;
  const destination = `/t/${topicId}#c-${firstId}`;
  // The parent is the branch root on the previous page: the continued branch starts with the link to it.
  const parent = () => page.locator(`[data-reply-branch="${firstId}"] a[href$="#c-${firstId}"]`);
  await beforeHydration(page, source, async () => {
    await expect(parent()).toHaveAttribute("href", destination);
    await parent().click({ noWaitAfter: true });
    await page.waitForURL(`**${destination}`, { waitUntil: "commit" });
  });
  await expect(page.locator(`#c-${firstId}`)).toBeInViewport();
  await beforeHydration(page, source, async () => {
    await page.locator('main [rel="prev"]').first().click({ noWaitAfter: true });
    await page.waitForURL(new RegExp(`/t/${topicId}#replies$`), { waitUntil: "commit" });
  });
  await expect(page.locator(`#c-${firstId}`)).toBeVisible();
  await pressAcrossHydration(page, source, parent);
  await expect(page).toHaveURL(new RegExp(`#c-${firstId}$`));
  await expect(page.locator(`#c-${firstId}`)).toBeInViewport();
  await page.goto(source);
  await waitForClientRoute(page);
  await page.evaluate(() => { (window as Window & { earlyNavigation?: boolean }).earlyNavigation = true; });
  await parent().click();
  await expect(page).toHaveURL(new RegExp(`#c-${firstId}$`));
  expect(await page.evaluate(() => (window as Window & { earlyNavigation?: boolean }).earlyNavigation)).toBe(true);
});

test("primary navigation controls work before hydration", async ({ page }) => {
  await useMember(page, "early_navigation@example.com");
  const { topicId, replyId, notificationId } = fixture().navigation;
  const messages = await uiMessages(page);
  for (const scenario of [
    { source: "/", selector: 'a[href*="order=activity"]', url: /order=activity/ },
    { source: "/", selector: 'a[href*="asks=1"]', url: /asks=1/ },
    { source: "/a/en", selector: 'a[href*="asks=1"]', url: /asks=1/ },
    { source: "/following?all=1", selector: 'a[href*="asks=1"]', url: /asks=1/ },
    { source: "/following?all=1", selector: `#q-${topicId} > a`, url: new RegExp(`/t/${topicId}`) },
    { source: "/notifications", selector: `#n-${notificationId} > div > a`, url: new RegExp(`#c-${replyId}$`) },
    { source: `/t/${topicId}?lang=en`, selector: 'a[href*="orig="]', url: /orig=/ },
    { source: `/t/${topicId}?lang=en`, selector: 'nav a[href*="lang=ja"]', url: /lang=ja/ },
    { source: `/t/${topicId}`, selector: `#c-${replyId} a[href*="reply_to="]`, url: /reply_to=.*#reply/ },
  ]) {
    await beforeHydration(page, scenario.source, async () => {
      const control = page.locator("main").locator(scenario.selector).first();
      if (!await control.isVisible()) await control.locator("xpath=ancestor::details[1]/summary").click();
      await control.click({ noWaitAfter: true });
      await page.waitForURL(scenario.url, { waitUntil: "commit" });
    });
    await expect(page).toHaveURL(scenario.url);
  }
  // A fold opened before hydration (the list filter on the home order row) stays open after it.
  const filterSummary = page.locator(`main summary[aria-label^="${messages.filter_prefix}"]`);
  await beforeHydration(page, "/", async () => {
    await filterSummary.click();
  });
  await expect(filterSummary.locator("xpath=..")).toHaveAttribute("open");
  await beforeHydration(page, "/notifications", async () => {
    const notice = page.locator(`#n-${notificationId}`);
    await expect(notice.getByText(messages.notification_unread, { exact: true })).toHaveCount(0);
    await notice.locator(`a[href="/notifications/${notificationId}/open"]`).click({ noWaitAfter: true });
    await page.waitForURL(new RegExp(`#c-${replyId}$`), { waitUntil: "commit" });
  });
  await expect(page).toHaveURL(new RegExp(`#c-${replyId}$`));
});

test("an unsupported passkey notice does not move an early navigation target", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: undefined }); });
  await useMember(page, "early_unsupported@example.com");
  await pressAcrossHydration(page, "/", () => page.locator('main a[href*="order=activity"]'));
  await expect(page).toHaveURL(/order=activity/);
});

test("native disclosures across writing, questions and review retain early toggles", async ({ page }) => {
  const f = fixture().audit;
  const appealText = "An owned appeal for disclosure checks.";
  const ownedAppeal = () => page.locator('main section[id^="a-"]').filter({ has: page.getByText(appealText, { exact: true }) });
  try {
    await useMember(page, "early_audit@example.com");
    const response = await page.request.post(`/appeal/${f.actionId}`, {
      form: { text: appealText }, headers: { Origin: new URL(page.url()).origin }, maxRedirects: 0,
    });
    expect(response.status()).toBe(302);
    await useMember(page, "early_reviewer@example.com", "/mod/appeals");
    await expect(ownedAppeal()).toHaveCount(1);
    const appealId = await ownedAppeal().locator('input[name="appealId"]').inputValue();
    let activeMember = "reviewer";
    for (const scenario of [
      { member: "audit", path: `/t/${f.topicId}`, selector: "main details:visible" },
      { member: "audit", path: `/appeal/${f.actionId}`, selector: "main details" },
      { member: "audit", path: `/drafts/${f.draftId}`, selector: "main details:visible" },
      { member: "audit", path: `/glossary?to=en`, selector: `#g-${f.glossaryId} details` },
      { member: "reviewer", path: `/t/${f.topicId}`, selector: "main details:visible" },
      { member: "reviewer", path: "/mod/appeals", selector: `#a-${appealId} details` },
      { member: "reviewer", path: "/admin/translations", selector: `#r-${f.reportId} details` },
      { member: "onboarding", path: "/onboarding", selector: "main details" },
    ]) {
      if (scenario.member === "onboarding") {
        // This authentication-stage account intentionally has no profile or member menu.
        await page.context().setStorageState(JSON.parse(fs.readFileSync(path.join(state().dir, "members", "early_onboarding@example.com.json"), "utf8")));
      } else if (activeMember !== scenario.member) await useMember(page, `early_${scenario.member}@example.com`);
      activeMember = scenario.member;
      let elements: Awaited<ReturnType<import("@playwright/test").Locator["elementHandles"]>> = [];
      let expected: boolean[] = [];
      await beforeHydration(page, scenario.path, async () => {
        elements = await page.locator(scenario.selector).elementHandles();
        expect(elements.length, scenario.path).toBeGreaterThan(0);
        expected = await Promise.all(elements.map(element => element.evaluate(node => !(node as HTMLDetailsElement).open)));
        for (const element of elements) await (await element.$("summary"))!.click();
      });
      for (let index = 0; index < elements.length; index++) {
        expect(await elements[index].evaluate(node => ({ connected: node.isConnected, open: (node as HTMLDetailsElement).open })), scenario.path).toEqual({ connected: true, open: expected[index] });
      }
    }
  } finally {
    // Finish this owned review so later scenarios do not inherit a pending appeal.
    await useMember(page, "early_reviewer@example.com", "/mod/appeals");
    // Find it again even if creation succeeded but a later assertion failed.
    if (await ownedAppeal().count()) {
      const appealId = await ownedAppeal().locator('input[name="appealId"]').inputValue();
      const response = await page.request.post("/mod/appeals", {
        form: { appealId, intent: "uphold", note: "Early disclosure audit completed." },
        headers: { Origin: new URL(page.url()).origin }, maxRedirects: 0,
      });
      expect(response.status()).toBe(302);
    }
  }
});
