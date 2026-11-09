import { readingActions } from "./helpers";
import { modulePath } from "./support/module-route";
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, clientHeaders, enMessages as en, formatMessage, state, escapeRegex, uiMessages, useMember } from "./helpers";

const fixture = (): Record<string, number> => JSON.parse(fs.readFileSync(path.join(state().dir, "cross-language.json"), "utf8"));

test("guests share the selected reading language through a menu loaded on demand", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.97.12.1") });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "share", { value: undefined });
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { (window as any).copied = text; } } });
  });
  const page = await context.newPage();
  const contentRequests: string[] = [];
  const shareModule = modulePath("app/components/topic-share-content.tsx");
  page.on("request", request => { if (new URL(request.url()).pathname === shareModule) contentRequests.push(request.url()); });
  try {
    const id = fixture().share;
    await page.goto(`/t/${id}?lang=en&rl=1&page=1#p-${id}`);
    let byline = page.locator(".reading-toc-sidebar [data-reading-actions]");
    let trigger = byline.locator("summary").filter({ hasText: en.share_topic });
    await expect(trigger).toBeVisible();
    expect(contentRequests).toHaveLength(0);
    await expect(page.locator("#reply summary").filter({ hasText: en.share_topic })).toHaveCount(0);
    for (const width of [390, 1100, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      byline = await readingActions(page);
      trigger = byline.locator("summary").filter({ hasText: en.share_topic });
      const ai = await byline.getByRole("button", { name: en.open_in_ai, exact: true }).boundingBox();
      const share = await trigger.boundingBox();
      expect(share!.y).toBe(ai!.y);
      expect(share!.height).toBe(ai!.height);
      await trigger.click();
      const panel = page.getByRole("group", { name: en.share_topic, exact: true });
      const select = panel.getByRole("combobox", { name: en.reading_lang_label });
      await expect(select).toBeFocused();
      await expect(select).toHaveValue("en");
      await expect(panel.getByRole("button", { name: en.share_native })).toHaveCount(0);
      await panel.getByRole("button", { name: en.share_copy_link }).click();
      await expect(panel.getByRole("status")).toHaveText(en.open_in_ai_copied);
      expect(await page.evaluate(() => (window as any).copied)).toBe(`${state().baseURL}/t/${id}?lang=en`);
      await select.selectOption("ja");
      await expect(panel.getByRole("status")).toHaveCount(0);
      await panel.getByRole("button", { name: en.share_copy_link }).click();
      expect(await page.evaluate(() => (window as any).copied)).toBe(`${state().baseURL}/t/${id}?lang=ja`);
      const box = await panel.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await captureScreenshot(page, { path: `share-${width}.png`, fullPage: true }, "topic-share");
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(panel).toHaveCount(0);
    }
    expect(contentRequests).toHaveLength(1);
    // Escape outside the panel belongs to the currently focused control and still reaches other handlers.
    await trigger.click();
    const panel = page.getByRole("group", { name: en.share_topic, exact: true });
    await expect(panel.getByRole("combobox")).toBeFocused();
    const outside = byline.getByRole("button", { name: en.open_in_ai, exact: true });
    await outside.focus();
    await page.evaluate(() => window.addEventListener("keydown", event => {
      if (event.key === "Escape") document.documentElement.dataset.shareEscape = "received";
    }, { once: true }));
    await page.keyboard.press("Escape");
    await expect(outside).toBeFocused();
    await expect(panel).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-share-escape", "received");

    // A layout change and horizontal scrolling keep the open panel inside the viewport.
    await trigger.click();
    await expect(panel).toBeVisible();
    await page.evaluate(() => { document.body.style.width = "150vw"; });
    const withinViewport = async () => {
      const box = await panel.boundingBox();
      return !!box && box.x >= 0 && box.x + box.width <= (page.viewportSize()?.width ?? 0);
    };
    await expect.poll(withinViewport).toBe(true);
    await page.evaluate(() => window.scrollTo(200, window.scrollY));
    await expect.poll(withinViewport).toBe(true);
    await page.evaluate(() => { document.body.style.width = ""; window.scrollTo(0, window.scrollY); });
    await page.keyboard.press("Escape");
    // Shared URLs open the requested version and expose matching previews.
    for (const lang of ["ja", "en"]) {
      await page.goto(`/t/${id}?lang=${lang}`);
      await expect(page.locator("article [data-reading-body]")).toHaveAttribute("lang", lang);
      await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", `${state().baseURL}/t/${id}?lang=${lang}`);
      await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", lang === "ja" ? "言葉を越えて読む" : "Reading across languages");
      await expect(page.locator('meta[property="og:description"]')).toHaveAttribute("content", lang === "ja" ? "異なる言語で同じ文章を読み、一緒に考える。" : "Read the same text across languages and think together.");
    }
  } finally { await context.close(); }
});

