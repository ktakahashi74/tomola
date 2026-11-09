import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { formatMessage, captureScreenshot, useMember, clientHeaders, enMessages as en, state  } from "./helpers";

test.describe.configure({ mode: "serial" });

let context: BrowserContext, page: Page, png: Buffer, topicURL: string;
const screenDir = path.join(process.cwd(), ".data/media/screenshots");
test.beforeAll(async ({ browser }) => {
  fs.mkdirSync(screenDir, { recursive: true });
  png = await sharp({ create: { width: 2400, height: 1200, channels: 4, background: { r: 60, g: 110, b: 150, alpha: 0.8 } } }).png().toBuffer();
  const fixture = JSON.parse(fs.readFileSync(`${state().dir}/media.json`, "utf8"));
  context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("192.0.2.239") });
  page = await context.newPage();
  await useMember(page, "media_uploader@example.com");
});
test.afterAll(async () => context?.close());
const button = () => page.getByRole("button", { name: en.media_insert, exact: true });
const body = () => page.locator('textarea[name="body"]');
async function choose(buffer = png, name = "diagram.png", mimeType = "image/png") {
  const chooser = page.waitForEvent("filechooser"); await button().click();
  await (await chooser).setFiles({ name, mimeType, buffer });
}
for (const width of [1366, 390]) {
  test(`file selection, insertion, preview and posted image at width ${width}`, async () => {
    await page.setViewportSize({ width, height: 950 }); await page.goto("/t/new");
    await expect(button()).toBeVisible();
    await page.locator('input[name="title"]').fill(`Media diagram ${width}`);
    await body().fill("Before.\n\nAfter.");
    await body().evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(9, 9); });
    await captureScreenshot(page, { path: path.join(screenDir, `new-${width}.png`), fullPage: true }, "e2e-media");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/media", async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
    await choose(); await expect(page.getByRole("status").filter({ hasText: en.media_uploading })).toBeVisible();
    await captureScreenshot(page, { path: path.join(screenDir, `uploading-${width}.png`), fullPage: true }, "e2e-media");
    await body().evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(9, 9); });
    release();
    await expect(body()).toHaveValue(new RegExp(`^Before\\.\\n\\n!\\[${en.media_alt_placeholder}\\]\\(/media/[a-f0-9]{64}-2000x1000\\.webp\\)After\\.$`));
    const selection = await body().evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
    expect(selection).toBe(en.media_alt_placeholder);
    await page.unroute("**/media");
    await captureScreenshot(page, { path: path.join(screenDir, `inserted-${width}.png`), fullPage: true }, "e2e-media");
    await page.keyboard.insertText("A synthetic diagram");
    await page.getByRole("button", { name: en.preview, exact: true }).click();
    const preview = page.locator('main img[alt="A synthetic diagram"]'); await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute("width", "2000");
    await expect(preview).toHaveAttribute("height", "1000");
    await captureScreenshot(page, { path: path.join(screenDir, `preview-${width}.png`), fullPage: true }, "e2e-media");
    await page.getByRole("button", { name: en.submit_post, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/\d+/); topicURL = new URL(page.url()).origin + new URL(page.url()).pathname;
    const image = page.locator('main img[alt="A synthetic diagram"]').first();
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(2000);
    const rect = await image.boundingBox(); expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
    expect(Math.abs(rect!.width / rect!.height - 2)).toBeLessThan(0.01);
    await expect(button()).toHaveCount(0);
    await captureScreenshot(page, { path: path.join(screenDir, `topic-${width}.png`), fullPage: true }, "e2e-media");
    const src = await image.getAttribute("src");
    const response = await context.request.get(src!); expect(response.status()).toBe(200);
    expect(response.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(response.headers()["cache-control"]).toBe("private, max-age=86400");
    expect((await context.request.get(src!.replace("2000x1000", "1x1"))).status()).toBe(404);
    const guest = await context.browser()!.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("192.0.2.240") });
    try {
      const guestImage = await guest.request.get(src!);
      expect(guestImage.status()).toBe(process.env.E2E_PUBLIC_READING === "1" ? 200 : 404);
      if (process.env.E2E_PUBLIC_READING === "1") {
        const guestPage = await guest.newPage(); await guestPage.goto(topicURL); await expect(guestPage.locator('main img[alt="A synthetic diagram"]').first()).toBeVisible();
        expect(guestImage.headers()["cache-control"]).toBe("private, max-age=86400");
      }
    } finally { await guest.close(); }
  });
}
test("paste and drop use the upload endpoint; invalid contents leave the body untouched", async () => {
  await page.goto("/t/new"); await expect(button()).toBeVisible(); await body().fill("Unchanged prose.");
  for (const event of ["paste", "drop"]) {
    const before = await body().inputValue();
    await body().evaluate((el: HTMLTextAreaElement, args) => {
      el.focus(); el.setSelectionRange(el.value.length, el.value.length);
      const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(args.bytes), c => c.charCodeAt(0))], "diagram.png", { type: "image/png" }));
      el.dispatchEvent(args.event === "paste" ? new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }) : new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, { bytes: png.toString("base64"), event });
    await expect.poll(() => body().inputValue()).toContain(`${before}![${en.media_alt_placeholder}](/media/`);
  }
  const unchanged = await body().inputValue();
  await choose(Buffer.from("<svg></svg>"), "pretend.png", "image/png");
  await expect(page.getByRole("alert")).toHaveText(en.media_error_type); await expect(body()).toHaveValue(unchanged);
});
test("a real paste containing text and an image keeps the default text insertion without uploading", async () => {
  await page.goto("/t/new"); await expect(button()).toBeVisible();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await body().fill("Before. "); await body().focus(); await page.keyboard.press("End");
  let uploads = 0;
  const count = (request: import("@playwright/test").Request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/media") uploads++; };
  page.on("request", count);
  try {
    await page.evaluate(async bytes => {
      const image = Uint8Array.from(atob(bytes), c => c.charCodeAt(0));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob(["Pasted text."], { type: "text/plain" }), "text/html": new Blob(["<p>Pasted text.</p>"], { type: "text/html" }), "image/png": new Blob([image], { type: "image/png" }) })]);
      const field = document.querySelector<HTMLTextAreaElement>('textarea[name="body"]')!;
      field.addEventListener("paste", event => { field.dataset.pasteTypes = JSON.stringify(event.clipboardData?.types); field.dataset.pasteFiles = String(event.clipboardData?.files.length); }, { once: true });
    }, png.toString("base64"));
    await page.keyboard.press("Control+V");
    await expect(body()).toHaveValue("Before. Pasted text.");
    await expect(body()).toHaveAttribute("data-paste-files", "1");
    await expect(body()).toHaveAttribute("data-paste-types", /text\/plain/);
    expect(uploads).toBe(0);
    // An HTML-only clipboard also belongs to native paste, even if it includes an image file.
    const prevented = await body().evaluate((field: HTMLTextAreaElement, bytes) => {
      const transfer = new DataTransfer(); transfer.setData("text/html", "<p>More text.</p>");
      transfer.items.add(new File([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], "diagram.png", { type: "image/png" }));
      const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }); field.dispatchEvent(event);
      return event.defaultPrevented;
    }, png.toString("base64"));
    expect(prevented).toBe(false); expect(uploads).toBe(0);
  } finally { page.off("request", count); }
});
for (const mode of ["cursor", "selection", "unfocused"] as const) {
  test(`finishing an upload inserts at the current ${mode} without removing typed text`, async () => {
    await page.goto("/t/new"); await expect(button()).toBeVisible(); await body().fill("First. Last.");
    await body().evaluate((field: HTMLTextAreaElement) => { field.focus(); field.setSelectionRange(0, 6); });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/media", async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
    try {
      await choose(); await expect(page.getByRole("status").filter({ hasText: en.media_uploading })).toBeVisible();
      await body().focus(); await page.keyboard.press("End"); await page.keyboard.insertText(" Typed while uploading.");
      const before = await body().inputValue();
      const insertion = mode === "unfocused" ? before.length : mode === "selection" ? 6 : 2;
      await body().evaluate((field: HTMLTextAreaElement, mode) => { field.focus(); field.setSelectionRange(mode === "selection" ? 1 : 2, mode === "selection" ? 6 : 2); }, mode);
      if (mode === "unfocused") await page.locator('input[name="title"]').focus();
      release();
      await expect.poll(() => body().inputValue()).toContain("![");
      const after = await body().inputValue(), inserted = after.slice(insertion, after.length - (before.length - insertion));
      expect(inserted).toMatch(new RegExp(`^!\\[${en.media_alt_placeholder}\\]\\(/media/[a-f0-9]{64}-2000x1000\\.webp\\)$`));
      expect(after).toBe(before.slice(0, insertion) + inserted + before.slice(insertion));
      expect(after).toContain("Typed while uploading.");
      expect(await body().evaluate((field: HTMLTextAreaElement) => field.value.slice(field.selectionStart, field.selectionEnd))).toBe(en.media_alt_placeholder);
    } finally { release(); await page.unroute("**/media"); }
  });
}
test("topic editing has the uploader, replies and JavaScript-free forms do not", async () => {
  await page.goto(`${topicURL}/edit`); await expect(button()).toBeVisible();
  const unchanged = await body().inputValue(); await body().evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await choose(); await expect.poll(() => body().inputValue()).not.toBe(unchanged);
  await page.getByRole("button", { name: en.save_changes, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+(?:\?sl=[\w-]+)?$/); await expect(button()).toHaveCount(0);
  const noJs = await context.browser()!.newContext({ javaScriptEnabled: false, storageState: await context.storageState(), extraHTTPHeaders: clientHeaders("192.0.2.241") });
  try {
    const native = await noJs.newPage(); await native.goto(new URL("/t/new", state().baseURL).href);
    await expect(native.locator('textarea[name="body"]')).toBeVisible(); await expect(native.getByRole("button", { name: en.media_insert, exact: true })).toHaveCount(0);
  } finally { await noJs.close(); }
});
test("malformed HTTP uploads leave the server available", async () => {
  const malformed = await context.request.post("/media", { headers: { Origin: state().baseURL, "Content-Type": "multipart/form-data; boundary=a" }, data: "--a\r\nunfinished" });
  expect(malformed.status()).toBe(400);
  expect((await context.request.get("/t/new")).status()).toBe(200);

});

test("own image deletion and private uploads", async () => {
  const bytes = await sharp({ create: { width: 17, height: 19, channels: 3, background: "#13579b" } }).png().toBuffer();
  const upload = await context.request.post("/media", { headers: { Origin: state().baseURL }, multipart: { image: { name: "private.png", mimeType: "image/png", buffer: bytes } } });
  expect(upload.status()).toBe(201);
  const { url } = await upload.json();
  const guest = await context.browser()!.newContext({ extraHTTPHeaders: clientHeaders("192.0.2.241") });
  try { expect((await guest.request.get(url)).status()).toBe(404); } finally { await guest.close(); }
  await page.goto("/t/new");
  await expect(button()).toBeVisible();
  await page.locator('input[name="title"]').fill("Image deletion confirmation");
  await body().fill(`This image will be removed.\n\n![picture](${url})`);
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/(\d+)\?posted=\1$/);
  await page.goto("/settings/media");
  expect((await context.request.get("/settings/media.data")).headers()["cache-control"]).toBe("private, no-store");
  expect((await context.request.get("/_.data")).headers()["cache-control"]).toBe("private, no-store");
  const item = page.locator("li").filter({ has: page.locator(`img[src="${url}"]`) });
  await expect(item).toBeVisible();
  await expect(item.getByText(formatMessage(en.media_used_posts, { count: 1 }), { exact: true })).toBeVisible();
  await item.getByLabel(en.media_delete_confirm, { exact: true }).check();
  await item.getByRole("button", { name: en.media_delete, exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: en.media_deleted })).toBeVisible();
  expect((await context.request.get(url)).status()).toBe(404);
  const again = await context.request.post("/media", { headers: { Origin: state().baseURL }, multipart: { image: { name: "private-again.png", mimeType: "image/png", buffer: bytes } } });
  expect(again.status()).toBe(201);
  const replacement = await again.json();
  expect(replacement.url).not.toBe(url);
  expect((await context.request.get(url)).status()).toBe(404);
  expect((await context.request.get(replacement.url)).status()).toBe(200);
});
