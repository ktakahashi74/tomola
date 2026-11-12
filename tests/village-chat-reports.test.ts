import { consentChatMembers } from "./helpers/chat-consent";
import { afterEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { selectedTables } from "./helpers/query-tables";
import { appeals, chatAccessLog, chatConsents, chatMessages, chatReportSnapshots, jobs, moderationActions, notifications, reports, villageMembers, villages } from "~/lib/db/schema";
import { ChatReportError, createChatReport, listChatAccessLog, moderateChatReport, pruneChatReportSnapshots, readChatEvidence } from "~/lib/village-chat-reports.server";
import { acceptChatConsent, chatChanges, mutateChat } from "~/lib/village-chat.server";
import { listPublicLog, listReportCards, suspendMember } from "~/lib/moderation.server";
import { createAppeal, decideAppeal, getAppealableAction, listOpenAppeals } from "~/lib/appeals.server";
import { changeVillageMembership } from "~/lib/villages.server";
import { listNotifications } from "~/lib/notifications.server";
import { CHAT_CONSENT_VERSION } from "~/lib/village-chat-consent";
import type { Actor } from "~/lib/moderation.server";
import { CHAT_APPEAL_REVIEW_REASON, CHAT_CASE_EXPAND_LIMIT, CHAT_EXPAND_REASON_PREFIX, CHAT_REPORT_REVIEW_REASON, chatAccessFreeReason } from "~/lib/chat-access";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const secret = "PRIVATE_CHAT_BODY_MARKER @cr_reporter";
const moderator: Actor = { id: "cr_mod", scope: { operator: false, langs: ["en"] } };
const reviewer: Actor = { id: "cr_review", scope: { operator: false, langs: ["en"] } };
const operator: Actor = { id: "cr_op", scope: { operator: true, langs: [] } };
async function world() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1"); vi.stubEnv("OPERATOR_EMAILS", "cr_op@example.com");
  const db = await createTestDb();
  for (const id of ["cr_writer", "cr_reporter", "cr_other", "cr_mod", "cr_review", "cr_op", "cr_out"]) await addMember(db, id, id);
  const [village] = await db.insert(villages).values({ slug: "report-chat", name: "Public case village", kind: "invite_public" }).returning();
  await db.insert(villageMembers).values(["cr_writer", "cr_reporter", "cr_other"].map(userId => ({ villageId: village.id, userId, role: userId === "cr_reporter" ? "owner" : "member" })));
  await consentChatMembers(db);
  const sent = await mutateChat(db, "cr_writer", village.slug!, "send", { body: secret });
  await db.update(chatMessages).set({ lang: "en" }).where(eq(chatMessages.id, sent.id));
  const report = () => createChatReport(db, "cr_reporter", { slug: village.slug!, messageId: sent.id, reason: "harassment", note: "Report explanation" });
  return { db, village, sent, report };
}
const hide = (db: Awaited<ReturnType<typeof createTestDb>>, reportId: number, actor = moderator, now?: Date) => moderateChatReport(db, actor, { reportId, intent: "hide", reason: "harassment", note: secret }, { now });

it("accepts a message report from a mixed-case village address", async () => {
  const { db, sent } = await world();
  expect(await createChatReport(db, "cr_reporter", { slug: "Report-Chat", messageId: sent.id, reason: "spam" })).toMatchObject({ id: expect.any(Number) });
  expect(await db.select().from(chatReportSnapshots)).toMatchObject([{ messageId: sent.id, body: secret }]);
});

