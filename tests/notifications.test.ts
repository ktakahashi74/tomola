import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { entries, notifications, profiles } from "~/lib/db/schema";
import { createReply, createTopic, softDeleteEntry } from "~/lib/entries.server";
import { createReport, deleteEntry, hideEntry, suspendMember, unhideEntry, unsuspendMember } from "~/lib/moderation.server";
import { countUnreadNotifications, hasUnreadFollowedThread, listNotifications, markAllNotificationsRead, markNotificationRead, replyRecipients } from "~/lib/notifications.server";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Notifications: replies notify topic/reply authors, excluding self, with one notification per reply per recipient; moderation notifies the affected member without the actor; read status is tracked.
const OP = { operator: true, langs: [] };

async function setup() {
  const db = await createTestDb();
  for (const [id, handle] of [["alice", "alice"], ["bob", "bob"], ["carol", "carol"], ["op", "opal"]]) await addMember(db, id, handle);
  const topic = await createTopic(db, "alice", { lang: "ja", title: "アリスの話題", body: "本文" });
  if (!topic.ok) throw new Error("topic failed");
  return { db, topic: topic.id };
}

const mine = (db: Awaited<ReturnType<typeof setup>>["db"], userId: string) => db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(notifications.id);

describe("who is notified of a reply", () => {
  it("the topic author for a reply in the topic, the parent's author for a reply to a reply, never the replier, once per person", () => {
    // A reply to the topic.
    expect([...replyRecipients({ actorId: "bob", topicAuthorId: "alice", parentAuthorId: null })]).toEqual([["alice", "reply_to_topic"]]);
    // A reply to a reply: notify the topic author (reply_to_topic) and parent author (reply_to_reply).
    expect([...replyRecipients({ actorId: "carol", topicAuthorId: "alice", parentAuthorId: "bob" })].sort()).toEqual([["alice", "reply_to_topic"], ["bob", "reply_to_reply"]]);
    // If both are the same person, keep only the more specific notification.
    expect([...replyRecipients({ actorId: "carol", topicAuthorId: "alice", parentAuthorId: "alice" })]).toEqual([["alice", "reply_to_reply"]]);
    // Do not notify oneself.
    expect([...replyRecipients({ actorId: "alice", topicAuthorId: "alice", parentAuthorId: null })]).toEqual([]);
    expect([...replyRecipients({ actorId: "bob", topicAuthorId: "alice", parentAuthorId: "bob" })]).toEqual([["alice", "reply_to_topic"]]);
  });
});

