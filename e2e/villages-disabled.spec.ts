import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { state, useMember } from "./helpers";
import { VILLAGE_MEMBER_FIXTURES } from "./member-fixtures";

test("private startup does not add village fixtures", () => {
  expect(fs.existsSync(path.join(state().dir, "villages.json"))).toBe(false);
  for (const member of VILLAGE_MEMBER_FIXTURES) expect(fs.existsSync(path.join(state().dir, "members", `${member.email}.json`))).toBe(false);
});

test("closed villages render the same application 404 as an unknown route", async ({ page }) => {
  const missing = await page.goto("/unknown-village-fixture");
  expect(missing?.status()).toBe(404);
  const main = await page.locator("main").innerText();
  const title = await page.title();
  const footer = await page.locator("footer").innerText();
  const urls = ["/villages", "/villages.md", "/villages.txt", "/villages/new", "/v/en", "/v/en.md", "/v/en.txt", "/mod/village/closed-place", "/settings/chat"];
  for (const signedIn of [false, true]) {
    if (signedIn) await useMember(page, "navigation_member@example.com");
    for (const url of urls) {
      const response = await page.goto(url);
      expect(response?.status()).toBe(404);
      expect(response?.headers()["content-type"]).toContain("text/html");
      expect(await page.locator("main").innerText()).toBe(main);
      expect(await page.title()).toBe(title);
      expect(await page.locator("footer").innerText()).toBe(footer);
      const post = await page.request.post(url, { headers: { Origin: new URL(page.url()).origin }, ...(url === "/villages/new" ? { form: { slug: "never-created", name: "Never created", description: "", kind: "open" } } : {}), maxRedirects: 0 });
      expect(post.status()).toBe(404);
    }
  }
});
test("disabled village chat has ordinary missing-route responses before login", async ({ page }) => {
  const response = await page.request.get("/v/en/chat.data");
  expect(response.status()).toBe(404);
  expect(await response.text()).not.toContain("data-chat-message");
  const receipt = await page.request.post("/v/en/chat/read", { headers: { Origin: state().baseURL }, form: { intent: "read", seq: "1" }, maxRedirects: 0 });
  expect(receipt.status()).toBe(404);

});
