import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleDraftCreate } from "~/lib/api/drafts-api.server";
import { authenticateRead } from "~/lib/api/read-auth.server";
import { moderationActions, profiles, reports } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { getWriter } from "~/lib/members.server";
import { createReport, dismissReports, hideEntry, suspendMember, unsuspendMember, type Actor } from "~/lib/moderation.server";
import { signOpenInAiToken } from "~/lib/open-in-ai.server";
import { grantModerator, type ModScope } from "~/lib/roles.server";
import { createApiToken } from "~/lib/tokens.server";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Suspension is time-limited and blocks only writes; login, reading, and appeals remain available.
const DAY = 24 * 60 * 60 * 1000;
const JA_MOD: ModScope = { operator: false, langs: ["ja"] };
const OPERATOR: ModScope = { operator: true, langs: [] };
const actor = (id: string, scope: ModScope): Actor => ({ id, scope });
const now = new Date("2026-10-10T00:00:00Z");

async function setup() {
  const db = await createTestDb();
  await addMember(db, "author", "hana", { readLangs: ["ja"] });
  await addMember(db, "reporter", "taro", { readLangs: ["ja"] });
  await addMember(db, "jamod", "moriko", { readLangs: ["ja"] });
  await addMember(db, "enmod", "mary", { readLangs: ["en"] });
  await addMember(db, "op", "opal", { readLangs: ["ja"], email: "opal@example.com" });
  const ja = await createTopic(db, "author", { lang: "ja", title: "日本語", body: "本文" });
  const en = await createTopic(db, "author", { lang: "en", title: "English", body: "Body" });
  if (!ja.ok || !en.ok) throw new Error("topic failed");
  const report = await createReport(db, "reporter", { entryId: ja.id, reason: "harassment" });
  const enReport = await createReport(db, "reporter", { entryId: en.id, reason: "harassment" });
  if (!report.ok || !enReport.ok) throw new Error("report failed");
  return { db, ja: ja.id, en: en.id, report: report.id, enReport: enReport.id };
}

const profileOf = async (db: Awaited<ReturnType<typeof setup>>["db"], id: string) => (await db.select().from(profiles).where(eq(profiles.userId, id)))[0];

describe("getWriter", () => {
  it("refuses a suspended member until the end date, with the date and the reason, and lets the member write after it", async () => {
    const { db } = await setup();
    expect(await getWriter(db, "author", { now })).toMatchObject({ ok: true });
    await db.update(profiles).set({ suspendedUntil: new Date(now.getTime() + DAY), suspendedReason: "harassment" }).where(eq(profiles.userId, "author"));
    const refused = await getWriter(db, "author", { now });
    expect(refused).toMatchObject({ ok: false, reason: "suspended", until: new Date(now.getTime() + DAY), category: "harassment" });
    // Writing resumes automatically at expiry.
    expect(await getWriter(db, "author", { now: new Date(now.getTime() + DAY) })).toMatchObject({ ok: true });
    expect(await getWriter(db, "author", { now: new Date(now.getTime() + 2 * DAY) })).toMatchObject({ ok: true });
  });
});