it("requires current consent for this village before reporting any known message ID", async () => {
  const { db, village, sent, report } = await world();
  const [other] = await db.insert(villages).values({ slug: "other-report-consent", kind: "open" }).returning();
  await db.insert(villageMembers).values({ villageId: other.id, userId: "cr_reporter" });
  await acceptChatConsent(db, "cr_reporter", other.slug!);
  await db.delete(chatConsents).where(eq(chatConsents.villageId, village.id));
  const [hidden] = await db.insert(chatMessages).values({ villageId: village.id, authorId: "cr_writer", body: "Hidden report target", lang: "en", hiddenAt: new Date(), createdSeq: 2, changedSeq: 2 }).returning();
  for (const version of [null, ...Array.from({ length: CHAT_CONSENT_VERSION - 1 }, (_, i) => i + 1), CHAT_CONSENT_VERSION + 1]) {
    if (version !== null) await db.insert(chatConsents).values({ villageId: village.id, userId: "cr_reporter", version }).onConflictDoUpdate({ target: [chatConsents.villageId, chatConsents.userId], set: { version } });
    for (const messageId of [sent.id, hidden.id, "0".repeat(32)]) {
      await expect(createChatReport(db, "cr_reporter", { slug: village.slug!, messageId, reason: "spam" })).rejects.toMatchObject({ code: "not_found" });
    }
    expect(await db.select().from(reports)).toEqual([]);
    expect(await db.select().from(chatReportSnapshots)).toEqual([]);
  }
  await acceptChatConsent(db, "cr_reporter", village.slug!);
  expect(await report()).toMatchObject({ id: expect.any(Number) });
  expect(await db.select().from(reports)).toHaveLength(1);
  expect(await db.select().from(chatReportSnapshots)).toMatchObject([{ messageId: sent.id, body: secret }]);
});

it("accepts only current members, rejects oneself, deleted and hidden messages, and uses the same report once per person", async () => {
  const { db, village, sent, report } = await world();
  for (const id of ["cr_writer", "cr_out"]) await expect(createChatReport(db, id, { slug: village.slug!, messageId: sent.id, reason: "spam" })).rejects.toBeInstanceOf(ChatReportError);
  const first = await report(); await expect(report()).rejects.toMatchObject({ code: "duplicate" });
  await createChatReport(db, "cr_other", { slug: village.slug!, messageId: sent.id, reason: "other" });
  expect(await db.select().from(reports)).toHaveLength(2);
  expect(await db.select().from(chatReportSnapshots)).toHaveLength(1);
  await hide(db, first.id);
  await expect(createChatReport(db, "cr_review", { slug: village.slug!, messageId: sent.id, reason: "spam" })).rejects.toMatchObject({ code: "not_found" });
  await mutateChat(db, "cr_writer", village.slug!, "delete", { id: sent.id });
  await expect(createChatReport(db, "cr_other", { slug: village.slug!, messageId: sent.id, reason: "spam" })).rejects.toMatchObject({ code: "not_found" });
});

it("freezes the first report version and preserves open reports after author editing and deletion", async () => {
  const { db, village, sent, report } = await world(); await report();
  const [before] = await db.select().from(chatReportSnapshots);
  await mutateChat(db, "cr_writer", village.slug!, "edit", { id: sent.id, body: "A corrected private message" });
  await createChatReport(db, "cr_other", { slug: village.slug!, messageId: sent.id, reason: "other" });
  expect(await db.select().from(chatReportSnapshots)).toEqual([before]);
  await mutateChat(db, "cr_writer", village.slug!, "delete", { id: sent.id });
  expect((await db.select().from(reports)).map(row => row.status)).toEqual(["open", "open"]);
  expect((await db.select().from(chatReportSnapshots))[0]).toMatchObject({ body: secret, authorId: "cr_writer", lang: "en", createdSeq: sent.seq, changedSeq: sent.seq });
});

it("groups scoped queue cards without reading evidence bodies and does not grant village outsiders ordinary chat access", async () => {
  const { db, village, sent, report } = await world(); const first = await report();
  await createChatReport(db, "cr_other", { slug: village.slug!, messageId: sent.id, reason: "other" });
  const seen = selectedTables(db);
  const result = await listReportCards(db, moderator.scope, { viewerId: moderator.id }); seen.restore();
  expect(result.cards).toMatchObject([{ kind: "chat", reportId: first.id, lang: "en", village: { name: village.name, language: null }, canUnhide: false, reports: [{ reason: "harassment" }, { reason: "other" }] }]);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(seen.tables.has("chat_report_snapshots")).toBe(false);
  expect((await listReportCards(db, { operator: false, langs: ["ja"] })).cards).toEqual([]);
  expect((await listReportCards(db, moderator.scope, { viewerId: "cr_writer" })).cards).toEqual([]);
  await expect(chatChanges(db, moderator.id, village.slug!, { since: 0 })).rejects.toMatchObject({ code: "not_found" });
});

