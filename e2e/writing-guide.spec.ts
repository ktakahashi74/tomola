import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages as en, jaMessages as ja, useMember, waitForClientRoute, captureScreenshot } from "./helpers";

for (const [lang, locale, messages] of [["en", "en-US", en], ["ja", "ja-JP", ja]] as const) {
  test(`visitors open the writing guide and copy its address (${lang})`, async ({ browser }) => {
    const context = await browser.newContext({ locale, permissions: ["clipboard-read", "clipboard-write"] });
    try {
      const page = await context.newPage();
      await page.goto("/connect");
      await waitForClientRoute(page);
      await page.getByRole("main").getByRole("link", { name: messages.writing_guide_title, exact: true }).click();
      await expect(page).toHaveURL(/\/writing$/);
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { name: messages.writing_guide_title, exact: true })).toBeVisible();
      await expect(main.getByText(messages.writing_guide_prompt, { exact: true })).toBeVisible();
      const address = `${new URL(page.url()).origin}/writing.md`;
      await expect(main.locator("code")).toHaveText(address);
      const copy = main.getByRole("button", { name: messages.connect_copy_address, exact: true });
      await expect(copy).toBeEnabled();
      await copy.focus();
      await page.keyboard.press("Enter");
      await expect(main.getByRole("status")).toHaveText(messages.connect_address_copied);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await captureScreenshot(page, { path: `writing-${lang}-${width}.png`, fullPage: true }, "writing-guide");
      }
      const res = await page.request.get("/writing.md");
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toBe("text/plain; charset=utf-8");
      expect(res.headers()["cache-control"]).toBe("public, max-age=300");
      expect(await res.text()).toContain(`canonical: ${new URL(page.url()).origin}/writing`);
    } finally { await context.close(); }
  });

  test(`members open the guide from new and edit writing tips (${lang})`, async ({ browser }) => {
    const context = await browser.newContext({ locale });
    try {
      const page = await context.newPage();
      await useMember(page, `writing_guide_${lang}@example.com`, "/t/new");
      const body = "An invented observation for checking the writing guide link.";
      const checkTips = async () => {
        await waitForClientRoute(page);
        await page.locator('textarea[name="body"]').fill(body);
        const tips = page.locator("[data-writing-tips]");
        await tips.locator("summary").click();
        const link = tips.getByRole("link", { name: messages.writing_guide_title, exact: true });
        await expect(link).toHaveAttribute("href", "/writing");
        const popupPromise = page.waitForEvent("popup");
        await link.click();
        const popup = await popupPromise;
        await expect(popup).toHaveURL(/\/writing$/);
        await expect(popup.getByRole("heading", { name: messages.writing_guide_title, exact: true })).toBeVisible();
        await popup.close();
        await expect(page.locator('textarea[name="body"]')).toHaveValue(body);
      };
      await checkTips();
      const fields = await page.locator('textarea[name="body"]').evaluate(field => Object.fromEntries(
        Array.from(new FormData((field as HTMLTextAreaElement).form!), ([key, value]) => [key, String(value)]),
      ));
      const response = await page.request.post("/t/new", { headers: { origin: new URL(page.url()).origin }, form: { ...fields, title: "An invented observation", body, lang: "en" }, maxRedirects: 0 });
      expect(response.status()).toBe(302);
      const location = response.headers().location?.match(/\/t\/(\d+)/);
      expect(location).toBeTruthy();
      await page.goto(`/t/${location![1]}/edit`);
      await checkTips();
    } finally { await context.close(); }
  });
}