describe("creating notifications with the reply", () => {
  it("notifies the topic author of a reply to the topic, and nobody of the author's own reply", async () => {
    const { db, topic } = await setup();
    const now = new Date("2026-10-05T00:00:00Z");
    const r = await createReply(db, "bob", topic, { lang: "ja", body: "返信" }, { now });
    if (!r.ok) throw new Error("reply failed");
    expect(await mine(db, "alice")).toMatchObject([{ kind: "reply_to_topic", entryId: r.id, actorId: "bob", actionId: null, createdAt: now, readAt: null, emailedAt: null }]);
    expect(await mine(db, "bob")).toEqual([]);
    // The topic author replying to their own topic receives no self-notification.
    await createReply(db, "alice", topic, { lang: "ja", body: "自分で返信" });
    expect(await mine(db, "alice")).toHaveLength(1);
  });

  it("notifies the parent reply's author and the topic author (two people), and only the parent author when they are the same", async () => {
    const { db, topic } = await setup();
    const a = await createReply(db, "bob", topic, { lang: "ja", body: "bob の返信" });
    if (!a.ok) throw new Error("reply failed");
    const b = await createReply(db, "carol", topic, { lang: "ja", body: "carol が bob の返信に返信", parentId: a.id });
    if (!b.ok) throw new Error("reply failed");
    expect((await mine(db, "bob")).map((n) => [n.kind, n.entryId, n.actorId])).toEqual([["reply_to_reply", b.id, "carol"]]);
    expect((await mine(db, "alice")).map((n) => [n.kind, n.entryId])).toEqual([["reply_to_topic", a.id], ["reply_to_topic", b.id]]);
    // Replying to the topic author's own reply creates only one notification.
    const c = await createReply(db, "alice", topic, { lang: "ja", body: "alice の返信" });
    if (!c.ok) throw new Error("reply failed");
    const d = await createReply(db, "bob", topic, { lang: "ja", body: "bob が alice の返信に返信", parentId: c.id });
    if (!d.ok) throw new Error("reply failed");
    // carol replied earlier, so she follows the topic: she is told as a follower; alice (a reply recipient) is told once, as reply_to_reply
    const forD = (await db.select().from(notifications).where(eq(notifications.entryId, d.id)).orderBy(notifications.id));
    expect(forD.map((n) => [n.userId, n.kind]).sort()).toEqual([["alice", "reply_to_reply"], ["carol", "followed_thread"]]);
    // Replying to one's own reply creates no self-notification.
    const e = await createReply(db, "bob", topic, { lang: "ja", body: "bob が自分に返信", parentId: a.id });
    if (!e.ok) throw new Error("reply failed");
    expect((await db.select().from(notifications).where(eq(notifications.entryId, e.id)).orderBy(notifications.id)).map((n) => n.userId).sort()).toEqual(["alice", "carol"]);
  });

  it("makes no notification when the reply is refused", async () => {
    const { db, topic } = await setup();
    const a = await createReply(db, "bob", topic, { lang: "ja", body: "a" });
    if (!a.ok) throw new Error("reply failed");
    await softDeleteEntry(db, a.id);
    const before = (await db.select().from(notifications)).length;
    expect(await createReply(db, "carol", topic, { lang: "ja", body: "x", parentId: a.id })).toEqual({ ok: false, error: "parent_not_in_thread" });
    expect(await createReply(db, "carol", topic, { lang: "ja", body: "" })).toMatchObject({ ok: false });
    expect(await createReply(db, "carol", 424242, { lang: "ja", body: "x" })).toEqual({ ok: false, error: "thread_not_found" });
    expect((await db.select().from(notifications)).length).toBe(before);
  });
});

describe("the same transaction", () => {
  it("rolls the reply back if its notification cannot be stored", async () => {
    const { db, topic } = await setup();
    await db.execute(sql`alter table notifications add constraint fail_all check (false) not valid`);
    await expect(createReply(db, "bob", topic, { lang: "ja", body: "返信" })).rejects.toThrow();
    await db.execute(sql`alter table notifications drop constraint fail_all`);
    expect((await db.select().from(entries).where(eq(entries.threadId, topic)))).toEqual([]);
    expect((await db.select().from(entries).where(eq(entries.id, topic)))[0]).toMatchObject({ replyCount: 0 });
    expect(await mine(db, "alice")).toEqual([]);
  });
});

describe("moderation notifications", () => {
  it("tells the author of a hidden or deleted post and a suspended member, without saying who acted", async () => {
    const { db, topic } = await setup();
    const r = await createReply(db, "bob", topic, { lang: "ja", body: "返信" });
    const r2 = await createReply(db, "bob", topic, { lang: "ja", body: "返信2" });
    if (!r.ok || !r2.ok) throw new Error("reply failed");
    const op = { id: "op", scope: OP };
    const hid = await hideEntry(db, op, { entryId: r.id, reason: "spam", note: "ad" });
    const del = await deleteEntry(db, op, { entryId: r2.id, reason: "harassment", note: "rude" });
    const sus = await suspendMember(db, op, { userId: "bob", reason: "infohazard", note: "careful", days: 3 });
    if (!hid.ok || !del.ok || !sus.ok) throw new Error("action failed");
    await unhideEntry(db, op, { entryId: r.id, reason: "other" });
    const rows = await mine(db, "bob");
    expect(rows.map((n) => [n.kind, n.entryId, n.actionId, n.actorId])).toEqual([
      ["moderation", r.id, hid.actionId, null],
      ["moderation", r2.id, del.actionId, null],
      ["moderation", null, sus.actionId, null],
    ]);
    // Unhiding sends no notification; the actor is absent everywhere.
    expect(JSON.stringify(rows)).not.toContain("op");
    expect(await mine(db, "op")).toEqual([]);
    // A report alone sends no notification.
    await createReport(db, "carol", { entryId: topic, reason: "spam" });
    expect(await mine(db, "alice")).toHaveLength(2);
  });
});

