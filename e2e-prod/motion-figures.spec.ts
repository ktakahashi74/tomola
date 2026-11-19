// Translated stills need E2E_MOTION_FIXTURES=1 FIGURE_TRANSLATION=1. Run with
// those settings using pnpm test:e2e:prod e2e-prod/motion-figures.spec.ts; the
// ordinary production suite keeps figure translation disabled.
import { motionImage } from "../tests/helpers/motion-images";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { enMessages as en } from "../e2e/helpers";
import { test, expect, useMember, state, watchCsp } from "./helpers";

for (const reduced of [false, true]) test(`motion loads on visibility once, or on request with reduced motion ${reduced}`, async ({ page, browser }) => {
  const watch = await watchCsp(page);
  await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
  await useMember(page, reduced ? "motion_reduced_prod@example.com" : "motion_prod@example.com");
  await page.goto("/t/new");
  await page.locator('input[name="title"]').fill(`Motion diagram ${reduced}`);
  await page.getByText(en.writing_tips, { exact: true }).click();
  await expect(page.getByText(en.media_help, { exact: false })).toBeVisible();
  await expect(page.getByText(en.motion_help, { exact: false })).toBeVisible();
  if (reduced) {
    await page.getByRole("button", { name: en.editor_mode_rich, exact: true }).click();
    await expect(page.locator('[contenteditable="true"]')).toBeVisible();
  }
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: en.media_insert, exact: true }).click();
  await (await chooser).setFiles({ name: "diagram.gif", mimeType: "image/gif", buffer: (await motionImage("gif", 4, 160, 100, 300)).bytes });
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
  if (reduced) await page.getByRole("button", { name: en.editor_mode_markdown, exact: true }).click();
  // Keep the figure below the fold without depending on a particular viewport.
  await body.fill(Array(24).fill("Reading context before the diagram.").join("\n\n") + "\n\n" + await body.inputValue());
  const fetched: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === urls[1]) fetched.push(request.url()); });
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(url => /^\/t\/\d+$/.test(url.pathname));
  const destination = page.url(), figure = page.locator("[data-reading-body] [data-motion-figure]").first();
  const still = figure.locator("img").first(), button = figure.getByRole("button");
  const duration = Number(await figure.getAttribute("data-motion-duration"));
  expect(duration).toBe(1200);
  await expect(still).toHaveAttribute("src", urls[0]);
  await expect(button).toHaveText(en.motion_show);
  await expect(button).not.toHaveAttribute("aria-pressed");
  expect((await still.boundingBox())!.y).toBeGreaterThan(page.viewportSize()!.height);
  await page.waitForTimeout(400);
  expect(fetched).toEqual([]);
  if (!reduced) {
    // A slow response must leave the still intact and not spend playback time.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**${urls[1]}`, async route => { await gate; await route.continue(); }, { times: 1 });
    await still.scrollIntoViewIfNeeded();
    await expect.poll(() => fetched.length).toBe(1);
    await page.waitForTimeout(duration + 150);
    await expect(still).toBeVisible();
    release();
    await expect(still).toBeHidden();
    await expect(button).toHaveAccessibleName(en.motion_show_still);
    await page.waitForTimeout(duration / 2);
    await expect(still).toBeHidden();
    await expect(still).toBeVisible();
    await expect(button).toHaveAccessibleName(en.motion_show);
    await page.evaluate(() => window.scrollTo(0, 0));
    await still.scrollIntoViewIfNeeded();
    await page.waitForTimeout(duration + 150);
    expect(fetched).toHaveLength(1);
    await expect(still).toBeVisible();
  } else {
    await still.scrollIntoViewIfNeeded();
    await page.waitForTimeout(duration + 150);
    expect(fetched).toEqual([]);
  }
  // Keyboard activation loops beyond the uploaded image's finite loop count.
  await button.focus(); await page.keyboard.press("Enter");
  await expect(still).toBeHidden();
  const moving = figure.locator("img").last();
  await expect(moving).toHaveAttribute("src", /^data:image\/webp;playback=/);
  const firstSource = await moving.getAttribute("src");
  await expect(button).toHaveAccessibleName(en.motion_show_still);
  await page.waitForTimeout(duration * 4);
  await expect(still).toBeHidden();
  const frame = await moving.screenshot();
  await expect.poll(async () => (await moving.screenshot()).equals(frame), { intervals: [100], timeout: duration }).toBe(false);
  await expect(figure.locator("[data-motion-note]")).toBeHidden();
  await button.click();
  await expect(still).toBeVisible();
  await expect(button).toHaveAccessibleName(en.motion_show);
  await button.click();
  await expect(still).toBeHidden();
  // The first frame is blank; a cached decoder must not resume a later frame.
  expect(await moving.getAttribute("src")).not.toBe(firstSource);
  // Inspect the opaque canvas, excluding the transparent margin.
  const { data, info } = await sharp(await moving.screenshot()).extract({ left: 8, top: 8, width: 144, height: 84 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i] < 130 && data[i + 1] < 130 && data[i + 2] < 130) dark++;
  expect(dark).toBe(0);
  await button.click();
  await expect(still).toBeVisible();
  if (!reduced) {
    const context = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true, storageState: await page.context().storageState() });
    const native = await context.newPage();
    try {
      await native.goto(destination);
      await expect(native.locator("[data-motion-figure]").getByRole("link", { name: en.motion_show, exact: true })).toHaveAttribute("href", urls[1]);
      await expect(native.locator("[data-motion-figure] img")).toHaveAttribute("src", urls[0]);
    } finally { await context.close(); }
  }
  expect(watch.violations).toEqual([]); expect(watch.pageErrors).toEqual([]); expect(watch.hydrationWarnings).toEqual([]);
});

