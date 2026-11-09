import { HELD_MARKDOWN } from "../tests/helpers/markdown-fixture";
import fs from "node:fs";
import path from "node:path";
import { test } from "./editor-fixture";
import { expect } from "@playwright/test";
import { enMessages as en, useMember, waitForClientRoute, waitForFormReady, state } from "./helpers";

// The test worker names each start marker "<input>.<thread>.<run>", so match by the input's prefix.
const startedMarkers = (value: string) => {
  const directory = path.join(state().dir, "markdown-started");
  const prefix = `${value.replace(/[^a-z0-9_-]/gi, "_").slice(0, 100) || "empty"}.`;
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.startsWith(prefix)).map(name => path.join(directory, name)) : [];
};

// Exercise the server-rendered POST response, including its internal loader.
test("busy reading stays stable and a native reply keeps its input", async ({ page, browser }) => {
  await useMember(page, "plain_member@example.com");
  const original = `An **ordinary** titleless topic ${Date.now()}.`;
  const created = await page.request.post("/t/new", { form: { body: original, lang: "en" }, headers: { origin: state().baseURL }, maxRedirects: 0 });
  expect(created.status()).toBe(302);
  const destination = created.headers().location;
  const context = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
  const native = await context.newPage();
  // Keep the probe distinct from other previews so a cached result cannot bypass the busy worker.
  const heldBody = `${HELD_MARKDOWN} Native`;
  const held = path.join(state().dir, "markdown-hold");
  for (const marker of startedMarkers(heldBody)) fs.rmSync(marker, { force: true });
  fs.writeFileSync(held, "hold");
  const preview = page.request.post("/preview", { form: { body: heldBody, lang: "en" }, headers: { origin: state().baseURL } }).then(response => response.status(), () => null);
  try {
    await expect.poll(() => startedMarkers(heldBody).length > 0).toBe(true);
    const busyPreview = await page.request.post("/preview", { form: { body: `Ordinary preview while occupied ${Date.now()}.`, lang: "en" }, headers: { origin: state().baseURL } });
    expect(busyPreview.status()).toBe(503);
    expect(busyPreview.headers()["retry-after"]).toBe("1");
    expect(await busyPreview.json()).toMatchObject({ error: "rate_limited" });
    const sourceView = new URL(destination, state().baseURL);
    sourceView.searchParams.set("orig", sourceView.pathname.split("/").at(-1)!);
    const reads: string[] = [];
    page.on("request", request => { if (request.method() === "GET" && new URL(request.url()).pathname.endsWith(".data")) reads.push(request.url()); });
    expect((await page.goto(sourceView.href))?.status()).toBe(200);
    await waitForClientRoute(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(original);
    // Observe the busy fallback after hydration; it must not start a retry loop.
    await page.waitForTimeout(500);
    expect(reads).toEqual([]);
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