it("audits every snapshot read, exposes changed current text only through that read, and omits bodies from the audit trail", async () => {
  const { db, village, sent, report } = await world(); const first = await report();
  const target = { kind: "report" as const, id: first.id };
  const opened = await readChatEvidence(db, moderator, target, { intent: "open" });
  expect(opened.snapshot).toMatchObject({ body: secret, author: "cr_writer", changedSeq: sent.seq }); expect(opened.current).toBeNull();
  await mutateChat(db, "cr_writer", village.slug!, "edit", { id: sent.id, body: "CURRENT_PRIVATE_VERSION" });
  const edited = await readChatEvidence(db, moderator, target, { intent: "open" });
  expect(edited.current).toMatchObject({ body: "CURRENT_PRIVATE_VERSION" });
  const logs = await listChatAccessLog(db, operator);
  expect(logs.items).toHaveLength(2); expect(logs.items[0].versions).toHaveLength(2);
  expect(JSON.stringify(logs)).not.toContain(secret); expect(JSON.stringify(logs)).not.toContain("CURRENT_PRIVATE_VERSION");
  await expect(listChatAccessLog(db, moderator)).rejects.toMatchObject({ code: "forbidden" });
  await expect(readChatEvidence(db, { ...moderator, scope: { operator: false, langs: ["ja"] } }, target, { intent: "open" })).rejects.toMatchObject({ code: "forbidden" });
  await expect(readChatEvidence(db, { id: "cr_other", scope: { operator: false, langs: [] } }, target, { intent: "open" })).rejects.toMatchObject({ code: "forbidden" });
  expect(await db.select().from(chatAccessLog)).toHaveLength(2);
});

it("returns ten existing messages on each side, includes hidden context, and expands only from the reader's own case record", async () => {
  const { db, village } = await world();
  const sent: Array<Awaited<ReturnType<typeof mutateChat>>> = [];
  for (let n = 0; n < 45; n++) sent.push(await mutateChat(db, "cr_writer", village.slug!, "send", { body: `Context message ${n}` }));
  const anchor = sent[22];
  await db.update(chatMessages).set({ lang: "en" }).where(eq(chatMessages.id, anchor.id));
  await db.update(chatMessages).set({ hiddenAt: new Date() }).where(eq(chatMessages.id, sent[21].id));
  await mutateChat(db, "cr_writer", village.slug!, "delete", { id: sent[23].id });
  const report = await createChatReport(db, "cr_reporter", { slug: village.slug!, messageId: anchor.id, reason: "spam" });
  const target = { kind: "report" as const, id: report.id };
  const initial = await readChatEvidence(db, moderator, target, { intent: "context" });
  expect(initial.context).toHaveLength(21);
  expect(initial.context.find(row => row.id === sent[21].id)).toMatchObject({ hidden: true, body: "Context message 21" });
  expect(initial.context.some(row => row.id === sent[23].id)).toBe(false);
  expect(initial.context.filter(row => row.createdSeq < anchor.seq)).toHaveLength(10);
  expect(initial.context.filter(row => row.createdSeq > anchor.seq)).toHaveLength(10);
  await expect(readChatEvidence(db, moderator, target, { intent: "expand", previous: initial.logId })).rejects.toMatchObject({ code: "invalid" });
  await expect(readChatEvidence(db, reviewer, target, { intent: "expand", previous: initial.logId, reason: "Earlier context" })).rejects.toMatchObject({ code: "forbidden" });
  const expanded = await readChatEvidence(db, moderator, target, { intent: "expand", previous: initial.logId, reason: "Earlier context" });
  expect(expanded.context).toHaveLength(20);
  expect(expanded.context.some(row => initial.context.some(old => old.id === row.id))).toBe(false);
  const [logged] = (await db.select().from(chatAccessLog)).filter(row => row.id === expanded.logId);
  expect(logged).toMatchObject({ reason: CHAT_EXPAND_REASON_PREFIX + "Earlier context", fromSeq: expanded.from, toSeq: expanded.to });
  expect(chatAccessFreeReason(logged.reason)).toBe("Earlier context");
  expect(logged.versions.map(row => row.id)).toEqual(expanded.context.map(row => row.id));
  expect(logged.ranges.flatMap(range => Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i))).toEqual(expanded.context.map(row => row.createdSeq));
});

