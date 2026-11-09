import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { PRINCIPLES_LANGS } from "../app/lib/principles-languages";
import { readNameSource } from "../tests/helpers/name-source";
import { enMessages, waitForClientRoute } from "./helpers";

// Fixed site documents need no member, topic, invitation or global row counts.
for (const lang of PRINCIPLES_LANGS) test(`the separate name page and its Markdown edition open anonymously in ${lang}`, async ({ page, request }) => {
  const source = readNameSource(lang);
  const response = await page.goto(`/name?lang=${lang}`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["x-robots-tag"]).toBe("noindex");
  await expect(page.locator("article")).toHaveAttribute("lang", lang);
  await expect(page.locator("article h1")).toHaveText(source.title);
  const mark = page.locator("article > img");
  await expect(mark).toHaveAttribute("src", /^\/l[a-f0-9]{8}\.svg$/);
  expect(await mark.evaluate(async image => {
    await (image as HTMLImageElement).decode();
    return (image as HTMLImageElement).naturalWidth;
  })).toBeGreaterThan(0);
  expect(await response!.text()).toMatch(/<img src="\/l[a-f0-9]{8}\.svg"/);
  await expect(page.locator("article .longread p").last()).toHaveText(source.signature);
  await expect(page.locator('link[rel="alternate"][type="text/markdown"]')).toHaveAttribute("href", lang === "ja" ? "/name.md" : `/name.md?lang=${lang}`);
  if (["ar", "ur"].includes(lang)) await expect(page.locator("article")).toHaveAttribute("dir", "rtl");
  const markdown = await request.get(`/name.md?lang=${lang}`);
  expect(markdown.status()).toBe(200);
  const text = await markdown.text();
  expect(text).toContain(`# ${source.title}\n`);
  expect(text).toContain(source.signature);
  expect(text).toContain("canonical:");
  expect(text).not.toContain("<!-- source:");
  await page.goto(`/why?lang=${lang}`);
  await expect(page.locator("article h1")).toBeVisible();
  await expect(page.getByRole("heading", { name: source.title, exact: true })).toHaveCount(0);
  expect(await (await request.get(`/why.md?lang=${lang}`)).text()).not.toContain(`## ${source.title}`);
});

test("the name page follows language selection and keeps invalid Markdown languages explicit", async ({ page, request }) => {
  await page.goto("/name");
  await expect(page.locator("article")).toHaveAttribute("lang", "en");
  await page.goto("/name?lang=unknown");
  await expect(page.locator("article")).toHaveAttribute("lang", "en");
  await waitForClientRoute(page);
  await page.getByRole("link", { name: enMessages.principles_original_link, exact: true }).click();
  await expect(page).toHaveURL(/\/name\?lang=ja$/);
  await expect(page.locator("article h1")).toHaveText(readNameSource("ja").title);
  for (const section of ["header", "footer"]) await expect(page.locator(`${section} a[href^="/name"]`)).toHaveCount(0);
  expect((await request.get("/name.md?lang=unknown")).status()).toBe(400);
  const alias = await request.get("/name.txt?lang=en");
  expect(alias.status()).toBe(200);
  expect(await alias.text()).toContain(`# ${readNameSource("en").title}\n`);
});
