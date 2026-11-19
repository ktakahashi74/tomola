import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { enMessages as m, formatMessage, loginCodeFor, logSize, state, useMember, waitForClientRoute } from "./helpers";

test("an operator returns to member search and to a post after re-verifying", async ({ page }) => {
  const email = "reauth_operator@example.com";
  const destination = "/admin/roles?q=reauth_target";
  const clock = path.join(state().dir, "server-clock.txt");
  const previous = fs.readFileSync(clock, "utf8");
  const topic: { id: number } = JSON.parse(fs.readFileSync(path.join(state().dir, "reauth-topic.json"), "utf8"));
  const verify = async (returnTo: string) => {
    await expect(page).toHaveURL(url => url.pathname === "/login" && url.searchParams.get("reauth") === "moderation" && url.searchParams.get("next") === returnTo);
    await expect(page.getByText(formatMessage(m.reauth_for_moderation, { who: "@reauth_operator" }), { exact: true })).toBeVisible();
    const since = logSize();
    await page.getByRole("button", { name: m.reauth_submit, exact: true }).click();
    await page.getByLabel(m.login_code_label, { exact: true }).fill(await loginCodeFor(email, since));
    await page.getByRole("button", { name: m.login_code_submit, exact: true }).click();
    await expect(page).toHaveURL(returnTo);
    await waitForClientRoute(page);
  };
  try {
    await useMember(page, email, destination);
    await waitForClientRoute(page);
    const member = page.getByRole("listitem").filter({ hasText: "@reauth_target" });
    const suspend = member.getByRole("button", { name: m.mod_suspend, exact: true });
    const note = suspend.locator("xpath=ancestor::form").getByLabel(m.mod_note_short, { exact: true });
    await note.fill("Repeated unsolicited advertising.");
    fs.writeFileSync(clock, String(25 * 3_600_000));
    await suspend.click();
    await verify(destination);
    await expect(suspend).toBeVisible();
    await expect(note).toHaveValue("");

    const post = `/t/${topic.id}`;
    await page.goto(post);
    await waitForClientRoute(page);
    const panel = page.locator("summary").filter({ hasText: m.mod_panel_summary });
    await panel.click();
    await page.getByLabel(m.mod_note, { exact: true }).fill("Review the wording of this post.");
    const hide = page.getByRole("button", { name: m.mod_hide, exact: true });
    fs.writeFileSync(clock, String(50 * 3_600_000));
    await hide.click();
    await verify(`${post}#p-${topic.id}`);
    await panel.click();
    await expect(hide).toBeVisible();
    await expect(page.getByLabel(m.mod_note, { exact: true })).toHaveValue("");
  } finally {
    fs.writeFileSync(clock, previous);
  }
});
