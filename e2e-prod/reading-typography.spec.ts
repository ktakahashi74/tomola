import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { captureScreenshot, waitForClientRoute, expect, useMember, state, test, watchCsp  } from "./helpers";

test("reading fonts load locally under CSP, while Japanese articles use device fonts", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const baseURL = state().baseURL;
  const author = await browser.newContext({ baseURL });
  const page = await author.newPage();
  const topics: Record<string, string> = {};
  const loads: { page: string; lang: string; fonts: { file: string; bytes: number }[] }[] = [];
  const sourceFont = (url: string) => /source-serif-4-.*\.woff2/.test(url);
  const screenshot = async (page: Page, name: string) => {
    if (!process.env.E2E_EVIDENCE_DIR) return;
    fs.mkdirSync(process.env.E2E_EVIDENCE_DIR, { recursive: true });
    await captureScreenshot(page, { path: path.join(process.env.E2E_EVIDENCE_DIR, `${name}.png`) }, "e2e-prod-reading-typography");
  };
  try {
    // This invitation belongs only to this test; other suites never log in as this member.
    await useMember(page, "reading_type@example.com");
    for (const lang of ["ja", "en"]) {
      const paragraph = lang === "ja"
        ? "文章を読むときには、題から本文へ、考えを追って進む。言葉が違っても、同じ節に戻って読み直せる。"
        : "A reader follows an idea from the title into the text. Across languages, headings help readers return to the same passage. ";
      const title = lang === "ja" ? "言葉を越えて、文章を読む" : "Reading a text across languages";
      const heading = lang === "ja" ? "読むための節" : "Following an idea";
      const subheading = lang === "ja" ? "読み直す" : "Returning to the text";
      const body = `${paragraph.repeat(2)}\n\n${lang === "ja" ? "*強調する言葉*" : "*Words to emphasize*"}\n\n## ${heading}\n\n${paragraph.repeat(8)}\n\n### ${subheading}\n\n> ${paragraph}\n\n${paragraph.repeat(4)}`;
      const response = await author.request.post("/t/new", {
        headers: { origin: baseURL }, form: { lang, title, body }, maxRedirects: 0,
      });
      expect(response.status()).toBe(302);
      topics[lang] = new URL(response.headers().location, baseURL).pathname;
      const reply = await author.request.post(topics[lang], {
        headers: { origin: baseURL }, form: { lang, body: `> ${paragraph}\n\n${paragraph}` }, maxRedirects: 0,
      });
      expect(reply.status()).toBe(302);
    }
    const storageState = await author.storageState();
    for (const lang of ["ja", "en"]) {
      // New contexts isolate font requests from cache and earlier English pages.
      const context = await browser.newContext({ baseURL, storageState });
      // A member keeps the saved display language over ?lang=; read each article as a reader of its language would.
      await context.addCookies([{ name: "PARAGLIDE_LOCALE", value: lang, url: baseURL }]);
      const article = await context.newPage();
      const watch = await watchCsp(article);
      const fonts: Promise<{ file: string; bytes: number }>[] = [];
      const failed: string[] = [];
      article.on("requestfailed", request => { if (sourceFont(request.url())) failed.push(request.url()); });
      article.on("response", response => {
        if (!sourceFont(response.url())) return;
        fonts.push((async () => {
          expect(new URL(response.url()).origin).toBe(new URL(baseURL).origin);
          expect(response.status()).toBe(200);
          return { file: new URL(response.url()).pathname, bytes: (await response.body()).length };
        })());
      });
      try {
        const id = topics[lang].split("/").at(-1);
        for (const width of [1280, 390]) {
          await article.setViewportSize({ width, height: 900 });
          await article.goto(`${topics[lang]}?lang=${lang}&orig=${id}`);
          await expect(article.locator("[data-reading-body]")).toHaveAttribute("lang", lang);
          const emphasis = article.locator("[data-reading-body] em").first();
          expect(await emphasis.evaluate(element => getComputedStyle(element).fontStyle)).toBe("italic");
          expect(await emphasis.evaluate(element => getComputedStyle(element).fontFamily)).toBe(await emphasis.locator("..").evaluate(element => getComputedStyle(element).fontFamily));
          await article.evaluate(() => document.fonts.ready);
          await waitForClientRoute(article);
          await article.evaluate(() => window.scrollTo(0, 0));
          await expect(article.getByRole("heading", { level: 1 })).toBeInViewport();
          await expect.poll(() => article.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
          await screenshot(article, `article-${lang}-${width}`);
          await article.locator("[id^='c-']").first().scrollIntoViewIfNeeded();
          await screenshot(article, `replies-${lang}-${width}`);
          const reply = article.locator("[id^='c-'] .longread").first();
          expect(await reply.evaluate(element => getComputedStyle(element).fontFamily)).toBe(await article.locator("body").evaluate(element => getComputedStyle(element).fontFamily));
        }
        const loaded = [...new Map((await Promise.all(fonts)).map(font => [font.file, font])).values()];
        loads.push({ page: "article", lang, fonts: loaded });
        expect(failed).toEqual([]);
        if (lang === "ja") expect(loaded).toEqual([]);
        else {
          expect(loaded.some(font => font.file.includes("wght-normal"))).toBe(true);
          expect(loaded.some(font => font.file.includes("wght-italic"))).toBe(true);
        }
        expect(watch.violations).toEqual([]);
        expect(watch.pageErrors).toEqual([]);
        expect(watch.hydrationWarnings).toEqual([]);
      } finally { await context.close(); }

      const documents = await browser.newContext({ baseURL, storageState });
      const docPage = await documents.newPage();
      const docWatch = await watchCsp(docPage);
      try {
        for (const route of ["/", "/principles", "/why"]) {
          for (const width of [1280, 390]) {
            await docPage.setViewportSize({ width, height: 900 });
            await docPage.goto(`${route}?lang=${lang}`);
            await docPage.evaluate(() => document.fonts.ready);
            await docPage.evaluate(() => window.scrollTo(0, 0));
            await expect.poll(() => docPage.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
            await screenshot(docPage, `${route.slice(1) || "home"}-${lang}-${width}`);
            if (route === "/" && width === 1280) {
              const resources = await docPage.evaluate(() => performance.getEntriesByType("resource").map(resource => resource.name).filter(url => /source-serif-4-.*\.woff2/.test(url)));
              const homeFonts = await Promise.all(resources.map(async url => {
                const response = await documents.request.get(url);
                expect(response.status()).toBe(200);
                return { file: new URL(url).pathname, bytes: (await response.body()).length };
              }));
              loads.push({ page: "home", lang, fonts: homeFonts });
            }
          }
        }
        expect(docWatch.violations).toEqual([]);
        expect(docWatch.pageErrors).toEqual([]);
        expect(docWatch.hydrationWarnings).toEqual([]);
      } finally { await documents.close(); }
    }
    await testInfo.attach("font-loads", { body: JSON.stringify(loads, null, 2), contentType: "application/json" });
    fs.writeFileSync(testInfo.outputPath("font-loads.json"), JSON.stringify(loads, null, 2));
  } finally { await author.close(); }
});
