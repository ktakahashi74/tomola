import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, enMessages, formatMessage, messageTitleField, waitForFormReady } from "./helpers";

test("reaction, stance and follow show confirmed results without rerunning page loaders", async ({ page, browser }) => {
  await useMember(page, "load_writer@example.com");
  await page.goto("/t/new");
  await waitForFormReady(page.locator("form", { has: messageTitleField(page) }));
  await messageTitleField(page).fill("Keep page reads out of one-tap controls");
  await page.getByLabel(enMessages.field_body).fill("Should reading stay light after a reaction?");
  await page.getByRole("checkbox", { name: enMessages.asks_stance_checkbox, exact: true }).check();
  await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Keep page reads out of one-tap controls" })).toBeVisible();
  const topic = new URL(page.url()).pathname;
  const context = await browser.newContext();
  const reader = await context.newPage();
  try {
    await useMember(reader, "load_voter@example.com"); await reader.goto(topic);
    await waitForFormReady(reader.locator("form[data-ready]").first());
    await expect(reader.locator('form[action="/vote"]').first()).toBeVisible();
    const reads: string[] = [];
    reader.on("request", request => { if (request.method() === "GET" && new URL(request.url()).pathname.endsWith(".data")) reads.push(request.url()); });
    const press = async (path: string, click: () => Promise<void>) => {
      const answer = reader.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `${path}.data`);
      await click(); expect((await answer).ok()).toBe(true);
      // Observe React's completed response processing at a paint boundary.
      await reader.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    };
    const vote = reader.getByRole("button", { name: enMessages.insightful_give, exact: true }).first();
    await press("/vote", () => vote.click());
    await expect(vote).toHaveAttribute("aria-pressed", "true");
    await expect(reader.locator("article").first().getByText(formatMessage(enMessages.insightful_count_short, { total: 1, langs: 1 }), { exact: true })).toBeVisible();
    await expect(reader.locator('form[action="/vote"]').first().locator('input[name="on"]')).toHaveValue("0");
    const stance = reader.locator("#stance");
    await press("/stance", () => stance.getByRole("button", { name: enMessages.stance_agree, exact: true }).click());
    await expect(stance.getByRole("button", { name: enMessages.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(stance.locator('input[name="version"]')).toHaveValue("1");
    await expect(stance.getByRole("listitem").first()).toHaveText(`${enMessages.stance_agree} 1`);
    const follow = reader.locator('form[action="/follow"]').first();
    await press("/follow", () => follow.getByRole("button").click());
    await expect(follow.locator('input[name="follow"]')).toHaveValue("0");
    await press("/vote", () => vote.click());
    await expect(vote).toHaveAttribute("aria-pressed", "false");
    await expect(reader.locator("article").first().getByText(formatMessage(enMessages.insightful_count_short, { total: 1, langs: 1 }), { exact: true })).toHaveCount(0);
    await press("/stance", () => stance.getByRole("button", { name: enMessages.stance_withdraw, exact: true }).click());
    await expect(stance.getByRole("button", { name: enMessages.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "false");
    await press("/follow", () => follow.getByRole("button").click());
    await expect(follow.locator('input[name="follow"]')).toHaveValue("1");
    expect(reads).toEqual([]);
  } finally { await context.close(); }
});

test("choosing a stance on this page enables Reconsider after Insightful and withdrawal removes it without loader GETs", async ({ page, browser }) => {
  await useMember(page, "load_review_author@example.com");
  await page.goto("/t/new");
  await waitForFormReady(page.locator("form", { has: messageTitleField(page) }));
  await messageTitleField(page).fill("A fresh stance on the current page");
  await page.getByLabel(enMessages.field_body).fill("Which view helps explain this question?");
  await page.getByRole("checkbox", { name: enMessages.asks_stance_checkbox, exact: true }).check();
  await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "A fresh stance on the current page" })).toBeVisible();
  const topic = new URL(page.url()).pathname;
  const replyForm = page.locator('#reply form');
  await waitForFormReady(replyForm);
  await replyForm.getByLabel(enMessages.field_body).fill("A reply worth reconsidering");
  await replyForm.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
  await expect(page.locator("#replies")).toContainText("A reply worth reconsidering");
  const context = await browser.newContext();
  const reader = await context.newPage();
  try {
    await useMember(reader, "load_review_reader@example.com");
    await reader.goto(topic);
    const stance = reader.locator("#stance");
    await expect(stance.getByRole("button", { name: enMessages.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "false");
    const reconsider = reader.locator("#replies").getByRole("link", { name: enMessages.insightful_review, exact: true });
    await expect(reconsider).toHaveCount(0);
    const reads: string[] = [];
    reader.on("request", request => { if (request.method() === "GET" && new URL(request.url()).pathname.endsWith(".data")) reads.push(request.url()); });
    const press = async (path: string, click: () => Promise<void>) => {
      const response = reader.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `${path}.data`);
      await click(); expect((await response).ok()).toBe(true);
      await reader.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    };
    await press("/stance", () => stance.getByRole("button", { name: enMessages.stance_agree, exact: true }).click());
    await expect(stance.locator('input[name="version"]')).toHaveValue("1");
    const insightful = reader.locator("#replies").getByRole("button", { name: enMessages.insightful_give, exact: true });
    await press("/vote", () => insightful.click());
    await expect(insightful).toHaveAttribute("aria-pressed", "true");
    await expect(reconsider).toBeVisible();
    await expect(reconsider).toHaveAttribute("href", /\?review=\d+#stance$/);
    await press("/stance", () => stance.getByRole("button", { name: enMessages.stance_withdraw, exact: true }).click());
    await expect(stance.getByRole("button", { name: enMessages.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(reconsider).toHaveCount(0);
    expect(reads).toEqual([]);
  } finally { await context.close(); }
});
