import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, enMessages as m, useMember, waitForClientRoute, openVillageManagement } from "./helpers";

async function evidence(page: Page, label: string) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureScreenshot(page, { path: `${label}-${width}.png`, animations: "disabled", fullPage: true }, "village-moderation");
  }
}

test("reports a village, corrects it, notifies its owner and reverses the correction after independent review", async ({ page }) => {
  const original = "A village for independent review";
  const corrected = "Corrected village for review";
  await useMember(page, "vr_owner@example.com", "/v/village-review-journey");
  await expect(page).toHaveURL(/\/v\/village-review-journey$/);

  await useMember(page, "vr_reporter@example.com", "/v/village-review-journey"); await waitForClientRoute(page);
  await page.getByText(m.village_report, { exact: true }).click();
  await page.getByLabel(m.flag_note, { exact: true }).fill("Reported village details need review.");
  await evidence(page, "report");
  await page.getByRole("button", { name: m.flag_submit, exact: true }).click();
  await expect(page.getByText(m.village_reported, { exact: true })).toBeVisible();
  expect((await page.request.post("/v/village-review-journey", { form: { intent: "flag", reason: "spam" }, headers: { Origin: new URL(page.url()).origin } })).status()).toBe(409);

  await useMember(page, "vr_operator@example.com", "/v/village-review-journey");
  await expect(page.getByText(m.village_edit, { exact: true })).toHaveCount(0);
  const unrecorded = await page.request.post("/v/village-review-journey", { form: { intent: "edit", name: "Unrecorded edit", description: "" }, headers: { Origin: new URL(page.url()).origin } });
  expect(unrecorded.status()).toBe(403);
  await page.goto("/mod"); await waitForClientRoute(page);
  const card = page.locator('section[id^="v-report-"]').filter({ hasText: original });
  await expect(card.getByText(m.village_report_snapshot, { exact: true })).toBeVisible();
  await expect(card).not.toContainText("vr_reporter");
  await card.getByLabel(m.village_name_field, { exact: true }).fill(corrected);
  await card.getByLabel(m.village_slug_field, { exact: true }).fill("village-review-corrected");
  await card.getByLabel(m.village_description_field, { exact: true }).fill("Corrected public description.");
  await card.getByLabel(m.village_mod_note, { exact: true }).fill("Explanation of the correction.");
  await evidence(page, "queue");
  await card.getByRole("button", { name: m.village_mod_fix, exact: true }).click();
  await expect(card).toHaveCount(0);
  expect((await page.request.get("/v/village-review-journey")).status()).toBe(404);

  await useMember(page, "vr_owner@example.com", "/notifications"); await waitForClientRoute(page);
  await expect(page.locator("main")).toContainText(m.notification_moderation_fix_village);
  await page.getByRole("link", { name: m.notification_appeal, exact: true }).click();
  await expect(page).toHaveURL(/\/appeal\/\d+$/);
  await expect(page.locator("main")).toContainText(original);
  await expect(page.locator("main")).toContainText(corrected);
  await page.getByLabel(m.appeal_text, { exact: true }).fill("Please reconsider the village correction.");
  await evidence(page, "appeal");
  await page.getByRole("button", { name: m.appeal_submit, exact: true }).click();
  await expect(page.getByText(m.appeal_status_open, { exact: true })).toBeVisible();

  await useMember(page, "vr_operator@example.com", "/mod/appeals");
  await expect(page.locator('section[id^="a-"]').filter({ hasText: "vr_owner" })).toHaveCount(0);
  await useMember(page, "vr_reviewer@example.com", "/mod/appeals"); await waitForClientRoute(page);
  const review = page.locator('section[id^="a-"]').filter({ hasText: "vr_owner" });
  await review.getByLabel(m.mod_appeals_note, { exact: true }).fill("Independent review accepts the owner's appeal.");
  await evidence(page, "review");
  await review.getByRole("button", { name: m.mod_appeals_overturn, exact: true }).click();
  await expect(page.getByText(m.mod_appeals_done_overturned, { exact: true })).toBeVisible();
  await page.goto("/v/village-review-journey");
  await expect(page.getByRole("heading", { name: original, exact: true })).toBeVisible();
  expect((await page.request.get("/v/village-review-corrected")).status()).toBe(404);
  await page.goto("/moderation");
  await expect(page.getByRole("cell", { name: m.log_action_fix_village, exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: m.log_action_unfix_village, exact: true })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Explanation of the correction.");
  const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: m.log_action_unfix_village, exact: true }) });
  await expect(row.getByRole("link", { name: original, exact: true })).toHaveAttribute("href", "/v/village-review-journey");
  await evidence(page, "public-log");
});

