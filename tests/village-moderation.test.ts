import { RETENTION } from "~/lib/retention";
import { moderateWithCurrentVersion as moderateVillage } from "./helpers/village-moderation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { appeals, entries, moderationActions, notifications, profiles, reports, villageEvents, villageInvites, villageMembers, villageReportSnapshots, villages } from "~/lib/db/schema";
import { createAppeal, decideAppeal, getAppealableAction, listOpenAppeals } from "~/lib/appeals.server";
import { createTopic } from "~/lib/entries.server";
import { createReport, hideEntry, listPublicLog, listReportCards, type Actor } from "~/lib/moderation.server";
import { countUnreadNotifications, listNotifications } from "~/lib/notifications.server";
import { createVillage, editVillage, endVillage, inviteToVillage } from "~/lib/village-management.server";
import { ensureLanguageVillages, villageBySlug } from "~/lib/villages.server";
import { createVillageReport, pruneVillageReportSnapshots } from "~/lib/village-moderation.server";
import { itemText } from "~/lib/mail/notification.server";
import { createNotificationHandlers } from "~/lib/jobs/notification-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createMailer } from "~/lib/mail/mail.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { m } from "~/paraglide/messages.js";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const op: Actor = { id: "operator", scope: { operator: true, langs: [] } };
const reviewer: Actor = { id: "reviewer", scope: { operator: true, langs: [] } };
const langMod: Actor = { id: "language-mod", scope: { operator: false, langs: ["en" as const] } };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function setup() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "en,ja"); vi.stubEnv("OPERATOR_EMAILS", "operator@example.com");
  const db = await createTestDb();
  await ensureLanguageVillages(db);
  for (const id of ["owner", "co-owner", "reporter", "operator", "reviewer", "language-mod"]) await addMember(db, id, `vr_${id.replaceAll("-", "_")}`, { homeArea: "en" });
  expect(await createVillage(db, "owner", { slug: "reviewed-place", name: "Original village", description: "Original description", kind: "invite_public" })).toMatchObject({ ok: true });
  const village = (await villageBySlug(db, "reviewed-place"))!;
  await db.insert(villageMembers).values({ villageId: village.id, userId: "co-owner", role: "owner" });
  return { db, village };
}
async function report(db: Awaited<ReturnType<typeof createTestDb>>, userId = "reporter", slug = "reviewed-place", now?: Date) {
  const res = await createVillageReport(db, userId, { slug, reason: "other", note: "The report evidence" }, { now });
  if (!res.ok) throw new Error(res.error);
  return res.id;
}
async function fix(db: Awaited<ReturnType<typeof createTestDb>>, reportId: number, fields: Record<string, string> = {}) {
  const res = await moderateVillage(db, op, { reportId, intent: "fix", reason: "harassment", note: "Correction explanation", name: "Corrected village", ...fields });
  if (!res.ok) throw new Error(res.error);
  return res.actionId;
}
async function appeal(db: Awaited<ReturnType<typeof createTestDb>>, actionId: number, owner = "owner") {
  const res = await createAppeal(db, owner, actionId, "Please reconsider this correction");
  if (!res.ok) throw new Error(res.error);
  return res.id;
}
const overturn = (db: Awaited<ReturnType<typeof createTestDb>>, id: number, actor = reviewer) => decideAppeal(db, actor, id, { decision: "overturned", note: "Independent review" });

// Capture the executed SELECTs, rather than only checking which helpers were invoked.
function queries(db: Awaited<ReturnType<typeof createTestDb>>) {
  const client = (db as unknown as { $client: { query: (...args: unknown[]) => unknown } }).$client;
  const original = client.query.bind(client);
  const seen: string[] = [];
  vi.spyOn(client, "query").mockImplementation((...args: unknown[]) => {
    const q = args[0];
    seen.push(typeof q === "string" ? q : q && typeof q === "object" && "text" in q ? String(q.text) : "");
    return original(...args);
  });
  return seen;
}
function expectNoVillageReads(seen: string[]) {
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter(q => /\b(?:from|join)\s+"?(?:villages|village_[a-z_]+)"?\b/i.test(q))).toEqual([]);
}

