import { captureScreenshot, enMessages, jaMessages  } from "./helpers";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { PRINCIPLES_LANGS, PRINCIPLES_LANG_LABELS } from "../app/lib/principles-languages";
import { expectedPrinciplesStatus, readPrinciplesSource } from "../tests/helpers/principles-source";

// The principles page and footer are public without logging in.
test("the principles page opens without logging in, shows the English text and its review notice, and has the names other pages link to", async ({ page, request }) => {
  const res = await page.goto("/principles");
  expect(res!.status()).toBe(200);
  // Public, but not indexable (header and meta).
  expect(res!.headers()["x-robots-tag"]).toBe("noindex");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
  const english = readPrinciplesSource("en");
  await expect(page.getByRole("heading", { level: 1, name: english.title, exact: true })).toBeVisible();
  for (const heading of english.headings) await expect(page.getByRole("heading", { level: 2, name: heading, exact: true })).toBeVisible();
  await expect(page.getByRole("note")).toHaveCount(0);
  if (expectedPrinciplesStatus("en") === "unverified") await expect(page.locator("article p").first()).toHaveText("Unverified machine translation");
  else await expect(page.getByText("Unverified machine translation", { exact: true })).toHaveCount(0);
  // The anchors: #s1 to #s7 and the names #rules (section 3) and #objections (section 7).
  for (const id of ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "rules", "objections"]) await expect(page.locator(`[id="${id}"]`), id).toHaveCount(1);
  expect(await page.locator("#rules").evaluate((el) => el.closest("section")?.id)).toBe("s3");
  expect(await page.locator("#objections").evaluate((el) => el.closest("section")?.id)).toBe("s7");
  await page.goto("/principles#objections");
  await expect(page.getByRole("heading", { level: 2, name: english.headings[6], exact: true })).toBeInViewport();
  // The Markdown twin links back, and is public too.
  // The English text on the page: the alternate link is the English twin.
  await expect(page.locator('link[rel="alternate"][type="text/markdown"]')).toHaveAttribute("href", "/principles.md?lang=en");
  const md = await request.get("/principles.md");
  expect(md.status()).toBe(200);
  expect(md.headers()["x-robots-tag"]).toBe("noindex");
  expect(await md.text()).toContain("type: page");
  // The Japanese original, by the link.
  await page.getByRole("link", { name: enMessages.principles_original_link }).click();
  await expect(page).toHaveURL(/\/principles\?lang=ja$/);
  const japanese = readPrinciplesSource("ja");
  await expect(page.getByRole("heading", { level: 1, name: japanese.title, exact: true })).toBeVisible();
  for (const heading of japanese.headings) await expect(page.getByRole("heading", { level: 2, name: heading, exact: true })).toBeVisible();
  await expect(page.locator("article")).toHaveAttribute("lang", "ja");
  await expect(page.locator("article")).toHaveAttribute("dir", "ltr");
  await expect(page.getByText("Unverified machine translation", { exact: true })).toHaveCount(0);
});

