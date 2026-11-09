import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { clientHeaders, state, useMember, waitForHydration } from "./helpers";
const ja = JSON.parse(fs.readFileSync(new URL("../messages/ja.json", import.meta.url), "utf8"));

type Fixture = { id: number; reply: number; url: string; alt: string; translatedAlt: string };
const fixture = (name: string): Fixture => JSON.parse(fs.readFileSync(path.join(state().dir, "figure-translation.json"), "utf8"))[name];
const destination = (data: Fixture) => `/t/${data.id}?lang=ja&tr=${data.id}&tr=${data.reply}`;

test("translated figures switch to the original and back in topics and replies", async ({ page, browser }) => {
  const data = fixture("toggle");
  await page.setViewportSize({ width: 390, height: 844 });
  await useMember(page, "figure_toggle_reader@example.com", destination(data));
  await waitForHydration(page);
  const figures = page.locator("main [data-translated-figure]");
  await expect(figures).toHaveCount(2);
  for (const figure of await figures.all()) {
    const image = figure.locator("img"), link = figure.locator("[data-figure-toggle]");
    const translated = await image.getAttribute("src");
    expect(translated).toMatch(/\.ja\.v\d+\.webp$/);
    await expect(image).toHaveAttribute("alt", data.translatedAlt);
    await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(360);
    const fallback = figure.locator("[data-figure-fallback]");
    await expect(fallback).toBeVisible();
    await expect(fallback).toContainText(ja.figure_fallback_space);
    await expect(fallback).toContainText(ja.figure_fallback_math);
    await expect(fallback.locator("[role=listitem]")).toHaveCount(2);
    await expect(fallback).not.toContainText("Example Name");
    await expect(fallback.locator("label")).toHaveCount(0);
    expect(await image.evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(await fallback.evaluate(el => el.getBoundingClientRect().top));
    await link.click(); await expect(image).toHaveAttribute("src", data.url);
    await expect(fallback).toBeHidden();
    await expect(image).toHaveAttribute("alt", data.translatedAlt);
    await link.click(); await expect(image).toHaveAttribute("src", translated!);
    await expect(fallback).toBeVisible();
  }
  const guest = await browser.newContext({ extraHTTPHeaders: clientHeaders("192.0.2.207") });
  try {
    const translated = await figures.first().locator("img").getAttribute("src");
    const response = await guest.request.get(new URL(translated!, page.url()).href);
    expect(response.status()).toBe(test.info().config.metadata.publicReading ? 200 : 404);
  } finally { await guest.close(); }
  await page.goto(`/t/${data.id}?lang=ja&orig=${data.id}&orig=${data.reply}`);
  await expect(page.locator("main [data-translated-figure]")).toHaveCount(0);
  await expect(page.locator("main [data-figure-fallback]")).toHaveCount(0);
  await expect(page.locator(`main img[alt="${data.alt}"]`).first()).toHaveAttribute("src", data.url);
  const markdown = await page.request.get(`/t/${data.id}.md?lang=ja`);
  expect(markdown.ok()).toBe(true); const text = await markdown.text();
  expect(text).toContain(data.url); expect(text).not.toMatch(/\.ja\.v\d+\.webp/);
});

test("unchanged figure labels retain the original without an external list", async ({ page }) => {
  const data = fixture("unchanged");
  await useMember(page, "figure_unchanged_reader@example.com", destination(data));
  await expect(page.locator("main [data-figure-fallback]")).toHaveCount(0);
  await expect(page.locator("main [data-figure-toggle]")).toHaveCount(0);
  await expect(page.locator(`main img[alt="${data.translatedAlt}"]`).first()).toHaveAttribute("src", data.url);
});

test("translated figures retain an original-image link without JavaScript", async ({ browser }) => {
  const data = fixture("nojs");
  const context = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: clientHeaders("192.0.2.206"), locale: "en-US" });
  try {
    const page = await context.newPage();
    await useMember(page, "figure_nojs_reader@example.com", destination(data));
    const fallback = page.locator("main [data-figure-fallback]").first();
    await expect(fallback).toBeVisible(); await expect(fallback).toContainText("Source <label> → 訳 <label>");
    await expect(fallback).toContainText(ja.figure_fallback_space);
    const link = page.locator("main [data-figure-toggle]").first();
    await expect(link).toHaveAttribute("href", data.url);
    const response = await page.request.get(data.url); expect(response.status()).toBe(200);
    await link.click(); await expect(page).toHaveURL(new RegExp(`${data.url.replaceAll(".", "\\.")}$`));
  } finally { await context.close(); }
});

test("a missing translated figure leaves the original visible without a waiting state", async ({ page }) => {
  const data = fixture("missing");
  await useMember(page, "figure_missing_reader@example.com", destination(data));
  await expect(page.locator("main [data-translated-figure]")).toHaveCount(0);
  const image = page.locator(`main img[alt="${data.translatedAlt}"]`).first();
  await expect(image).toHaveAttribute("src", data.url);
  await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(360);
});


test("all external translations appear below the original figure and disappear in original reading", async ({ page, browser }) => {
  const data = fixture("fallback_all");
  await useMember(page, "figure_fallback_all_reader@example.com", destination(data));
  const figures = page.locator("main [data-translated-figure]");
  await expect(figures).toHaveCount(2);
  await expect(figures.first().locator("img")).toHaveAttribute("src", data.url);
  await expect(figures.first().locator("[data-figure-fallback]")).toBeVisible();
  await expect(figures.first().locator("[data-figure-toggle]")).toHaveCount(0);
  const markdown = await page.request.get(`/t/${data.id}.md?lang=ja`);
  expect(await markdown.text()).not.toContain("Source <label>");
  const nojs = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: clientHeaders("192.0.2.208"), locale: "en-US" });
  try {
    const plain = await nojs.newPage();
    await useMember(plain, "figure_fallback_all_reader@example.com", destination(data));
    await expect(plain.locator("main [data-figure-fallback]").first()).toContainText(ja.figure_fallback_math);
    await plain.goto(`/t/${data.id}?lang=ja&orig=${data.id}&orig=${data.reply}`);
    await expect(plain.locator("main [data-figure-fallback]")).toHaveCount(0);
  } finally { await nojs.close(); }
  await page.goto(`/t/${data.id}?lang=ja&orig=${data.id}&orig=${data.reply}`);
  await expect(page.locator("main [data-figure-fallback]")).toHaveCount(0);
});


test("unavailable translations show one reason per figure without JavaScript", async ({ browser }) => {
  const data = fixture("unavailable");
  const context = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: clientHeaders("192.0.2.209"), locale: "en-US" });
  try {
    const page = await context.newPage();
    await useMember(page, "figure_unavailable_reader@example.com", destination(data));
    const notes = page.locator("main [data-figure-fallback]");
    await expect(notes).toHaveCount(2);
    for (const note of await notes.all()) {
      await expect(note).toContainText(ja.figure_fallback_translation);
      await expect(note.locator("[role=listitem]")).toHaveCount(0);
      await expect(note).not.toContainText(ja.figure_fallback_unavailable);
      await expect(note).not.toContainText(ja.figure_fallback_heading);
    }
    await page.goto(`/t/${data.id}?lang=ja&orig=${data.id}&orig=${data.reply}`);
    await expect(page.locator("main [data-figure-fallback]")).toHaveCount(0);
  } finally { await context.close(); }
});
