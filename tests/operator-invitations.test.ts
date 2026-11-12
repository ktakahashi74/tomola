import { createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { invitations, jobs, profiles, rateLimits, suspendedEmailHashes, villages } from "~/lib/db/schema";
import { createInvitation, findValidInvitationByToken, hashInvitationToken, markInvitationUsed } from "~/lib/invitations.server";
import { parseInvitationEmails } from "~/lib/operator-invitations.server";
import { hitMemberLimit } from "~/lib/rate-limit.server";
import { createMailer, type Mailer } from "~/lib/mail/mail.server";
import { createDevTransport, createMemoryMailbox } from "~/lib/mail/transports.server";
import { suspendedEmailHash } from "~/lib/suspended-email.server";
import { DELETED_MEMBER_EMAIL } from "~/lib/deleted-member";
import { operatorConfig } from "~/lib/operator-config.server";
import InvitesNew, { action, loader } from "~/routes/invites-new";
import { m } from "~/paraglide/messages.js";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { renderInRouter } from "./helpers/render-in-router";
import { createVillage } from "~/lib/village-management.server";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let h: RouteHarness;
const box = createMemoryMailbox();
const globalMail = globalThis as { __tomolaMailer?: Mailer };
let savedMailer: Mailer | undefined;
beforeAll(async () => {
  h = await setupRouteHarness();
  for (const name of ["bulk_operator", "bulk_member", "bulk_registered"]) await h.signIn(name);
  savedMailer = globalMail.__tomolaMailer;
});
beforeEach(async () => {
  vi.stubEnv("OPERATOR_EMAILS", "bulk_operator@example.com");
  vi.stubEnv("OPERATOR_ONLY_INVITATIONS", "");
  vi.stubEnv("ENABLED_LANGS", "en,ja");
  box.clear();
  globalMail.__tomolaMailer = createMailer(box.transport, "tomola <no-reply@example.org>");
  await h.db.delete(invitations).where(and(eq(invitations.createdBy, h.ids.bulk_operator), isNull(invitations.usedAt)));
  await h.db.delete(rateLimits).where(eq(rateLimits.key, `member:invitation:${h.ids.bulk_operator}`));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(() => { h.restore(); globalMail.__tomolaMailer = savedMailer; });
const post = (form: Record<string, string | string[]>, as = "bulk_operator") => action(h.args(h.request("/invites/new", { as, form })));
const pending = () => h.db.select().from(invitations).where(and(eq(invitations.createdBy, h.ids.bulk_operator), isNull(invitations.usedAt)));
const allowance = async () => (await h.db.select().from(rateLimits).where(eq(rateLimits.key, `member:invitation:${h.ids.bulk_operator}`)))[0]?.count ?? 0;

it("splits whitespace, commas and semicolons, normalizes case, and deduplicates", () => {
  expect(parseInvitationEmails([" A@EXAMPLE.COM\n b@example.com, a@example.com;\tc@example.com ", "B@example.com"]))
    .toEqual(["a@example.com", "b@example.com", "c@example.com"]);
});

it("rejects 21 distinct recipients before creating or charging anything", async () => {
  expect(await post({ email: Array.from({ length: 21 }, (_, i) => `batch_${i}@example.com`).join("\n"), sendEmail: "1", mailLocale: "en" }))
    .toMatchObject({ error: "too_many" });
  expect(await pending()).toEqual([]);
  expect(await allowance()).toBe(0);
  expect(box.sent).toEqual([]);
});

it("reports non-creatable addresses individually without consuming their allowance", async () => {
  await createInvitation(h.db, { email: "bulk_already_invited@example.com", createdBy: h.ids.bulk_operator });
  await h.db.insert(suspendedEmailHashes).values({ hash: suspendedEmailHash("bulk_held@example.com"), expiresAt: new Date(Date.now() + 86400000) });
  const email = ["bulk_registered@example.com", "bulk_already_invited@example.com", DELETED_MEMBER_EMAIL, "bulk_held@example.com", "broken", "bulk_operator@example.com"].join("\n");
  const out = await post({ email });
  expect(out).toMatchObject({ error: null, results: [
    { status: "member" }, { status: "existing" }, { status: "ineligible" }, { status: "ineligible" }, { status: "invalid" }, { status: "self" },
  ] });
  expect(await pending()).toHaveLength(1);
  expect(await allowance()).toBe(0);
  expect(box.sent).toEqual([]);
});

it("charges only created unique invitations and returns links without sending mail", async () => {
  const out = await post({ email: "bulk_links_a@example.com;BULK_LINKS_A@example.com\nbulk_registered@example.com\nbroken\nbulk_links_b@example.com" });
  expect(out).toMatchObject({ error: null, results: [
    { email: "bulk_links_a@example.com", status: "created", url: expect.stringContaining("/invite/") },
    { status: "member" }, { status: "invalid" }, { email: "bulk_links_b@example.com", status: "created", url: expect.stringContaining("/invite/") },
  ] });
  expect(await pending()).toHaveLength(2);
  expect(await allowance()).toBe(2);
  expect(box.sent).toEqual([]);
});

it("rejects an over-budget batch atomically and reports the unchanged remaining allowance", async () => {
  for (let i = 0; i < 19; i++) await hitMemberLimit(h.db, "invitation", h.ids.bulk_operator);
  const out = await post({ email: "budget_a@example.com\nbulk_registered@example.com\nbudget_b@example.com", sendEmail: "1", mailLocale: "en" });
  expect(out).toMatchObject({ data: { error: "bulk_rate_limited", remaining: 1 }, init: { status: 429 } });
  expect(await pending()).toEqual([]);
  expect(await allowance()).toBe(19);
  expect(box.sent).toEqual([]);
  expect(await post({ email: "budget_a@example.com\nbulk_registered@example.com" })).toMatchObject({ error: null });
  expect(await allowance()).toBe(20);
});

it.each(["en", "ja"] as const)("sends one plaintext invitation per recipient in %s with usable recipient-bound tokens", async locale => {
  vi.stubEnv("TOMOLA_SITE_STAGE", "test");
  await h.db.update(profiles).set({ displayName: "招待者", displayNameLatin: "Inviter", homeArea: "ja" }).where(eq(profiles.userId, h.ids.bulk_operator));
  const emails = [`bulk_mail_${locale}_a@example.com`, `bulk_mail_${locale}_b@example.com`];
  expect(await post({ email: emails.join("\n"), sendEmail: "1", mailLocale: locale, note: "原文の一言" }))
    .toMatchObject({ error: null, results: emails.map(email => ({ email, status: "sent" })) });
  expect(box.sent.map(mail => mail.to)).toEqual(emails);
  expect(await allowance()).toBe(2);
  for (const mail of box.sent) {
    expect(mail.subject).toContain(locale === "ja" ? "招待者" : "Inviter");
    expect(mail.subject.startsWith(m.mail_test_prefix({}, { locale }))).toBe(true);
    expect(mail.text).toContain("@bulk_operator");
    expect(mail.text).toContain(m.mail_signup_invitation_about({}, { locale }));
    expect(mail.text).toContain("原文の一言");
    expect(mail.text).toContain(operatorConfig().contactEmail);
    expect(mail.text).not.toContain("bulk_operator@example.com");
    expect(mail.text).toContain("14");
    expect(mail.html).toBeUndefined();
    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(mail.text)![1];
    const invitation = (await findValidInvitationByToken(h.db, token))!;
    expect(invitation.email).toBe(mail.to);
    expect(invitation.tokenHash).toBe(hashInvitationToken(token));
    expect(await markInvitationUsed(h.db, "wrong_address@example.com", { invitationId: invitation.id })).toBe(0);
    expect(await markInvitationUsed(h.db, mail.to, { invitationId: invitation.id })).toBe(1);
    expect(await findValidInvitationByToken(h.db, token)).toBeNull();
  }
  expect(await h.db.select().from(jobs).where(eq(jobs.kind, "translate_invitation_note"))).toEqual([]);
});

it("omits absent note and village sections and includes a selected signup village", async () => {
  await post({ email: "bulk_optional@example.com", sendEmail: "1", mailLocale: "en" });
  expect(box.sent[0].text).not.toContain(m.mail_signup_invitation_note({ name: "", note: "" }, { locale: "en" }));
  expect(box.sent[0].text).not.toContain(m.mail_signup_invitation_village({ village: "" }, { locale: "en" }));
  vi.stubEnv("VILLAGES", "1");
  const made = await createVillage(h.db, h.ids.bulk_operator, { slug: "bulk-mail-village", kind: "invite_public", name: "Mail village", description: "" });
  if (!made.ok) throw new Error(made.error);
  const [village] = await h.db.select().from(villages).where(eq(villages.slug, made.slug));
  await post({ email: "bulk_village_a@example.com\nbulk_village_b@example.com", sendEmail: "1", mailLocale: "en", villageId: village.id });
  for (const mail of box.sent.slice(1)) expect(mail.text).toContain(m.mail_signup_invitation_village({ village: "Mail village" }, { locale: "en" }));
  expect((await pending()).filter(row => row.villageId === village.id)).toHaveLength(2);
});

it("rolls back creation and allowance for an invalid village", async () => {
  expect(await post({ email: "bad_village_a@example.com\nbad_village_b@example.com", villageId: "missing" })).toMatchObject({ error: "invalid_village" });
  expect(await pending()).toEqual([]);
  expect(await allowance()).toBe(0);
});

it("revokes a failed delivery, retains its charge, and continues with later recipients without logging content", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const transport = { kind: "memory" as const, async send(mail: Parameters<typeof box.transport.send>[0]) {
    if (mail.to === "bulk_failed@example.com") throw new Error(`Provider included ${mail.text}`);
    await box.transport.send(mail);
  } };
  globalMail.__tomolaMailer = createMailer(transport, "tomola <no-reply@example.org>");
  expect(await post({ email: "bulk_failed@example.com\nbulk_success@example.com", sendEmail: "1", mailLocale: "ja" }))
    .toMatchObject({ error: null, results: [{ status: "send_failed" }, { status: "sent" }] });
  expect((await pending()).find(row => row.email === "bulk_failed@example.com")?.revokedAt).toBeInstanceOf(Date);
  expect(box.sent).toHaveLength(1);
  expect(await allowance()).toBe(2);
  expect(log).not.toHaveBeenCalled();
});

it("redacts invitation content in the development transport", async () => {
  const lines: string[] = [];
  globalMail.__tomolaMailer = createMailer(createDevTransport(line => lines.push(line)), "tomola <noreply@localhost>");
  await post({ email: "bulk_dev@example.com", sendEmail: "1", mailLocale: "en", note: "Private note" });
  expect(lines).toHaveLength(1);
  for (const text of ["/invite/", "Private note", "bulk_dev@example.com"]) expect(lines[0]).not.toContain(text);
});

it.each(["1", ""])("rejects forged operator requests from members when restriction is %s", async setting => {
  vi.stubEnv("OPERATOR_ONLY_INVITATIONS", setting);
  const forms: Array<Record<string, string | string[]>> = [{ email: "forged_a@example.com\nforged_b@example.com" },
    { email: "forged_a@example.com;FORGED_A@example.com" }, { email: "forged_a@example.com", sendEmail: "1" },
    { email: "forged_a@example.com", sendEmail: "0" }, { email: ["forged_a@example.com", "forged_b@example.com"] }, { email: "forged_a@example.com", mailLocale: "ja" }];
  for (const form of forms) {
    expect(await h.outcome(() => post(form, "bulk_member"))).toMatchObject({ status: 400 });
  }
  expect(await h.db.select().from(invitations).where(eq(invitations.email, "forged_a@example.com"))).toEqual([]);
  expect(await h.db.select().from(rateLimits).where(eq(rateLimits.key, `member:invitation:${h.ids.bulk_member}`))).toEqual([]);
  expect(box.sent).toEqual([]);
});

it("keeps an unrestricted member's single-address invitation and manual link", async () => {
  expect(await post({ email: "bulk_member_manual@example.com" }, "bulk_member")).toMatchObject({ error: null, url: expect.stringContaining("/invite/") });
  expect(box.sent).toEqual([]);
});

it("offers only enabled mail languages, rejects a disabled choice, and separates member and operator forms", async () => {
  expect(await post({ email: "bulk_disabled@example.com", sendEmail: "1", mailLocale: "fr" })).toMatchObject({ init: { status: 400 } });
  expect(await pending()).toEqual([]);
  for (const operator of [true, false]) {
    const loaderData = await loader(h.args(h.request("/invites/new", { as: operator ? "bulk_operator" : "bulk_member" })));
    expect(loaderData.mailLanguages).toEqual(operator ? ["ja", "en"] : []);
    const html = await renderInRouter(() => createElement(InvitesNew, { loaderData } as never), "/invites/new");
    expect(html.includes('name="sendEmail"')).toBe(operator);
    expect(/<textarea[^>]*name="email"/.test(html)).toBe(operator);
  }
});