test("the public language list opens every language's own text and marks only the current edition", async ({ browser, request }) => {
  const context = await browser.newContext({ locale: "ja-JP" });
  const page = await context.newPage();
  await page.goto("/principles");
  for (const lang of PRINCIPLES_LANGS) {
    const nav = page.getByRole("navigation", { name: jaMessages.principles_langs_label, exact: true });
    const current = await nav.locator('[aria-current="page"]').getAttribute("lang");
    if (lang !== current) {
      // The editions one cannot join in are one fold away.
      const fold = nav.locator("details");
      if (!(await fold.evaluate(element => (element as HTMLDetailsElement).open)) && await fold.locator(`a[lang="${lang}"]`).count()) await fold.locator("summary").click();
      await nav.locator(`a[lang="${lang}"]`).click();
    }
    const source = readPrinciplesSource(lang);
    await expect(page.locator("article")).toHaveAttribute("lang", lang);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(source.title);
    await expect(page.locator("article h2")).toHaveText(source.headings);
    await expect(page.locator("#s7 li")).toHaveCount(2);
    expect(await page.locator("article").textContent()).not.toContain("{{principles-");
    const markdown = await request.get(`/principles.md?lang=${lang}`);
    expect(markdown.status()).toBe(200);
    expect(await markdown.text()).toContain(source.markdown);
    for (const comment of source.comments) expect(await page.locator("article").textContent()).not.toContain(comment);
    await expect(nav.locator('[aria-current="page"]')).toHaveAttribute("lang", lang);
    await expect(nav.locator("a")).toHaveCount(16);
    for (const other of PRINCIPLES_LANGS) await expect(nav).toContainText(PRINCIPLES_LANG_LABELS[other]);
    // The languages one can join in are on the line; the others are in a fold, open when the page is shown in one of them.
    await expect(nav.locator("ul")).toHaveCount(2);
    const rows = [
      ["ja", "de", "en", "fr", "ko", "th", "vi", "zh-Hans", "zh-Hant"],
      ["ar", "bn", "es", "hi", "id", "pt", "ru", "ur"],
    ];
    for (const [index, langs] of rows.entries()) expect(await nav.locator("ul").nth(index).locator("[lang]").evaluateAll(items => items.map(item => item.getAttribute("lang")))).toEqual(langs);
    expect(await nav.locator("details").evaluate(element => (element as HTMLDetailsElement).open)).toBe(rows[1].includes(lang));
    await expect(page.locator('link[rel="alternate"][type="text/markdown"]')).toHaveAttribute("href", lang === "ja" ? "/principles.md" : `/principles.md?lang=${lang}`);
    await expect(page.getByRole("note")).toHaveCount(0);
    if (expectedPrinciplesStatus(lang) !== "unverified") await expect(page.getByText("Unverified machine translation", { exact: true })).toHaveCount(0);
    else await expect(page.locator("article p").first()).toHaveText("Unverified machine translation");
  }
  await context.close();
});

test("the Arabic body alone reads right to left without overflowing a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/principles?lang=ar");
  const article = page.locator("article");
  await expect(article).toHaveAttribute("lang", "ar");
  await expect(article).toHaveAttribute("dir", "rtl");
  await expect(article).toHaveCSS("direction", "rtl");
  await expect(page.getByRole("navigation", { name: enMessages.principles_langs_label, exact: true })).toHaveCSS("direction", "ltr");
  await expect(page.getByRole("link", { name: enMessages.principles_original_link, exact: true })).toHaveCSS("direction", "ltr");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(article.locator("ul").first()).toHaveCSS("direction", "rtl");
  await page.evaluate(() => document.querySelector("article")!.scrollIntoView({ block: "start" }));
  await captureScreenshot(page, { path: ".data/principles-revision/arabic-intro-390.png" }, "e2e-principles");
  await page.locator("#s1").evaluate(element => element.scrollIntoView({ block: "start" }));
  await captureScreenshot(page, { path: ".data/principles-revision/arabic-list-390.png" }, "e2e-principles");
});

test("the footer is on every page, the login page included: a link to the principles, and to the source when SOURCE_URL is set", async ({ page }) => {
  await page.goto("/login");
  const footer = page.getByRole("contentinfo");
  await expect(footer.getByRole("link", { name: enMessages.footer_principles })).toHaveAttribute("href", "/principles");
  await expect(footer.getByRole("link", { name: enMessages.footer_source })).toHaveAttribute("href", "https://example.org/tomola-source");
  await footer.getByRole("link", { name: enMessages.footer_principles }).click();
  await expect(page).toHaveURL(/\/principles$/);
  await expect(page.getByRole("contentinfo").getByRole("link", { name: enMessages.footer_source })).toBeVisible();
  // An error page has it too.
  await page.goto("/no-such-page");
  await expect(page.getByRole("contentinfo").getByRole("link", { name: enMessages.footer_principles })).toBeVisible();
});
