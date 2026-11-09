import { consentChatMembers } from "./helpers/chat-consent";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createElement } from "react";
import { eq } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { renderInRouter } from "./helpers/render-in-router";
import { chatAccessLog, chatMessages, villageMembers, villages } from "~/lib/db/schema";
import { ensureLanguageVillages } from "~/lib/villages.server";
import { mutateChat } from "~/lib/village-chat.server";
import { createChatReport, moderateChatReport, readChatEvidence } from "~/lib/village-chat-reports.server";
import { grantModerator } from "~/lib/roles.server";
import ModQueue, { loader as queue } from "~/routes/mod";
import ModChat, { loader as review, action as reviewAction } from "~/routes/mod-chat";
import ChatAccess, { loader as access } from "~/routes/chat-access";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { setTestMessages } from "./stubs/paraglide-messages";
import { jsonMessages } from "./helpers/messages-json";

let h: RouteHarness, reportId: number;
const enable = () => { vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1"); vi.stubEnv("OPERATOR_EMAILS", "cdisplay_op@example.com"); };
beforeAll(async () => {
  setTestMessages(jsonMessages()); h = await setupRouteHarness(); enable();
  for (const id of ["cdisplay_writer", "cdisplay_reporter", "cdisplay_second", "cdisplay_mod", "cdisplay_op"]) await h.signIn(id);
  await grantModerator(h.db, h.ids.cdisplay_op, h.ids.cdisplay_mod, "en");
  await ensureLanguageVillages(h.db);
  const [village] = await h.db.select().from(villages).where(eq(villages.language, "en"));
  expect(village.name).toBe("");
  await h.db.insert(villageMembers).values(["cdisplay_writer", "cdisplay_reporter", "cdisplay_second"].map(id => ({ villageId: village.id, userId: h.ids[id] }))).onConflictDoNothing();
  await consentChatMembers(h.db);
  const sent = await mutateChat(h.db, h.ids.cdisplay_writer, "en", "send", { body: "PRIVATE_LANGUAGE_VILLAGE_EVIDENCE" });
  await h.db.update(chatMessages).set({ lang: "en" }).where(eq(chatMessages.id, sent.id));
  reportId = (await createChatReport(h.db, h.ids.cdisplay_reporter, { slug: "en", messageId: sent.id, reason: "spam" })).id;
  await readChatEvidence(h.db, { id: h.ids.cdisplay_op, scope: { operator: true, langs: [] } }, { kind: "report", id: reportId }, { intent: "open" });
}, 60000);
afterEach(() => { setTestLocale("en"); vi.unstubAllEnvs(); });
afterAll(() => { h.restore(); setTestMessages(); });

it.each([["en", "English village"], ["ja", "英語のビレッジ"]] as const)("renders language village names in %s on the card, heading and access row", async (locale, expected) => {
  enable(); setTestLocale(locale);
  const queued = await queue(h.args(h.request("/mod", { as: "cdisplay_op" })));
  const card = await renderInRouter(() => createElement(ModQueue, { loaderData: queued } as Parameters<typeof ModQueue>[0]));
  expect(card).toContain(expected); expect(card).not.toContain("PRIVATE_LANGUAGE_VILLAGE_EVIDENCE");
  const metadata = await review(h.args(h.request(`/mod/chat/report/${reportId}`, { as: "cdisplay_op" }), { kind: "report", caseId: String(reportId) }));
  const heading = await renderInRouter(() => createElement(ModChat, { loaderData: metadata.data } as Parameters<typeof ModChat>[0]));
  expect(heading).toContain(expected); expect(heading).not.toContain("PRIVATE_LANGUAGE_VILLAGE_EVIDENCE");
  const rows = await access(h.args(h.request("/admin/chat-access", { as: "cdisplay_op" })));
  const row = await renderInRouter(() => createElement(ChatAccess, { loaderData: rows.data } as Parameters<typeof ChatAccess>[0]));
  expect(row).toContain(expected); expect(row).toContain('href="/v/en"'); expect(row).not.toContain("PRIVATE_LANGUAGE_VILLAGE_EVIDENCE");
});

const actor = (operator: boolean) => ({ id: h.ids[operator ? "cdisplay_op" : "cdisplay_mod"], scope: { operator, langs: ["en" as const] } });
async function newReport() {
  const sent = await mutateChat(h.db, h.ids.cdisplay_writer, "en", "send", { body: "Private moderation display case" });
  await h.db.update(chatMessages).set({ lang: "en" }).where(eq(chatMessages.id, sent.id));
  const report = await createChatReport(h.db, h.ids.cdisplay_reporter, { slug: "en", messageId: sent.id, reason: "spam" });
  return { sent, report };
}
it("links handled cards to the latest resolved report rather than an earlier dismissal", async () => {
  enable();
  const { sent, report } = await newReport();
  await moderateChatReport(h.db, actor(false), { reportId: report.id, intent: "dismiss", reason: "other", note: "First review" });
  const latest = await createChatReport(h.db, h.ids.cdisplay_second, { slug: "en", messageId: sent.id, reason: "spam" });
  await moderateChatReport(h.db, actor(false), { reportId: latest.id, intent: "hide", reason: "spam", note: "Later review" });
  const queued = await queue(h.args(h.request("/mod?tab=handled", { as: "cdisplay_mod" })));
  const card = queued.cards.find(c => c.kind === "chat" && c.reports.some(r => r.id === report.id));
  expect(card).toMatchObject({ reportId: latest.id, canUnhide: true });
  const html = await renderInRouter(() => createElement(ModQueue, { loaderData: queued } as Parameters<typeof ModQueue>[0]));
  expect(html).toContain(`href="/mod/chat/report/${latest.id}"`);
  expect(html).not.toContain(`href="/mod/chat/report/${report.id}"`);
});

it("hides operator-only restoration links and buttons from language moderators", async () => {
  enable(); const { report } = await newReport();
  await moderateChatReport(h.db, actor(true), { reportId: report.id, intent: "hide", reason: "spam", note: "Operator decision" });
  for (const operator of [false, true]) {
    const as = operator ? "cdisplay_op" : "cdisplay_mod";
    const metadata = await review(h.args(h.request(`/mod/chat/report/${report.id}`, { as }), { kind: "report", caseId: String(report.id) }));
    expect(metadata.data.canUnhide).toBe(operator);
    const page = await renderInRouter(() => createElement(ModChat, { loaderData: metadata.data } as Parameters<typeof ModChat>[0]));
    expect(page.includes('value="unhide"')).toBe(operator);
    const queued = await queue(h.args(h.request("/mod?tab=handled", { as })));
    const html = await renderInRouter(() => createElement(ModQueue, { loaderData: queued } as Parameters<typeof ModQueue>[0]));
    expect(html.includes(`href="/mod/chat/report/${report.id}"`)).toBe(operator);
  }
});

it.each([["en", "cannot start"], ["ja", "始めることはできません"]] as const)("explains reserved context reasons in %s without recording a read", async (locale, expected) => {
  enable(); setTestLocale(locale);
  const metadata = await review(h.args(h.request(`/mod/chat/report/${reportId}`, { as: "cdisplay_op" }), { kind: "report", caseId: String(reportId) }));
  const records = await h.db.select().from(chatAccessLog);
  const rejected = await reviewAction(h.args(h.request(`/mod/chat/report/${reportId}`, { as: "cdisplay_op", form: { intent: "expand", note: " chat:explanation" } }), { kind: "report", caseId: String(reportId) }));
  expect(rejected).toMatchObject({ data: { error: "reserved_reason" }, init: { status: 400 } });
  expect(await h.db.select().from(chatAccessLog)).toEqual(records);
  const html = await renderInRouter(() => createElement(ModChat, { loaderData: metadata.data, actionData: rejected.data } as Parameters<typeof ModChat>[0]));
  expect(html).toContain(expected);
});