describe("suspending a member", () => {
  it("lets a moderator suspend from a report in scope, for up to 30 days, always with an end date", async () => {
    const { db, report, en, ja } = await setup();
    const m = actor("jamod", JA_MOD);
    const base = { userId: "author", reason: "harassment", note: "repeated insults" };
    // A report is required; reports outside the assigned language or concerning another member cannot be used.
    expect(await suspendMember(db, m, { ...base, days: 7 }, { now })).toEqual({ ok: false, error: "forbidden" });
    const enReport = (await db.select().from(reports).where(eq(reports.entryId, en)))[0];
    expect(await suspendMember(db, m, { ...base, reportId: enReport.id, days: 7 }, { now })).toEqual({ ok: false, error: "forbidden" });
    expect(await suspendMember(db, m, { ...base, userId: "reporter", reportId: report, days: 7 }, { now })).toEqual({ ok: false, error: "forbidden" });
    // Duration: an integer from 1 to 30 days.
    for (const days of [0, -1, 31, 1.5, "abc", "", undefined, 365]) expect(await suspendMember(db, m, { ...base, reportId: report, days }, { now }), String(days)).toEqual({ ok: false, error: "invalid_days" });
    expect(await suspendMember(db, m, { ...base, reportId: report, days: 7, note: " " }, { now })).toEqual({ ok: false, error: "note_required" });
    expect(await db.select().from(moderationActions)).toEqual([]);
    const res = await suspendMember(db, m, { ...base, reportId: report, days: "30" }, { now });
    const until = new Date(now.getTime() + 30 * DAY);
    expect(res).toMatchObject({ ok: true, until });
    expect(await profileOf(db, "author")).toMatchObject({ suspendedUntil: until, suspendedReason: "harassment", suspendedActionId: (res as { actionId: number }).actionId });
    expect((await db.select().from(moderationActions))[0]).toMatchObject({ action: "suspend", targetUserId: "author", targetEntryId: null, reportId: report, until, actorId: "jamod", note: "repeated insults" });
    // The report becomes resolved.
    expect((await db.select().from(reports).where(eq(reports.id, report)))[0]).toMatchObject({ status: "resolved", handledBy: "jamod" });
    expect(ja).toBeDefined();
  });

  it("lets an operator suspend any member for up to 365 days, without a report", async () => {
    const { db } = await setup();
    const o = actor("op", OPERATOR);
    expect(await suspendMember(db, o, { userId: "reporter", reason: "spam", note: "n", days: 366 }, { now })).toEqual({ ok: false, error: "invalid_days" });
    expect(await suspendMember(db, o, { userId: "nobody", reason: "spam", note: "n", days: 5 }, { now })).toEqual({ ok: false, error: "not_found" });
    expect(await suspendMember(db, o, { userId: "reporter", reason: "spam", note: "n", days: 365 }, { now })).toMatchObject({ ok: true, until: new Date(now.getTime() + 365 * DAY) });
  });

  it("refuses to suspend yourself, and an operator; a longer suspension is not cut short by a shorter one", async () => {
    const process_env = process.env.OPERATOR_EMAILS;
    process.env.OPERATOR_EMAILS = "opal@example.com";
    try {
      const { db, report } = await setup();
      const m = actor("jamod", JA_MOD);
      const o = actor("op", OPERATOR);
      expect(await suspendMember(db, m, { userId: "jamod", reportId: report, reason: "spam", note: "n", days: 3 }, { now })).toEqual({ ok: false, error: "own_entry" });
      expect(await suspendMember(db, o, { userId: "op", reason: "spam", note: "n", days: 3 }, { now })).toEqual({ ok: false, error: "own_entry" });
      expect(await suspendMember(db, actor("jamod", { operator: true, langs: [] }), { userId: "op", reason: "spam", note: "n", days: 3 }, { now })).toEqual({ ok: false, error: "target_is_operator" });
      expect(await suspendMember(db, o, { userId: "author", reason: "spam", note: "n", days: 100 }, { now })).toMatchObject({ ok: true });
      // A 30-day suspension cannot shorten a 100-day suspension.
      expect(await suspendMember(db, m, { userId: "author", reportId: report, reason: "spam", note: "n", days: 30 }, { now })).toEqual({ ok: false, error: "invalid_state" });
      expect((await profileOf(db, "author")).suspendedUntil).toEqual(new Date(now.getTime() + 100 * DAY));
      // It can be extended.
      expect(await suspendMember(db, o, { userId: "author", reason: "spam", note: "n", days: 200 }, { now })).toMatchObject({ ok: true });
      expect((await profileOf(db, "author")).suspendedUntil).toEqual(new Date(now.getTime() + 200 * DAY));
    } finally {
      if (process_env === undefined) delete process.env.OPERATOR_EMAILS;
      else process.env.OPERATOR_EMAILS = process_env;
    }
  });

  it("lifts a suspension: a moderator from a report in scope but never one an operator made; an operator any; only a suspension that is running", async () => {
    const saved = process.env.OPERATOR_EMAILS;
    process.env.OPERATOR_EMAILS = "opal@example.com";
    try {
      const { db, report, enReport } = await setup();
      const o = actor("op", OPERATOR);
      const m = actor("jamod", JA_MOD);
      expect(await unsuspendMember(db, o, { userId: "author", reason: "other" }, { now })).toEqual({ ok: false, error: "invalid_state" });
      await suspendMember(db, o, { userId: "author", reason: "harassment", note: "n", days: 10 }, { now });
      expect(await unsuspendMember(db, m, { userId: "author", reason: "other" }, { now })).toEqual({ ok: false, error: "forbidden" });
      expect(await unsuspendMember(db, m, { userId: "author", reportId: enReport, reason: "other" }, { now })).toEqual({ ok: false, error: "forbidden" });
      // A moderator cannot lift an operator-imposed suspension even when the report is in scope.
      expect(await unsuspendMember(db, m, { userId: "author", reportId: report, reason: "other", note: "reviewed" }, { now })).toEqual({ ok: false, error: "forbidden" });
      expect((await profileOf(db, "author")).suspendedUntil).not.toBeNull();
      expect(await unsuspendMember(db, o, { userId: "author", reason: "other", note: "reviewed" }, { now })).toMatchObject({ ok: true });
      expect(await profileOf(db, "author")).toMatchObject({ suspendedUntil: null, suspendedReason: null, suspendedActionId: null });
      // A moderator can lift a moderator-imposed suspension through an in-scope report.
      expect(await suspendMember(db, m, { userId: "author", reportId: report, reason: "harassment", note: "n", days: 10 }, { now })).toMatchObject({ ok: true });
      expect(await unsuspendMember(db, m, { userId: "author", reportId: report, reason: "other" }, { now })).toMatchObject({ ok: true });
      expect((await db.select().from(moderationActions).orderBy(moderationActions.id)).map((r) => r.action)).toEqual(["suspend", "unsuspend", "suspend", "unsuspend"]);
      // An expired suspension cannot be lifted.
      await suspendMember(db, o, { userId: "author", reason: "harassment", note: "n", days: 1 }, { now });
      expect(await unsuspendMember(db, o, { userId: "author", reason: "other" }, { now: new Date(now.getTime() + 2 * DAY) })).toEqual({ ok: false, error: "invalid_state" });
    } finally {
      if (saved === undefined) delete process.env.OPERATOR_EMAILS;
      else process.env.OPERATOR_EMAILS = saved;
    }
  });

  it("does not let a moderator suspend again and again from one report (the 30 day limit would mean nothing), nor from a report the moderator filed", async () => {
    const { db, report, ja } = await setup();
    const m = actor("jamod", JA_MOD);
    const base = { userId: "author", reason: "harassment", note: "n" };
    const first = await suspendMember(db, m, { ...base, reportId: report, days: 30 }, { now });
    expect(first).toMatchObject({ ok: true });
    // Retrying through the same report on day 29 is rejected without extending expiry.
    const later = new Date(now.getTime() + 29 * DAY);
    expect(await suspendMember(db, m, { ...base, reportId: report, days: 30 }, { now: later })).toEqual({ ok: false, error: "invalid_state" });
    expect((await profileOf(db, "author")).suspendedUntil).toEqual(new Date(now.getTime() + 30 * DAY));
    expect((await db.select().from(moderationActions)).filter((a) => a.action === "suspend")).toHaveLength(1);
    // A moderator cannot both file the report and impose the suspension.
    await addMember(db, "victim", "vic", { readLangs: ["ja"] });
    const t = await createTopic(db, "victim", { lang: "ja", title: "t", body: "b" });
    if (!t.ok) throw new Error("topic failed");
    const own = await createReport(db, "jamod", { entryId: t.id, reason: "spam" });
    if (!own.ok) throw new Error("report failed");
    expect(await suspendMember(db, m, { userId: "victim", reason: "spam", note: "n", reportId: own.id, days: 5 }, { now })).toEqual({ ok: false, error: "forbidden" });
    expect((await profileOf(db, "victim")).suspendedUntil).toBeNull();
    expect(ja).toBeDefined();
  });

  it("never lets a moderator replace or extend a suspension that is running, and never undo an operator's suspension; an operator can extend it", async () => {
    const saved = process.env.OPERATOR_EMAILS;
    process.env.OPERATOR_EMAILS = "opal@example.com";
    try {
      const { db, report, ja } = await setup();
      const m = actor("jamod", JA_MOD);
      const o = actor("op", OPERATOR);
      // A separate report by someone else that the moderator may use.
      await addMember(db, "other2", "sara", { readLangs: ["ja"] });
      const again = await createReport(db, "other2", { entryId: ja, reason: "spam" });
      if (!again.ok) throw new Error("report failed");
      const first = await suspendMember(db, o, { userId: "author", reason: "infohazard", note: "operator's decision", days: 7 }, { now });
      if (!first.ok) throw new Error("suspend failed");
      const operatorUntil = new Date(now.getTime() + 7 * DAY);
      // A moderator cannot overwrite an operator's seven-day suspension with an eight-day suspension and thereby erase the appeal against the operator's action.
      const inside = new Date(now.getTime() + DAY);
      expect(await suspendMember(db, m, { userId: "author", reason: "harassment", note: "n", reportId: again.id, days: 8 }, { now: inside })).toEqual({ ok: false, error: "invalid_state" });
      expect(await suspendMember(db, m, { userId: "author", reason: "harassment", note: "n", entryId: ja, days: 8 }, { now: inside })).toEqual({ ok: false, error: "invalid_state" });
      expect(await unsuspendMember(db, m, { userId: "author", reportId: report, reason: "other" }, { now: inside })).toEqual({ ok: false, error: "forbidden" });
      expect(await profileOf(db, "author")).toMatchObject({ suspendedUntil: operatorUntil, suspendedActionId: first.actionId });
      expect((await db.select().from(reports).where(eq(reports.id, again.id)))[0].status).toBe("open");
      // An operator can extend it but cannot shorten it.
      expect(await suspendMember(db, o, { userId: "author", reason: "infohazard", note: "longer", days: 30 }, { now: inside })).toMatchObject({ ok: true });
      expect(await suspendMember(db, o, { userId: "author", reason: "infohazard", note: "shorter", days: 3 }, { now: inside })).toEqual({ ok: false, error: "invalid_state" });
    } finally {
      if (saved === undefined) delete process.env.OPERATOR_EMAILS;
      else process.env.OPERATOR_EMAILS = saved;
    }
  });

  it("limits what a moderator can suspend a member for to 30 days in any 90 days (operators are not limited)", async () => {
    const { db, report, ja } = await setup();
    const m = actor("jamod", JA_MOD);
    const o = actor("op", OPERATOR);
    await addMember(db, "other2", "sara", { readLangs: ["ja"] });
    await addMember(db, "other3", "kaz", { readLangs: ["ja"] });
    const r2 = await createReport(db, "other2", { entryId: ja, reason: "spam" });
    const r3 = await createReport(db, "other3", { entryId: ja, reason: "spam" });
    if (!r2.ok || !r3.ok) throw new Error("report failed");
    const base = { userId: "author", reason: "harassment", note: "n" };
    // Day 0: 30 days, the full cap.
    expect(await suspendMember(db, m, { ...base, reportId: report, days: 30 }, { now })).toMatchObject({ ok: true });
    // Day 31, after expiry: reject even one more day through another report because 30 + 1 > 30.
    const day31 = new Date(now.getTime() + 31 * DAY);
    expect(await suspendMember(db, m, { ...base, reportId: r2.id, days: 1 }, { now: day31 })).toEqual({ ok: false, error: "forbidden" });
    expect((await profileOf(db, "author")).suspendedUntil).toEqual(new Date(now.getTime() + 30 * DAY));
    // Operators are not subject to the cap.
    expect(await suspendMember(db, o, { ...base, reportId: r2.id, days: 40 }, { now: day31 })).toMatchObject({ ok: true });
    // Ignore suspensions older than 90 days: the day-0 suspension no longer counts on day 91, although the operator's 40-day suspension follows from day 31.
    const day200 = new Date(now.getTime() + 200 * DAY);
    expect(await suspendMember(db, m, { ...base, reportId: r3.id, days: 30 }, { now: day200 })).toMatchObject({ ok: true });
  });

  it("picks a usable report for a member action itself: not a dismissed one, not one the moderator filed, and only a report about that member's post", async () => {
    const { db, report, ja, en } = await setup();
    const m = actor("jamod", JA_MOD);
    const base = { userId: "author", reason: "harassment", note: "n" };
    // A dismissed report filed by reporter cannot be used.
    await dismissReports(db, m, { entryId: ja, reason: "other" });
    expect((await db.select().from(reports).where(eq(reports.id, report)))[0].status).toBe("dismissed");
    expect(await suspendMember(db, m, { ...base, reportId: report, days: 5 }, { now })).toEqual({ ok: false, error: "forbidden" });
    expect(await suspendMember(db, m, { ...base, entryId: ja, days: 5 }, { now })).toEqual({ ok: false, error: "forbidden" });
    // A report resolved by a hide action can be used. The server selects it from entryId alone.
    await addMember(db, "other2", "sara", { readLangs: ["ja"] });
    const again = await createReport(db, "other2", { entryId: ja, reason: "spam" });
    if (!again.ok) throw new Error("report failed");
    expect((await hideEntry(db, m, { entryId: ja, reason: "spam", note: "n" })).ok).toBe(true);
    expect((await db.select().from(reports).where(eq(reports.id, again.id)))[0].status).toBe("resolved");
    const res = await suspendMember(db, m, { ...base, entryId: ja, days: 5 }, { now });
    expect(res).toMatchObject({ ok: true });
    expect((await db.select().from(moderationActions).where(eq(moderationActions.action, "suspend")))[0].reportId).toBe(again.id);
    // A report on another member's post cannot justify suspending this member.
    await addMember(db, "victim", "vic", { readLangs: ["ja"] });
    expect(await suspendMember(db, m, { userId: "victim", reason: "spam", note: "n", reportId: again.id, days: 5 }, { now })).toEqual({ ok: false, error: "forbidden" });
    expect(await suspendMember(db, m, { userId: "victim", reason: "spam", note: "n", entryId: ja, days: 5 }, { now })).toEqual({ ok: false, error: "forbidden" });
    expect(en).toBeDefined();
  });

  it("an operator's suspension names a report only if it is about that member's post, and then resolves that report and no other", async () => {
    const { db, report, enReport, ja } = await setup();
    const o = actor("op", OPERATOR);
    // A report on author's post cannot be attached to reporter's suspension. Unrelated reports remain unresolved.
    expect(await suspendMember(db, o, { userId: "reporter", reason: "spam", note: "n", reportId: report, days: 5 }, { now })).toEqual({ ok: false, error: "forbidden" });
    expect((await db.select().from(reports).where(eq(reports.id, report)))[0].status).toBe("open");
    expect(await suspendMember(db, o, { userId: "author", reason: "spam", note: "n", reportId: 424242, days: 5 }, { now })).toEqual({ ok: false, error: "forbidden" });
    // With the correct report, only that report becomes resolved.
    expect(await suspendMember(db, o, { userId: "author", reason: "spam", note: "n", reportId: report, days: 5 }, { now })).toMatchObject({ ok: true });
    expect((await db.select().from(reports).where(eq(reports.id, report)))[0]).toMatchObject({ status: "resolved", handledBy: "op" });
    expect((await db.select().from(reports).where(eq(reports.id, enReport)))[0].status).toBe("open");
    expect(ja).toBeDefined();
  });
});

