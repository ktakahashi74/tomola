import fs from "node:fs";
import path from "node:path";
import { ARTICLE_AUTHOR, ARTICLE_OPERATOR, ARTICLE_RESTRICTED, ARTICLE_SUSPENDED, ARTICLE_UNCONSENTED, articleCounts } from "./article-reading-fixtures";
import { expect, state, test, useMember, waitForClientRoute } from "./helpers";
import { enMessages as en } from "../e2e/helpers";

const fixture = () => JSON.parse(fs.readFileSync(path.join(state().dir, "article-reading.json"), "utf8")) as { id: number };
const storageKey = "tomola:read-dedupe:v1";

test("serves article counts only in eligible member HTML and single-fetch data", async ({ browser, baseURL }) => {
  const { id } = fixture();
  const article = `/t/${id}`;
  const leaked = new RegExp(`(?:${articleCounts.total}|${articleCounts.translated}|data-article-views)`);
  const anonymous = await browser.newContext({ baseURL });
  try {
    for (const suffix of ["", ".data"]) {
      const response = await anonymous.request.get(article + suffix, { maxRedirects: 0 });
      if (process.env.PUBLIC_READING === "1") {
        expect(response.status()).toBe(200);
        expect(response.headers()["cache-control"]).toContain("private");
      }
      const body = await response.text();
      expect(body).not.toMatch(leaked);
      if (suffix === "" && process.env.PUBLIC_READING === "1") expect(body).toContain('property="og:title"');
    }
  } finally { await anonymous.close(); }

  for (const email of [ARTICLE_AUTHOR, ARTICLE_SUSPENDED, ARTICLE_UNCONSENTED, ARTICLE_RESTRICTED]) {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      const prepared = JSON.parse(fs.readFileSync(path.join(state().dir, "members", email + ".json"), "utf8"));
      await context.setStorageState(prepared);
      const eligible = email === ARTICLE_AUTHOR;
      for (const suffix of ["", ".data"]) {
        const response = await context.request.get(article + suffix);
        expect(response.status(), `${email} ${suffix}`).toBe(200);
        expect(response.headers()["cache-control"]).toContain("private");
        const body = await response.text();
        if (eligible) expect(body).toContain(String(articleCounts.translated));
        else expect(body).not.toMatch(leaked);
      }
      if (eligible) {
        await page.goto(article);
        await expect(page.locator("[data-article-views]")).toContainText(String(articleCounts.total));
        await expect(page.locator("[data-article-views]")).toContainText("UTC");
        await expect(page.locator("[data-article-views]")).toContainText(en.article_views_help);
        for (const route of ["/", "/a/ja", "/following", "/u/article_read_author", article + ".md", article + ".txt"]) {
          const response = await context.request.get(route);
          expect(response.status(), route).toBe(200);
          const body = await response.text();
          expect(body, route).not.toMatch(leaked);
          if (route.startsWith("/u/")) expect(body).toContain("data-read-language-count");
        }
        expect((await context.request.get("/admin/metrics")).status()).toBe(404);
      } else {
        await page.goto(article);
        await expect(page.locator("[data-reading-body]")).toBeVisible();
        await expect(page.locator("[data-article-views]")).toHaveCount(0);
      }
    } finally { await context.close(); }
  }
});

test("counts the initial translation and the client-side source switch once across reloads", async ({ page }) => {
  const { id } = fixture();
  const article = `/t/${id}`;
  await useMember(page, ARTICLE_OPERATOR);
  const reads: Array<{ shown: string; mark?: string }> = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === article + "/translations" && request.postDataJSON()?.intent === "read") {
      reads.push(request.postDataJSON());
    }
  });
  const report = () => page.waitForResponse(response => response.request().method() === "POST" &&
    new URL(response.url()).pathname === article + "/translations" && response.request().postDataJSON()?.intent === "read");
  const initial = report();
  await page.goto(`${article}?lang=en&tr=${id}`);
  expect(await (await initial).json()).toMatchObject({ counted: true });
  await waitForClientRoute(page);
  await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), storageKey)).toContain(`${article}:en:tr`);
  const toggle = report();
  await page.getByRole("link", { name: en.show_original, exact: true }).click();
  expect(await (await toggle).json()).toMatchObject({ counted: true });
  await expect(page.locator("[data-reading-body]")).toHaveAttribute("lang", "ja");
  expect(reads[0]).toMatchObject({ shown: "translation", mark: expect.any(String) });
  expect(reads[1]).toMatchObject({ shown: "original" });
  expect(reads[1].mark).toBeUndefined();
  await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), storageKey)).toContain(`${article}:ja:orig`);
  await page.locator(".reading-lang-menu summary").click();
  await page.locator(".reading-lang-menu").getByRole("link", { name: "English", exact: true }).click();
  await expect(page.locator("[data-reading-body]")).toHaveAttribute("lang", "en");
  await page.reload();
  await waitForClientRoute(page);
  await expect(page.locator("[data-article-views]")).toContainText(String(articleCounts.total + 2));
  expect(reads).toHaveLength(2);

  const stats = await page.request.get("/stats.md?lang=en");
  expect(await stats.text()).toContain(en.stats_reading_cumulative);
  await page.goto("/stats?lang=en");
  await expect(page.getByRole("heading", { level: 3, name: en.stats_reading_cumulative, exact: true })).toBeVisible();
  await page.goto("/admin/metrics");
  const operatorTable = page.getByRole("region", { name: en.metrics_article_reading_title });
  await expect(operatorTable.getByRole("columnheader", { name: en.metrics_article_reading_translated, exact: true })).toBeVisible();
  const row = operatorTable.getByRole("row").filter({ has: page.getByRole("link", { name: "Article count browser fixture" }) });
  await expect(row.getByRole("cell").nth(5)).toHaveText("3");
  await expect(row.getByRole("cell").nth(1)).toHaveText(String(articleCounts.total + 2));
});