test("native sharing uses the language link and cancellation stays quiet", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.97.12.2") });
  await context.addInitScript(() => Object.defineProperty(navigator, "share", { value: async (data: ShareData) => {
    (window as any).shared = data;
    throw new DOMException("Canceled", "AbortError");
  } }));
  const page = await context.newPage();
  try {
    const id = fixture().native;
    await page.goto(`/t/${id}?lang=en`);
    await page.locator(".reading-toc-sidebar [data-reading-actions] summary").filter({ hasText: en.share_topic }).click();
    const panel = page.getByRole("group", { name: en.share_topic, exact: true });
    await panel.getByRole("combobox").selectOption("ja");
    await panel.getByRole("button", { name: en.share_native }).click();
    expect(await page.evaluate(() => (window as any).shared)).toEqual({ url: `${state().baseURL}/t/${id}?lang=ja` });
    await expect(panel.getByRole("status")).toHaveCount(0);
    await page.locator("h1").click();
    await expect(panel).toHaveCount(0);
  } finally { await context.close(); }
});

test("AI prompts describe only the translation currently read at both entrances", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.97.12.3") });
  const opened: string[] = [];
  await context.route("https://ai.example/**", route => {
    opened.push(new URL(route.request().url()).searchParams.get("prompt")!);
    return route.fulfill({ contentType: "text/html", body: "<title>Fixture AI</title>" });
  });
  const page = await context.newPage();
  try {
    await useMember(page, "cross_prompt@example.com");
    const id = fixture().prompt;
    await page.goto(`/t/${id}?lang=en`);
    await page.evaluate(() => localStorage.setItem("tomola.openInAi", JSON.stringify({ provider: "custom", template: "https://ai.example/?prompt={prompt}" })));
    const entrances = [page.locator(".reading-toc-sidebar [data-reading-actions]"), page.locator("#reply [data-reply-heading]")];
    for (const translated of [true, false]) {
      if (!translated) await page.getByRole("link", { name: en.show_original, exact: true }).first().click();
      for (const entrance of entrances) {
        const count = opened.length;
        await entrance.getByRole("button", { name: en.open_in_ai, exact: true }).click();
        await expect.poll(() => opened.length).toBe(count + 1);
        const prompt = opened.at(-1)!;
        const url = prompt.match(new RegExp(`${escapeRegex(state().baseURL)}/[^\\s]+`))?.[0];
        expect(url).toBeDefined();
        expect(prompt).toBe(translated
          ? formatMessage(en.open_in_ai_prompt_translated, { source: en.language_name_ja, reading: en.language_name_en, url: url! })
          : formatMessage(en.open_in_ai_prompt, { url: url! }));
      }
    }
    await context.clearCookies();
    await page.goto(`/t/${id}?lang=en`);
    await context.route("**/open-in-ai/link", route => route.abort());
    const count = opened.length;
    await page.locator(".reading-toc-sidebar [data-reading-actions]").getByRole("button", { name: en.open_in_ai, exact: true }).click();
    await expect.poll(() => opened.length).toBe(count + 1);
    expect(opened.at(-1)).toBe(formatMessage(en.open_in_ai_prompt_translated, { source: en.language_name_ja, reading: en.language_name_en, url: `${state().baseURL}/t/${id}.md?lang=en` }));
    await page.goto(`/t/${id}?lang=en&rl=ja`);
    const ja = await uiMessages(page);
    const before = opened.length;
    await page.locator(".reading-toc-sidebar [data-reading-actions]").getByRole("button", { name: ja.open_in_ai, exact: true }).click();
    await expect.poll(() => opened.length).toBe(before + 1);
    expect(opened.at(-1)).toBe(formatMessage(ja.open_in_ai_prompt_translated, { source: ja.language_name_ja, reading: ja.language_name_en, url: `${state().baseURL}/t/${id}.md?lang=en` }));
  } finally { await context.close(); }
});
