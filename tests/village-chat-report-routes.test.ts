import { consentChatMembers } from "./helpers/chat-consent";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { chatAccessLog, chatMessages, chatMessageTranslations, chatTranslationReports, villageMembers, villages } from "~/lib/db/schema";
import { action as chatAction } from "~/routes/village-chat";
import { chatSourceHash } from "~/lib/village-chat-translations.server";
import { grantModerator } from "~/lib/roles.server";
import { mutateChat } from "~/lib/village-chat.server";
import { createChatReport, moderateChatReport } from "~/lib/village-chat-reports.server";
import { createAppeal } from "~/lib/appeals.server";
import { loader as review, action as read } from "~/routes/mod-chat";
import { loader as queue } from "~/routes/mod";
import { loader as access } from "~/routes/chat-access";
import { loader as ownAppeal } from "~/routes/appeal";
import { stopVillageChat } from "~/lib/village-chat-events.server";

let h: RouteHarness, reportId: number, messageId: string;
const secret = "PRIVATE_ROUTE_CHAT_MARKER";
const enable = () => { vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1"); vi.stubEnv("OPERATOR_EMAILS", "crroute_op@example.com"); };
const args = (as: string, kind = "report", id = reportId, form?: Record<string, string>) => h.args(h.request(`/mod/chat/${kind}/${id}`, { as, form }), { kind, caseId: String(id) });
beforeAll(async () => {
  h = await setupRouteHarness(); enable();
  for (const id of ["crroute_writer", "crroute_reporter", "crroute_mod", "crroute_wrong", "crroute_op"]) await h.signIn(id);
  await grantModerator(h.db, h.ids.crroute_op, h.ids.crroute_mod, "en"); await grantModerator(h.db, h.ids.crroute_op, h.ids.crroute_wrong, "ja");
  const [village] = await h.db.insert(villages).values({ slug: "chat-route-review", kind: "open", name: "Review route village" }).returning();
  await h.db.insert(villageMembers).values(["crroute_writer", "crroute_reporter"].map(id => ({ villageId: village.id, userId: h.ids[id] })));
  await consentChatMembers(h.db);
  const sent = await mutateChat(h.db, h.ids.crroute_writer, village.slug!, "send", { body: secret }); messageId = sent.id;
  await h.db.update(chatMessages).set({ lang: "en" }).where(eq(chatMessages.id, sent.id));
  reportId = (await createChatReport(h.db, h.ids.crroute_reporter, { slug: village.slug!, messageId, reason: "spam" })).id;
}, 60000);
afterAll(() => h.restore());
afterEach(() => { stopVillageChat(); vi.unstubAllEnvs(); });

it("accepts both report forms posted to a mixed-case chat address", async () => {
  enable();
  vi.stubEnv("ENABLED_LANGS", "ja,en");
  const sent = await mutateChat(h.db, h.ids.crroute_writer, "chat-route-review", "send", { body: "日本語の発言です。" });
  await h.db.insert(chatMessageTranslations).values({ messageId: sent.id, lang: "en", sourceHash: chatSourceHash("日本語の発言です。"), text: "Translation", state: "ready" });
  for (const intent of ["flag", "translation-report"]) {
    const request = h.request("/v/Chat-Route-Review/chat", { as: "crroute_reporter", form: { intent, id: sent.id, reason: "spam", lang: "en" } });
    const result = await h.outcome(() => chatAction(h.args(request, { slug: "Chat-Route-Review" })));
    expect(result.status).toBe(intent === "flag" ? 302 : 200);
  }
  expect(await h.db.select().from(chatTranslationReports)).toMatchObject([{ messageId: sent.id }]);
});

it("GET returns metadata only; POST reads are private, recorded each time, scoped and CSRF-protected", async () => {
  enable();
  const before = (await h.db.select().from(chatAccessLog)).length;
  expect((await h.outcome(() => read(args("crroute_mod", "report", reportId, { intent: "expand", previous: "-1", note: "More context" })))).status).toBe(400);
  const metadata = await h.outcome(() => review(args("crroute_mod")));
  expect(metadata.status).toBe(200); expect(JSON.stringify(metadata)).not.toContain(secret);
  expect(await h.db.select().from(chatAccessLog)).toHaveLength(before);
  const queued = await h.outcome(() => queue(h.args(h.request("/mod", { as: "crroute_mod" })))); expect(JSON.stringify(queued)).not.toContain(secret);
  for (let n = 0; n < 2; n++) {
    const result = await read(args("crroute_mod", "report", reportId, { intent: "open" }));
    expect(result.init?.headers).toMatchObject({ "Cache-Control": "private, no-store" });
    expect(JSON.stringify(result.data)).toContain(secret);
  }
  expect(await h.db.select().from(chatAccessLog)).toHaveLength(before + 2);
  for (const as of ["crroute_wrong", "crroute_reporter"]) expect((await h.outcome(() => read(args(as, "report", reportId, { intent: "open" })))).status).toBeGreaterThanOrEqual(400);
  const cross = h.args(h.request(`/mod/chat/report/${reportId}`, { as: "crroute_mod", form: { intent: "open" }, headers: { Origin: "https://other.example" } }), { kind: "report", caseId: String(reportId) });
  expect((await h.outcome(() => read(cross))).status).toBe(403);
  expect(await h.db.select().from(chatAccessLog)).toHaveLength(before + 2);
});

it("continues recorded case reads and operator audit access after closing, and keeps an author's appeal copy private", async () => {
  enable();
  const hidden = await moderateChatReport(h.db, { id: h.ids.crroute_mod, scope: { operator: false, langs: ["en"] } }, { reportId, intent: "hide", reason: "spam", note: "Reason" });
  const appeal = await createAppeal(h.db, h.ids.crroute_writer, hidden.actionId, "Please review"); if (!appeal.ok) throw new Error(appeal.error);
  vi.stubEnv("VILLAGES", ""); vi.stubEnv("VILLAGE_CHAT", "");
  const result = await read(args("crroute_op", "appeal", appeal.id, { intent: "open" })); expect(JSON.stringify(result)).toContain(secret);
  const closed = await h.outcome(() => read(args("crroute_mod", "report", reportId, { intent: "open" })));
  expect(closed).toMatchObject({ status: 409 }); expect(JSON.stringify(closed)).not.toContain(secret);
  const metadata = await review(args("crroute_mod")); expect(metadata.data).toMatchObject({ closed: true, canHide: false, canUnhide: true, canDismiss: false });
  const mine = await ownAppeal(h.args(h.request(`/appeal/${hidden.actionId}`, { as: "crroute_writer" }), { actionId: String(hidden.actionId) }));
  expect(JSON.stringify(mine)).toContain(secret); expect("init" in mine && mine.init?.headers).toMatchObject({ "Cache-Control": "private, no-store" });
  expect((await h.outcome(() => ownAppeal(h.args(h.request(`/appeal/${hidden.actionId}`, { as: "crroute_reporter" }), { actionId: String(hidden.actionId) })))).status).toBe(404);
  expect((await h.outcome(() => access(h.args(h.request("/admin/chat-access", { as: "crroute_mod" }))))).status).toBe(404);
  const audit = await h.outcome(() => access(h.args(h.request("/admin/chat-access", { as: "crroute_op" })))); expect(audit.status).toBe(200); expect(JSON.stringify(audit)).not.toContain(secret);
});

it("returns a generic failure without the body when inserting the read record fails", async () => {
  enable();
  const sent = await mutateChat(h.db, h.ids.crroute_writer, "chat-route-review", "send", { body: secret });
  await h.db.update(chatMessages).set({ lang: "en" }).where(eq(chatMessages.id, sent.id));
  const pending = await createChatReport(h.db, h.ids.crroute_reporter, { slug: "chat-route-review", messageId: sent.id, reason: "spam" });
  await h.db.execute(sql`create function reject_route_chat_read() returns trigger language plpgsql as $$ begin raise exception 'PRIVATE_ROUTE_CHAT_MARKER'; end $$`);
  await h.db.execute(sql`create trigger reject_route_chat_read before insert on chat_access_log for each row execute function reject_route_chat_read()`);
  const result = await h.outcome(() => read(args("crroute_mod", "report", pending.id, { intent: "open" })));
  expect(result.status).toBe(503); expect(JSON.stringify(result)).not.toContain(secret);
});