describe("village reports and operator actions", () => {
  it("keeps one open report per reporter, snapshots metadata, and permits re-reporting after handling", async () => {
    const { db } = await setup();
    const id = await report(db);
    expect(await createVillageReport(db, "reporter", { slug: "reviewed-place", reason: "spam" })).toEqual({ ok: false, error: "duplicate" });
    await editVillage(db, "owner", "reviewed-place", { name: "Changed by owner", description: "Changed after reporting" });
    expect(await db.select().from(villageReportSnapshots)).toMatchObject([{ reportId: id, name: "Original village", description: "Original description", slug: "reviewed-place" }]);
    await report(db, "co-owner");
    const page = await listReportCards(db, op.scope);
    expect(page.cards).toHaveLength(1);
    const card = page.cards[0];
    if (card.kind !== "village") throw new Error("wrong target");
    expect(card.reports).toHaveLength(2);
    expect(card.village.name).toBe("Changed by owner");
    expect(card.reports[0].snapshot?.name).toBe("Original village");
    expect(JSON.stringify(card)).not.toContain("reporterId");
    expect(JSON.stringify(card)).not.toContain("vr_reporter");
    expect(JSON.stringify(card)).not.toMatch(/[a-f0-9]{32}/);
    expect(await listReportCards(db, langMod.scope)).toEqual({ cards: [], page: 1, hasNext: false });
    expect(await moderateVillage(db, langMod, { reportId: id, intent: "dismiss", reason: "other" })).toEqual({ ok: false, error: "forbidden" });
    expect(await moderateVillage(db, op, { reportId: id, intent: "dismiss", reason: "other" })).toMatchObject({ ok: true });
    expect((await db.select().from(reports)).every(r => r.status === "dismissed")).toBe(true);
    expect((await report(db))).toBeGreaterThan(id);
  });
  it("accepts language and ended village reports, preserving reports during ordinary edits and resolving only explicit card edits", async () => {
    const { db } = await setup();
    const id = await report(db, "reporter", "en");
    for (const fields of [{ slug: "renamed-language" }, { name: "Renamed language" }]) expect(await moderateVillage(db, op, { reportId: id, intent: "fix", reason: "other", note: "Not permitted", ...fields })).toEqual({ ok: false, error: "forbidden" });
    expect(await moderateVillage(db, op, { reportId: id, intent: "end", reason: "other", note: "Cannot end" })).toEqual({ ok: false, error: "forbidden" });
    expect(await moderateVillage(db, op, { reportId: id, intent: "fix", description: "Corrected language description", reason: "other", note: "Fix description" })).toEqual({ ok: false, error: "forbidden" });
    expect(await editVillage(db, op.id, "en", { name: "Ignored", description: "Corrected language description" })).toMatchObject({ ok: true });
    expect((await db.select().from(reports).where(eq(reports.id, id)))[0].status).toBe("open");
    expect(await editVillage(db, op.id, "en", { name: "Ignored", description: "Corrected language description", resolveReportId: id })).toMatchObject({ ok: true });
    expect((await db.select().from(reports).where(eq(reports.id, id)))[0].status).toBe("resolved");
    expect(await db.select().from(moderationActions)).toEqual([]);
    expect(await db.select().from(notifications)).toEqual([]);
    expect(await villageBySlug(db, "en")).toMatchObject({ slug: "en", name: "", description: "Corrected language description", endedAt: null });
    const next = await report(db, "owner", "en");
    expect(await moderateVillage(db, op, { reportId: next, intent: "dismiss", reason: "other" })).toMatchObject({ ok: true });
    await endVillage(db, "owner", "reviewed-place");
    expect(await report(db)).toBeGreaterThan(next);
  });
  it("validates corrections, atomically rejects collisions, and moves the current slug without redirects", async () => {
    const { db } = await setup();
    const id = await report(db);
    for (const fields of [{ name: null }, { description: null }, { slug: null }, { name: "\u200b" }, { name: "\u3164" }, { name: "\u115f" }, { name: "two\nlines" }, { name: "\u202eHidden" }, { description: "\u2060" }, { slug: "en" }, { slug: "f".repeat(32) }, { slug: "UPPERCASE" }, { slug: "bad--slug" }])
      expect(await moderateVillage(db, op, { reportId: id, intent: "fix", reason: "other", note: "Invalid text", ...fields })).toEqual({ ok: false, error: "invalid_village" });
    expect(await moderateVillage(db, op, { reportId: id, intent: "fix", reason: "other" })).toEqual({ ok: false, error: "note_required" });
    await createVillage(db, "co-owner", { slug: "taken-place", name: "Taken", kind: "open", description: "" });
    expect(await moderateVillage(db, op, { reportId: id, intent: "fix", slug: "taken-place", reason: "other", note: "Collision" })).toEqual({ ok: false, error: "slug_taken" });
    expect(await db.select().from(moderationActions)).toEqual([]);
    expect((await db.select().from(reports))[0].status).toBe("open");
    await fix(db, id, { slug: "corrected-place", description: "Corrected description" });
    expect(await villageBySlug(db, "reviewed-place")).toBeNull();
    expect(await villageBySlug(db, "corrected-place")).toMatchObject({ name: "Corrected village", description: "Corrected description" });
    expect((await db.select().from(moderationActions))[0].villageEventId).not.toBeNull();
    const notices = await db.select().from(notifications).where(eq(notifications.kind, "moderation"));
    expect(notices.map(n => n.userId).sort()).toEqual(["co-owner", "owner"]);
    expect(notices.every(n => n.actorId === null && n.entryId === null)).toBe(true);
  });
  it("refuses unrecorded operator editing and ending, while operators who own the village keep owner authority", async () => {
    const { db, village } = await setup();
    vi.stubEnv("OPERATOR_EMAILS", "operator@example.com");
    expect(await editVillage(db, op.id, village.slug!, { name: "Unrecorded", description: "" })).toEqual({ ok: false, error: "forbidden" });
    expect(await endVillage(db, op.id, village.slug!)).toEqual({ ok: false, error: "forbidden" });
    await db.insert(villageMembers).values({ villageId: village.id, userId: op.id, role: "owner" });
    expect(await editVillage(db, op.id, village.slug!, { name: "Owner edit", description: "" })).toMatchObject({ ok: true });
    expect(await endVillage(db, op.id, village.slug!)).toMatchObject({ ok: true });
    expect(await db.select().from(moderationActions)).toEqual([]);
  });
  it("allows a single current-owner appeal per action and rejects conflicted or language-only reviewers", async () => {
    const { db, village } = await setup();
    const id = await report(db, reviewer.id);
    const actionId = await fix(db, id);
    expect(await createAppeal(db, "reporter", actionId, "Not an owner")).toEqual({ ok: false, error: "not_found" });
    const appealId = await appeal(db, actionId);
    expect(await createAppeal(db, "co-owner", actionId, "Another owner")).toEqual({ ok: false, error: "duplicate" });
    expect((await getAppealableAction(db, "co-owner", actionId))?.appeal?.id).toBe(appealId);
    expect(await listOpenAppeals(db, reviewer)).toMatchObject({ cards: [], hasNext: false });
    expect(await listOpenAppeals(db, langMod)).toMatchObject({ cards: [], hasNext: false });
    expect(await overturn(db, appealId, langMod)).toEqual({ ok: false, error: "forbidden" });
    expect(await overturn(db, appealId, op)).toEqual({ ok: false, error: "own_action" });
    expect(await overturn(db, appealId)).toEqual({ ok: false, error: "reporter" });
    expect(await overturn(db, appealId, { ...reviewer, id: "owner" })).toEqual({ ok: false, error: "own_appeal" });
    await db.delete(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, "co-owner")));
    const second = await fix(db, await report(db, "reporter"), { name: "Another correction" });
    expect(await createAppeal(db, "co-owner", second, "Former owner")).toEqual({ ok: false, error: "not_found" });
  });
  it("overturns a correction, restores metadata, and notifies every owner", async () => {
    const { db } = await setup();
    const actionId = await fix(db, await report(db), { slug: "corrected-place", description: "Changed" });
    const appealId = await appeal(db, actionId);
    expect((await listOpenAppeals(db, reviewer)).cards[0]).toMatchObject({ village: { slug: "corrected-place" }, villageBefore: { slug: "reviewed-place", name: "Original village" } });
    expect(await overturn(db, appealId)).toEqual({ ok: true, status: "overturned", reversed: true });
    expect(await villageBySlug(db, "reviewed-place")).toMatchObject({ name: "Original village", description: "Original description" });
    expect(await villageBySlug(db, "corrected-place")).toBeNull();
    expect((await db.select().from(moderationActions)).map(a => a.action)).toEqual(["fix_village", "unfix_village"]);
    expect((await listNotifications(db, "co-owner")).items.some(n => n.action === "unfix_village")).toBe(true);
    expect((await db.select().from(appeals))[0].reversed).toBe(true);
  });
  it("records an overturned appeal without overwriting subsequent owner edits or later corrections", async () => {
    const { db } = await setup();
    const actionId = await fix(db, await report(db));
    const appealId = await appeal(db, actionId);
    await editVillage(db, "owner", "reviewed-place", { name: "Owner's new name", description: "Owner's description" });
    expect(await overturn(db, appealId)).toEqual({ ok: true, status: "overturned", reversed: false });
    expect(await villageBySlug(db, "reviewed-place")).toMatchObject({ name: "Owner's new name", description: "Owner's description" });
    expect((await db.select().from(appeals))[0]).toMatchObject({ status: "overturned", reversed: false });
  });
  it("records a slug collision on reversal without aborting the appeal transaction", async () => {
    const { db } = await setup();
    const actionId = await fix(db, await report(db), { slug: "corrected-place" });
    const appealId = await appeal(db, actionId);
    const afterHold = new Date(Date.now() + 90 * 86400000 + 1000);
    await createVillage(db, "co-owner", { slug: "reviewed-place", name: "New village", description: "", kind: "open" }, { now: afterHold });
    expect(await overturn(db, appealId)).toEqual({ ok: true, status: "overturned", reversed: false });
    expect((await db.select().from(appeals))[0].status).toBe("overturned");
    expect((await listNotifications(db, "owner")).items[0]).toMatchObject({ kind: "appeal_decided", appealReversed: false });
  });
  it("ends and reopens the same village, leaving cancelled invitations and changed defaults alone", async () => {
    const { db, village } = await setup();
    await inviteToVillage(db, "owner", "reviewed-place", "vr_reporter", "join");
    const id = await report(db);
    const ended = await moderateVillage(db, op, { reportId: id, intent: "end", reason: "other", note: "Ending explanation" });
    if (!ended.ok) throw new Error(ended.error);
    expect((await villageBySlug(db, village.slug!))?.endedAt).not.toBeNull();
    expect((await db.select().from(villageInvites))[0].state).toBe("cancelled");
    const [defaultBefore] = await db.select({ id: profiles.defaultVillageId }).from(profiles).where(eq(profiles.userId, "owner"));
    const appealId = await appeal(db, ended.actionId);
    expect(await overturn(db, appealId)).toMatchObject({ ok: true, reversed: true });
    expect(await villageBySlug(db, village.slug!)).toMatchObject({ id: village.id, endedAt: null });
    expect((await db.select().from(villageInvites))[0].state).toBe("cancelled");
    expect((await db.select({ id: profiles.defaultVillageId }).from(profiles).where(eq(profiles.userId, "owner")))[0]).toEqual(defaultBefore);
    expect((await db.select().from(villageMembers)).filter(m => m.villageId === village.id)).toHaveLength(2);
    expect((await listNotifications(db, "co-owner")).items[0].action).toBe("reopen_village");
  });
  it("keeps existing cases visible and actionable after disabling villages, while closing new reports", async () => {
    const { db } = await setup();
    const id = await report(db);
    vi.stubEnv("VILLAGES", "");
    expect(await createVillageReport(db, "owner", { slug: "reviewed-place", reason: "other" })).toEqual({ ok: false, error: "not_found" });
    expect((await listReportCards(db, op.scope)).cards).toHaveLength(1);
    const actionId = await fix(db, id);
    expect(await countUnreadNotifications(db, "owner")).toBe(1);
    expect((await listNotifications(db, "owner")).items[0]).toMatchObject({ action: "fix_village", village: { name: "Corrected village" } });
    const appealId = await appeal(db, actionId);
    expect((await listOpenAppeals(db, reviewer)).cards).toHaveLength(1);
    expect(await overturn(db, appealId)).toMatchObject({ ok: true, reversed: true });
    expect((await listPublicLog(db)).entries[0]).toMatchObject({ action: "unfix_village", village: { slug: "reviewed-place", name: "Original village" } });
  });
  it("publishes only current public village names/slugs, with no language or internal metadata", async () => {
    const { db, village } = await setup();
    await fix(db, await report(db), { slug: "corrected-place" });
    const page = await listPublicLog(db);
    expect(Object.keys(page.entries[0]).sort()).toEqual(["action", "date", "reason", "village"]);
    expect(page.entries[0].village).toEqual({ name: "Corrected village", slug: "corrected-place" });
    const serialized = JSON.stringify(page);
    for (const privateValue of [village.id, "Original village", "Original description", "Correction explanation", "The report evidence", "operator", "reporter", "language", "lang"]) expect(serialized).not.toContain(privateValue);
    await db.update(villages).set({ kind: "closed" }).where(eq(villages.id, village.id));
    expect((await listPublicLog(db)).entries[0].village).toBeNull();
  });
  it("does not read village tables on legacy queue, log, appeal or notification pages", async () => {
    const { db } = await setup();
    vi.stubEnv("VILLAGES", "");
    const topic = await createTopic(db, "owner", { title: "Legacy topic", body: "Legacy content", lang: "en" });
    if (!topic.ok) throw new Error(topic.error);
    await createReport(db, "reporter", { entryId: topic.id, reason: "spam", note: "Legacy report" });
    const seen = queries(db);
    expect((await listReportCards(db, op.scope)).cards).toMatchObject([{ kind: "topic", entryId: topic.id, reports: [{ note: "Legacy report" }] }]);
    const hidden = await hideEntry(db, op, { entryId: topic.id, reason: "spam", note: "Legacy hide" });
    if (!hidden.ok) throw new Error(hidden.error);
    expect((await listPublicLog(db)).entries[0]).toMatchObject({ action: "hide", reason: "spam", lang: "en" });
    await getAppealableAction(db, "owner", hidden.actionId);
    await appeal(db, hidden.actionId);
    await listOpenAppeals(db, reviewer);
    await listNotifications(db, "owner");
    expectNoVillageReads(seen);
  });
  it("does not read village tables for empty pages even when other pages contain village cases", async () => {
    const { db } = await setup();
    const actionId = await fix(db, await report(db));
    await appeal(db, actionId);
    const seen = queries(db);
    expect((await listReportCards(db, op.scope, { handled: true, page: 2, limit: 1 })).cards).toEqual([]);
    expect((await listPublicLog(db, { page: 2, limit: 1 })).entries).toEqual([]);
    expect((await listNotifications(db, "owner", { page: 2, limit: 1 })).items).toEqual([]);
    expect((await listOpenAppeals(db, reviewer, { page: 2, limit: 1 })).cards).toEqual([]);
    expectNoVillageReads(seen);
  });
  it("does not read village tables on a post appeal page when later pages contain village appeals", async () => {
    const { db } = await setup();
    const topic = await createTopic(db, "owner", { title: "Earlier post appeal", body: "Post appeal body", lang: "en" });
    if (!topic.ok) throw new Error(topic.error);
    const hidden = await hideEntry(db, op, { entryId: topic.id, reason: "spam", note: "Post action" });
    if (!hidden.ok) throw new Error(hidden.error);
    const postAppeal = await appeal(db, hidden.actionId);
    await appeal(db, await fix(db, await report(db)));
    for (const enabled of ["1", ""]) {
      vi.stubEnv("VILLAGES", enabled);
      const seen = queries(db);
      expect(await listOpenAppeals(db, reviewer, { limit: 1 })).toMatchObject({ cards: [{ id: postAppeal, action: "hide" }], page: 1, hasNext: true });
      expectNoVillageReads(seen);
      vi.restoreAllMocks();
    }
  });
  it("prunes only handled snapshots after the retention period, preserving reports and open evidence", async () => {
    const { db } = await setup();
    const now = new Date("2026-01-01T00:00:00Z");
    const id = await report(db, "reporter", "reviewed-place", now);
    await moderateVillage(db, op, { reportId: id, intent: "dismiss", reason: "other" }, { now });
    const openId = await report(db, "owner", "reviewed-place", now);
    expect(await pruneVillageReportSnapshots(db, new Date(now.getTime() + RETENTION.villageReportDays * 86400000))).toBe(0);
    expect(await pruneVillageReportSnapshots(db, new Date(now.getTime() + (RETENTION.villageReportDays + 1) * 86400000))).toBe(1);
    expect(await db.select().from(villageReportSnapshots).orderBy(villageReportSnapshots.reportId)).toMatchObject([{ reportId: id, name: null, description: null, slug: null }, { reportId: openId, name: "Original village" }]);
    expect(await db.select().from(reports)).toHaveLength(2);
  });
  it("enforces exclusive report targets and preserves the old unconditional post-report uniqueness", async () => {
    const { db, village } = await setup();
    const topic = await createTopic(db, "owner", { title: "Report constraint topic", body: "Report constraint body", lang: "en" });
    if (!topic.ok) throw new Error(topic.error);
    const input = { reporterId: "reporter", reason: "spam" };
    await expect(db.insert(reports).values(input)).rejects.toThrow();
    await expect(db.insert(reports).values({ ...input, entryId: topic.id, villageId: village.id })).rejects.toThrow();
    const reported = await createReport(db, "reporter", { entryId: topic.id, reason: "spam" });
    if (!reported.ok) throw new Error(reported.error);
    await db.update(reports).set({ status: "resolved" }).where(eq(reports.id, reported.id));
    expect(await createReport(db, "reporter", { entryId: topic.id, reason: "spam" })).toEqual({ ok: false, error: "duplicate" });
    for (const values of [{ action: "end_village", targetEntryId: topic.id }, { action: "hide", targetVillageId: village.id }, { action: "end_village", targetVillageId: village.id, targetUserId: "owner" }]) {
      await expect(db.insert(moderationActions).values({ actorId: op.id, reason: "spam", ...values })).rejects.toThrow();
    }
  });
  it("delivers village moderation mail to all owners in their UI languages after disabling the entry", async () => {
    const { db } = await setup();
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:5173");
    await db.update(profiles).set({ emailPref: "immediate", uiLocale: "ja" }).where(eq(profiles.userId, "owner"));
    await db.update(profiles).set({ emailPref: "immediate", uiLocale: "en" }).where(eq(profiles.userId, "co-owner"));
    const actionId = await fix(db, await report(db));
    vi.stubEnv("VILLAGES", "");
    const box = createMemoryMailbox();
    const mailer = createMailer(box.transport, "tomola <no-reply@example.org>");
    const seen = queries(db);
    const result = await runDueJobs(db, createNotificationHandlers({ mailer: () => mailer }), { now: new Date(Date.now() + 360000), limit: 20, logger: { error() {}, warn() {} } });
    expect(result).toMatchObject({ done: 2, failed: 0 });
    expect(box.sent.map(message => message.to).sort()).toEqual(["co-owner@example.com", "owner@example.com"]);
    for (const [owner, locale] of [["owner", "ja"], ["co-owner", "en"]] as const) {
      const mail = box.sent.find(message => message.to === `${owner}@example.com`)!;
      expect(mail.text).toContain(m.mail_item_moderation_fix_village({ reason: "", url: "" }, { locale }).split(".")[0].split("。")[0]);
      expect(mail.text).toContain("http://localhost:5173/notifications");
      for (const privateValue of ["The report evidence", "vr_operator", "vr_reporter", "Original description"]) expect(mail.text).not.toContain(privateValue);
    }
    // Mail builds its labels from the action without querying the village.
    expectNoVillageReads(seen);
    expect((await db.select().from(notifications).where(eq(notifications.actionId, actionId))).every(n => n.emailedAt !== null)).toBe(true);
  });
  it("uses distinct village action wording in English and Japanese mail", () => {
    for (const locale of ["en", "ja"] as const) {
      expect(itemText({ kind: "moderation", action: "fix_village", reason: "spam", url: "https://example.test/notifications" }, locale)).toContain(m.mail_item_moderation_fix_village({ reason: "", url: "" }, { locale }).split(".")[0].split("。")[0]);
      expect(itemText({ kind: "moderation", action: "reopen_village", url: "https://example.test/notifications" }, locale)).toBe(m.mail_item_moderation_reopen_village({ url: "https://example.test/notifications" }, { locale }));
    }
  });
});

