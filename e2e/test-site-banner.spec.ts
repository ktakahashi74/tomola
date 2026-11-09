import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { enMessages, jaMessages, state, useMember, waitForClientRoute } from "./helpers";

const enabled = process.env.TOMOLA_SITE_STAGE === "test";
const fixture = () => JSON.parse(fs.readFileSync(path.join(state().dir, "test-site-banner.json"), "utf8")) as { topic: number; invite: string };

for (const [locale, messages] of [["en", enMessages], ["ja", jaMessages]] as const) {
  test(`test-site notice covers guest and error HTML in ${locale}`, async ({ browser }, info) => {
    const context = await browser.newContext({ locale: locale === "ja" ? "ja-JP" : "en-US" });
    try {
      const page = await context.newPage();
      const hydrationErrors: string[] = [];
      page.on("pageerror", error => hydrationErrors.push(error.message));
      page.on("console", message => {
        if (message.type() === "error" && /hydration|hydrating|did not match|Minified React error/i.test(message.text())) hydrationErrors.push(message.text());
      });
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        for (const route of ["/login", `/invite/${fixture().invite}`, "/connect", "/terms", "/test-site-banner-missing", ...(info.project.metadata.publicReading ? [`/t/${fixture().topic}`, "/t/999999999"] : [])]) {
          const response = await page.goto(route);
          const html = await response!.text();
          if (enabled) {
            // Count serialized copies separately from the visible notice.
            // Early routing errors can bypass the root loader altogether.
            const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g)?.join("") ?? "";
            const copies = scripts.split(messages.test_site_notice).length - 1;
            expect(copies, route).toBeLessThanOrEqual(1);
            if (route === "/login") expect(copies).toBe(1);
          } else {
            expect(html, route).not.toContain(messages.test_site_notice);
          }
          await waitForClientRoute(page);
          const notice = page.locator("[data-test-site-notice]");
          await expect(notice).toHaveCount(enabled ? 1 : 0);
          if (enabled) {
            await expect(notice).toHaveText(messages.test_site_notice);
            await expect(notice).toHaveAttribute("role", "note");
            await expect(page.locator("body > :first-child")).toHaveAttribute("data-test-site-notice", "");
            await expect(notice.locator("button, [aria-live], a")).toHaveCount(0);
            const geometry = await notice.evaluate(element => {
              const range = document.createRange(); range.selectNodeContents(element);
              const lines = new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
              const box = element.getBoundingClientRect();
              return { lines, fits: box.left >= 0 && box.right <= innerWidth && element.scrollWidth <= element.clientWidth };
            });
            expect(geometry.fits).toBe(true);
            expect(geometry.lines).toBeGreaterThan(0);
            expect(geometry.lines).toBeLessThanOrEqual(2);
            if (process.env.E2E_EVIDENCE_DIR && route === "/login") {
              fs.mkdirSync(process.env.E2E_EVIDENCE_DIR, { recursive: true });
              await page.screenshot({ path: path.join(process.env.E2E_EVIDENCE_DIR, `site-banner-${locale}-${width}.png`), fullPage: true });
            }
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
      }
      // Client navigation preserves the same single notice.
      await page.goto("/login"); await waitForClientRoute(page);
      await page.locator("footer").getByRole("link", { name: messages.footer_connect, exact: true }).click();
      await expect(page).toHaveURL(/\/connect$/);
      await expect(page.locator("[data-test-site-notice]")).toHaveCount(enabled ? 1 : 0);
      expect(hydrationErrors).toEqual([]);
    } finally { await context.close(); }
  });
}

test("test-site notice covers the writing shell", async ({ page }) => {
  await useMember(page, "site_banner_writer@example.com", "/t/new");
  await waitForClientRoute(page);
  const notice = page.locator("[data-test-site-notice]");
  await expect(notice).toHaveCount(enabled ? 1 : 0);
  if (enabled) await expect(notice).toHaveText(enMessages.test_site_notice);
});

test("test-site identification stays out of Markdown, API and MCP responses", async ({ request }, info) => {
  const resources: Array<[string, number]> = [["/connect.md", 200], ["/llms.txt", 200], ["/api/openapi.json", 200], ["/api/auth/get-session", 404]];
  if (info.project.metadata.publicReading) resources.push([`/t/${fixture().topic}.md`, 200]);
  for (const [route, status] of resources) {
    const response = await request.get(route);
    expect(response.status(), route).toBe(status);
    expect(response.headers()["content-type"]).not.toContain("text/html");
    const body = await response.text();
    for (const forbidden of [enMessages.test_site_notice, jaMessages.test_site_notice, "data-test-site-notice"]) expect(body).not.toContain(forbidden);
  }
  const response = await request.post("/mcp/public", {
    headers: { accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "Test site fixture", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } },
  });
  expect(response.status()).toBe(info.project.metadata.publicReading ? 200 : 404);
  const body = await response.text();
  for (const forbidden of [enMessages.test_site_notice, jaMessages.test_site_notice, "data-test-site-notice"]) expect(body).not.toContain(forbidden);
});
