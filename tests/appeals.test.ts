import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppeal, decideAppeal, getAppealableAction, listOpenAppeals } from "~/lib/appeals.server";
import { appeals, entries, jobs, moderationActions, notifications, profiles, reports, segments } from "~/lib/db/schema";
import { createReply, createTopic, getThread, softDeleteEntry } from "~/lib/entries.server";
import { createReport, deleteEntry, hideEntry, suspendMember, unhideEntry, listPublicLog } from "~/lib/moderation.server";
import { listNotifications } from "~/lib/notifications.server";
import type { ModScope } from "~/lib/roles.server";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Appeals: the affected member may appeal once per action, even while suspended. A different moderator or operator reviews; overturning automatically reverses the action.
const OP: ModScope = { operator: true, langs: [] };
const MOD: ModScope = { operator: false, langs: ["en"] };
const now = new Date("2026-10-10T00:00:00Z");

async function setup() {
  const db = await createTestDb();
  await addMember(db, "author", "hana");
  await addMember(db, "bystander", "taro");
  await addMember(db, "actor", "opal");
  await addMember(db, "reviewer", "rina");
  await addMember(db, "enmod", "mary");
  const topic = await createTopic(db, "author", { lang: "ja", title: "話題", body: "本文です。二文目。" }, { now: new Date("2026-10-01T00:00:00Z") });
  if (!topic.ok) throw new Error("topic failed");
  const reply = await createReply(db, "author", topic.id, { lang: "ja", body: "返信です。" }, { now: new Date("2026-10-01T00:05:00Z") });
  const other = await createReply(db, "bystander", topic.id, { lang: "ja", body: "別の返信" }, { now: new Date("2026-10-01T00:10:00Z") });
  if (!reply.ok || !other.ok) throw new Error("reply failed");
  return { db, topic: topic.id, reply: reply.id, other: other.id };
}

const op = (id: string) => ({ id, scope: OP });
const stateOf = async (db: Awaited<ReturnType<typeof setup>>["db"], id: number) => (await db.select().from(entries).where(eq(entries.id, id)))[0];

describe("who may appeal", () => {
  it("the author of a hidden or deleted post and the suspended member, once per decision; nobody else", async () => {
    const { db, reply, other } = await setup();
    const hid = await hideEntry(db, op("actor"), { entryId: reply, reason: "spam", note: "ad" });
    const del = await deleteEntry(db, op("actor"), { entryId: other, reason: "harassment", note: "rude" });
    const sus = await suspendMember(db, op("actor"), { userId: "bystander", reason: "spam", note: "again", days: 3 }, { now });
    if (!hid.ok || !del.ok || !sus.ok) throw new Error("action failed");
    // Only the affected member; do not even reveal the action's existence to others.
    expect(await getAppealableAction(db, "bystander", hid.actionId)).toBeNull();
    expect(await getAppealableAction(db, "author", sus.actionId)).toBeNull();
    expect(await createAppeal(db, "bystander", hid.actionId, "me")).toEqual({ ok: false, error: "not_found" });
    expect(await createAppeal(db, "author", 424242, "x")).toEqual({ ok: false, error: "not_found" });
    const info = await getAppealableAction(db, "author", hid.actionId);
    expect(info).toMatchObject({ action: "hide", reason: "spam", note: "ad", appeal: null, entry: { id: reply, body: "返信です。" } });
    expect(await getAppealableAction(db, "bystander", sus.actionId)).toMatchObject({ action: "suspend", until: new Date(now.getTime() + 3 * 86_400_000), entry: null });
    // Once per action.
    expect((await createAppeal(db, "author", hid.actionId, "  it was not spam  ")).ok).toBe(true);
    expect(await createAppeal(db, "author", hid.actionId, "again")).toEqual({ ok: false, error: "duplicate" });
    expect((await getAppealableAction(db, "author", hid.actionId))?.appeal).toMatchObject({ status: "open", text: "it was not spam" });
    // Suspended members can appeal both their suspension and a separate action.
    expect((await createAppeal(db, "bystander", sus.actionId, "I did not do it")).ok).toBe(true);
    expect((await createAppeal(db, "bystander", del.actionId, "my post")).ok).toBe(true);
    // An explanation is required and has a length limit.
    const again = await hideEntry(db, op("actor"), { entryId: (await createTopic(db, "author", { lang: "ja", title: "t2", body: "b" }).then((r) => (r.ok ? r.id : 0))), reason: "spam", note: "n" });
    if (!again.ok) throw new Error("hide failed");
    for (const text of ["", "   ", undefined, "x".repeat(2001), "a\u0000b"]) expect(await createAppeal(db, "author", again.actionId, text), String(text)).toEqual({ ok: false, error: "invalid_text" });
    // Actions other than hiding, deletion or suspension, such as unhiding or dismissal, cannot be appealed.
    const un = await unhideEntry(db, op("actor"), { entryId: reply, reason: "other" });
    if (!un.ok) throw new Error("unhide failed");
    expect(await createAppeal(db, "author", un.actionId, "x")).toEqual({ ok: false, error: "not_found" });
  });
});