test("translated still figures explain the source-language motion", async ({ page }) => {
  test.skip(process.env.E2E_MOTION_FIXTURES !== "1" || process.env.FIGURE_TRANSLATION !== "1", "Requires motion fixtures and figure translation");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "motion-figure.json"), "utf8"));
  await useMember(page, "motion_figure_reader@example.com");
  const requests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === fixture.url) requests.push(request.url()); });
  await page.goto(`/t/${fixture.id}?lang=ja&tr=${fixture.id}`);
  const figure = page.locator("[data-reading-body] [data-motion-figure]").first(), image = figure.locator("img").first();
  await expect(image).toHaveAttribute("src", /\.ja\.v\d+\.webp$/);
  const still = await image.getAttribute("src"); expect(requests).toEqual([]);
  const fallback = figure.locator("[data-figure-fallback]");
  await expect(fallback).toBeVisible();
  const imageWidth = (await image.boundingBox())!.width;
  const textWidth = (await page.locator("[data-reading-body]").boundingBox())!.width;
  const figureMax = await page.locator("html").evaluate(element => parseFloat(getComputedStyle(element).getPropertyValue("--reading-figure-max")));
  expect(imageWidth).toBeCloseTo(figureMax);
  expect((await fallback.boundingBox())!.width).toBeCloseTo(textWidth);
  const fallbackHeight = (await fallback.boundingBox())!.height;
  const translationHeight = (await figure.locator("[data-translated-figure]").boundingBox())!.height;
  const following = page.getByText("Text after the figure.", { exact: true });
  const followingY = (await following.boundingBox())!.y;
  await figure.getByRole("button", { name: en.motion_show, exact: true }).click();
  await expect(figure.getByRole("status")).toHaveText(en.motion_original_text);
  await expect(image).toBeHidden();
  await expect(fallback).toHaveCSS("visibility", "hidden");
  expect((await fallback.boundingBox())!.height).toBe(fallbackHeight);
  expect((await figure.locator("[data-translated-figure]").boundingBox())!.height).toBe(translationHeight);
  expect((await following.boundingBox())!.y).toBe(followingY);
  const moving = figure.locator("img").last();
  await expect(moving).toHaveAttribute("src", /^data:image\/webp;playback=/);
  expect((await moving.boundingBox())!.width).toBeCloseTo(imageWidth);
  await figure.getByRole("button", { name: en.motion_show_still, exact: true }).click();
  await expect(image).toHaveAttribute("src", still!);
  await expect(image).toBeVisible();
  await expect(fallback).toBeVisible();
  await expect(figure.getByRole("status")).toBeHidden();
  await page.reload();
  await expect(image).toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(image).toBeHidden();
  await expect(fallback).toHaveCSS("visibility", "hidden");
  expect((await fallback.boundingBox())!.height).toBe(fallbackHeight);
  expect((await figure.locator("[data-translated-figure]").boundingBox())!.height).toBe(translationHeight);
  expect((await following.boundingBox())!.y).toBe(followingY);
  await expect(figure.getByRole("status")).toHaveText(en.motion_original_text);
  await expect(image).toBeVisible();
  await expect(fallback).toBeVisible();
  await expect(image).toHaveAttribute("src", still!);
  await expect(figure.getByRole("status")).toBeHidden();
  const beforeSwitch = requests.length;
  await page.getByRole("link", { name: en.show_original, exact: true }).click();
  await expect(image).toHaveAttribute("src", fixture.posterUrl);
  await expect(figure.getByRole("button")).toHaveText(en.motion_show);
  await page.waitForTimeout(1400);
  expect(requests).toHaveLength(beforeSwitch);
  await expect(image).toBeVisible();
});