describe("reading and the list", () => {
  it("counts unread, marks one (own only) or all as read, and marks nothing twice; the others' notifications are left alone", async () => {
    const { db, topic } = await setup();
    for (const who of ["bob", "carol", "bob"]) await createReply(db, who, topic, { lang: "ja", body: "r" });
    // bob also has notifications: carol's reply as a new reply in a followed topic, and alice's reply to bob's topic.
    const bobTopic = await createTopic(db, "bob", { lang: "ja", title: "bob の話題", body: "b" });
    if (!bobTopic.ok) throw new Error("topic failed");
    await createReply(db, "alice", bobTopic.id, { lang: "ja", body: "alice の返信" });
    const [first, second] = await mine(db, "alice");
    expect(await countUnreadNotifications(db, "alice")).toBe(3);
    // The number counts only what is addressed to the member; a new reply in a followed topic is a dot (hasUnreadFollowedThread), not part of the number.
    expect(await countUnreadNotifications(db, "bob")).toBe(1);
    expect(await hasUnreadFollowedThread(db, "bob")).toBe(true);
    expect(await hasUnreadFollowedThread(db, "alice")).toBe(false);
    const at = new Date("2026-10-06T00:00:00Z");
    // One cannot mark another person's notification as read.
    expect(await markNotificationRead(db, "bob", first.id, { now: at })).toBe(false);
    expect(await markNotificationRead(db, "alice", first.id, { now: at })).toBe(true);
    expect(await markNotificationRead(db, "alice", first.id)).toBe(false);
    expect((await mine(db, "alice"))[0].readAt).toEqual(at);
    expect(await countUnreadNotifications(db, "alice")).toBe(2);
    // Marking all as read affects only one's own notifications.
    expect(await markAllNotificationsRead(db, "alice", { now: at })).toBe(2);
    expect(await countUnreadNotifications(db, "alice")).toBe(0);
    expect((await mine(db, "alice"))[1].readAt).toEqual(at);
    expect((await mine(db, "bob")).map((n) => n.readAt)).toEqual([null, null]);
    expect(await countUnreadNotifications(db, "bob")).toBe(1);
    expect(second.readAt).toBeNull();
  });

  it("lists newest first in pages, with the replier and the title; a hidden or deleted reply or topic is only a placeholder", async () => {
    const { db, topic } = await setup();
    const a = await createReply(db, "bob", topic, { lang: "ja", body: "SECRET-A" }, { now: new Date("2026-10-05T00:00:00Z") });
    const b = await createReply(db, "carol", topic, { lang: "ja", body: "SECRET-B" }, { now: new Date("2026-10-05T01:00:00Z") });
    const c = await createReply(db, "bob", topic, { lang: "ja", body: "SECRET-C" }, { now: new Date("2026-10-05T02:00:00Z") });
    if (!a.ok || !b.ok || !c.ok) throw new Error("reply failed");
    const page1 = await listNotifications(db, "alice", { limit: 2 });
    expect(page1).toMatchObject({ page: 1, hasNext: true });
    expect(page1.items.map((n) => [n.entryId, n.actorHandle, n.topicTitle, n.unavailable, n.read])).toEqual([
      [c.id, "bob", "アリスの話題", false, false],
      [b.id, "carol", "アリスの話題", false, false],
    ]);
    // Hidden and deleted items expose no handle, title, or reply link.
    await hideEntry(db, { id: "op", scope: OP }, { entryId: b.id, reason: "spam", note: "n" });
    await softDeleteEntry(db, c.id);
    const all = await listNotifications(db, "alice");
    expect(all.items.map((n) => [n.unavailable, n.actorHandle, n.topicTitle, n.entryId, n.threadId])).toEqual([
      [true, null, null, null, null],
      [true, null, null, null, null],
      [false, "bob", "アリスの話題", a.id, topic],
    ]);
    // Deleting the topic makes the remaining items placeholders too.
    await softDeleteEntry(db, topic);
    expect((await listNotifications(db, "alice")).items.every((n) => n.unavailable)).toBe(true);
  });

  it("shows no title, handle or link for a reply in a hidden topic (the title is hidden content)", async () => {
    const { db, topic } = await setup();
    const r = await createReply(db, "bob", topic, { lang: "ja", body: "返信" });
    if (!r.ok) throw new Error("reply failed");
    expect((await listNotifications(db, "alice")).items[0]).toMatchObject({ unavailable: false, topicTitle: "アリスの話題", actorHandle: "bob", entryId: r.id });
    await hideEntry(db, { id: "op", scope: OP }, { entryId: topic, reason: "spam", note: "n" });
    const [item] = (await listNotifications(db, "alice")).items.filter((n) => n.kind === "reply_to_topic");
    expect(item).toMatchObject({ unavailable: true, topicTitle: null, actorHandle: null, entryId: null, threadId: null });
  });

  it("tells a member when a suspension is lifted by hand (and not who lifted it)", async () => {
    const { db } = await setup();
    const op = { id: "op", scope: OP };
    const sus = await suspendMember(db, op, { userId: "bob", reason: "spam", note: "n", days: 3 }, { now: new Date("2026-10-05T00:00:00Z") });
    if (!sus.ok) throw new Error("suspend failed");
    const lifted = await unsuspendMember(db, op, { userId: "bob", reason: "other", note: "reviewed again" }, { now: new Date("2026-10-05T01:00:00Z") });
    if (!lifted.ok) throw new Error("unsuspend failed");
    const rows = await mine(db, "bob");
    expect(rows.map((n) => [n.kind, n.actionId, n.actorId])).toEqual([["moderation", sus.actionId, null], ["moderation", lifted.actionId, null]]);
    const items = (await listNotifications(db, "bob")).items;
    expect(items[0]).toMatchObject({ action: "unsuspend", note: "reviewed again" });
    expect(JSON.stringify(items)).not.toContain("opal");
  });

  it("shows the affected member the action, the reason, the explanation and the end of a suspension", async () => {
    const { db, topic } = await setup();
    const r = await createReply(db, "bob", topic, { lang: "ja", body: "r" });
    if (!r.ok) throw new Error("reply failed");
    const op = { id: "op", scope: OP };
    await suspendMember(db, op, { userId: "bob", reason: "infohazard", note: "explained", days: 2 }, { now: new Date("2026-10-05T00:00:00Z") });
    await hideEntry(db, op, { entryId: r.id, reason: "spam", note: "because" }, { now: new Date("2026-10-05T01:00:00Z") });
    const items = (await listNotifications(db, "bob")).items;
    expect(items.map((n) => [n.kind, n.action, n.reason, n.note])).toEqual([
      ["moderation", "hide", "spam", "because"],
      ["moderation", "suspend", "infohazard", "explained"],
    ]);
    expect(items[1].until).toEqual(new Date("2026-10-07T00:00:00Z"));
  });
});