it("returns no evidence and rolls back if recording the private read fails", async () => {
  const { db, report } = await world(); const first = await report();
  await db.execute(sql`create function reject_chat_read() returns trigger language plpgsql as $$ begin raise exception 'PRIVATE_CHAT_BODY_MARKER'; end $$`);
  await db.execute(sql`create trigger reject_chat_read before insert on chat_access_log for each row execute function reject_chat_read()`);
  const error = await readChatEvidence(db, moderator, { kind: "report", id: first.id }, { intent: "open" }).catch(error => error);
  expect(error).toMatchObject({ code: "unavailable" }); expect(String(error)).not.toContain("PRIVATE_CHAT_BODY_MARKER");
  expect(await db.select().from(chatAccessLog)).toEqual([]);
});

it("hides via a new sequence, clears mentions, and keeps private bodies and explanations out of notifications and public rows", async () => {
  const { db, village, sent, report } = await world(); const first = await report();
  expect((await db.select().from(notifications)).some(row => row.kind === "chat_mention")).toBe(true);
  const action = await hide(db, first.id);
  expect(action.seq).toBeGreaterThan(sent.seq);
  expect((await chatChanges(db, "cr_writer", village.slug!, { since: sent.seq })).messages[0]).toMatchObject({ hidden: true, parts: [] });
  expect((await db.select().from(notifications)).filter(row => row.kind === "chat_mention")).toEqual([]);
  const notices = await listNotifications(db, "cr_writer");
  expect(JSON.stringify(notices)).not.toContain(secret);
  expect(notices.items[0]).toMatchObject({ kind: "moderation", action: "hide_chat", note: null });
  const publicLog = await listPublicLog(db);
  expect(publicLog.entries[0]).toEqual({ action: "hide_chat", reason: "harassment", place: "village_chat", date: new Date().toISOString().slice(0, 10) });
  expect(JSON.stringify(publicLog)).not.toContain(village.name); expect(JSON.stringify(publicLog)).not.toContain(sent.id);
  await expect(moderateChatReport(db, { ...moderator, scope: { operator: false, langs: ["ja"] } }, { reportId: first.id, intent: "unhide", reason: "other", note: "Restore" })).rejects.toMatchObject({ code: "forbidden" });
});

it("lets a former member see only their own copy and appeal; scopes reviewers and separates actor, author and all reporters", async () => {
  const { db, village, report } = await world(); const first = await report(); const hidden = await hide(db, first.id);
  await changeVillageMembership(db, "cr_writer", village.slug!, "leave");
  expect((await getAppealableAction(db, "cr_writer", hidden.actionId))?.chat).toMatchObject({ body: secret });
  expect(await getAppealableAction(db, "cr_other", hidden.actionId)).toBeNull();
  expect(await getAppealableAction(db, "cr_reporter", hidden.actionId)).toBeNull();
  const appeal = await createAppeal(db, "cr_writer", hidden.actionId, "PRIVATE_APPEAL_STATEMENT"); if (!appeal.ok) throw new Error(appeal.error);
  const listed = await listOpenAppeals(db, reviewer);
  expect(listed.cards).toHaveLength(1); expect(listed.cards[0]).toMatchObject({ chat: { lang: "en" }, entry: null, text: "", note: "", appellantHandle: "" });
  expect(JSON.stringify(listed)).not.toContain(secret); expect(JSON.stringify(listed)).not.toContain("PRIVATE_APPEAL_STATEMENT");
  expect((await listOpenAppeals(db, { ...reviewer, scope: { operator: false, langs: ["ja"] } })).cards).toEqual([]);
  for (const [actor, error] of [[moderator, "own_action"], [{ ...reviewer, id: "cr_writer" }, "own_appeal"], [{ ...reviewer, id: "cr_reporter" }, "reporter"], [{ ...reviewer, scope: { operator: false, langs: ["ja"] } }, "forbidden"]] as const) {
    expect(await decideAppeal(db, actor, appeal.id, { decision: "overturned", note: "Independent decision" })).toMatchObject({ ok: false, error });
  }
  const evidence = await readChatEvidence(db, reviewer, { kind: "appeal", id: appeal.id }, { intent: "open" });
  expect(evidence.statement).toBe("PRIVATE_APPEAL_STATEMENT"); expect(evidence.snapshot?.body).toBe(secret);
  expect(await decideAppeal(db, reviewer, appeal.id, { decision: "overturned", note: "Independent decision" })).toMatchObject({ ok: true, reversed: true });
  expect((await db.select().from(chatMessages))[0].hiddenAt).toBeNull();
});