test("translation arrival preserves motion history across remounts", async ({ page }) => {
  test.skip(process.env.E2E_MOTION_FIXTURES !== "1" || process.env.FIGURE_TRANSLATION !== "1", "Requires motion fixtures and figure translation");
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "motion-figure.json"), "utf8"));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await useMember(page, "motion_figure_reader@example.com");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/t/${fixture.pendingId}/translations*`, async route => {
    if (route.request().postDataJSON()?.intent === "request") await gate;
    await route.continue().catch(() => {});
  });
  const requests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === fixture.url) requests.push(request.url()); });
  await page.goto(`/t/${fixture.pendingId}?lang=ja`);
  const body = page.locator("[data-reading-body]");
  const figure = body.locator("[data-motion-figure]").first(), image = figure.locator("img").first();
  await expect(body).toHaveAttribute("lang", "en");
  await expect(image).toBeHidden();
  await expect(image).toBeVisible();
  expect(requests).toHaveLength(1);
  // Track even cached playback, which a second HTTP request would miss.
  await page.evaluate(() => {
    document.documentElement.dataset.replayedMotion = "false";
    new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes].some(node => node instanceof Element && (node.matches('img[src^="data:image/webp"]') || node.querySelector('img[src^="data:image/webp"]'))))) document.documentElement.dataset.replayedMotion = "true";
    }).observe(document.body, { childList: true, subtree: true });
  });
  release();
  await expect(body).toHaveAttribute("lang", "ja");
  await expect(image).toHaveAttribute("src", /\.ja\.v\d+\.webp$/);
  await page.getByRole("link", { name: en.show_original, exact: true }).click();
  await expect(body).toHaveAttribute("lang", "en");
  await page.locator(".reading-lang-menu summary").click();
  await page.locator(".reading-lang-menu").getByRole("link", { name: /日本語/ }).click();
  await expect(body).toHaveAttribute("lang", "ja");
  await page.waitForTimeout(1400);
  await expect(image).toBeVisible();
  expect(requests).toHaveLength(1);
  await expect(page.locator("html")).toHaveAttribute("data-replayed-motion", "false");
});

test("zero-delay GIFs autoplay for a browser-adjusted cycle", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await useMember(page, "motion_prod@example.com");
  const uploaded = await page.request.post("/media", { headers: { origin: state().baseURL }, multipart: { image: { name: "zero-delay.gif", mimeType: "image/gif", buffer: (await motionImage("gif", 12, 160, 100, 0)).bytes } } });
  expect(uploaded.status()).toBe(201);
  const { url, posterUrl } = await uploaded.json();
  await page.goto("/t/new");
  await page.locator('textarea[name="body"]').fill(`[![Zero-delay diagram](${posterUrl})](${url})`);
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  const figure = page.locator("[data-reading-body] [data-motion-figure]").first(), image = figure.locator("img").first();
  await expect(figure).toHaveAttribute("data-motion-duration", "0");
  await expect(image).toBeHidden();
  await page.waitForTimeout(600);
  await expect(image).toBeHidden();
  await expect(image).toBeVisible();
  await expect(figure.getByRole("button")).toHaveText(en.motion_show);
});

test("automatic playback stops on request or reduced motion, and printing uses the still", async ({ page }) => {
  test.skip(process.env.E2E_MOTION_FIXTURES !== "1", "Requires motion fixtures");
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "motion-figure.json"), "utf8"));
  const watch = await watchCsp(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await useMember(page, "motion_figure_reader@example.com");
  const fetched: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === fixture.url) fetched.push(request.url()); });
  await page.goto(`/t/${fixture.id}`);
  const figure = page.locator("[data-reading-body] [data-motion-figure]").first();
  const still = figure.locator("img").first(), button = figure.getByRole("button");
  await expect(button).toHaveText(en.motion_show);
  await page.waitForTimeout(300);
  expect(fetched).toEqual([]);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(still).toBeHidden();
  await button.click();
  await expect(still).toBeVisible();
  await page.waitForTimeout(1400);
  expect(fetched).toHaveLength(1);
  await page.reload();
  await expect(still).toBeHidden();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(still).toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForTimeout(1400);
  await expect(still).toBeVisible();
  await button.click();
  await expect(still).toBeHidden();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(still).toBeHidden();
  await page.evaluate(() => {
    window.addEventListener("beforeprint", () => {
      document.documentElement.dataset.printedStill = String(!document.querySelector<HTMLImageElement>("[data-motion-figure] img")!.hidden);
    }, { once: true });
  });
  await page.pdf();
  await expect(page.locator("html")).toHaveAttribute("data-printed-still", "true");
  await expect(still).toBeVisible();
  expect(watch.violations).toEqual([]); expect(watch.pageErrors).toEqual([]);
});

for (const failure of ["http", "decode", "cancel"] as const) test(`failed or cancelled automatic motion preserves the still: ${failure}`, async ({ page }) => {
  test.skip(process.env.E2E_MOTION_FIXTURES !== "1", "Requires motion fixtures");
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "motion-figure.json"), "utf8"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await useMember(page, "motion_figure_reader@example.com");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**${fixture.url}`, async route => {
    if (failure === "cancel") { await gate; await route.continue().catch(() => {}); }
    else await route.fulfill({ status: failure === "http" ? 404 : 200, contentType: "image/webp", body: "invalid image" });
  });
  await page.goto(`/t/${fixture.id}`);
  const figure = page.locator("[data-reading-body] [data-motion-figure]").first();
  const still = figure.locator("img").first(), button = figure.getByRole("button");
  await expect(button).toHaveText(en.motion_show);
  const requested = page.waitForRequest(request => new URL(request.url()).pathname === fixture.url);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await requested;
  if (failure === "cancel") {
    await expect(button).toHaveText(en.motion_show_still);
    await button.click();
    release();
  }
  await expect(button).toHaveText(en.motion_show);
  await expect(still).toBeVisible();
  await expect(still).toHaveAttribute("src", fixture.posterUrl);
  await page.waitForTimeout(1400);
  await expect(still).toBeVisible();
  await expect(figure.locator("img")).toHaveCount(1);
});
