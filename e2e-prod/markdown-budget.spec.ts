import { SLOW_MARKDOWN, HELD_MARKDOWN } from "../tests/helpers/markdown-fixture";
import path from "node:path";
import fs from "node:fs";
import { test, expect, useMember, state, waitForClientRoute } from "./helpers";
import { enMessages as en, waitForFormReady } from "../e2e/helpers";

// The test worker names each start marker "<input>.<thread>.<run>", so match by the input's prefix.
const startedMarkers = (value: string) => {
  const directory = path.join(state().dir, "markdown-started");
  const prefix = `${value.replace(/[^a-z0-9_-]/gi, "_").slice(0, 100) || "empty"}.`;
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.startsWith(prefix)).map(name => path.join(directory, name)) : [];
};

test("production workers refuse costly Markdown while health checks and normal posts work", async ({ page }) => {
  await useMember(page, "editor_default_prod@example.com");
  await page.goto("/t/new");
  await waitForClientRoute(page);
  const body = page.locator('textarea[name="body"]');
  await waitForFormReady(page.locator("form", { has: body }));
  const source = SLOW_MARKDOWN.padEnd(50_000, " ");
  await body.fill(source);
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  const start = performance.now();
  const health = await page.request.get("/healthz");
  expect(health.status()).toBe(200);
  expect(performance.now() - start).toBeLessThan(10_000);
  await expect(page.getByText(en.error_body_too_complex, { exact: true })).toBeVisible();
  await expect(body).toHaveValue(source);
  await body.fill("Ordinary **Markdown**, with $x^2$.\n");
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+(?:\?.*)?$/);
  await expect(page.locator("[data-reading-body]").first()).toContainText("Ordinary Markdown");
  expect(fs.readFileSync(state().serverLog, "utf8")).toContain("[markdown] CPU budget");
});

test("production keeps the editor when a worker is busy", async ({ page }) => {
  await useMember(page, "editor_default_prod@example.com");
  await page.goto("/t/new"); await waitForClientRoute(page);
  const body = page.locator('textarea[name="body"]');
  await waitForFormReady(page.locator("form", { has: body }));
  const held = path.join(state().dir, "markdown-hold");
  for (const marker of startedMarkers(HELD_MARKDOWN)) fs.rmSync(marker, { force: true });
  fs.writeFileSync(held, "hold");
  const preview = page.request.post("/preview", { form: { body: HELD_MARKDOWN, lang: "en" }, headers: { origin: state().baseURL } }).then(response => response.status(), () => null);
  try {
    await expect.poll(() => startedMarkers(HELD_MARKDOWN).length > 0).toBe(true);
    const source = "Keep this **ordinary** production post."; await body.fill(source);
    const submitted = page.waitForResponse(response => response.request().method() === "POST" && response.url().includes("/t/new"));
    await page.getByRole("button", { name: en.submit_post, exact: true }).click();
    expect((await submitted).status()).toBe(503);
    await expect(page.getByText(en.error_busy, { exact: true })).toBeVisible();
    await expect(body).toHaveValue(source);
  } finally { fs.rmSync(held, { force: true }); await preview; }
});

// Exercise the server-rendered POST response, including its internal loader.
test("a native busy reply keeps a titleless topic and the submitted text", async ({ page, browser }) => {
  await useMember(page, "editor_default_prod@example.com");
  const created = await page.request.post("/t/new", { form: { body: `An ordinary titleless topic ${Date.now()}.`, lang: "en" }, headers: { origin: state().baseURL }, maxRedirects: 0 });
  expect(created.status()).toBe(302);
  const destination = created.headers().location;
  const context = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
  const native = await context.newPage();
  // A new value avoids the successful preview cached by the preceding test.
  const heldBody = `${HELD_MARKDOWN} Native`;
  const held = path.join(state().dir, "markdown-hold");
  for (const marker of startedMarkers(heldBody)) fs.rmSync(marker, { force: true });
  fs.writeFileSync(held, "hold");
  const preview = page.request.post("/preview", { form: { body: heldBody, lang: "en" }, headers: { origin: state().baseURL } }).then(response => response.status(), () => null);
  try {
    await expect.poll(() => startedMarkers(heldBody).length > 0).toBe(true);
    expect((await native.goto(new URL(destination, state().baseURL).href))?.status()).toBe(200);
    const body = native.locator('textarea[name="body"]');
    const source = "Keep my **native reply**."; await body.fill(source);
    const submitted = native.waitForResponse(response => response.request().method() === "POST");
    await native.getByRole("button", { name: en.submit_reply, exact: true }).click();
    expect((await submitted).status()).toBe(503);
    await expect(native.getByText(en.error_busy, { exact: true })).toBeVisible();
    await expect(body).toHaveValue(source);
    await expect(native.getByRole("heading", { name: en.reply_write_title, exact: true })).toBeVisible();
  } finally { fs.rmSync(held, { force: true }); await preview; await context.close(); }
});
