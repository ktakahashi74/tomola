import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages as m, formatMessage, useMember, waitForHydration } from "./helpers";

test("owners find a name fragment, navigate suggestions and invite the selected handle", async ({ page }) => {
  await useMember(page, "zis_keys_owner@example.com", "/v/invite-suggest-keys?manage=1");
  await waitForHydration(page);
  const field = page.getByLabel(m.village_invite_handle, { exact: true });
  const list = page.getByRole("listbox", { name: m.village_invite_suggest_label, exact: true });
  await expect(field).toHaveAttribute("required", "");
  await expect(page.getByText(m.village_invite_suggest_help, { exact: false })).toBeVisible();
  const helperLoaded = () => page.evaluate(() => performance.getEntriesByType("resource").some(entry => entry.name.includes("/assets/village-invite-autocomplete-")));
  if (process.env.E2E_SERVER === "build") expect(await helperLoaded()).toBe(false);
  await field.fill("nnia");
  await expect(field).toHaveAttribute("role", "combobox");
  if (process.env.E2E_SERVER === "build") expect(await helperLoaded()).toBe(true);
  await expect(list.getByRole("option")).toHaveText(["Zinnia Cedar @zis_candidate_a", "Zinnia Elm @zis_candidate_b", "Zinnia Willow @zis_race_target"]);
  await expect(list.locator("img")).toHaveCount(0);
  await expect(field).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("status").filter({ hasText: "3 suggestions" })).toBeVisible();
  await field.press("ArrowDown");
  const chosen = list.getByRole("option", { selected: true });
  await expect(chosen).toContainText("@zis_candidate_b");
  await expect(field).toHaveAttribute("aria-activedescendant", await chosen.getAttribute("id") ?? "");
  await field.press("ArrowUp");
  await expect(list.getByRole("option", { selected: true })).toContainText("@zis_candidate_a");
  await field.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(field).toHaveAttribute("aria-expanded", "false");
  await expect(field).toHaveValue("nnia");
  await field.fill("NnIa");
  await expect(list).toBeVisible();
  await field.press("ArrowDown");
  await field.press("Enter");
  await expect(field).toHaveValue("zis_candidate_b");
  await expect(list).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: formatMessage(m.village_invite_suggest_selected, { handle: "zis_candidate_b" }) })).toBeVisible();
  await page.getByRole("button", { name: m.village_invite_member, exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: m.village_invite_sent })).toBeVisible();
  await expect(page.locator("#village-invites")).toContainText("@zis_candidate_b");
  await field.fill("nnia");
  await expect(list.getByRole("option")).toHaveCount(2);
  await expect(list).not.toContainText("@zis_candidate_b");
});

test("owners can still type a handle and invite without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: "en-US" });
  try {
    const page = await context.newPage();
    await useMember(page, "zis_native_owner@example.com", "/v/invite-suggest-native?manage=1");
    const field = page.getByLabel(m.village_invite_handle, { exact: true });
    await field.fill("zis_native_target");
    await page.getByRole("button", { name: m.village_invite_member, exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: m.village_invite_sent })).toBeVisible();
    await expect(page.locator("#village-invites")).toContainText("@zis_native_target");
  } finally { await context.close(); }
});

test("suggestions discard old responses, respect composition and support pointer selection on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useMember(page, "zis_race_owner@example.com", "/v/invite-suggest-race?manage=1");
  await waitForHydration(page);
  const field = page.getByLabel(m.village_invite_handle, { exact: true });
  const list = page.getByRole("listbox", { name: m.village_invite_suggest_label, exact: true });
  let finishOld: (() => Promise<void>) | undefined;
  await page.route("**/invite-suggest?**", async route => {
    if (new URL(route.request().url()).searchParams.get("q") !== "old") return route.continue();
    await new Promise<void>(resolve => { finishOld = async () => { await route.fulfill({ json: { members: [{ handle: "old_result", name: "Old result" }] } }).catch(() => {}); resolve(); }; });
  });
  await field.fill("old");
  await expect.poll(() => !!finishOld).toBe(true);
  await field.fill("Willow");
  await expect(list.getByRole("option")).toHaveText(["Zinnia Willow @zis_race_target"]);
  await finishOld!();
  await expect(list).not.toContainText("old_result");
  await field.dispatchEvent("compositionstart");
  await expect(list).toHaveCount(0);
  await field.fill("Willow");
  await field.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(field).toHaveValue("Willow");
  await field.dispatchEvent("compositionend");
  await expect(list).toBeVisible();
  await list.getByRole("option").click();
  await expect(field).toHaveValue("zis_race_target");
  await expect(list).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
