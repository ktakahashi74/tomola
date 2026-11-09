import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages as en, openReplyMore, useMember, waitForFormReady } from "./helpers";

test("topic and reply previews retain their published reading modes when edited", async ({ page, baseURL }) => {
  await useMember(page, "longread_preview@example.com", "/t/new");
  const body = "文章の組みを確認する。\n\n## 見出し\n\n本文を読む。";
  const textarea = () => page.locator('textarea[name="body"]');
  const preview = () => page.getByRole("button", { name: en.preview, exact: true }).locator("..").locator(".longread");
  const show = async (compact: boolean) => {
    await waitForFormReady(page.locator("form", { has: textarea() }));
    await page.getByRole("button", { name: en.preview, exact: true }).click();
    await expect(preview()).toContainText("本文を読む。");
    await expect(preview()).toHaveAttribute("lang", "ja");
    if (compact) await expect(preview()).toHaveClass(/longread-compact/);
    else await expect(preview()).not.toHaveClass(/longread-compact/);
  };
  await waitForFormReady(page.locator("form", { has: textarea() }));
  await textarea().fill(body);
  // Automatic language selection uses the body language even in an English interface.
  await show(false);

  const response = await page.request.post("/t/new", { headers: { origin: baseURL! }, form: { lang: "ja", title: "Preview reading modes", body }, maxRedirects: 0 });
  expect(response.status()).toBe(302);
  const topic = new URL(response.headers().location, baseURL).pathname;
  page.on("dialog", dialog => dialog.accept());
  await page.goto(topic);
  await expect(page.locator("[data-reading-body]")).not.toHaveClass(/longread-compact/);
  await page.goto(`${topic}/edit`);
  await show(false);

  await page.goto(topic);
  await waitForFormReady(page.locator("form", { has: textarea() }));
  await textarea().fill(body);
  await openReplyMore(page);
  await show(true);
  const reply = await page.request.post(topic, { headers: { origin: baseURL! }, form: { lang: "ja", body }, maxRedirects: 0 });
  expect(reply.status()).toBe(302);
  await page.goto(new URL(reply.headers().location, baseURL).href);
  const published = page.locator('article[id^="c-"]').filter({ hasText: "本文を読む。" }).first();
  await expect(published.locator(".longread")).toHaveClass(/longread-compact/);
  const id = (await published.getAttribute("id"))!.slice(2);
  await page.goto(`/c/${id}/edit`);
  await show(true);
});