describe("who may review", () => {
  it("a moderator of any language or an operator, never the actor of the decision, never the appellant", async () => {
    const { db, reply } = await setup();
    const hid = await hideEntry(db, op("actor"), { entryId: reply, reason: "spam", note: "ad" });
    if (!hid.ok) throw new Error("hide failed");
    const made = await createAppeal(db, "author", hid.actionId, "not spam");
    if (!made.ok) throw new Error("appeal failed");
    const enMod = { id: "enmod", scope: MOD };
    // The review queue excludes the original actor and non-moderators without a scope; another moderator responsible for the language can see it.
    expect((await listOpenAppeals(db, op("actor"))).cards).toEqual([]);
    expect((await listOpenAppeals(db, { id: "bystander", scope: { operator: false, langs: [] } })).cards).toEqual([]);
    const cards = (await listOpenAppeals(db, enMod)).cards;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: made.id, text: "not spam", appellantHandle: "hana", action: "hide", reason: "spam", note: "ad", entry: { id: reply, body: "返信です。", hidden: true, deleted: false } });
    // The card excludes the original actor's name.
    expect(JSON.stringify(cards)).not.toContain("opal");
    expect(JSON.stringify(cards)).not.toContain("actor");
    expect((await listOpenAppeals(db, op("reviewer"))).cards).toHaveLength(1);
    // The original actor, the appellant and non-moderators cannot review.
    expect(await decideAppeal(db, op("actor"), made.id, { decision: "overturned", note: "mine" })).toEqual({ ok: false, error: "own_action" });
    expect(await decideAppeal(db, { id: "author", scope: OP }, made.id, { decision: "overturned", note: "mine" })).toEqual({ ok: false, error: "own_appeal" });
    expect(await decideAppeal(db, { id: "bystander", scope: { operator: false, langs: [] } }, made.id, { decision: "upheld", note: "x" })).toEqual({ ok: false, error: "forbidden" });
    expect(await decideAppeal(db, enMod, made.id, { decision: "maybe", note: "x" })).toEqual({ ok: false, error: "invalid_decision" });
    expect(await decideAppeal(db, enMod, made.id, { decision: "upheld", note: "  " })).toEqual({ ok: false, error: "note_required" });
    expect(await decideAppeal(db, enMod, made.id, { decision: "upheld", note: "x".repeat(1001) })).toEqual({ ok: false, error: "invalid_note" });
    expect(await decideAppeal(db, enMod, 424242, { decision: "upheld", note: "x" })).toEqual({ ok: false, error: "not_found" });
    expect((await db.select().from(appeals))[0]).toMatchObject({ status: "open", decidedBy: null });
    expect((await stateOf(db, reply)).hiddenAt).not.toBeNull();
  });
});