describe("the /notifications route and the header count", () => {
  let h: RouteHarness;
  let topicId: number;
  beforeAll(async () => {
    process.env.OPERATOR_EMAILS = "";
    h = await setupRouteHarness();
    await h.signIn("alice", { homeArea: "ja" });
    await h.signIn("bob", { homeArea: "ja" });
    const t = await createTopic(h.db, h.ids.alice, { lang: "ja", title: "話題", body: "本文" });
    if (!t.ok) throw new Error("topic failed");
    topicId = t.id;
    for (let i = 0; i < 3; i++) await createReply(h.db, h.ids.bob, topicId, { lang: "ja", body: `返信${i}` });
  });
  afterAll(() => {
    h.restore();
    delete process.env.OPERATOR_EMAILS;
  });

  it("is for members: a visitor goes to the login; the list links each reply to its page and anchor", async () => {
    const { loader } = await import("~/routes/notifications");
    expect(await h.outcome(async () => (await loader(h.args(h.request("/notifications")))))).toMatchObject({ status: 302, location: "/login?next=%2Fnotifications" });
    const res = await h.outcome(async () => (await loader(h.args(h.request("/notifications", { as: "alice" })))));
    const value = res.value as { items: Array<{ href: string | null; read: boolean }> };
    expect(value.items).toHaveLength(3);
    expect(value.items.every((n) => n.href?.startsWith(`/t/${topicId}#c-`))).toBe(true);
    expect((await h.outcome(async () => (await loader(h.args(h.request("/notifications?page=2", { as: "alice" })))))).status).toBe(200);
    expect((await h.outcome(async () => (await loader(h.args(h.request("/notifications?page=x", { as: "alice" })))))).status).toBe(404);
  });

  it("marks one notification and then all as read, only the member's own, and the header count follows", async () => {
    const { action } = await import("~/routes/notifications");
    const { loader: layout } = await import("~/routes/member-layout");
    const { loader: openLink } = await import("~/routes/notification-open");
    const unread = async (as: string) => ((await h.outcome(() => layout(h.args(h.request("/", { as }))))).value as { unreadNotifications: number }).unreadNotifications;
    expect(await unread("alice")).toBe(3);
    expect(await unread("bob")).toBe(0);
    const [first] = await h.db.select().from(notifications).where(eq(notifications.userId, h.ids.alice)).orderBy(notifications.id);
    // bob trying to mark alice's notification as read changes nothing.
    await h.outcome(() => openLink(h.args(h.request(`/notifications/${first.id}/open`, { as: "bob" }), { id: String(first.id) })));
    expect(await unread("alice")).toBe(3);
    expect(await h.outcome(() => openLink(h.args(h.request(`/notifications/${first.id}/open`, { as: "alice" }), { id: String(first.id) })))).toMatchObject({ status: 302, location: expect.stringMatching(new RegExp(`^/t/${topicId}#c-`)) });
    expect(await unread("alice")).toBe(2);
    expect(await h.outcome(() => action(h.args(h.request("/notifications", { as: "alice", form: { intent: "read-all" } }))))).toMatchObject({ status: 302, location: "/notifications" });
    expect(await unread("alice")).toBe(0);
    expect((await h.outcome(() => action(h.args(h.request("/notifications", { as: "alice", form: { intent: "nope" } }))))).status).toBe(400);
    expect((await h.outcome(() => openLink(h.args(h.request("/notifications/x/open", { as: "alice" }), { id: "x" })))).status).toBe(400);
  });

  it("a suspended member can read and mark read", async () => {
    await createReply(h.db, h.ids.bob, topicId, { lang: "ja", body: "もう1つ" });
    await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86_400_000), suspendedReason: "spam" }).where(eq(profiles.userId, h.ids.alice));
    const { loader, action } = await import("~/routes/notifications");
    expect((await h.outcome(async () => (await loader(h.args(h.request("/notifications", { as: "alice" })))))).status).toBe(200);
    expect(await h.outcome(() => action(h.args(h.request("/notifications", { as: "alice", form: { intent: "read-all" } }))))).toMatchObject({ status: 302, location: "/notifications" });
  });
});
