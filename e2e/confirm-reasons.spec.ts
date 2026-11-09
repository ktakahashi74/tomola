import fs from "node:fs";
import path from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { clientHeaders, formatMessage, enMessages as m, logSize, loginCodeFor, magicLinkFor, signUp, state } from "./helpers";

test.describe.configure({ mode: "serial" });
let context: BrowserContext;
let page: Page;
let usedLink: string;
const fixture = () => JSON.parse(fs.readFileSync(path.join(state().dir, "confirm-reasons.json"), "utf8")) as { invite: string; otherInvite: string; expiredLink: string };

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: clientHeaders("10.36.0.1") });
  page = await context.newPage();
});
test.afterAll(async () => { await context.close(); });

test("a signed-in browser goes home only for its own used link", async () => {
  const since = logSize();
  await signUp(page, fixture().invite, "confirm_reasons@example.com", { handle: "confirm_reasons" });
  usedLink = await magicLinkFor("confirm_reasons@example.com", since);
  await page.goto(usedLink);
  await expect(page).toHaveURL(new URL("/", state().baseURL).href);
  await expect(page.locator("[data-member-menu-trigger]")).toHaveAttribute("title", "@confirm_reasons");
  for (const token of ["x".repeat(32), "bad"]) {
    await page.goto("/auth/confirm?token=" + token);
    await expect(page.getByRole("heading", { name: m.confirm_unknown_heading, exact: true })).toBeVisible();
    await expect(page.getByLabel(m.login_email, { exact: true })).toBeVisible();
  }
  const failed = await context.request.post("/auth/confirm", { headers: { origin: state().baseURL }, form: { token: new URL(usedLink).searchParams.get("token")! }, maxRedirects: 0 });
  expect(failed.status()).toBe(302);
  expect(failed.headers().location).toBe("/");
});

test("another member's used link offers recovery and its code switches accounts while return events keep the pending screen", async ({ browser }) => {
  const target = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: clientHeaders("10.36.0.2") });
  let otherLink: string;
  try {
    const targetPage = await target.newPage();
    const since = logSize();
    await signUp(targetPage, fixture().otherInvite, "confirm_reasons_other@example.com", { handle: "confirm_reasons_other" });
    otherLink = await magicLinkFor("confirm_reasons_other@example.com", since);
  } finally { await target.close(); }
  const switching = await browser.newContext({ storageState: await context.storageState(), extraHTTPHeaders: clientHeaders("10.36.0.3") });
  try {
    const active = await switching.newPage();
    await active.goto(otherLink);
    await expect(active.getByRole("heading", { name: m.confirm_used_heading, exact: true })).toBeVisible();
    await expect(active.getByLabel(m.login_email, { exact: true })).toBeVisible();
    expect(await active.content()).not.toContain("confirm_reasons_other@example.com");
    const rejected = await switching.request.post("/auth/confirm", { headers: { origin: state().baseURL }, form: { token: new URL(otherLink).searchParams.get("token")! }, maxRedirects: 0 });
    expect(rejected.status()).toBe(400);
    expect(await rejected.text()).toContain(m.confirm_used_heading);
    const since = logSize();
    await active.getByLabel(m.login_email, { exact: true }).fill("confirm_reasons_other@example.com");
    await active.getByRole("button", { name: m.login_submit, exact: true }).click();
    await expect(active.getByRole("heading", { name: m.login_code_heading, exact: true })).toBeVisible();
    const code = await loginCodeFor("confirm_reasons_other@example.com", since);
    await active.getByLabel(m.login_code_label, { exact: true }).fill("123");
    const refreshed = active.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/login.data");
    await active.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refreshed;
    await expect(active.getByLabel(m.login_code_label, { exact: true })).toHaveValue("123");
    await expect(active).toHaveURL(new URL("/login", state().baseURL).href);
    await active.reload();
    await expect(active.getByRole("heading", { name: m.login_code_heading, exact: true })).toBeVisible();
    await active.getByLabel(m.login_code_label, { exact: true }).fill(code);
    await active.getByRole("button", { name: m.login_code_submit, exact: true }).click();
    await expect(active).toHaveURL(new URL("/", state().baseURL).href);
    await expect(active.locator("[data-member-menu-trigger]")).toHaveAttribute("title", "@confirm_reasons_other");
  } finally { await switching.close(); }
});

test("recovery with the current member's normalized address sends no email", async () => {
  await page.goto("/auth/confirm?token=" + "x".repeat(32));
  const since = logSize();
  await page.getByLabel(m.login_email, { exact: true }).fill("CONFIRM_REASONS@EXAMPLE.COM");
  await page.getByRole("button", { name: m.login_submit, exact: true }).click();
  await expect(page).toHaveURL(new URL("/", state().baseURL).href);
  expect(fs.readFileSync(state().logFile).subarray(since).toString()).not.toContain("[mail]");
});

test("after logout a used link explains single use and offers a new email without JavaScript", async () => {
  await context.request.post("/logout", { headers: { origin: state().baseURL }, form: {} });
  await page.goto(usedLink);
  await expect(page.getByRole("heading", { level: 1, name: m.confirm_used_heading, exact: true })).toBeVisible();
  await expect(page.getByText(m.confirm_used, { exact: true })).toBeVisible();
  await expect(page.getByLabel(m.login_email, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: m.confirm_submit, exact: true })).toHaveCount(0);
  await expect(page.locator('input[name="next"]')).toHaveCount(0);
  expect(await page.content()).not.toContain("confirm_reasons@example.com");
  const failed = await context.request.post("/auth/confirm", { headers: { origin: state().baseURL }, form: { token: new URL(usedLink).searchParams.get("token")! } });
  expect(failed.status()).toBe(400);
  expect(await failed.text()).toContain(m.confirm_used_heading);
});

test("an expired link explains the time limit on GET and POST without JavaScript", async () => {
  const clock = path.join(state().dir, "server-clock.txt");
  fs.writeFileSync(clock, String(16 * 60_000));
  try {
    await page.goto(fixture().expiredLink);
    await expect(page.getByRole("heading", { level: 1, name: m.confirm_expired_heading, exact: true })).toBeVisible();
    await expect(page.getByText(formatMessage(m.confirm_expired, { minutes: 15 }), { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: m.login_submit, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: m.confirm_submit, exact: true })).toHaveCount(0);
    expect(await page.content()).not.toContain("confirm_reasons_expired@example.com");
    const failed = await context.request.post("/auth/confirm", { headers: { origin: state().baseURL }, form: { token: new URL(fixture().expiredLink).searchParams.get("token")! } });
    expect(failed.status()).toBe(400);
    expect(await failed.text()).toContain(m.confirm_expired_heading);
    expect(failed.headers()["cache-control"]).toContain("no-store");
    expect(failed.headers()["referrer-policy"]).toBe("strict-origin");
    expect(failed.headers()["x-robots-tag"]).toBe("noindex");
  } finally { fs.writeFileSync(clock, "0"); }
});