describe("upholding and overturning", () => {
  it("upholding keeps the decision, records who decided and why, and tells the appellant", async () => {
    const { db, reply } = await setup();
    const hid = await hideEntry(db, op("actor"), { entryId: reply, reason: "spam", note: "ad" });
    if (!hid.ok) throw new Error("hide failed");
    const made = await createAppeal(db, "author", hid.actionId, "not spam");
    if (!made.ok) throw new Error("appeal failed");
    const at = new Date("2026-10-11T00:00:00Z");
    expect(await decideAppeal(db, { id: "enmod", scope: MOD }, made.id, { decision: "upheld", note: " It was an advertisement " }, { now: at })).toEqual({ ok: true, status: "upheld", reversed: false });
    expect((await db.select().from(appeals))[0]).toMatchObject({ status: "upheld", decidedBy: "enmod", decidedAt: at, decisionNote: "It was an advertisement" });
    expect((await stateOf(db, reply)).hiddenAt).not.toBeNull();
    expect((await db.select().from(moderationActions)).map((a) => a.action)).toEqual(["hide"]);
    expect(await decideAppeal(db, { id: "enmod", scope: MOD }, made.id, { decision: "overturned", note: "again" })).toEqual({ ok: false, error: "already_decided" });
    // Notify the appellant without identifying the reviewer.
    const note = (await db.select().from(notifications).where(and(eq(notifications.userId, "author"), eq(notifications.kind, "appeal_decided"))))[0];
    expect(note).toMatchObject({ actionId: hid.actionId, appealId: made.id, actorId: null, readAt: null });
    const items = (await listNotifications(db, "author")).items;
    expect(items[0]).toMatchObject({ kind: "appeal_decided", appealStatus: "upheld", decisionNote: "It was an advertisement" });
  });

  it("overturning a hide shows the post again, queues its translations and records an unhide", async () => {
    const { db, reply } = await setup();
    const hid = await hideEntry(db, op("actor"), { entryId: reply, reason: "spam", note: "ad" });
    if (!hid.ok) throw new Error("hide failed");
    await db.delete(jobs);
    const made = await createAppeal(db, "author", hid.actionId, "not spam");
    if (!made.ok) throw new Error("appeal failed");
    const at = new Date("2026-10-11T00:00:00Z");
    expect(await decideAppeal(db, op("reviewer"), made.id, { decision: "overturned", note: "fine" }, { now: at })).toEqual({ ok: true, status: "overturned", reversed: true });
    const row = await stateOf(db, reply);
    expect(row).toMatchObject({ hiddenAt: null, moderatedAt: at });
    const actions = await db.select().from(moderationActions).orderBy(moderationActions.id);
    expect(actions.map((a) => [a.action, a.actorId, a.targetEntryId])).toEqual([["hide", "actor", reply], ["unhide", "reviewer", reply]]);
    expect(row.moderationActionId).toBe(actions[1].id);
    expect((await db.select().from(jobs)).filter((j) => j.kind === "translate_entry").length).toBe(8);
    // Public record: reversal appears as a normal action, without the actor.
    expect((await listPublicLog(db)).entries.map((e) => e.action)).toEqual(["unhide", "hide"]);
    expect((await getThread(db, (await stateOf(db, reply)).threadId!))!.replies.find((r) => r.id === reply)!.visibility).toBe("visible");
  });

  it("overturning a suspension lifts it; overturning a deletion restores the post, its place and its translations queue", async () => {
    const { db, topic, reply, other } = await setup();
    const sus = await suspendMember(db, op("actor"), { userId: "author", reason: "spam", note: "n", days: 10 }, { now: new Date() });
    if (!sus.ok) throw new Error("suspend failed");
    const a1 = await createAppeal(db, "author", sus.actionId, "unfair");
    if (!a1.ok) throw new Error("appeal failed");
    expect(await decideAppeal(db, op("reviewer"), a1.id, { decision: "overturned", note: "agreed" })).toMatchObject({ ok: true, reversed: true });
    expect((await db.select().from(profiles).where(eq(profiles.userId, "author")))[0]).toMatchObject({ suspendedUntil: null, suspendedReason: null, suspendedActionId: null });

    const del = await deleteEntry(db, op("actor"), { entryId: other, reason: "harassment", note: "rude" });
    if (!del.ok) throw new Error("delete failed");
    expect((await db.select().from(entries).where(eq(entries.id, topic)))[0]).toMatchObject({ replyCount: 1 });
    expect(await db.select().from(segments).where(eq(segments.entryId, other))).toEqual([]);
    await db.delete(jobs);
    const a2 = await createAppeal(db, "bystander", del.actionId, "my reply");
    if (!a2.ok) throw new Error("appeal failed");
    expect(await decideAppeal(db, op("reviewer"), a2.id, { decision: "overturned", note: "it was fine" })).toMatchObject({ ok: true, reversed: true });
    expect(await stateOf(db, other)).toMatchObject({ deletedAt: null });
    expect((await db.select().from(entries).where(eq(entries.id, topic)))[0]).toMatchObject({ replyCount: 2, lastActivityAt: new Date("2026-10-01T00:10:00Z") });
    expect((await db.select().from(segments).where(eq(segments.entryId, other))).length).toBeGreaterThan(0);
    expect((await db.select().from(jobs)).filter((j) => j.kind === "translate_entry").length).toBe(8);
    expect((await db.select().from(moderationActions).orderBy(moderationActions.id)).map((a) => a.action)).toEqual(["suspend", "unsuspend", "delete", "restore"]);
    expect((await getThread(db, topic))!.replies.map((r) => [r.id, r.visibility])).toEqual([[reply, "visible"], [other, "visible"]]);
  });

  it("decides without a reversal when the decision no longer stands (already reversed, replaced or expired)", async () => {
    const { db, reply, other } = await setup();
    // Hide, then another actor unhides: overturning the appeal has nothing left to reverse.
    const hid = await hideEntry(db, op("actor"), { entryId: reply, reason: "spam", note: "ad" });
    if (!hid.ok) throw new Error("hide failed");
    await unhideEntry(db, op("actor"), { entryId: reply, reason: "other" });
    const a1 = await createAppeal(db, "author", hid.actionId, "x");
    if (!a1.ok) throw new Error("appeal failed");
    expect(await decideAppeal(db, op("reviewer"), a1.id, { decision: "overturned", note: "n" })).toEqual({ ok: true, status: "overturned", reversed: false });
    // Hide, then a new hide action: overturning the old action leaves the new one intact.
    const h1 = await hideEntry(db, op("actor"), { entryId: other, reason: "spam", note: "1" });
    if (!h1.ok) throw new Error("hide failed");
    await unhideEntry(db, op("actor"), { entryId: other, reason: "other" });
    const h2 = await hideEntry(db, op("actor"), { entryId: other, reason: "spam", note: "2" });
    if (!h2.ok) throw new Error("hide failed");
    const a2 = await createAppeal(db, "bystander", h1.actionId, "x");
    if (!a2.ok) throw new Error("appeal failed");
    expect(await decideAppeal(db, op("reviewer"), a2.id, { decision: "overturned", note: "n" })).toMatchObject({ ok: true, reversed: false });
    expect((await stateOf(db, other)).hiddenAt).not.toBeNull();
    // If the author deleted the post, overturning its hide action does not reverse the deletion.
    const h3 = await hideEntry(db, op("actor"), { entryId: reply, reason: "spam", note: "3" });
    if (!h3.ok) throw new Error("hide failed");
    await softDeleteEntry(db, reply);
    const a3 = await createAppeal(db, "author", h3.actionId, "x");
    if (!a3.ok) throw new Error("appeal failed");
    expect(await decideAppeal(db, op("reviewer"), a3.id, { decision: "overturned", note: "n" })).toMatchObject({ ok: true, reversed: false });
    expect((await stateOf(db, reply)).deletedAt).not.toBeNull();
    // An expired suspension has nothing left to reverse.
    const sus = await suspendMember(db, op("actor"), { userId: "bystander", reason: "spam", note: "n", days: 1 }, { now: new Date("2026-09-01T00:00:00Z") });
    if (!sus.ok) throw new Error("suspend failed");
    const a4 = await createAppeal(db, "bystander", sus.actionId, "x");
    if (!a4.ok) throw new Error("appeal failed");
    expect(await decideAppeal(db, op("reviewer"), a4.id, { decision: "overturned", note: "n" })).toMatchObject({ ok: true, reversed: false });
  });
});