describe("village moderation boundaries", () => {
  it("rejects an owner-operator's correction, ending and dismissal without handling reports", async () => {
    const { db, village } = await setup();
    await db.insert(villageMembers).values({ villageId: village.id, userId: op.id, role: "owner" });
    const id = await report(db);
    for (const intent of ["fix", "end", "dismiss"] as const) expect(await moderateVillage(db, op, { reportId: id, intent, name: "Own correction", reason: "other", note: "Owner action" })).toEqual({ ok: false, error: "forbidden" });
    expect((await db.select().from(reports))[0].status).toBe("open");
    expect(await db.select().from(moderationActions)).toEqual([]);
    expect((await listReportCards(db, op.scope, { viewerId: op.id })).cards).toEqual([]);
  });
  it("excludes a co-owner operator from reviewing another owner's appeal", async () => {
    const { db, village } = await setup();
    const id = await fix(db, await report(db));
    const appealId = await appeal(db, id);
    await db.insert(villageMembers).values({ villageId: village.id, userId: reviewer.id, role: "owner" });
    expect(await listOpenAppeals(db, reviewer)).toMatchObject({ cards: [], hasNext: false });
    expect(await overturn(db, appealId)).toEqual({ ok: false, error: "forbidden" });
    expect((await db.select().from(appeals))[0].status).toBe("open");
  });
  it("anonymizes dismissed village reports without looking up their village", async () => {
    const { db } = await setup();
    await moderateVillage(db, op, { reportId: await report(db), intent: "dismiss", reason: "spam" });
    const seen = queries(db);
    const page = await listPublicLog(db);
    expect(page.entries[0]).toMatchObject({ action: "dismiss_village_report", reason: "spam", village: null });
    expect(JSON.stringify(page)).not.toContain("reviewed-place");
    expect(JSON.stringify(page)).not.toContain("Original village");
    expectNoVillageReads(seen);
  });
  it("holds a replaced slug for ninety days for both creation and other corrections, but permits appeal restoration", async () => {
    const { db } = await setup();
    const actionId = await fix(db, await report(db), { slug: "changed-place" });
    expect(await createVillage(db, "co-owner", { slug: "reviewed-place", name: "Pretender", kind: "open", description: "" })).toEqual({ ok: false, error: "slug_taken" });
    await createVillage(db, "co-owner", { slug: "second-place", name: "Second village", kind: "open", description: "" });
    const reportId = await report(db, "reporter", "second-place");
    expect(await moderateVillage(db, op, { reportId, intent: "fix", slug: "reviewed-place", reason: "spam", note: "Claim old address" })).toEqual({ ok: false, error: "slug_taken" });
    expect(await overturn(db, await appeal(db, actionId))).toMatchObject({ ok: true, reversed: true });
    expect(await villageBySlug(db, "reviewed-place")).toMatchObject({ name: "Original village" });
  });
  it("allows direct recorded actions without manufacturing a report and closes that entry when disabled", async () => {
    const { db, village } = await setup();
    const { loadVillageModerationView } = await import("~/lib/village-moderation.server");
    const view = (await loadVillageModerationView(db, village.slug!, op.id))!;
    expect(view).toMatchObject({ reportId: null, reports: [], owned: false });
    const corrected = await moderateVillage(db, op, { slugTarget: village.slug!, version: view.version, intent: "fix", name: "Direct correction", reason: "other", note: "Operator discovered an issue" });
    expect(corrected).toMatchObject({ ok: true });
    expect(await db.select().from(reports)).toEqual([]);
    expect((await db.select().from(moderationActions))[0]).toMatchObject({ reportId: null, action: "fix_village" });
    expect((await db.select().from(notifications)).map(n => n.userId).sort()).toEqual(["co-owner", "owner"]);
    if (!corrected.ok) throw new Error(corrected.error);
    expect(await overturn(db, await appeal(db, corrected.actionId))).toMatchObject({ ok: true, reversed: true });
    const ended = await moderateVillage(db, op, { slugTarget: village.slug!, intent: "end", reason: "spam", note: "Direct recorded ending" });
    if (!ended.ok) throw new Error(ended.error);
    expect((await db.select().from(moderationActions).where(eq(moderationActions.id, ended.actionId)))[0]).toMatchObject({ action: "end_village", reportId: null });
    expect(await villageBySlug(db, village.slug!)).toMatchObject({ endedAt: expect.any(Date) });
    expect(await overturn(db, await appeal(db, ended.actionId))).toMatchObject({ ok: true, reversed: true });
    expect((await listNotifications(db, "owner")).items.find(n => n.action === "reopen_village")).toMatchObject({ reason: null, note: null });
    expect(await db.select().from(reports)).toEqual([]);
    vi.stubEnv("VILLAGES", "");
    expect(await moderateVillage(db, op, { slugTarget: village.slug!, intent: "end", reason: "other", note: "New direct entry" })).toEqual({ ok: false, error: "not_found" });
  });
  it("rejects a stale three-field form and exposes fresh metadata and a new version", async () => {
    const { db } = await setup();
    const reportId = await report(db);
    const c = (await listReportCards(db, op.scope)).cards[0];
    if (c.kind !== "village") throw new Error("wrong target");
    await editVillage(db, "owner", "reviewed-place", { name: "Owner's newer name", description: "Owner's newer description" });
    expect(await moderateVillage(db, op, { reportId, version: c.version, intent: "fix", name: c.village.name, description: c.village.description, slug: "changed-slug", reason: "spam", note: "Only the address was intended" })).toEqual({ ok: false, error: "stale" });
    expect(await villageBySlug(db, "reviewed-place")).toMatchObject({ name: "Owner's newer name", description: "Owner's newer description" });
    expect(await db.select().from(moderationActions)).toEqual([]);
    const fresh = (await listReportCards(db, op.scope)).cards[0];
    if (fresh.kind !== "village") throw new Error("wrong target");
    expect(fresh.version).not.toBe(c.version);
    expect(fresh.village.name).toBe("Owner's newer name");
  });
  it("keeps a former owner's filed appeal readable while other owners see it as a shared appeal", async () => {
    const { db, village } = await setup();
    const id = await fix(db, await report(db));
    const appealId = await appeal(db, id);
    await db.delete(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, "owner")));
    expect(await getAppealableAction(db, "owner", id)).toMatchObject({ villageAppealOwn: true, appeal: { id: appealId, status: "open" } });
    expect(await getAppealableAction(db, "co-owner", id)).toMatchObject({ villageAppealOwn: false, appeal: { id: appealId } });
    expect(await createAppeal(db, "owner", id, "New attempt")).toEqual({ ok: false, error: "not_found" });
    await overturn(db, appealId);
    expect(await getAppealableAction(db, "owner", id)).toMatchObject({ appeal: { status: "overturned" } });
    const reversal = (await listNotifications(db, "co-owner")).items.find(n => n.action === "unfix_village")!;
    expect(reversal).toMatchObject({ reason: null, note: null });
  });
});

it("releases a replaced slug exactly at the configured hold boundary", async () => {
  const { db } = await setup();
  const { VILLAGE_SLUG_HOLD_DAYS } = await import("~/lib/village-slugs.server");
  expect(VILLAGE_SLUG_HOLD_DAYS).toBe(90);
  const actionId = await fix(db, await report(db), { slug: "replacement-place" });
  const [action] = await db.select().from(moderationActions).where(eq(moderationActions.id, actionId));
  const candidate = { slug: "reviewed-place", name: "After the hold", kind: "open", description: "" };
  const expiry = action.createdAt.getTime() + VILLAGE_SLUG_HOLD_DAYS * 86400000;
  expect(await createVillage(db, "co-owner", candidate, { now: new Date(expiry - 1) })).toEqual({ ok: false, error: "slug_taken" });
  expect(await createVillage(db, "co-owner", candidate, { now: new Date(expiry) })).toMatchObject({ ok: true });
});
