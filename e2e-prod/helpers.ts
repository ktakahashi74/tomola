import fs from "node:fs";
export { openUserMenu, openAdminMenu } from "../e2e/helpers";
export { captureScreenshot, waitForClientRoute } from "../e2e/helpers";
import { completeTrialFields, enMessages, restoreMember } from "../e2e/helpers";
import { PROD_MEMBERS } from "./member-fixtures";
import { expect, type Page } from "@playwright/test";
import { test as base, richEditorTest as richBase } from "../e2e/editor-fixture";
import type { ProdState } from "./global-setup";
import type { ReceivedMail } from "./support/fake-smtp";

// Shared state written by global-setup.ts: site URL, server log, fake SMTP mail file and invitation URLs.
export function state(): ProdState {
  return JSON.parse(fs.readFileSync(process.env.E2E_PROD_STATE!, "utf8")) as ProdState;
}

export async function useMember(page: Page, email: string) {
  const member = PROD_MEMBERS.find(member => member.email === email);
  if (!member) throw new Error(`No owned production member fixture for ${email}`);
  await restoreMember(page, state().dir, email, member.handle);
}

// baseURL is determined during setup, after choosing a free port.
export const test = base.extend({
  baseURL: async ({}, use) => {
    await use(state().baseURL);
  },
});
export const richEditorTest = richBase.extend({
  baseURL: async ({}, use) => { await use(state().baseURL); },
});
export { expect };

export const mailCount = (): number => fs.readFileSync(state().mailFile, "utf8").split("\n").filter(Boolean).length;

// Wait for the latest email to this recipient received by fake SMTP after since (a mailCount value).
export async function mailFor(email: string, since: number): Promise<ReceivedMail> {
  let found: ReceivedMail | undefined;
  await expect
    .poll(
      () => {
        const lines = fs.readFileSync(state().mailFile, "utf8").split("\n").filter(Boolean).slice(since);
        found = lines.map((l) => JSON.parse(l) as ReceivedMail).filter((m) => m.to.includes(email)).at(-1);
        return found;
      },
      { message: `mail for ${email}`, timeout: 30_000 },
    )
    .toBeDefined();
  return found!;
}

export async function magicLinkFor(email: string, since: number): Promise<string> {
  const mail = await mailFor(email, since);
  const url = mail.text.match(/https?:\/\/\S+/)?.[0];
  expect(url, `a link in the mail for ${email}`).toBeDefined();
  return url!;
}

// Collect CSP violations from console errors and securitypolicyviolation events. Events belong to each document, so
// forward them to the console from an initialization script to keep capturing them across navigation.
export type CspWatch = { violations: string[]; pageErrors: string[]; hydrationWarnings: string[] };
export async function watchCsp(page: Page): Promise<CspWatch> {
  const watch: CspWatch = { violations: [], pageErrors: [], hydrationWarnings: [] };
  const hydration = /hydrat|did not match|server rendered HTML|Minified React error #(?:418|423|425)\b|react\.dev\/errors\/(?:418|423|425)\b/i;
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP-VIOLATION ${e.violatedDirective} ${e.blockedURI} ${e.sourceFile ?? ""}`));
  });
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" && /Content Security Policy|CSP-VIOLATION|Refused to/i.test(text)) watch.violations.push(text);
    if ((msg.type() === "error" || msg.type() === "warning") && hydration.test(text)) watch.hydrationWarnings.push(text);
  });
  page.on("pageerror", (error) => watch.pageErrors.push(error.message));
  return watch;
}

// Send a login link from the invitation URL, open it and set up a profile (member signup; the production build reads mail from fake SMTP).
export async function signUp(
  page: Page,
  email: string,
  profile: { handle: string; mainLang: string; read?: string[] },
  beforeConfirm?: (link: string) => Promise<void>,
) {
  const since = mailCount();
  await page.goto(state().invites[email]);
  await page.getByRole("button", { name: enMessages.invite_submit, exact: true }).click();
  await expect(page.getByText(enMessages.invite_sent.replace("{email}", email), { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: enMessages.login_code_heading, exact: true })).toBeVisible();
  const link = await magicLinkFor(email, since);
  await beforeConfirm?.(link);
  await page.goto(link);
  await expect(page).toHaveURL(/\/auth\/confirm\?token=/);
  await page.getByRole("button", { name: enMessages.confirm_submit, exact: true }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel(enMessages.onboarding_handle).fill(profile.handle);
  // Choose the main language explicitly, then complete trial eligibility and agreement.
  const { LANG_LABELS } = await import("../app/lib/languages");
  await page.getByRole("combobox", { name: enMessages.onboarding_home_area, exact: true }).click();
  await page.getByRole("listbox").getByRole("option", { name: profile.mainLang === "other" ? "Other" : LANG_LABELS[profile.mainLang as keyof typeof LANG_LABELS], exact: true }).click();
  await completeTrialFields(page);
  await page.getByRole("button", { name: enMessages.onboarding_join }).click();
  await expect(page).toHaveURL(new URL("/", state().baseURL).href);
  await expect(page.locator("[data-member-menu-trigger]")).toHaveAttribute("title", `@${profile.handle}`);
  // Languages to read beyond the default (the main language) are set in /settings.
  if (profile.read) await setReadLangs(page, profile.read);
}

// Sets the languages the member reads in /settings (the checkboxes listed in `labels` are checked, the others cleared) and saves.
export async function setReadLangs(page: Page, labels: string[]) {
  await page.goto("/settings");
  const group = page.getByRole("group", { name: enMessages.onboarding_read_langs });
  for (const box of await group.getByRole("checkbox").all()) {
    const label = (await box.evaluate((el) => el.closest("label")?.textContent ?? "")).trim();
    if (await box.isChecked() !== labels.includes(label)) {
      const saved = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/settings/save");
      await box.setChecked(labels.includes(label));
      expect((await saved).ok()).toBe(true);
      await expect(group.getByRole("status")).toHaveText(enMessages.settings_saved);
    }
  }
  await page.goto("/");
}