describe("reversal details", () => {
  it("does not lift a newer, longer suspension when an older one is overturned", async () => {
    const { db } = await setup();
    const first = await suspendMember(db, op("actor"), { userId: "bystander", reason: "spam", note: "1", days: 3 }, { now: new Date() });
    const second = await suspendMember(db, op("actor"), { userId: "bystander", reason: "harassment", note: "2", days: 30 }, { now: new Date() });
    if (!first.ok || !second.ok) throw new Error("suspend failed");
    const made = await createAppeal(db, "bystander", first.actionId, "unfair");
    if (!made.ok) throw new Error("appeal failed");
    expect(await decideAppeal(db, op("reviewer"), made.id, { decision: "overturned", note: "agreed" })).toEqual({ ok: true, status: "overturned", reversed: false });
    expect((await db.select().from(profiles).where(eq(profiles.userId, "bystander")))[0]).toMatchObject({ suspendedActionId: second.actionId, suspendedReason: "harassment" });
    expect((await db.select().from(profiles).where(eq(profiles.userId, "bystander")))[0].suspendedUntil).not.toBeNull();
    expect((await db.select().from(moderationActions)).map((a) => a.action)).toEqual(["suspend", "suspend"]);
  });

  it("does not list an appeal to its own appellant (a moderator whose post was hidden)", async () => {
    const { db, reply } = await setup();
    await addMember(db, "modauthor", "mona");
    const mine = await createReply(db, "modauthor", (await db.select().from(entries).where(eq(entries.id, reply)))[0].threadId!, { lang: "ja", body: "moderator's own reply" });
    if (!mine.ok) throw new Error("reply failed");
    const hid = await hideEntry(db, op("actor"), { entryId: mine.id, reason: "spam", note: "n" });
    if (!hid.ok) throw new Error("hide failed");
    const made = await createAppeal(db, "modauthor", hid.actionId, "not spam");
    if (!made.ok) throw new Error("appeal failed");
    const asAppellant = { id: "modauthor", scope: MOD };
    expect((await listOpenAppeals(db, asAppellant)).cards).toEqual([]);
    expect((await listOpenAppeals(db, op("reviewer"))).cards.map((c) => c.id)).toEqual([made.id]);
    expect(await decideAppeal(db, asAppellant, made.id, { decision: "overturned", note: "mine" })).toEqual({ ok: false, error: "own_appeal" });
  });

  it("restores a deleted post that is also hidden without queueing its translations, and keeps it hidden", async () => {
    const { db, other } = await setup();
    await hideEntry(db, op("actor"), { entryId: other, reason: "spam", note: "hidden first" });
    const del = await deleteEntry(db, op("actor"), { entryId: other, reason: "spam", note: "then deleted" });
    if (!del.ok) throw new Error("delete failed");
    await db.delete(jobs);
    const made = await createAppeal(db, "bystander", del.actionId, "my reply");
    if (!made.ok) throw new Error("appeal failed");
    expect(await decideAppeal(db, op("reviewer"), made.id, { decision: "overturned", note: "fine" })).toMatchObject({ ok: true, reversed: true });
    expect(await stateOf(db, other)).toMatchObject({ deletedAt: null });
    expect((await stateOf(db, other)).hiddenAt).not.toBeNull();
    expect((await db.select().from(jobs)).filter((j) => j.kind === "translate_entry")).toEqual([]);
    // The notification excludes the reviewer.
    const note = (await db.select().from(notifications).where(eq(notifications.kind, "appeal_decided")))[0];
    expect(note).toMatchObject({ userId: "bystander", actorId: null, appealId: made.id });
  });
});

