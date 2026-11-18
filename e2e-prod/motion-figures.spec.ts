import { motionImage } from "../tests/helpers/motion-images";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { enMessages as en } from "../e2e/helpers";
import { test, expect, useMember, state, watchCsp } from "./helpers";

for (const reduced of [false, true]) test(`motion is fetched only after activation with reduced motion ${reduced}`, async ({ page, browser }) => {
  const watch = await watchCsp(page);
  await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
  await useMember(page, reduced ? "motion_reduced_prod@example.com" : "motion_prod@example.com");
  await page.goto("/t/new");
  await page.locator('input[name="title"]').fill(`Motion diagram ${reduced}`);
  if (reduced) {
    await page.getByRole("button", { name: en.editor_mode_rich, exact: true }).click();
    await expect(page.locator('[contenteditable="true"]')).toBeVisible();
  }
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: en.media_insert, exact: true }).click();
  await (await chooser).setFiles({ name: "diagram.gif", mimeType: "image/gif", buffer: (await motionImage()).bytes });
  const body = page.locator('textarea[name="body"]');
  await expect(body).toHaveValue(/\[!\[.*\]\(\/media\/.*\.webp\)\]\(\/media\/.*\.webp\)/);
  const markup = await body.inputValue(), urls = [...markup.matchAll(/\/media\/[^)]+/g)].map(match => match[0]);
  expect(urls).toHaveLength(2);
  if (!reduced) {
    const uploaded = await page.request.post("/media", { headers: { origin: state().baseURL }, multipart: { image: { name: "poster.png", mimeType: "image/png", buffer: await sharp({ create: { width: 160, height: 100, channels: 3, background: "#d8e8f8" } }).png().toBuffer() } } });
    expect(uploaded.status()).toBe(201);
    const replacement = (await uploaded.json()).url;
    await body.fill(markup.replace(urls[0], replacement)); urls[0] = replacement;
    await page.getByRole("button", { name: en.editor_mode_rich, exact: true }).click();
    const rich = page.locator('[contenteditable="true"]');
    await expect(rich.locator(`a[href="${urls[1]}"] img[src]`)).toHaveCount(1);
    await rich.click(); await page.keyboard.press("Control+End"); await page.keyboard.press("Enter"); await page.keyboard.type("Motion explanation.");
    await page.getByRole("button", { name: en.editor_mode_markdown, exact: true }).click();
    await expect(body).toHaveValue(/\[!\[.*\]\([^)]*\)\]\([^)]*\)/);
  }
  const fetched: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === urls[1]) fetched.push(request.url()); });
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(url => /^\/t\/\d+$/.test(url.pathname));
  const destination = page.url(), figure = page.locator("[data-reading-body] [data-motion-figure]").first();
  const image = figure.locator("img");
  await expect(image).toHaveAttribute("src", urls[0]);
  const button = figure.getByRole("button");
  await expect(button).toHaveText(en.motion_show);
  await expect(button).toBeVisible(); expect(fetched).toEqual([]);
  await button.focus(); await page.keyboard.press("Enter");
  await expect(image).toHaveAttribute("src", urls[1]);
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => fetched.length).toBe(1);
  await expect(figure.locator("[data-motion-note]")).toBeHidden();
  await figure.getByRole("button", { name: en.motion_show_still, exact: true }).click();
  await expect(image).toHaveAttribute("src", urls[0]);
  await expect(button).toHaveAttribute("aria-pressed", "false");
  if (!reduced) {
    const context = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true, storageState: await page.context().storageState() });
    const native = await context.newPage();
    try { await native.goto(destination); await expect(native.locator("[data-motion-figure]").getByRole("link", { name: en.motion_show, exact: true })).toHaveAttribute("href", urls[1]); }
    finally { await context.close(); }
  }
  expect(watch.violations).toEqual([]); expect(watch.pageErrors).toEqual([]); expect(watch.hydrationWarnings).toEqual([]);
});

test("translated still figures explain the source-language motion", async ({ page }) => {
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "motion-figure.json"), "utf8"));
  await useMember(page, "motion_figure_reader@example.com");
  const requests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === fixture.url) requests.push(request.url()); });
  await page.goto(`/t/${fixture.id}?lang=ja&tr=${fixture.id}`);
  const figure = page.locator("[data-reading-body] [data-motion-figure]").first(), image = figure.locator("img");
  await expect(image).toHaveAttribute("src", /\.ja\.v\d+\.webp$/);
  const still = await image.getAttribute("src"); expect(requests).toEqual([]);
  await figure.getByRole("button", { name: en.motion_show, exact: true }).click();
  await expect(figure.getByRole("status")).toHaveText(en.motion_original_text);
  await expect(image).toHaveAttribute("src", fixture.url);
  await figure.getByRole("button", { name: en.motion_show_still, exact: true }).click();
  await expect(image).toHaveAttribute("src", still!);
  await expect(figure.getByRole("status")).toBeHidden();
});