it("withdraws a hiding decision without resurrecting an author-deleted body", async () => {
  const { db, village, sent, report } = await world(); const first = await report(); const hidden = await hide(db, first.id);
  await mutateChat(db, "cr_writer", village.slug!, "delete", { id: sent.id });
  const appeal = await createAppeal(db, "cr_writer", hidden.actionId, "Please review the decision"); if (!appeal.ok) throw new Error(appeal.error);
  expect(await decideAppeal(db, reviewer, appeal.id, { decision: "overturned", note: "Withdrawn" })).toMatchObject({ ok: true, reversed: false });
  expect((await db.select().from(chatMessages))[0]).toMatchObject({ body: "", deletedAt: expect.any(Date), hiddenAt: null });
  expect((await listPublicLog(db)).entries.map(row => row.action)).toEqual(["unhide_chat", "hide_chat"]);
});

it("dismisses all open reports together without a new sequence or a public chat decision", async () => {
  const { db, village, sent, report } = await world(); const first = await report();
  await createChatReport(db, "cr_other", { slug: village.slug!, messageId: sent.id, reason: "other" });
  expect((await moderateChatReport(db, moderator, { reportId: first.id, intent: "dismiss", reason: "other" })).seq).toBeNull();
  expect((await db.select().from(reports)).map(row => row.status)).toEqual(["dismissed", "dismissed"]);
  expect((await db.select().from(chatMessages))[0].changedSeq).toBe(sent.seq);
  expect((await listPublicLog(db)).entries).toEqual([]);
});

it("allows only an operator to suspend from a chat report and publishes no chat source on the member action", async () => {
  const { db, report } = await world(); const first = await report();
  const input = { userId: "cr_writer", reportId: first.id, days: "3", reason: "harassment", note: "Explanation" };
  expect(await suspendMember(db, moderator, input)).toMatchObject({ ok: false, error: "forbidden" });
  expect(await suspendMember(db, operator, input)).toMatchObject({ ok: true });
  expect((await listPublicLog(db)).entries[0]).toEqual({ action: "suspend", reason: "harassment", lang: null, date: new Date().toISOString().slice(0, 10) });
});

it.each(["", "1"])("blocks new reports while chat is closed, but finishes existing cases with VILLAGES=%s", async villagesFlag => {
  const { db, village, sent, report } = await world(); const first = await report();
  vi.stubEnv("VILLAGE_CHAT", ""); vi.stubEnv("VILLAGES", villagesFlag);
  const seen = selectedTables(db); await expect(report()).rejects.toMatchObject({ code: "not_found" }); expect(seen.tables.size).toBe(0); seen.restore();
  expect((await listReportCards(db, moderator.scope)).cards).toHaveLength(1);
  expect((await readChatEvidence(db, moderator, { kind: "report", id: first.id }, { intent: "open" })).snapshot?.body).toBe(secret);
  const hidden = await hide(db, first.id);
  expect((await getAppealableAction(db, "cr_writer", hidden.actionId))?.chat?.body).toBe(secret);
  const appeal = await createAppeal(db, "cr_writer", hidden.actionId, "Please review"); if (!appeal.ok) throw new Error(appeal.error);
  expect(await decideAppeal(db, reviewer, appeal.id, { decision: "overturned", note: "Accepted" })).toMatchObject({ ok: true });
  expect((await listPublicLog(db)).entries).toHaveLength(2);
  expect((await db.select().from(chatMessages).where(eq(chatMessages.id, sent.id)))[0].hiddenAt).toBeNull();
  expect((await listChatAccessLog(db, operator)).items).toHaveLength(1);
  expect((await listNotifications(db, "cr_writer")).items.some(row => row.action === "hide_chat")).toBe(true);
});