describe("whether the decision still stands is read from the action records", () => {
  it("overturns a hide after the post was deleted by an operator and restored by an appeal (a restore overwrites moderation_action_id)", async () => {
    const { db, other } = await setup();
    const hid = await hideEntry(db, op("actor"), { entryId: other, reason: "spam", note: "hidden first" });
    const del = await deleteEntry(db, op("actor"), { entryId: other, reason: "harassment", note: "then deleted" });
    if (!hid.ok || !del.ok) throw new Error("action failed");
    const deleteAppeal = await createAppeal(db, "bystander", del.actionId, "delete was wrong");
    if (!deleteAppeal.ok) throw new Error("appeal failed");
    expect(await decideAppeal(db, op("reviewer"), deleteAppeal.id, { decision: "overturned", note: "restore it" })).toMatchObject({ ok: true, reversed: true });
    // After restoration, moderation_action_id points to the restore action; the post remains hidden.
    const restoreId = (await stateOf(db, other)).moderationActionId;
    expect(restoreId).not.toBe(hid.actionId);
    expect((await stateOf(db, other)).hiddenAt).not.toBeNull();
    const hideAppeal = await createAppeal(db, "bystander", hid.actionId, "hide was wrong too");
    if (!hideAppeal.ok) throw new Error("appeal failed");
    expect(await decideAppeal(db, op("reviewer"), hideAppeal.id, { decision: "overturned", note: "show it" })).toEqual({ ok: true, status: "overturned", reversed: true });
    expect(await stateOf(db, other)).toMatchObject({ hiddenAt: null, deletedAt: null });
    expect((await db.select().from(appeals).where(eq(appeals.id, hideAppeal.id)))[0]).toMatchObject({ status: "overturned", reversed: true });
  });

  it("records reversed = false when nothing had to be reversed (and null when upheld), and tells the appellant", async () => {
    const { db, reply } = await setup();
    const sus = await suspendMember(db, op("actor"), { userId: "bystander", reason: "spam", note: "n", days: 1 }, { now: new Date("2026-09-01T00:00:00Z") });
    const hid = await hideEntry(db, op("actor"), { entryId: reply, reason: "spam", note: "n" });
    if (!sus.ok || !hid.ok) throw new Error("action failed");
    // The suspension already ended; overturning has nothing to reverse.
    const expired = await createAppeal(db, "bystander", sus.actionId, "x");
    const upheld = await createAppeal(db, "author", hid.actionId, "y");
    if (!expired.ok || !upheld.ok) throw new Error("appeal failed");
    expect(await decideAppeal(db, op("reviewer"), expired.id, { decision: "overturned", note: "n" })).toEqual({ ok: true, status: "overturned", reversed: false });
    expect(await decideAppeal(db, op("reviewer"), upheld.id, { decision: "upheld", note: "n" })).toEqual({ ok: true, status: "upheld", reversed: false });
    expect((await db.select().from(appeals).where(eq(appeals.id, expired.id)))[0]).toMatchObject({ status: "overturned", reversed: false });
    expect((await db.select().from(appeals).where(eq(appeals.id, upheld.id)))[0]).toMatchObject({ status: "upheld", reversed: null });
    const items = (await listNotifications(db, "bystander")).items.filter((n) => n.kind === "appeal_decided");
    expect(items.map((n) => [n.appealStatus, n.appealReversed])).toEqual([["overturned", false]]);
    // True when overturning actually restored the state.
    const hid2 = await hideEntry(db, op("actor"), { entryId: (await db.select().from(entries).where(eq(entries.kind, "topic")))[0].id, reason: "spam", note: "n" });
    if (!hid2.ok) throw new Error("hide failed");
    const done = await createAppeal(db, "author", hid2.actionId, "z");
    if (!done.ok) throw new Error("appeal failed");
    expect(await decideAppeal(db, op("reviewer"), done.id, { decision: "overturned", note: "n" })).toEqual({ ok: true, status: "overturned", reversed: true });
    expect((await listNotifications(db, "author")).items.filter((n) => n.kind === "appeal_decided").map((n) => [n.appealStatus, n.appealReversed])).toEqual([["overturned", true], ["upheld", null]]);
  });
});

