import { ELIGIBLE_COUNTRY, testOperator } from "./operator-fixture";
import { formatOperatorCopy, operatorCopy } from "../app/lib/operator-settings";
import type { Message } from "../app/lib/i18n/messages";
import fs from "node:fs";
import path from "node:path";
import { MEMBER_FIXTURES } from "./member-fixtures";
import { errors, expect, type Locator, type Page } from "@playwright/test";

// Read JSON without native module loading: Playwright's ESM loader also runs on Node versions requiring JSON import attributes.
export const enMessages = operatorMessages("en", JSON.parse(fs.readFileSync(new URL("../messages/en.json", import.meta.url), "utf8")) as typeof import("../messages/en.json"));
export const jaMessages = operatorMessages("ja", JSON.parse(fs.readFileSync(new URL("../messages/ja.json", import.meta.url), "utf8")) as typeof import("../messages/en.json"));

function operatorMessages(locale: string, messages: typeof import("../messages/en.json")) {
  const policy = testOperator.participation;
  const copy = policy.copy[locale] ?? policy.copy.en;
  const siteCopy = operatorCopy(testOperator, locale);
  return { ...messages,
    footer_operator: messages.footer_operator.replace("{operator}", testOperator.name[locale] ?? testOperator.name.en),
    onboarding_adult: messages.onboarding_adult.replace("{age}", String(policy.minimumAge)),
    onboarding_error_adult: formatOperatorCopy(siteCopy.adultError ?? messages.onboarding_error_adult, { age: policy.minimumAge }),
    error_body_unexpected: messages.error_body_unexpected.replace("{email}", testOperator.contactEmail),
    account_delete_error_failed: messages.account_delete_error_failed.replace("{email}", testOperator.privacyEmail),
    onboarding_country_excluded: copy.countryExcluded,
    invite_excluded_countries: copy.invitationRestriction,
    trial_summary_eligibility: copy.eligibilitySummary,
    disclosure_no_lookup: siteCopy.stanceDisclosure,
    village_chat_consent_provider: siteCopy.chatProvider,
    village_chat_changes_v3_provider: siteCopy.chatProviderChange,
    onboarding_purposes: formatOperatorCopy(messages.onboarding_purposes, { aiRecipient: siteCopy.aiRecipient }),
    stance_consent_text: formatOperatorCopy(messages.stance_consent_text, { lookupPolicy: siteCopy.stanceConsent }),
    trial_summary_copyright: formatOperatorCopy(messages.trial_summary_copyright, { trainingPolicy: siteCopy.trainingPolicy }),
    notice_terms: siteCopy.termsLabel ?? messages.notice_terms,
    onboarding_country_help: siteCopy.countryHelp ?? messages.onboarding_country_help,
    onboarding_trial_agree: siteCopy.agreementLabel ?? messages.onboarding_trial_agree,
    onboarding_error_consent: siteCopy.agreementError ?? messages.onboarding_error_consent,
    onboarding_review_title: siteCopy.reviewTitle ?? messages.onboarding_review_title,
    onboarding_review_help: siteCopy.reviewHelp ?? messages.onboarding_review_help,
    test_site_notice: siteCopy.testSiteNotice ?? messages.test_site_notice,
  };
}

