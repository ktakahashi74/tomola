import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { clientHeaders, enMessages as m, logSize, magicLinkFor, state, useMember as signInAs, waitForClientRoute } from "./helpers";


test("a link opened where the login was not started gets one answer for everyone, and stays usable where it was", async ({ browser }) => {
  const starter = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.95.0.3") });
  const opened: string[] = [];
  let link: string;
  try {
    const page = await starter.newPage();
    await page.goto("/login");
    await waitForClientRoute(page);
    const since = logSize();
    await page.getByLabel(m.login_email, { exact: true }).fill("cfix_member@example.com");
    await page.getByRole("button", { name: m.login_submit, exact: true }).click();
    await expect(page.getByRole("heading", { name: m.login_code_heading, exact: true })).toBeVisible();
    link = await magicLinkFor("cfix_member@example.com", since);
    for (const [ip, member] of [["10.95.0.4", "cfix_member@example.com"], ["10.95.0.5", "cfix_other@example.com"], ["10.95.0.6", null]] as const) {
      const other = await browser.newContext({ extraHTTPHeaders: clientHeaders(ip) });
      try {
        const p = await other.newPage();
        if (member) await signInAs(p, member);
        await p.goto(link);
        await expect(p.getByRole("heading", { name: m.confirm_unusable_heading, exact: true })).toBeVisible();
        await expect(p.getByText(m.confirm_invalid_hint, { exact: true })).toBeVisible();
        await expect(p.getByLabel(m.login_email, { exact: true })).toBeVisible();
        await expect(p.getByRole("link", { name: m.confirm_home, exact: true })).toBeVisible();
        expect(new URL(p.url()).pathname).toBe("/auth/confirm");
        const text = await p.locator("main").innerText();
        expect(text).not.toContain("cfix_");
        opened.push(text);
        if (member === "cfix_member@example.com") {
          await p.getByRole("link", { name: m.confirm_home, exact: true }).click();
          await expect(p).toHaveURL(new URL("/", state().baseURL).href);
        }
      } finally { await other.close(); }
    }
    expect(new Set(opened).size).toBe(1);
    // The link was not used up: the browser that started the login can still press its button.
    await page.goto(link);
    await expect(page.getByRole("button", { name: m.confirm_submit, exact: true })).toBeVisible();
  } finally { await starter.close(); }
});