describe("a suspended member on every path", () => {
  let h: RouteHarness;
  let topicId: number;
  let replyId: number;
  const saved = process.env.OPERATOR_EMAILS;
  beforeAll(async () => {
    process.env.OPERATOR_EMAILS = "opal@example.com,susop@example.com";
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja", readLangs: ["ja"] });
    await h.signIn("susop", { homeArea: "ja", readLangs: ["ja"] });
    await h.signIn("sus", { homeArea: "ja", readLangs: ["ja"] });
    await h.signIn("susmod", { homeArea: "ja", readLangs: ["ja"] });
    await h.signIn("opal", { homeArea: "ja", readLangs: ["ja"] });
    await grantModerator(h.db, h.ids.opal, h.ids.susmod, "ja");
    const t = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "話題", body: "本文" });
    if (!t.ok) throw new Error("topic failed");
    topicId = t.id;
    const r = await createReply(h.db, h.ids.sus, t.id, { lang: "ja", body: "自分の返信" });
    if (!r.ok) throw new Error("reply failed");
    replyId = r.id;
    const until = new Date(Date.now() + 30 * DAY);
    await h.db.update(profiles).set({ suspendedUntil: until, suspendedReason: "spam" }).where(eq(profiles.userId, h.ids.sus));
    await h.db.update(profiles).set({ suspendedUntil: until, suspendedReason: "spam" }).where(eq(profiles.userId, h.ids.susmod));
    await h.db.update(profiles).set({ suspendedUntil: until, suspendedReason: "spam" }).where(eq(profiles.userId, h.ids.susop));
  });
  afterAll(() => {
    h.restore();
    if (saved === undefined) delete process.env.OPERATOR_EMAILS;
    else process.env.OPERATOR_EMAILS = saved;
  });

  it("is sent to the suspension page by every action that writes (table-driven)", async () => {
    const id = String(topicId);
    const rid = String(replyId);
    const cases: Array<[string, () => Promise<Record<string, (a: never) => unknown>>, string, Record<string, string>, Record<string, string>]> = [
      ["topic-new (post)", () => import("~/routes/topic-new") as never, "/t/new", {}, { title: "x", body: "y" }],
      ["topic-new (draft)", () => import("~/routes/topic-new") as never, "/t/new", {}, { title: "x", body: "y", intent: "draft" }],
      ["topic (reply)", () => import("~/routes/topic") as never, `/t/${id}`, { id }, { body: "y" }],
      ["topic (draft)", () => import("~/routes/topic") as never, `/t/${id}`, { id }, { body: "y", intent: "draft" }],
      ["topic (report a post)", () => import("~/routes/topic") as never, `/t/${id}`, { id }, { intent: "flag", entryId: id, reason: "spam" }],
      ["topic (translation report)", () => import("~/routes/topic") as never, `/t/${id}`, { id }, { intent: "report", entryId: id, lang: "en", field: "body", note: "n" }],
      ["topic-edit", () => import("~/routes/topic-edit") as never, `/t/${id}/edit`, { id }, { title: "x", body: "y" }],
      ["reply-edit", () => import("~/routes/reply-edit") as never, `/c/${rid}/edit`, { id: rid }, { body: "y" }],
      ["draft (save)", () => import("~/routes/draft") as never, "/drafts/1", { id: "1" }, { intent: "save", body: "y" }],
      ["draft (publish)", () => import("~/routes/draft") as never, "/drafts/1", { id: "1" }, { intent: "publish" }],
      ["draft (delete)", () => import("~/routes/draft") as never, "/drafts/1", { id: "1" }, { intent: "delete" }],
      ["draft (remove the link to the original question)", () => import("~/routes/draft") as never, "/drafts/1", { id: "1" }, { intent: "remove_alt", body: "y" }],
      ["vote", () => import("~/routes/vote") as never, "/vote", {}, { entryId: id, on: "1" }],
      ["settings-tokens (create)", () => import("~/routes/settings-tokens") as never, "/settings/tokens", {}, { intent: "create", name: "n", kind: "read" }],
      ["invites-new", () => import("~/routes/invites-new") as never, "/invites/new", {}, { email: "x@example.com" }],
      ["mod (a suspended moderator cannot act)", () => import("~/routes/mod") as never, "/mod", {}, { intent: "hide", entryId: id, reason: "spam", note: "n" }],
      ["mod-appeals (a suspended moderator cannot review)", () => import("~/routes/mod-appeals") as never, "/mod/appeals", {}, { appealId: "1", intent: "uphold", note: "n" }],
      ["admin-translations (a suspended moderator cannot write a human fix)", () => import("~/routes/admin-translations") as never, "/admin/translations", {}, { reportId: "1", text: "x" }],
    ];
    const count = async () => {
      const { votes, entries, drafts, apiTokens, invitations, translations } = await import("~/lib/db/schema");
      const rows = await Promise.all([votes, entries, drafts, apiTokens, invitations, translations, reports, moderationActions].map((t) => h.db.select().from(t)));
      return rows.map((r) => r.length);
    };
    const before = await count();
    for (const [name, load, p, params, form] of cases) {
      const mod = await load();
      const as = name.startsWith("mod") || name.startsWith("admin-translations") ? "susmod" : "sus";
      const outcome = await h.outcome(() => mod.action(h.args(h.request(p, { as, form }), params)));
      expect(outcome, name).toMatchObject({ status: 302, location: "/suspended" });
    }
    // Nothing is written: no additional votes, posts, drafts, tokens, invitations, translations, reports, or actions.
    expect(await count()).toEqual(before);
    expect((await h.db.select().from(reports)).length).toBe(0);
    expect((await h.db.select().from(moderationActions)).length).toBe(0);
  });

  it("an operator who is suspended (added to OPERATOR_EMAILS later) is refused on the operator screens and writes like anyone else; a suspended plain member still gets 404 there", async () => {
    const roles = await import("~/routes/admin-roles");
    const glossary = await import("~/routes/admin-glossary");
    const before = (await h.db.select().from(moderationActions)).length;
    for (const [name, call] of [
      ["admin-roles loader", async () => (await roles.loader(h.args(h.request("/admin/roles", { as: "susop" }))))],
      ["admin-roles action", () => roles.action(h.args(h.request("/admin/roles", { as: "susop", form: { intent: "grant", userId: h.ids.hana, lang: "ja" } })))],
      ["admin-glossary loader", async () => (await glossary.loader(h.args(h.request("/admin/glossary", { as: "susop" }))))],
      ["mod action", async () => (await import("~/routes/mod")).action(h.args(h.request("/mod", { as: "susop", form: { intent: "suspend", userId: h.ids.hana, reason: "spam", note: "n", days: "3" } })))],
    ] as const) {
      expect(await h.outcome(call), name).toMatchObject({ status: 302, location: "/suspended" });
    }
    expect((await h.db.select().from(moderationActions)).length).toBe(before);
    expect((await h.db.select().from((await import("~/lib/db/schema")).roles)).filter((r) => r.role === "moderator")).toHaveLength(1);
    // A suspended ordinary member gets 404 for operator pages, hiding their existence.
    expect(await h.outcome(async () => (await roles.loader(h.args(h.request("/admin/roles", { as: "sus" })))))).toMatchObject({ status: 404 });
    expect(await h.outcome(() => (import("~/routes/mod") as Promise<{ loader: (a: never) => unknown }>).then(async (m) => (await m.loader(h.args(h.request("/mod", { as: "sus" }))))))).toMatchObject({ status: 404 });
  });

  it("a suspended member can still delete their own posts (the right to delete), and only their own; every other write stays refused", async () => {
    const { action } = await import("~/routes/topic");
    const mine = await createReply(h.db, h.ids.sus, topicId, { lang: "ja", body: "消したい自分の返信" });
    if (!mine.ok) throw new Error("reply failed");
    const post = (as: string, form: Record<string, string>) => h.outcome(() => action(h.args(h.request(`/t/${topicId}`, { as, form }), { id: String(topicId) })));
    // Do not delete without confirmation. Other people's posts cannot be deleted, whether suspended or not.
    expect((await post("sus", { intent: "delete", entryId: String(mine.id) })).status).toBe(400);
    expect((await post("sus", { intent: "delete", entryId: String(topicId), confirm: "1" })).status).toBe(403);
    expect((await h.db.select().from((await import("~/lib/db/schema")).entries).where(eq((await import("~/lib/db/schema")).entries.id, mine.id)))[0].deletedAt).toBeNull();
    const res = await post("sus", { intent: "delete", entryId: String(mine.id), confirm: "1" });
    expect(res.status).toBe(302);
    expect(res.location).toMatch(new RegExp(`^/t/${topicId}.*#c-${mine.id}$`));
    expect((await h.db.select().from((await import("~/lib/db/schema")).entries).where(eq((await import("~/lib/db/schema")).entries.id, mine.id)))[0].deletedAt).not.toBeNull();
    // Other writes by the same suspended member are rejected.
    expect(await post("sus", { body: "a new reply" })).toMatchObject({ status: 302, location: "/suspended" });
    expect(await post("sus", { intent: "flag", entryId: String(topicId), reason: "spam" })).toMatchObject({ status: 302, location: "/suspended" });
  });

  it("is refused by POST /api/drafts with 403 { error: suspended } and the end date", async () => {
    const token = await createApiToken(h.db, h.ids.sus, { name: "d", kind: "draft" });
    if (!token.ok) throw new Error("token failed");
    const res = await handleDraftCreate(
      new Request("http://localhost:5173/api/drafts", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "text/markdown" }, body: "hello" }),
      { db: h.db },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("suspended");
    expect(body.message).toMatch(/suspended until \d{4}-\d\d-\d\dT/);
  });

  it("can still log in, read the pages and the Markdown twins (session, read token, signed link), and is shown the suspension page", async () => {
    // Login: suspension does not affect magic-link verification or revoke existing sessions.
    const { action } = await import("~/routes/auth-confirm");
    const token = await h.issueLink("sus@example.com");
    const login = (await action(h.args(h.request("/auth/confirm", { form: { token }, headers: { cookie: h.linkCookie(token) } })))) as Response;
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/");
    expect(login.headers.getSetCookie().some((c) => /session_token=/.test(c))).toBe(true);
    for (const [path, mod] of [
      ["/", "home"],
      ["/latest", "latest"],
      ["/a/ja", "area"],
      ["/settings", "settings"],
      ["/drafts", "drafts"],
    ] as const) {
      const { loader } = await import(`~/routes/${mod}`);
      const outcome = await h.outcome(async () => (await loader(h.args(h.request(path, { as: "sus" }), path === "/a/ja" ? { lang: "ja" } : {}))));
      expect(outcome.status, path).toBe(200);
    }
    const { loader: topic } = await import("~/routes/topic");
    expect((await h.outcome(() => topic(h.args(h.request(`/t/${topicId}`, { as: "sus" }), { id: String(topicId) })))).status).toBe(200);
    // Markdown and read access: sessions, read tokens, and signed links.
    const read = await createApiToken(h.db, h.ids.sus, { name: "r", kind: "read" });
    if (!read.ok) throw new Error("token failed");
    const session = await authenticateRead(h.request("/latest.md", { as: "sus" }), "text", { db: h.db });
    expect(session).toMatchObject({ ok: true, auth: { userId: h.ids.sus, via: "session" } });
    const bearer = await authenticateRead(new Request("http://localhost:5173/latest.md", { headers: { authorization: `Bearer ${read.token}` } }), "text", { db: h.db });
    expect(bearer).toMatchObject({ ok: true, auth: { via: "read-token" } });
    const signed = await authenticateRead(new Request(`http://localhost:5173/latest.md?k=${signOpenInAiToken({ resource: "/latest.md", userId: h.ids.sus, generation: 0 })}`), "text", { db: h.db });
    expect(signed).toMatchObject({ ok: true, auth: { via: "signed-link" } });
    // The suspension page shows reason and expiry; unsuspended members return to the home page.
    const { loader: page } = await import("~/routes/suspended");
    const shown = await h.outcome(() => page(h.args(h.request("/suspended", { as: "sus" }))));
    expect(shown.status).toBe(200);
    expect(shown.value).toMatchObject({ reason: "spam", until: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d$/) });
    expect(await h.outcome(() => page(h.args(h.request("/suspended", { as: "hana" }))))).toMatchObject({ status: 302, location: "/" });
  });

  it("writes again when the suspension has ended, without any other action", async () => {
    await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() - 1000) }).where(eq(profiles.userId, h.ids.sus));
    const { action } = await import("~/routes/vote");
    const res = await h.outcome(() => action(h.args(h.request("/vote", { as: "sus", form: { entryId: String(topicId), on: "1" } }))));
    expect(res.status).toBe(200);
    const { loader: page } = await import("~/routes/suspended");
    expect(await h.outcome(() => page(h.args(h.request("/suspended", { as: "sus" }))))).toMatchObject({ status: 302, location: "/" });
  });

  it("a moderator action from the route suspends a member, and the suspended member is then refused", async () => {
    const { action } = await import("~/routes/mod");
    // An operator suspends member hana.
    const res = await h.outcome(() => action(h.args(h.request("/mod", { as: "opal", form: { intent: "suspend", userId: h.ids.hana, reason: "harassment", note: "n", days: "3", returnTo: "/admin/roles?q=hana" } }))));
    expect(res).toMatchObject({ status: 302, location: "/admin/roles?q=hana" });
    const { action: post } = await import("~/routes/topic");
    expect(await h.outcome(() => post(h.args(h.request(`/t/${topicId}`, { as: "hana", form: { body: "y" } }), { id: String(topicId) })))).toMatchObject({ status: 302, location: "/suspended" });
    const bad = await h.outcome(() => action(h.args(h.request("/mod", { as: "opal", form: { intent: "suspend", userId: h.ids.hana, reason: "harassment", note: "n", days: "999" } }))));
    expect(bad.status).toBe(400);
  });
});