describe("a reporter of the post does not review the appeal about it", () => {
  it("leaves the appeal out of the reporter's list and refuses the decision (hide, delete and a suspension made from the report)", async () => {
    const { db, reply, other } = await setup();
    await addMember(db, "rep", "rei");
    const repMod = { id: "rep", scope: MOD };
    // hide: the member who reported that post.
    await createReport(db, "rep", { entryId: reply, reason: "spam" });
    const hid = await hideEntry(db, op("actor"), { entryId: reply, reason: "spam", note: "n" });
    if (!hid.ok) throw new Error("hide failed");
    const hideAppeal = await createAppeal(db, "author", hid.actionId, "x");
    if (!hideAppeal.ok) throw new Error("appeal failed");
    // suspend: a reporter of the post underlying the suspension, whether the same actor or a different report.
    await createReport(db, "rep", { entryId: other, reason: "harassment" });
    const report = (await db.select().from(reports).where(eq(reports.entryId, other)))[0];
    const sus = await suspendMember(db, op("actor"), { userId: "bystander", reason: "harassment", note: "n", days: 3, reportId: report.id }, { now: new Date() });
    if (!sus.ok) throw new Error("suspend failed");
    const susAppeal = await createAppeal(db, "bystander", sus.actionId, "y");
    if (!susAppeal.ok) throw new Error("appeal failed");
    expect((await listOpenAppeals(db, repMod)).cards).toEqual([]);
    expect((await listOpenAppeals(db, op("reviewer"))).cards.map((c) => c.id).sort()).toEqual([hideAppeal.id, susAppeal.id].sort());
    expect(await decideAppeal(db, repMod, hideAppeal.id, { decision: "overturned", note: "mine" })).toEqual({ ok: false, error: "reporter" });
    expect(await decideAppeal(db, repMod, susAppeal.id, { decision: "upheld", note: "mine" })).toEqual({ ok: false, error: "reporter" });
    expect((await stateOf(db, reply)).hiddenAt).not.toBeNull();
    // A non-reporter may review.
    expect(await decideAppeal(db, { id: "enmod", scope: MOD }, hideAppeal.id, { decision: "upheld", note: "ok" })).toMatchObject({ ok: true });
  });
});