// Wait for the route response and client router, rather than a quiet network.
export async function waitForClientRoute(page: Page) {
  await page.waitForFunction(() => {
    const router = (window as unknown as { __reactRouterDataRouter?: { state: { initialized: boolean; navigation: { state: string }; revalidation: string } } }).__reactRouterDataRouter;
    return router?.state.initialized && router.state.navigation.state === "idle" && router.state.revalidation === "idle";
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

// Wait until React has committed the hydrated page, so its event handlers are attached. A key press or click before that is handled by the browser itself
// (a form is submitted natively), which is the progressive-enhancement path and not what a test about the live page means. React marks the document it hydrates
// with a container key; the root there stays dehydrated until the hydration is committed.
export async function waitForHydration(page: Page) {
  await page.waitForFunction(() => {
    const key = Object.keys(document).find(name => name.startsWith("__reactContainer$"));
    const root = key ? (document as unknown as Record<string, { stateNode?: { current?: { memoizedState?: { isDehydrated?: boolean } } } }>)[key] : null;
    return root?.stateNode?.current?.memoizedState?.isDehydrated === false;
  });
  await waitForClientRoute(page);
}

export async function captureScreenshot(page: Page, options: Parameters<Page["screenshot"]>[0], scenario: string) {
  if (!process.env.E2E_EVIDENCE_DIR) return;
  const destination = path.join(process.env.E2E_EVIDENCE_DIR, scenario, path.basename(String(options?.path ?? "screenshot.png")));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  await page.screenshot({ ...options, path: destination });
}

export async function openTranslationSettings(page: Page) {
  const details = page.locator("#settings-display-lang").locator("..");
  if (await details.getAttribute("open") === null) await details.locator(":scope > summary").click();
}

export async function openVillageManagement(page: Page) {
  const management = page.locator("#village-management");
  if (await management.getAttribute("open") === null) await management.locator(":scope > summary").click();
  await expect(management).toHaveAttribute("open", "");
  return management;
}

export async function openUserMenu(page: Page) {
  const menu = page.locator("[data-member-menu][data-open]");
  await expect(async () => {
    if (await page.locator("[data-admin-menu][data-open]").isVisible()) await page.keyboard.press("Escape");
    if (!await menu.isVisible()) await page.locator("[data-member-menu-trigger]").click();
    await expect(menu).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  return menu;
}
// The places drawer in the header ("≡"): Home, Following, the joined villages and their chats, and the list of villages. Opens it if it is closed.
export async function openPlaces(page: Page) {
  const drawer = page.locator("[data-navigation-drawer]");
  if (await drawer.getAttribute("open") === null) await drawer.locator(":scope > summary").click();
  await expect(drawer).toHaveAttribute("open", "");
  return drawer.locator("nav");
}
export async function closePlaces(page: Page) {
  const drawer = page.locator("[data-navigation-drawer]");
  if (await drawer.getAttribute("open") !== null) await drawer.locator(":scope > summary").click();
  await expect(drawer).not.toHaveAttribute("open", "");
}

export async function openAdminMenu(page: Page) {
  const menu = page.locator("[data-admin-menu][data-open]");
  if (await page.locator("[data-admin-menu-trigger]").isVisible()) {
    await expect(async () => {
      if (await page.locator("[data-member-menu][data-open]").isVisible()) await page.keyboard.press("Escape");
      if (!await menu.isVisible()) await page.locator("[data-admin-menu-trigger]").click();
      await expect(menu).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    return menu;
  }
  return openUserMenu(page);
}

// Shared state written by global-setup.ts: server log path, initial invitation URL and invitations for machine.spec.ts, auth.spec.ts, moderation.spec.ts, i18n.spec.ts, questions.spec.ts, stances.spec.ts and glossary.spec.ts.
export type E2eState = { dir: string; baseURL: string; logFile: string; invite: string; machineInvite: string; authInvite: string; moderationInvite: string; i18nInvite: string; questionsInvite: string; stancesInvite: string; glossaryInvite: string; scenarioInvite: string; scenarioOperatorInvite: string; followsInvite: string; mentionsInvite: string; discoveryAkiInvite: string; discoveryBenInvite: string; signingInvite: string; mcpInvite: string; mobileInvite: string; enrollmentInvite: string; languageInvite: string; navigationInvite: string; detectInvite: string; fallbackInvite: string; loginConfirmInvite: string; loginPromptInvite: string; loginUnsupportedInvite: string; loginCodeInvite: string; loginMcpInvite: string; loginFlowInvite: string; loginPolishInvite: string; returnReaderInvite: string; returnWriterInvite: string; entryHeaderInvite: string; titleFirstInvite: string };
export function state(): E2eState {
  return JSON.parse(fs.readFileSync(process.env.E2E_STATE!, "utf8")) as E2eState;
}

// Apply the API-created session while retaining explicit locale/editor storage.
export async function useMember(page: Page, email: string, destination = "/") {
  const member = MEMBER_FIXTURES.find(member => member.email === email);
  if (!member) throw new Error(`No owned member fixture for ${email}`);
  await restoreMember(page, state().dir, email, member.handle, destination);
}

export async function restoreMember(page: Page, dir: string, email: string, handle: string, destination = "/") {
  const prepared = JSON.parse(fs.readFileSync(path.join(dir, "members", `${email}.json`), "utf8"));
  const previous = await page.context().storageState();
  prepared.cookies = [...previous.cookies.filter(cookie => !prepared.cookies.some((next: { name: string; domain: string }) => next.name === cookie.name && next.domain === cookie.domain)), ...prepared.cookies];
  prepared.origins = previous.origins;
  await page.context().setStorageState(prepared);
  await page.goto(destination);
  await expect(page.locator("[data-member-menu-trigger]")).toHaveAttribute("title", `@${handle}`);
}

// Supply the test client address. The E2E server has one upstream proxy configured (TRUSTED_PROXY_HOPS=1 in e2e/global-setup.ts), so
// per-IP limits use X-Forwarded-For: 20 magic-link requests and 60 passkey requests per 15 minutes. Otherwise
// all tests would count as the same local address and hit limits as more files are added. Use separate addresses per file and browser context.
export function clientHeaders(ip: string): Record<string, string> {
  return { "x-forwarded-for": ip };
}

export function logSize(): number {
  return fs.statSync(state().logFile).size;
}

// Mail printed to development-server stdout by the development transport (app/lib/mail/transports.server.ts):
//   [mail] to=<email> subject=<subject>
//   <body>
//   [/mail]
export type LoggedMail = { subject: string; text: string };

// Wait for and return the latest mail to this address after since whose subject matches pattern.
export async function mailFor(email: string, since: number, pattern: RegExp = /.*/): Promise<LoggedMail> {
  const blocks = new RegExp(`\\[mail\\] to=${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} subject=([^\\n]*)\\n([\\s\\S]*?)\\n\\[/mail\\]`, "g");
  let found: LoggedMail | undefined;
  await expect
    .poll(
      () => {
        const log = fs.readFileSync(state().logFile).subarray(since).toString("utf8");
        found = [...log.matchAll(blocks)].map((m) => ({ subject: m[1], text: m[2] })).filter((mail) => pattern.test(mail.subject)).at(-1);
        return found;
      },
      { message: `mail for ${email} (${pattern})`, timeout: 30_000 },
    )
    .toBeDefined();
  return found!;
}

// Return the first URL in the latest mail body for this address: the magic link.
export async function magicLinkFor(email: string, since: number): Promise<string> {
  const mail = await mailFor(email, since);
  const url = mail.text.match(/https?:\/\/\S+/)?.[0];
  expect(url, `a link in the mail for ${email}`).toBeDefined();
  return url!;
}

// Mail can arrive before the browser receives the response that sets its binding cookie.
// Capture the send response before clicking, then finish the code-screen transition before reading the link.
export async function requestMagicLink(page: Page, email: string): Promise<string> {
  const messages = await uiMessages(page);
  const url = new URL(page.url());
  const invitation = url.pathname.startsWith("/invite/");
  if (!invitation) {
    const address = page.getByLabel(messages.login_email, { exact: true });
    if (await address.isEditable()) await address.fill(email);
    else await expect(address).toHaveValue(email);
  }
  const submit = page.getByRole("button", { name: invitation ? messages.invite_submit : url.searchParams.has("reauth") ? messages.reauth_submit : messages.login_submit, exact: true });
  const action = await submit.evaluate(button => (button as HTMLButtonElement).form!.action);
  const pathname = new URL(action).pathname;
  const since = logSize();
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && [pathname, `${pathname}.data`].includes(new URL(response.url()).pathname), { timeout: 20_000 }).catch(error => {
      if (error instanceof errors.TimeoutError) throw new Error(`Timed out waiting for the login email POST response (${pathname} or ${pathname}.data)`, { cause: error });
      throw error;
    }),
    submit.click(),
  ]);
  expect(response.status(), "login email request succeeded").toBe(response.request().isNavigationRequest() ? 303 : 200);
  await expect(page.getByLabel((await uiMessages(page)).login_code_label, { exact: true })).toBeVisible();
  // Native forms, including JavaScript-disabled tests, finish with a document navigation.
  if (!response.request().isNavigationRequest()) await waitForClientRoute(page);
  return magicLinkFor(email, since);
}

// An absent confirmation button must fail here, before the test-wide timeout and context cleanup.
export async function confirmMagicLink(page: Page, link?: string) {
  if (link !== undefined) await page.goto(link);
  await expect(page).toHaveURL(/\/auth\/confirm\?token=/);
  const confirm = page.getByRole("button", { name: (await uiMessages(page)).confirm_submit, exact: true });
  await expect(confirm, "the requesting browser can confirm its login link").toBeVisible({ timeout: 5_000 });
  await confirm.click();
}

export async function loginWithMagicLink(page: Page, email: string): Promise<string> {
  const link = await requestMagicLink(page, email);
  await confirmMagicLink(page, link);
  return link;
}

// Read the code only from development mail output, never from page HTML/data.
export async function loginCodeFor(email: string, since: number): Promise<string> {
  const code = (await mailFor(email, since)).text.match(/\b(\d{3}) (\d{3})\b/);
  expect(code, "six-digit code in the email").not.toBeNull();
  return `${code![1]}${code![2]}`;
}

// Wait for this form's client initialization, including adoption of input typed before hydration.
// The development server compiles a route on its first request, so the first form of a run can take longer than an ordinary assertion on a busy machine.
export async function waitForFormReady(form: Locator) {
  await expect(form).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
}

// The title field of a topic. Its label is "Title (optional)", and "Title (required)" while "ask for stances" is on (a question needs its title), so it is found here by what the two share
// and a change of the name is made in one place.
export function titleField(page: Page) {
  return page.locator('input[name="title"]');
}

// The server's chosen UI language, after navigation. Signup keeps browser defaults intact and works in both discovery contexts.
export async function uiMessages(page: Page): Promise<typeof enMessages> {
  const locale = (await page.locator("html").getAttribute("lang")) ?? "en";
  if (locale === "en") return enMessages;
  if (locale === "ja") return jaMessages;
  // Match sparse translated catalogues to the same English fallback as the UI.
  if (!["fr", "de", "zh-Hant", "zh-Hans", "ko", "th", "vi"].includes(locale)) return enMessages;
  const messages = JSON.parse(fs.readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"));
  return operatorMessages(locale, { ...enMessages, ...messages });
}

// Send a login link from an invitation URL, open it and set up a profile (member signup).
export async function signUp(
  page: Page,
  inviteUrl: string,
  email: string,
  profile: { handle: string; mainLang?: string; read?: string[] },
  beforeProfile?: (page: Page) => Promise<void>,
) {
  let link = "";
  // Retry if a dev-server reload loses an immediate click; reset a pending invitation before sending a fresh link.
  await expect(async () => {
    await page.goto(inviteUrl);
    const messages = await uiMessages(page);
    const restart = page.getByRole("button", { name: messages.login_restart, exact: true });
    if (await restart.count()) await restart.click();
    link = await requestMagicLink(page, email);
    await expect(page.getByText(messages.invite_sent.replace("{email}", email), { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("heading", { level: 1, name: messages.login_code_heading, exact: true })).toBeVisible();
  }).toPass({ timeout: 60_000 });
  // The emailed URL opens a confirmation page. Opening alone does not sign in; pressing its button signs in and navigates.
  await confirmMagicLink(page, link);
  await expect(page).toHaveURL(/\/onboarding$/);
  if (beforeProfile) await beforeProfile(page);
  const messages = await uiMessages(page);
  await page.getByLabel(messages.onboarding_handle, { exact: true }).fill(profile.handle);
  // Omitting mainLang preserves the browser-derived default, which discovery checks before submission.
  if (profile.mainLang !== undefined) {
    const { LANG_LABELS } = await import("../app/lib/languages");
    await page.getByRole("combobox", { name: messages.onboarding_home_area, exact: true }).click();
    await page.getByRole("listbox").getByRole("option", { name: profile.mainLang === "other" ? messages.area_other : LANG_LABELS[profile.mainLang as keyof typeof LANG_LABELS], exact: true }).click();
  }
  await completeTrialFields(page);
  await page.getByRole("button", { name: messages.onboarding_join, exact: true }).click();
  // The member header can render before the onboarding redirect finishes. Wait for its destination before the caller starts another navigation.
  await page.waitForURL(new URL("/", state().baseURL).href);
  await expect(page.locator("[data-member-menu-trigger]")).toHaveAttribute("title", `@${profile.handle}`);
  // Additional read languages are changed in settings; signup has no read or write language fields.
  if (profile.read) await setReadLangs(page, profile.read);
}

// Sets the languages the member reads in /settings (the checkboxes listed in `labels` are checked, the others cleared) and saves.
export async function setReadLangs(page: Page, labels: string[]) {
  await page.goto("/settings");
  const messages = await uiMessages(page);
  const group = page.getByRole("group", { name: messages.onboarding_read_langs });
  for (const box of await group.getByRole("checkbox").all()) {
    const label = (await box.evaluate((el) => el.closest("label")?.textContent ?? "")).trim();
    if (await box.isChecked() !== labels.includes(label)) {
      const saved = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/settings/save");
      await box.setChecked(labels.includes(label));
      expect((await saved).ok()).toBe(true);
      await expect(group.getByRole("status")).toHaveText(messages.settings_saved);
    }
  }
  await page.goto("/");
}

// Match the actual message template, including inputs, rather than copying visible wording into a test.
export function formatMessage(template: Message, inputs: Record<string, string | number> = {}): string {
  if (typeof template !== "string") {
    const plural = template[0];
    const declaration = /local (\w+) = (\w+): plural/.exec(plural.declarations.find(d => d.startsWith("local ")) ?? "");
    const category = new Intl.PluralRules("en").select(Number(inputs[declaration![2]]));
    template = plural.match[`${declaration![1]}=${category}`] ?? plural.match[`${declaration![1]}=other`];
  }
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!(name in inputs)) throw new Error(`message input ${name} is missing`);
    return String(inputs[name]);
  });
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Literal wording stays escaped; a variable input can be matched by a regular expression.
export function messagePattern(template: Message, inputs: Record<string, string | number | RegExp> = {}, flags = ""): RegExp {
  if (typeof template !== "string") return new RegExp(`(?:${Object.values(template[0].match).map(pattern => messagePattern(pattern, inputs).source).join("|")})`, flags);
  const parts = template.split(/(\{\w+\})/g);
  return new RegExp(parts.map(part => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    if (name === undefined) return escapeRegex(part);
    if (!(name in inputs)) throw new Error(`message input ${name} is missing`);
    const value = inputs[name];
    return value instanceof RegExp ? `(?:${value.source})` : escapeRegex(String(value));
  }).join(""), flags);
}

export function insightfulCountPattern(messages = enMessages): RegExp {
  return messagePattern(messages.insightful_count_aria, { total: /\d+/, langs: /\d+/ });
}

export function messageTitleField(page: Page, messages = enMessages): Locator {
  const labels = [messages.field_title, messages.field_title_required].map(escapeRegex);
  return page.getByRole("textbox", { name: new RegExp(`^(?:${labels.join("|")})$`) });
}

export function followedThreadPattern(messages = enMessages): RegExp {
  return new RegExp([
    messagePattern(messages.notification_followed_thread, { title: /.+/, count: /\d+/, handle: /.+/ }).source,
    messagePattern(messages.notification_followed_thread_nolatest, { title: /.+/, count: /\d+/ }).source,
  ].join("|"));
}

// Invitations reserved for the related-discussion suite; no shared accounts.
export function relatedInvitations(): { writer: string; reader: string } {
  return JSON.parse(fs.readFileSync(`${state().dir}/related-invites.json`, "utf8"));
}

export function aiDraftInvite(): string {
  return (state() as E2eState & { aiDraftInvite: string }).aiDraftInvite;
}

// Locate owned fixtures through pagination instead of assuming a global row or page.
export async function visitListRow(page: Page, url: string, row: Locator) {
  await page.goto(url);
  for (let remaining = 100; remaining > 0; remaining--) {
    if (await row.count()) return;
    const next = page.getByRole("link", { name: (await uiMessages(page)).page_next, exact: true }).first();
    if (!await next.count()) break;
    await page.goto((await next.getAttribute("href"))!);
  }
  await expect(row, `owned fixture in ${url}`).toBeVisible();
}

export async function allListIds(page: Page, url: string): Promise<number[]> {
  await page.goto(url);
  const ids: number[] = [];
  for (let remaining = 100; remaining > 0; remaining--) {
    ids.push(...await page.locator('li[id^="q-"]').evaluateAll(rows => rows.map(row => Number(row.id.slice(2)))));
    const next = page.getByRole("link", { name: (await uiMessages(page)).page_next, exact: true }).first();
    if (!await next.count()) { await page.goto(url); return ids; }
    await page.goto((await next.getAttribute("href"))!);
  }
  throw new Error("List pagination did not terminate");
}

// Language and editor settings are behind "Change" in a closed <details>. Open the first one on the page.
export async function openPostSettings(page: Page): Promise<void> {
  await page.locator("[data-post-settings]").first().evaluate(element => { (element as HTMLDetailsElement).open = true; });
}

// Choose the way of editing directly beside the body, without opening post settings.
export async function chooseEditorMode(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).click();
}

// What a member typed and did not send is kept on the device and offered back on the next visit of the same screen. A test that abandons a form and opens the screen again
// as if it were new forgets those first.
export async function forgetLocalDrafts(page: Page): Promise<void> {
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("tomola:draft:")) localStorage.removeItem(key); });
}

