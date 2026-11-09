import { consentChatMembers } from "./helpers/chat-consent";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { expectSettlesWithin, holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { addMember } from "./helpers/db";
import { chatAccessLog, chatMessages, chatReportSnapshots, chatSequences, profiles, reports, villageMembers, villages } from "~/lib/db/schema";
import { createChatReport, moderateChatReport, pruneChatReportSnapshots, readChatEvidence } from "~/lib/village-chat-reports.server";
import { createAppeal, decideAppeal } from "~/lib/appeals.server";
import { mutateChat } from "~/lib/village-chat.server";
import { changeVillageMembership } from "~/lib/villages.server";
import { suspendMember } from "~/lib/moderation.server";

describe.skipIf(!REAL_PG_URL)("chat report concurrency on PostgreSQL", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb, seq = 0;
  beforeAll(async () => { scratch = await createScratchDb(); }, 60000);
  afterEach(async () => { await scratch.closeOpened(); vi.unstubAllEnvs(); });
  afterAll(async () => { await scratch?.drop(); });
  async function world() {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
    const db = await scratch.open("setup"), suffix = ++seq;
    const writer = `crpg_writer${suffix}`, reporter = `crpg_reporter${suffix}`, mod = `crpg_mod${suffix}`, owner = `crpg_owner${suffix}`;
    for (const id of [writer, reporter, mod, owner]) await addMember(db, id, id);
    const [village] = await db.insert(villages).values({ slug: `chat-report-${suffix}`, name: "Concurrent case", kind: "open" }).returning();
    await db.insert(villageMembers).values([writer, reporter, owner].map(userId => ({ villageId: village.id, userId, role: userId === owner ? "owner" : "member" })));
    await consentChatMembers(db);
    const sent = await mutateChat(db, writer, village.slug!, "send", { body: "Private concurrent message" });
    await db.update(chatMessages).set({ lang: "en" }).where(eq(chatMessages.id, sent.id));
    const input = { slug: village.slug!, messageId: sent.id, reason: "spam" };
    const actor = { id: mod, scope: { operator: false, langs: ["en" as const] } };
    return { db, village, writer, reporter, mod, owner, sent, input, actor };
  }
  it("captures the committed edited version after waiting for the author's message lock", async () => {
    const w = await world(), author = await scratch.open("editing"), reporter = await scratch.open("report-wait"), admin = await scratch.admin();
    const held = holdTx(author, async tx => {
      const edited = await mutateChat(tx, w.writer, w.village.slug!, "edit", { id: w.sent.id, body: "Committed private correction" });
      await tx.update(chatMessages).set({ lang: "en" }).where(eq(chatMessages.id, w.sent.id)); return edited;
    });
    const edited = await held.ready;
    const reporting = createChatReport(reporter, w.reporter, w.input);
    try { await waitForLockWait(admin, "report-wait"); } finally { await held.commit(); }
    await expectSettlesWithin(reporting, 10000, "report after author edit");
    expect((await w.db.select().from(chatReportSnapshots).where(eq(chatReportSnapshots.messageId, w.sent.id)))[0]).toMatchObject({ body: "Committed private correction", changedSeq: edited.seq });
  });
  it("serializes membership departure after report acceptance without dropping the case", async () => {
    const w = await world(), accepting = await scratch.open("accepting"), leaving = await scratch.open("leave-wait"), admin = await scratch.admin();
    const held = holdTx(accepting, tx => createChatReport(tx, w.reporter, w.input)); await held.ready;
    const departed = changeVillageMembership(leaving, w.reporter, w.village.slug!, "leave");
    try { await waitForLockWait(admin, "leave-wait"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(departed, 10000, "leave after report acceptance")).toBe(true);
    expect((await w.db.select().from(reports).where(eq(reports.chatMessageId, w.sent.id)))[0].status).toBe("open");
  });
  it("does not return a body until the audit insertion commits", async () => {
    const w = await world(), locking = await scratch.open("audit-lock"), reading = await scratch.open("read-wait"), admin = await scratch.admin();
    const report = await createChatReport(w.db, w.reporter, w.input);
    const held = holdTx(locking, tx => tx.execute(sql`lock table chat_access_log in share mode`)); await held.ready;
    let returned = false;
    const result = readChatEvidence(reading, w.actor, { kind: "report", id: report.id }, { intent: "open" }).then(value => { returned = true; return value; });
    try { await waitForLockWait(admin, "read-wait"); expect(returned).toBe(false); } finally { await held.commit(); }
    const evidence = await expectSettlesWithin(result, 10000, "audited private read");
    expect(evidence.snapshot?.body).toBe("Private concurrent message");
    expect(await w.db.select().from(chatAccessLog).where(eq(chatAccessLog.id, evidence.logId))).toHaveLength(1);
  });
  it.each(["report", "appeal"] as const)("rechecks %s closure after a concurrent decision commits", async kind => {
    const w = await world(), deciding = await scratch.open("decision-held"), reading = await scratch.open("closed-read-wait"), admin = await scratch.admin();
    const report = await createChatReport(w.db, w.reporter, w.input);
    let target = { kind, id: report.id }, actor = w.actor;
    if (kind === "appeal") {
      const hidden = await moderateChatReport(w.db, w.actor, { reportId: report.id, intent: "hide", reason: "spam", note: "Decision" });
      const appeal = await createAppeal(w.db, w.writer, hidden.actionId, "Review"); if (!appeal.ok) throw new Error(appeal.error);
      target = { kind, id: appeal.id }; actor = { ...w.actor, id: w.owner };
    }
    const held = holdTx(deciding, async tx => {
      if (kind === "report") await moderateChatReport(tx, w.actor, { reportId: report.id, intent: "dismiss", reason: "other" });
      else expect(await decideAppeal(tx, actor, target.id, { decision: "upheld", note: "Decided" })).toMatchObject({ ok: true });
    });
    await held.ready;
    const result = readChatEvidence(reading, actor, target, { intent: "open" }).catch(error => error);
    try { await waitForLockWait(admin, "closed-read-wait"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(result, 10000, "read after decision")).toMatchObject({ code: "case_closed" });
    expect(await w.db.select().from(chatAccessLog).where(kind === "report" ? eq(chatAccessLog.reportId, target.id) : eq(chatAccessLog.appealId, target.id))).toEqual([]);
  });
  it("serializes competing expansions so a fourth read cannot pass the quota", async () => {
    const w = await world(), thirdDb = await scratch.open("third-expansion"), fourthDb = await scratch.open("fourth-expansion-wait"), admin = await scratch.admin();
    const report = await createChatReport(w.db, w.reporter, w.input), target = { kind: "report" as const, id: report.id };
    const context = await readChatEvidence(w.db, w.actor, target, { intent: "context" });
    const input = { intent: "expand" as const, previous: context.logId, reason: "More context" };
    for (let n = 0; n < 2; n++) await readChatEvidence(w.db, w.actor, target, input);
    const held = holdTx(thirdDb, tx => readChatEvidence(tx, w.actor, target, input)); await held.ready;
    const fourth = readChatEvidence(fourthDb, w.actor, target, input).catch(error => error);
    try { await waitForLockWait(admin, "fourth-expansion-wait"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(fourth, 10000, "fourth expansion")).toMatchObject({ code: "expand_limit" });
    expect(await w.db.select().from(chatAccessLog).where(eq(chatAccessLog.reportId, report.id))).toHaveLength(4);
  });
  it("waits for suspension to resolve a report without a message lock, then rejects the closed read", async () => {
    const w = await world(), suspending = await scratch.open("suspension-held"), reading = await scratch.open("suspension-read-wait"), admin = await scratch.admin();
    const report = await createChatReport(w.db, w.reporter, w.input);
    const held = holdTx(suspending, tx => suspendMember(tx, { id: w.owner, scope: { operator: true, langs: [] } }, { userId: w.writer, reportId: report.id, days: "3", reason: "spam", note: "Suspension decision" }));
    expect(await held.ready).toMatchObject({ ok: true });
    const result = readChatEvidence(reading, w.actor, { kind: "report", id: report.id }, { intent: "open" }).catch(error => error);
    try { await waitForLockWait(admin, "suspension-read-wait"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(result, 10000, "read after suspension")).toMatchObject({ code: "case_closed" });
    expect(await w.db.select().from(chatAccessLog).where(eq(chatAccessLog.reportId, report.id))).toEqual([]);
    expect((await w.db.select().from(chatMessages).where(eq(chatMessages.id, w.sent.id)))[0].hiddenAt).toBeNull();
  });
  it("rechecks a pending appeal after waiting for its message lock instead of pruning the evidence", async () => {
    const w = await world(), appealing = await scratch.open("filing-appeal"), pruning = await scratch.open("prune-wait"), admin = await scratch.admin();
    const report = await createChatReport(w.db, w.reporter, w.input);
    const hidden = await moderateChatReport(w.db, w.actor, { reportId: report.id, intent: "hide", reason: "spam", note: "Decision" }, { now: new Date(Date.now() - 200 * 86400000) });
    const held = holdTx(appealing, tx => createAppeal(tx, w.writer, hidden.actionId, "Pending appeal"));
    expect(await held.ready).toMatchObject({ ok: true });
    const pruned = pruneChatReportSnapshots(pruning, new Date());
    try { await waitForLockWait(admin, "prune-wait"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(pruned, 10000, "pruning after appeal filing")).toBe(0);
    expect((await w.db.select().from(chatReportSnapshots).where(eq(chatReportSnapshots.messageId, w.sent.id)))[0].body).toBe("Private concurrent message");
  });
  it("keeps village and message locks while waiting at the last allocator and does not lock profiles", async () => {
    const w = await world(), horizon = await scratch.open("horizon"), mod = await scratch.open("moderation-wait"), author = await scratch.open("delete-wait"), admin = await scratch.admin();
    const report = await createChatReport(w.db, w.reporter, w.input);
    const held = holdTx(horizon, tx => tx.select().from(chatSequences).where(eq(chatSequences.villageId, w.village.id)).for("update")); await held.ready;
    const hiding = moderateChatReport(mod, w.actor, { reportId: report.id, intent: "hide", reason: "spam", note: "Decision" });
    let deleting: ReturnType<typeof mutateChat> | undefined;
    try {
      await waitForLockWait(admin, "moderation-wait");
      deleting = mutateChat(author, w.writer, w.village.slug!, "delete", { id: w.sent.id });
      await waitForLockWait(admin, "delete-wait");
    } finally { await held.commit(); }
    const hidden = await expectSettlesWithin(hiding, 10000, "hiding at allocator");
    const deleted = await expectSettlesWithin(deleting!, 10000, "author deletion after hiding");
    expect(deleted.seq).toBeGreaterThan(hidden.seq!);
    const second = await mutateChat(w.db, w.writer, w.village.slug!, "send", { body: "Another private message" });
    await w.db.update(chatMessages).set({ lang: "en" }).where(eq(chatMessages.id, second.id));
    const next = await createChatReport(w.db, w.reporter, { ...w.input, messageId: second.id });
    const profileDb = await scratch.open("profiles-held");
    const profilesHeld = holdTx(profileDb, tx => tx.select().from(profiles).where(inArray(profiles.userId, [w.writer, w.mod])).for("update")); await profilesHeld.ready;
    try { expect(await expectSettlesWithin(moderateChatReport(mod, w.actor, { reportId: next.id, intent: "hide", reason: "spam", note: "Decision" }), 2500, "moderation without profile locks")).toHaveProperty("actionId"); }
    finally { await profilesHeld.rollback(); }
  });
});