describe("the routes", () => {
  let h: RouteHarness;
  let replyId: number;
  let actionId: number;
  const saved = process.env.OPERATOR_EMAILS;
  beforeAll(async () => {
    process.env.OPERATOR_EMAILS = "opal@example.com";
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja" });
    await h.signIn("taro", { homeArea: "ja" });
    await h.signIn("opal", { homeArea: "ja" });
    await h.signIn("rina", { homeArea: "ja" });
    const { grantModerator } = await import("~/lib/roles.server");
    await grantModerator(h.db, h.ids.opal, h.ids.rina, "th");
    const t = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "話題", body: "本文" });
    if (!t.ok) throw new Error("topic failed");
    const r = await createReply(h.db, h.ids.hana, t.id, { lang: "ja", body: "返信" });
    if (!r.ok) throw new Error("reply failed");
    replyId = r.id;
    const hid = await hideEntry(h.db, { id: h.ids.opal, scope: OP }, { entryId: replyId, reason: "spam", note: "ad" });
    if (!hid.ok) throw new Error("hide failed");
    actionId = hid.actionId;
    // An operator suspends author hana; appeals remain available during suspension.
    const sus = await suspendMember(h.db, { id: h.ids.opal, scope: OP }, { userId: h.ids.hana, reason: "spam", note: "n", days: 5 });
    if (!sus.ok) throw new Error("suspend failed");
  });
  afterAll(() => {
    h.restore();
    if (saved === undefined) delete process.env.OPERATOR_EMAILS;
    else process.env.OPERATOR_EMAILS = saved;
  });

  it("/appeal/:id opens for the member concerned only, also while suspended, and takes one appeal", async () => {
    const { loader, action } = await import("~/routes/appeal");
    const params = { actionId: String(actionId) };
    expect(await h.outcome(async () => (await loader(h.args(h.request(`/appeal/${actionId}`), params))))).toMatchObject({ status: 302, location: `/login?next=${encodeURIComponent(`/appeal/${actionId}`)}` });
    expect(await h.outcome(async () => (await loader(h.args(h.request(`/appeal/${actionId}`, { as: "taro" }), params))))).toMatchObject({ status: 404 });
    const page = await h.outcome(async () => (await loader(h.args(h.request(`/appeal/${actionId}`, { as: "hana" }), params))));
    expect(page.status).toBe(200);
    expect(page.value).toMatchObject({ action: "hide", reason: "spam", note: "ad", appeal: null });
    expect(JSON.stringify(page.value)).not.toContain("opal");
    const bad = await h.outcome(() => action(h.args(h.request(`/appeal/${actionId}`, { as: "hana", form: { text: " " } }), params)));
    expect(bad.status).toBe(400);
    expect(await h.outcome(() => action(h.args(h.request(`/appeal/${actionId}`, { as: "taro", form: { text: "hi" } }), params)))).toMatchObject({ status: 404 });
    expect(await h.outcome(() => action(h.args(h.request(`/appeal/${actionId}`, { as: "hana", form: { text: "It was not spam" } }), params)))).toMatchObject({ status: 302, location: `/appeal/${actionId}?sent=1` });
    expect((await h.outcome(() => action(h.args(h.request(`/appeal/${actionId}`, { as: "hana", form: { text: "again" } }), params)))).status).toBe(409);
    const after = await h.outcome(async () => (await loader(h.args(h.request(`/appeal/${actionId}?sent=1`, { as: "hana" }), params))));
    expect(after.value).toMatchObject({ sent: true, appeal: { status: "open", text: "It was not spam" } });
    // From the suspension screen to an appeal of that suspension action.
    const { loader: suspended } = await import("~/routes/suspended");
    const s = (await h.outcome(() => suspended(h.args(h.request("/suspended", { as: "hana" }))))).value as { actionId: number | null };
    expect(s.actionId).not.toBeNull();
    expect((await h.outcome(async () => (await loader(h.args(h.request(`/appeal/${s.actionId}`, { as: "hana" }), { actionId: String(s.actionId) }))))).status).toBe(200);
  });

  it("/mod/appeals: the actor does not see it and cannot decide it; another moderator can; the decision shows on the member's notification", async () => {
    const { loader, action } = await import("~/routes/mod-appeals");
    expect(await h.outcome(async () => (await loader(h.args(h.request("/mod/appeals", { as: "taro" })))))).toMatchObject({ status: 404 });
    const asActor = (await h.outcome(async () => (await loader(h.args(h.request("/mod/appeals", { as: "opal" })))))).value as { cards: unknown[] };
    expect(asActor.cards).toEqual([]);
    const [appeal] = await h.db.select().from(appeals);
    const decide = (as: string, form: Record<string, string>) => h.outcome(() => action(h.args(h.request("/mod/appeals", { as, form: { appealId: String(appeal.id), ...form } }))));
    expect((await decide("opal", { intent: "overturn", note: "mine" })).status).toBe(403);
    expect((await decide("taro", { intent: "overturn", note: "x" })).status).toBe(404);
    const asRina = (await h.outcome(async () => (await loader(h.args(h.request("/mod/appeals", { as: "rina" })))))).value as { cards: Array<{ id: number }> };
    expect(asRina.cards.map((c) => c.id)).toEqual([appeal.id]);
    expect((await decide("rina", { intent: "overturn", note: "" })).status).toBe(400);
    expect((await decide("rina", { intent: "explode", note: "x" })).status).toBe(400);
    expect(await decide("rina", { intent: "overturn", note: "It was fine" })).toMatchObject({ status: 302, location: "/mod/appeals?done=overturned" });
    expect((await stateOf(h.db, replyId)).hiddenAt).toBeNull();
    expect((await decide("rina", { intent: "uphold", note: "again" })).status).toBe(400);
    // Post-review display distinguishes a reversal from nothing left to reverse.
    const shown = async (done: string) => ((await h.outcome(async () => (await loader(h.args(h.request(`/mod/appeals?done=${done}`, { as: "rina" })))))).value as { done: string | null }).done;
    expect(await shown("overturned-nochange")).toBe("overturned-nochange");
    expect(await shown("bogus")).toBeNull();
    const { loader: notes } = await import("~/routes/notifications");
    const list = (await h.outcome(() => notes(h.args(h.request("/notifications", { as: "hana" }))))).value as { items: Array<{ kind: string; appealStatus: string | null; decisionNote: string | null }> };
    expect(list.items[0]).toMatchObject({ kind: "appeal_decided", appealStatus: "overturned", decisionNote: "It was fine" });
  });
});
