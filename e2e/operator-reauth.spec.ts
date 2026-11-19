import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { enMessages as m, loginCodeFor, logSize, state, useMember, waitForClientRoute } from "./helpers";

test("an operator returns to member search after re-verifying to suspend a member", async ({ page }) => {
  const email = "reauth_operator@example.com";
  const destination = "/admin/roles?q=reauth_target";
  const clock = path.join(state().dir, "server-clock.txt");
  const previous = fs.readFileSync(clock, "utf8");
  try {
    await useMember(page, email, destination);
    await waitForClientRoute(page);
    const member = page.getByRole("listitem").filter({ hasText: "@reauth_target" });
    const suspend = member.getByRole("button", { name: m.mod_suspend, exact: true });
    const note = suspend.locator("xpath=ancestor::form").getByLabel(m.mod_note_short, { exact: true });
    await note.fill("Repeated unsolicited advertising.");
    fs.writeFileSync(clock, String(25 * 3_600_000));
    await suspend.click();
    await expect(page).toHaveURL(url => url.pathname === "/login" && url.searchParams.get("reauth") === "1" && url.searchParams.get("next") === destination);

    const since = logSize();
    await page.getByRole("button", { name: m.reauth_submit, exact: true }).click();
    await page.getByLabel(m.login_code_label, { exact: true }).fill(await loginCodeFor(email, since));
    await page.getByRole("button", { name: m.login_code_submit, exact: true }).click();
    await expect(page).toHaveURL(destination);
    await waitForClientRoute(page);

    await expect(suspend).toBeVisible();
    await expect(note).toHaveValue("");
  } finally {
    fs.writeFileSync(clock, previous);
  }
});