it("waits 180 days after all reports and appeals finish, then prunes only the body", async () => {
  const { db, report } = await world(); const first = await report(); const start = new Date();
  const hidden = await hide(db, first.id, moderator, start);
  const appeal = await createAppeal(db, "cr_writer", hidden.actionId, "Please review"); if (!appeal.ok) throw new Error(appeal.error);
  const day = (n: number) => new Date(start.getTime() + n * 86400000);
  expect(await pruneChatReportSnapshots(db, day(181))).toBe(0);
  await decideAppeal(db, reviewer, appeal.id, { decision: "upheld", note: "Reviewed" }, { now: day(181) });
  expect(await pruneChatReportSnapshots(db, day(360))).toBe(0);
  expect(await pruneChatReportSnapshots(db, day(362))).toBe(1);
  expect((await db.select().from(chatReportSnapshots))[0]).toMatchObject({ body: null, lang: "en", authorId: "cr_writer", prunedAt: day(362) });
  expect(await pruneChatReportSnapshots(db, day(400))).toBe(0);
  expect(await db.select().from(appeals)).toHaveLength(1); expect(await db.select().from(reports)).toHaveLength(1);
});

it("does not read private chat tables on legacy-only queue, public log and notification pages", async () => {
  vi.stubEnv("VILLAGES", ""); vi.stubEnv("VILLAGE_CHAT", "");
  const db = await createTestDb(); await addMember(db, "legacy", "legacy");
  const seen = selectedTables(db);
  await listReportCards(db, operator.scope); await listPublicLog(db); await listNotifications(db, "legacy");
  seen.restore();
  for (const table of ["chat_messages", "chat_report_snapshots", "chat_access_log", "villages"]) expect(seen.tables.has(table)).toBe(false);
  expect(await db.select().from(jobs)).toEqual([]); expect(await db.select().from(moderationActions)).toEqual([]);
});


it("matches posting's author-deletion restriction and never cascades away chat evidence", async () => {
  const { db, report } = await world(); await report();
  const result = await db.execute(sql`select c.confdeltype, c.conrelid::regclass::text as target from pg_constraint c where c.contype='f' and c.conname in ('entries_author_id_user_id_fk', 'chat_messages_author_id_user_id_fk') order by target`) as { rows: Array<{ confdeltype: string; target: string }> };
  expect(result.rows).toHaveLength(2); expect(result.rows.map(row => row.confdeltype)).toEqual(["a", "a"]);
});

it.each(["resolved", "dismissed"] as const)("rejects every evidence read after a report is %s, without an audit entry, while preserving restore", async status => {
  const { db, report } = await world(); const first = await report();
  const target = { kind: "report" as const, id: first.id };
  await readChatEvidence(db, moderator, target, { intent: "open" });
  const context = await readChatEvidence(db, moderator, target, { intent: "context" });
  await moderateChatReport(db, moderator, { reportId: first.id, intent: status === "resolved" ? "hide" : "dismiss", reason: "spam", note: "Case finished" });
  const before = await db.select().from(chatAccessLog);
  for (const intent of ["open", "context", "expand"] as const) await expect(readChatEvidence(db, moderator, target, { intent, previous: context.logId, reason: "More context" })).rejects.toMatchObject({ code: "case_closed" });
  expect(await db.select().from(chatAccessLog)).toEqual(before);
  if (status === "resolved") expect(await moderateChatReport(db, moderator, { reportId: first.id, intent: "unhide", reason: "other", note: "Restore without reading" })).toHaveProperty("actionId");
});

it.each(["upheld", "overturned"] as const)("rejects every evidence read after an appeal is %s without an audit entry, preserving the author's copy", async decision => {
  const { db, report } = await world(); const first = await report(); const hidden = await hide(db, first.id);
  const appeal = await createAppeal(db, "cr_writer", hidden.actionId, "Review this decision"); if (!appeal.ok) throw new Error(appeal.error);
  const target = { kind: "appeal" as const, id: appeal.id };
  expect((await readChatEvidence(db, reviewer, target, { intent: "open" })).snapshot?.body).toBe(secret);
  const context = await readChatEvidence(db, reviewer, target, { intent: "context" });
  expect(await decideAppeal(db, reviewer, appeal.id, { decision, note: "Review finished" })).toMatchObject({ ok: true });
  const before = await db.select().from(chatAccessLog);
  for (const intent of ["open", "context", "expand"] as const) await expect(readChatEvidence(db, reviewer, target, { intent, previous: context.logId, reason: "More context" })).rejects.toMatchObject({ code: "case_closed" });
  expect(await db.select().from(chatAccessLog)).toEqual(before);
  expect((await getAppealableAction(db, "cr_writer", hidden.actionId))?.chat?.body).toBe(secret);
});