test("moderates without a report and refreshes all fields after a stale form is rejected", async ({ page, browser }) => {
  const slug = "village-direct-review", changedSlug = "village-direct-corrected";
  const ownerContext = await browser.newContext({ locale: "en-US" });
  const owner = await ownerContext.newPage();
  try {
    await useMember(owner, "vr_owner@example.com", `/v/${slug}`);
    await expect(owner).toHaveURL(new RegExp(`/v/${slug}$`));

    await useMember(page, "vr_operator@example.com");
    await page.goto(`/v/${slug}`); await waitForClientRoute(page);
    await page.getByRole("link", { name: m.village_mod_link, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/mod/village/${slug}$`));
    await expect(page.getByRole("button", { name: m.mod_dismiss, exact: true })).toHaveCount(0);
    const oldVersion = await page.locator('input[name="villageVersion"]').inputValue();
    await page.getByLabel(m.village_slug_field, { exact: true }).fill(changedSlug);
    await page.getByLabel(m.village_mod_note, { exact: true }).fill("Direct correction of the slug");

    await openVillageManagement(owner);
    await owner.getByText(m.village_edit, { exact: true }).click();
    await owner.getByLabel(m.village_name_field, { exact: true }).fill("Owner's latest name");
    await owner.getByLabel(m.village_description_field, { exact: true }).fill("Owner's latest description");
    await owner.getByRole("button", { name: m.save_changes, exact: true }).click();
    await expect(owner.getByRole("heading", { name: "Owner's latest name", exact: true })).toBeVisible();
    await expect(page.getByLabel(m.village_name_field, { exact: true })).toHaveValue("Original direct village");
    const rejected = page.waitForResponse(r => r.request().method() === "POST" && r.url().includes(`/mod/village/${slug}`));
    await page.getByRole("button", { name: m.village_mod_fix, exact: true }).click();
    expect((await rejected).status()).toBe(409);
    await expect(page.getByRole("alert")).toHaveText(m.village_mod_stale);
    await expect(page.getByLabel(m.village_name_field, { exact: true })).toHaveValue("Owner's latest name");
    await expect(page.getByLabel(m.village_description_field, { exact: true })).toHaveValue("Owner's latest description");
    await expect(page.getByLabel(m.village_slug_field, { exact: true })).toHaveValue(slug);
    await expect(page.locator('input[name="villageVersion"]')).not.toHaveValue(oldVersion);
    await evidence(page, "direct-stale-form");

    await page.getByLabel(m.village_slug_field, { exact: true }).fill(changedSlug);
    await page.getByLabel(m.village_mod_note, { exact: true }).fill("Direct correction of the slug after rereading");
    await page.getByRole("button", { name: m.village_mod_fix, exact: true }).click();
    await expect(page).toHaveURL(/\/mod$/);
    await owner.goto(`/v/${changedSlug}`);
    await expect(owner.getByRole("heading", { name: "Owner's latest name", exact: true })).toBeVisible();
    await expect(owner.getByRole("paragraph").filter({ hasText: "Owner's latest description" })).toBeVisible();
    await owner.goto("/notifications"); await waitForClientRoute(owner);
    const notice = owner.locator("main").getByRole("listitem").filter({ hasText: "Owner's latest name" });
    await expect(notice).toContainText(m.notification_moderation_fix_village);
    await expect(notice.getByRole("link", { name: m.notification_appeal, exact: true })).toBeVisible();

    await useMember(page, "vr_reporter@example.com", "/villages/new"); await waitForClientRoute(page);
    await page.getByLabel(m.village_kind_open_option, { exact: true }).check();
    await page.getByLabel(m.village_name_field, { exact: true }).fill("An attempted slug takeover");
    await page.getByLabel(m.village_slug_field, { exact: true }).fill(slug);
    await page.getByRole("button", { name: m.village_create, exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText(m.village_error_slug_taken);
    expect((await page.request.get(`/v/${slug}`)).status()).toBe(404);
  } finally { await ownerContext.close(); }
});

test("keeps language-village reports open after ordinary editing and resolves them only from a moderation card", async ({ page }) => {
  await useMember(page, "vr_reporter@example.com", "/v/en"); await waitForClientRoute(page);
  await page.getByText(m.village_report, { exact: true }).click();
  await page.getByLabel(m.flag_note, { exact: true }).fill("Please update the language village description");
  await page.getByRole("button", { name: m.flag_submit, exact: true }).click();
  await expect(page.getByText(m.village_reported, { exact: true })).toBeVisible();

  await useMember(page, "vr_operator@example.com", "/moderation"); await waitForClientRoute(page);
  const actionCount = await page.getByRole("row").count();
  await page.goto("/v/en"); await waitForClientRoute(page);
  await openVillageManagement(page);
  await page.getByText(m.village_edit, { exact: true }).click();
  await page.getByLabel(m.village_description_field, { exact: true }).fill("An ordinary configuration update");
  await page.getByRole("button", { name: m.save_changes, exact: true }).click();
  await expect(page.getByRole("paragraph").filter({ hasText: "An ordinary configuration update" })).toBeVisible();
  await page.goto("/mod"); await waitForClientRoute(page);
  const languageCard = page.locator('section[id^="v-report-"]').filter({ has: page.locator('a[href="/v/en"]') });
  await expect(languageCard).toHaveCount(1);
  await expect(languageCard.getByRole("button", { name: m.village_mod_fix, exact: true })).toHaveCount(0);
  await languageCard.getByRole("link", { name: m.village_edit, exact: true }).click();
  await expect(page).toHaveURL(/\/v\/en\?resolveReport=\d+$/); await waitForClientRoute(page);
  await expect(page.getByRole("link", { name: m.village_mod_link, exact: true })).toHaveCount(0);
  await expect(page.getByText(m.village_edit_resolve_reports, { exact: true })).toBeVisible();
  await expect(page.getByLabel(m.village_name_field, { exact: true })).toHaveCount(0);
  await page.getByLabel(m.village_description_field, { exact: true }).fill("An updated description of the English village");
  await page.getByRole("button", { name: m.save_changes, exact: true }).click();
  await expect(page.getByRole("paragraph").filter({ hasText: "An updated description of the English village" })).toBeVisible();
  await page.goto("/mod");
  await expect(page.locator('section[id^="v-report-"]').filter({ has: page.locator('a[href="/v/en"]') })).toHaveCount(0);
  await page.goto("/moderation");
  await expect(page.getByRole("row")).toHaveCount(actionCount);
  await evidence(page, "language-description-edit");
});