// The reply field keeps preview, writing tips and writing with an AI behind "…" (a closed <details>). Open it.
export async function openReplyMore(page: Page): Promise<void> {
  await page.locator("[data-reply-more]").first().evaluate(element => { (element as HTMLDetailsElement).open = true; });
}

export async function completeTrialFields(page: Page) {
  // A streamed onboarding document can expose the handle before the optional trial fields arrive.
  await page.waitForLoadState("domcontentloaded");
  if (!await page.locator('select[name="residenceCountry"]').count()) return;
  const messages = await uiMessages(page);
  await page.getByLabel(messages.onboarding_country, { exact: true }).selectOption(ELIGIBLE_COUNTRY);
  await page.getByRole("checkbox", { name: messages.onboarding_adult, exact: true }).check();
  await page.getByRole("checkbox", { name: messages.onboarding_trial_agree, exact: true }).check();
}

// These cookies use the host prefix only on an HTTPS site.
export function hostCookieName(name: "tomola.reading-return" | "tomola.invitation") {
  return `${new URL(state().baseURL).protocol === "https:" ? "__Host-" : ""}${name}`;
}

// Open the persistent article controls at the active reading breakpoint.
export async function readingActions(page: Page) {
  const rail = page.locator(".reading-toc-sidebar [data-reading-actions]");
  if (await rail.isVisible()) return rail;
  const menu = page.locator(".reading-action-menu");
  if (!(await menu.evaluate(element => (element as HTMLDetailsElement).open))) await menu.locator(":scope > summary").click();
  return menu.locator("[data-reading-actions]");
}

export async function readTopicTranslation(scope: Page | Locator, lang = "en") {
  const menu = scope.locator("[data-reading-byline] details.reading-lang-menu");
  await menu.locator("summary").click();
  await menu.locator(`a[lang="${lang}"]`).click();
  await expect(scope.locator("[data-reading-body]").first()).toHaveAttribute("lang", lang);
}