it.each(["report", "appeal"] as const)("limits %s expansions per reader and case, including replay and empty windows", async kind => {
  const { db, village, sent, report } = await world(); const first = await report();
  const second = await createChatReport(db, "cr_other", { slug: village.slug!, messageId: sent.id, reason: "other" });
  let target = { kind, id: first.id };
  let reader = moderator, otherReader = reviewer;
  if (kind === "appeal") {
    const hidden = await hide(db, first.id);
    const appeal = await createAppeal(db, "cr_writer", hidden.actionId, "Review this decision"); if (!appeal.ok) throw new Error(appeal.error);
    target = { kind, id: appeal.id }; reader = reviewer; otherReader = operator;
  }
  await readChatEvidence(db, reader, target, { intent: "open" });
  const context = await readChatEvidence(db, reader, target, { intent: "context" });
  for (let n = 0; n < CHAT_CASE_EXPAND_LIMIT; n++) await readChatEvidence(db, reader, target, { intent: "expand", previous: context.logId, reason: "More context" });
  const before = await db.select().from(chatAccessLog);
  const reset = await readChatEvidence(db, reader, target, { intent: "context" });
  await expect(readChatEvidence(db, reader, target, { intent: "expand", previous: reset.logId, reason: "Start again" })).rejects.toMatchObject({ code: "expand_limit" });
  expect(await db.select().from(chatAccessLog)).toHaveLength(before.length + 1);
  const other = await readChatEvidence(db, otherReader, target, { intent: "context" });
  expect(await readChatEvidence(db, otherReader, target, { intent: "expand", previous: other.logId, reason: "Separate reader" })).toHaveProperty("logId");
  {
    let otherCase = { kind, id: second.id };
    if (kind === "appeal") {
      const message = await mutateChat(db, "cr_writer", village.slug!, "send", { body: "Separate appeal case" });
      await db.update(chatMessages).set({ lang: "en" }).where(eq(chatMessages.id, message.id));
      const report = await createChatReport(db, "cr_reporter", { slug: village.slug!, messageId: message.id, reason: "other" });
      const hidden = await hide(db, report.id);
      const appeal = await createAppeal(db, "cr_writer", hidden.actionId, "Separate review"); if (!appeal.ok) throw new Error(appeal.error);
      otherCase = { kind, id: appeal.id };
    }
    await expect(readChatEvidence(db, reader, otherCase, { intent: "expand", previous: context.logId, reason: "Wrong case" })).rejects.toMatchObject({ code: "forbidden" });
    const separate = await readChatEvidence(db, reader, otherCase, { intent: "context" });
    expect(await readChatEvidence(db, reader, otherCase, { intent: "expand", previous: separate.logId, reason: "Separate case" })).toHaveProperty("logId");
  }
  const logs = await db.select().from(chatAccessLog);
  expect(logs[0].reason).toBe(kind === "report" ? CHAT_REPORT_REVIEW_REASON : CHAT_APPEAL_REVIEW_REASON);
});

it("rejects moderator-authors' reads and decisions, and preserves moderators handling their own reports", async () => {
  const { db, report } = await world(); const first = await report();
  const author = { ...moderator, id: "cr_writer" }, target = { kind: "report" as const, id: first.id };
  for (const intent of ["open", "context", "expand"] as const) await expect(readChatEvidence(db, author, target, { intent, previous: 1, reason: "Context" })).rejects.toMatchObject({ code: "forbidden" });
  await expect(hide(db, first.id, author)).rejects.toMatchObject({ code: "forbidden" });
  expect(await db.select().from(chatAccessLog)).toEqual([]);
  const reporter = { ...moderator, id: "cr_reporter" };
  expect((await readChatEvidence(db, reporter, target, { intent: "open" })).snapshot?.body).toBe(secret);
  expect(await hide(db, first.id, reporter)).toHaveProperty("actionId");
});

it("keeps reports with a null copied author in the scoped queue", async () => {
  const { db, report } = await world(); const first = await report();
  await db.update(reports).set({ chatAuthorId: null }).where(eq(reports.id, first.id));
  expect((await listReportCards(db, moderator.scope, { viewerId: moderator.id })).cards).toMatchObject([{ kind: "chat", reportId: first.id }]);
});

it.each(["open", "invite_public"])("shows %s village names in audit records, drops village IDs, and removes ended village links", async kind => {
  const { db, village, report } = await world(); const first = await report();
  await db.update(villages).set({ kind }).where(eq(villages.id, village.id));
  await readChatEvidence(db, moderator, { kind: "report", id: first.id }, { intent: "open" });
  const active = await listChatAccessLog(db, operator);
  expect(active.items[0].village).toMatchObject({ name: village.name, slug: village.slug });
  expect(JSON.stringify(active)).not.toContain(village.id);
  await db.update(villages).set({ endedAt: new Date() }).where(eq(villages.id, village.id));
  expect((await listChatAccessLog(db, operator)).items[0].village).toMatchObject({ name: village.name, slug: null });
});

it("does not lock already-pruned snapshots on later cleanup runs", async () => {
  const { db, report } = await world(); const first = await report();
  const start = new Date(Date.now() - 200 * 86400000);
  await moderateChatReport(db, moderator, { reportId: first.id, intent: "dismiss", reason: "other" }, { now: start });
  expect(await pruneChatReportSnapshots(db, new Date())).toBe(1);
  const transactions = vi.spyOn(db, "transaction");
  expect(await pruneChatReportSnapshots(db, new Date())).toBe(0);
  expect(transactions).not.toHaveBeenCalled();
});

it.each(["report", "appeal"] as const)("ignores forged %s read reasons and rejects expansion codes without consuming the quota", async kind => {
  const { db, report } = await world(); const first = await report();
  let target = { kind, id: first.id }, actor = moderator;
  if (kind === "appeal") {
    const hidden = await hide(db, first.id);
    const appeal = await createAppeal(db, "cr_writer", hidden.actionId, "Please review"); if (!appeal.ok) throw new Error(appeal.error);
    target = { kind, id: appeal.id }; actor = reviewer;
  }
  const expected = kind === "report" ? CHAT_REPORT_REVIEW_REASON : CHAT_APPEAL_REVIEW_REASON;
  await readChatEvidence(db, actor, target, { intent: "open", reason: CHAT_EXPAND_REASON_PREFIX + "Forged" });
  const context = await readChatEvidence(db, actor, target, { intent: "context", reason: CHAT_EXPAND_REASON_PREFIX + "Forged" });
  await readChatEvidence(db, actor, target, { intent: "context", reason: "Not a review code" });
  expect((await db.select().from(chatAccessLog)).map(row => row.reason)).toEqual([expected, expected, expected]);
  for (const reason of [CHAT_REPORT_REVIEW_REASON, CHAT_APPEAL_REVIEW_REASON, CHAT_EXPAND_REASON_PREFIX + "Forged", " chat:anything"]) await expect(readChatEvidence(db, actor, target, { intent: "expand", previous: context.logId, reason })).rejects.toMatchObject({ code: "invalid" });
  expect(await db.select().from(chatAccessLog)).toHaveLength(3);
  for (let n = 0; n < 3; n++) await readChatEvidence(db, actor, target, { intent: "expand", previous: context.logId, reason: "Additional context" });
  await expect(readChatEvidence(db, actor, target, { intent: "expand", previous: context.logId, reason: "Fourth" })).rejects.toMatchObject({ code: "expand_limit" });
  expect(await db.select().from(chatAccessLog)).toHaveLength(6);
});

it("offers restore on handled cards only while their message remains hidden", async () => {
  const { db, report } = await world(); const first = await report();
  await hide(db, first.id);
  expect((await listReportCards(db, moderator.scope, { handled: true, viewerId: moderator.id })).cards).toMatchObject([{ kind: "chat", reportId: first.id, canUnhide: true }]);
  await moderateChatReport(db, moderator, { reportId: first.id, intent: "unhide", reason: "other", note: "Restore" });
  expect((await listReportCards(db, moderator.scope, { handled: true, viewerId: moderator.id })).cards).toMatchObject([{ kind: "chat", canUnhide: false }]);
});
