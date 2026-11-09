import { messageText } from "~/lib/i18n/messages";
import { seedRateLimit } from "./helpers/fixtures";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entries, follows, notifications, profiles } from "~/lib/db/schema";
import { createDraft, publishDraft } from "~/lib/drafts.server";
import { createReply, createTopic, listTopics, softDeleteEntry } from "~/lib/entries.server";
import { autoFollow, followerIds, getFollowState, markFollowedThreadRead, setFollow } from "~/lib/follows.server";
import { hideEntry } from "~/lib/moderation.server";
import { enqueueImmediateEmails, listNotifications, notifyForNewEntry, planNewEntryNotifications } from "~/lib/notifications.server";
import { MEMBER_RATE_LIMITS } from "~/lib/rate-limit.server";
import { setStance } from "~/lib/stances.server";
import { createApiToken } from "~/lib/tokens.server";
import { setVote } from "~/lib/votes.server";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Following a topic: the automatic follow, follow and unfollow by hand, the follow list, the followed_thread notification (merged while unread, and the
// precedence reply > mention > follow), the /follow and /following routes, and the Markdown twin.
const OP = { operator: true, langs: [] };
const T0 = new Date("2026-10-05T00:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

async function setup() {
  const db = await createTestDb();
  for (const id of ["alice", "bob", "carol", "dave", "op"]) await addMember(db, id, id);
  const topic = await createTopic(db, "alice", { lang: "ja", title: "アリスの話題", body: "本文" }, { now: at(0) });
  if (!topic.ok) throw new Error("topic failed");
  return { db, topic: topic.id };
}
type Db = Awaited<ReturnType<typeof setup>>["db"];

const reply = async (db: Db, as: string, topic: number, extra: { parentId?: number; now?: Date } = {}) => {
  const res = await createReply(db, as, topic, { lang: "ja", body: `${as} の返信`, parentId: extra.parentId }, { now: extra.now });
  if (!res.ok) throw new Error(`reply failed: ${res.error}`);
  return res.id;
};
const rowsFor = (db: Db, userId: string) => db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(notifications.id);
const followedRows = async (db: Db, userId: string) => (await rowsFor(db, userId)).filter((n) => n.kind === "followed_thread");
const stateOf = (db: Db, userId: string, thread: number) => getFollowState(db, userId, thread);

describe("the automatic follow", () => {
  it("follows the topics a member starts and the topics a member replies to, and nothing else", async () => {
    const { db, topic } = await setup();
    expect(await stateOf(db, "alice", topic)).toBe("following");
    expect(await stateOf(db, "bob", topic)).toBeNull();
    await reply(db, "bob", topic);
    expect(await stateOf(db, "bob", topic)).toBe("following");
    expect(await stateOf(db, "carol", topic)).toBeNull();
    expect(await followerIds(db, topic)).toEqual(["alice", "bob"]);
    // A reply to a reply follows the thread (the topic), never the reply's id
    const r = await reply(db, "bob", topic);
    await reply(db, "carol", topic, { parentId: r });
    expect(await stateOf(db, "carol", topic)).toBe("following");
    expect((await db.select().from(follows).where(eq(follows.userId, "carol"))).map((f) => f.threadId)).toEqual([topic]);
  });

  it("follows a question and an alternative way of asking, for their own authors only", async () => {
    const { db } = await setup();
    const q = await createTopic(db, "bob", { lang: "ja", title: "問い", body: "本文", asksStance: true });
    if (!q.ok) throw new Error("question failed");
    const alt = await createTopic(db, "carol", { lang: "ja", title: "別の立て方", body: "本文", asksStance: true, altOf: q.id });
    if (!alt.ok) throw new Error("alternative failed");
    expect(await stateOf(db, "bob", q.id)).toBe("following");
    expect(await stateOf(db, "carol", alt.id)).toBe("following");
    expect(await stateOf(db, "carol", q.id)).toBeNull();
    expect(await stateOf(db, "bob", alt.id)).toBeNull();
  });

  it("follows when a draft is published (a topic and a reply)", async () => {
    const { db, topic } = await setup();
    const d1 = await createDraft(db, "bob", { kind: "topic", lang: "ja", title: "下書きの話題", body: "本文" });
    if (!d1.ok) throw new Error("draft failed");
    const published = await publishDraft(db, "bob", d1.id);
    if (!published.ok) throw new Error("publish failed");
    expect(await stateOf(db, "bob", published.threadId)).toBe("following");
    const d2 = await createDraft(db, "carol", { kind: "reply", threadId: topic, lang: "ja", body: "下書きの返信" });
    if (!d2.ok) throw new Error("draft failed");
    expect(await publishDraft(db, "carol", d2.id)).toMatchObject({ ok: true });
    expect(await stateOf(db, "carol", topic)).toBe("following");
  });

  it("never follows a topic again that the member took off: not by a reply, not by autoFollow", async () => {
    const { db, topic } = await setup();
    await reply(db, "bob", topic);
    expect(await setFollow(db, "bob", topic, false, { now: at(1) })).toEqual({ ok: true, state: "unfollowed" });
    await reply(db, "bob", topic);
    expect(await stateOf(db, "bob", topic)).toBe("unfollowed");
    await autoFollow(db, "bob", topic, at(2));
    expect(await stateOf(db, "bob", topic)).toBe("unfollowed");
    // The author who took off their own topic stays off, too (a reply in their own topic does not bring it back)
    await setFollow(db, "alice", topic, false);
    await reply(db, "alice", topic);
    expect(await stateOf(db, "alice", topic)).toBe("unfollowed");
    // An unfollowed member is not notified; the others are
    await reply(db, "carol", topic);
    expect(await followedRows(db, "bob")).toEqual([]);
    expect(await followedRows(db, "alice")).toEqual([]);
  });

  it("does not follow for a stance or a vote, and makes no row for the past (no backfill)", async () => {
    const { db } = await setup();
    const q = await createTopic(db, "alice", { lang: "ja", title: "問い", body: "本文", asksStance: true });
    if (!q.ok) throw new Error("question failed");
    expect(await setStance(db, "bob", { questionId: q.id, position: "agree", expectedVersion: 0, triggerEntryId: null })).toMatchObject({ ok: true });
    expect(await setVote(db, "bob", q.id, true)).toMatchObject({ ok: true });
    expect(await stateOf(db, "bob", q.id)).toBeNull();
    // A topic that exists with no follows row (made before the feature) stays that way
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(follows).where(eq(follows.userId, "bob"));
    expect(n).toBe(0);
  });
});

describe("following by hand", () => {
  it("records the state and the time, and follows again after unfollowing", async () => {
    const { db, topic } = await setup();
    expect(await setFollow(db, "bob", topic, true, { now: at(1) })).toEqual({ ok: true, state: "following" });
    expect(await setFollow(db, "bob", topic, false, { now: at(2) })).toEqual({ ok: true, state: "unfollowed" });
    const [row] = await db.select().from(follows).where(and(eq(follows.userId, "bob"), eq(follows.threadId, topic)));
    expect(row).toMatchObject({ state: "unfollowed", createdAt: at(1), updatedAt: at(2) });
    expect(await setFollow(db, "bob", topic, true, { now: at(3) })).toEqual({ ok: true, state: "following" });
    expect(await followerIds(db, topic)).toEqual(["alice", "bob"]);
  });

  it("is only for topics: a reply, a deleted topic and a missing id are not_found", async () => {
    const { db, topic } = await setup();
    const r = await reply(db, "bob", topic);
    expect(await setFollow(db, "carol", r, true)).toEqual({ ok: false, error: "not_found" });
    expect(await setFollow(db, "carol", 424242, true)).toEqual({ ok: false, error: "not_found" });
    const gone = await createTopic(db, "bob", { lang: "ja", title: "消す話題", body: "b" });
    if (!gone.ok) throw new Error("topic failed");
    await softDeleteEntry(db, gone.id);
    expect(await setFollow(db, "carol", gone.id, true)).toEqual({ ok: false, error: "not_found" });
    expect(await stateOf(db, "carol", r)).toBeNull();
  });

  it("follows a hidden topic only for those who may see it; unfollowing needs a row when the member may not see it", async () => {
    const { db, topic } = await setup();
    await setFollow(db, "bob", topic, true);
    expect((await hideEntry(db, { id: "op", scope: OP }, { entryId: topic, reason: "spam", note: "n" })).ok).toBe(true);
    const carolView = { userId: "carol", scope: { operator: false, langs: [] as never[] } };
    // Carol cannot see the hidden topic: it does not exist for her (follow and unfollow alike)
    expect(await setFollow(db, "carol", topic, true, { viewer: carolView })).toEqual({ ok: false, error: "not_found" });
    expect(await setFollow(db, "carol", topic, false, { viewer: carolView })).toEqual({ ok: false, error: "not_found" });
    expect(await stateOf(db, "carol", topic)).toBeNull();
    // Bob followed before it was hidden: he can take it off (no view needed)
    expect(await setFollow(db, "bob", topic, false)).toEqual({ ok: true, state: "unfollowed" });
    // The author sees the hidden topic; so does the operator
    expect(await setFollow(db, "alice", topic, false, { viewer: { userId: "alice", scope: { operator: false, langs: [] } } })).toEqual({ ok: true, state: "unfollowed" });
    expect(await setFollow(db, "op", topic, true, { viewer: { userId: "op", scope: OP } })).toEqual({ ok: true, state: "following" });
    // A viewer that is not the member is ignored (it cannot lend its rights)
    expect(await setFollow(db, "dave", topic, true, { viewer: { userId: "op", scope: OP } })).toEqual({ ok: false, error: "not_found" });
  });
});

describe("the follow list (listTopics, kind followed)", () => {
  it("lists the topics the member follows now, latest activity first, without the ones taken off or deleted", async () => {
    const { db, topic: t1 } = await setup();
    const t2 = await createTopic(db, "alice", { lang: "ja", title: "二つ目", body: "b" }, { now: at(10) });
    const t3 = await createTopic(db, "alice", { lang: "ja", title: "三つ目", body: "b" }, { now: at(20) });
    const t4 = await createTopic(db, "alice", { lang: "ja", title: "四つ目", body: "b" }, { now: at(30) });
    if (!t2.ok || !t3.ok || !t4.ok) throw new Error("topic failed");
    const ids = async (viewer?: { userId: string; scope: typeof OP }) => (await listTopics(db, { kind: "followed", userId: "alice" }, { viewer })).topics.map((t) => t.id);
    expect(await ids()).toEqual([t4.id, t3.id, t2.id, t1]);
    // A new reply moves the topic to the top (latest activity), even from another member
    await reply(db, "bob", t1, { now: at(40) });
    expect(await ids()).toEqual([t1, t4.id, t3.id, t2.id]);
    await setFollow(db, "alice", t3.id, false);
    await softDeleteEntry(db, t2.id);
    expect(await ids()).toEqual([t1, t4.id]);
    // Another member's follows are not in the list
    await setFollow(db, "bob", t3.id, true);
    expect(await ids()).toEqual([t1, t4.id]);
    expect((await listTopics(db, { kind: "followed", userId: "bob" })).topics.map((t) => t.id)).toEqual([t1, t3.id]);
    // A hidden topic is listed only to those who may see it
    await hideEntry(db, { id: "op", scope: OP }, { entryId: t4.id, reason: "spam", note: "n" });
    expect(await ids()).toEqual([t1]);
    expect(await ids({ userId: "alice", scope: OP })).toEqual([t1, t4.id]);
  });

  it("keeps the questions-only filter and the paging", async () => {
    const { db } = await setup();
    const q = await createTopic(db, "alice", { lang: "ja", title: "問い", body: "b", asksStance: true }, { now: at(5) });
    if (!q.ok) throw new Error("question failed");
    expect((await listTopics(db, { kind: "followed", userId: "alice" }, { asksOnly: true })).topics.map((t) => t.id)).toEqual([q.id]);
    const page = await listTopics(db, { kind: "followed", userId: "alice" }, { limit: 1, page: 1 });
    expect(page).toMatchObject({ hasNext: true });
    expect((await listTopics(db, { kind: "followed", userId: "alice" }, { limit: 1, page: 2 })).hasNext).toBe(false);
  });
});

describe("the followed_thread notification", () => {
  it("is made for a follower of the topic when someone else replies, with the topic, the latest reply and its author", async () => {
    const { db, topic } = await setup();
    await reply(db, "bob", topic, { now: at(1) });
    // bob follows now. carol replies: alice (topic author) gets reply_to_topic, bob gets followed_thread
    const r = await reply(db, "carol", topic, { now: at(2) });
    expect(await followedRows(db, "alice")).toEqual([]);
    expect((await rowsFor(db, "alice")).map((n) => n.kind)).toEqual(["reply_to_topic", "reply_to_topic"]);
    expect(await followedRows(db, "bob")).toMatchObject([{ kind: "followed_thread", entryId: r, threadId: topic, actorId: "carol", mergedCount: 1, createdAt: at(2), readAt: null, emailedAt: null }]);
    // Never the replier, and not a member who does not follow
    expect(await rowsFor(db, "carol")).toEqual([]);
    expect(await rowsFor(db, "dave")).toEqual([]);
  });

  it("merges into one row per member and topic while unread: the latest reply, its time and a count", async () => {
    const { db, topic } = await setup();
    await setFollow(db, "dave", topic, true);
    await reply(db, "bob", topic, { now: at(1) });
    const r2 = await reply(db, "carol", topic, { now: at(2) });
    const r3 = await reply(db, "bob", topic, { now: at(3) });
    const rows = await followedRows(db, "dave");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entryId: r3, actorId: "bob", mergedCount: 3, createdAt: at(3), threadId: topic });
    // The merged row is the latest in the member's list, with the count
    const [item] = (await listNotifications(db, "dave")).items;
    expect(item).toMatchObject({ kind: "followed_thread", count: 3, actorHandle: "bob", topicTitle: "アリスの話題", threadId: topic, entryId: r3, unavailable: false, latestUnavailable: false });
    expect(r2).toBeLessThan(r3);
  });

  it("starts a new row after the member reads it (marking it read by hand, or by opening the topic)", async () => {
    const { db, topic } = await setup();
    await setFollow(db, "dave", topic, true);
    await reply(db, "bob", topic, { now: at(1) });
    const [first] = await followedRows(db, "dave");
    await db.update(notifications).set({ readAt: at(2) }).where(eq(notifications.id, first.id));
    await reply(db, "bob", topic, { now: at(3) });
    const rows = await followedRows(db, "dave");
    expect(rows.map((n) => [n.mergedCount, n.readAt])).toEqual([[1, at(2)], [1, null]]);
    // Opening the topic marks the unread one (only that member's, only that topic's) as read
    const other = await createTopic(db, "alice", { lang: "ja", title: "別の話題", body: "b" }, { now: at(4) });
    if (!other.ok) throw new Error("topic failed");
    await setFollow(db, "dave", other.id, true);
    await reply(db, "bob", other.id, { now: at(5) });
    await setFollow(db, "carol", topic, true);
    await reply(db, "bob", topic, { now: at(6) });
    expect(await markFollowedThreadRead(db, "dave", topic, at(7))).toBe(1);
    expect(await markFollowedThreadRead(db, "dave", topic, at(8))).toBe(0);
    expect((await followedRows(db, "dave")).map((n) => [n.threadId, n.readAt !== null])).toEqual([[topic, true], [topic, true], [other.id, false]]);
    expect((await followedRows(db, "carol")).map((n) => n.readAt)).toEqual([null]);
  });

  it("sends only the reply notification to a member who would also be told as a follower (reply > follow), and never both", async () => {
    const { db, topic } = await setup();
    const a = await reply(db, "bob", topic, { now: at(1) });
    // carol replies to bob's reply: bob (reply_to_reply) and alice (reply_to_topic) get reply notifications; both follow, neither gets followed_thread. dave follows and does.
    await setFollow(db, "dave", topic, true);
    const b = await reply(db, "carol", topic, { parentId: a, now: at(2) });
    const byEntry = await db.select().from(notifications).where(eq(notifications.entryId, b));
    expect(byEntry.map((n) => [n.userId, n.kind]).sort()).toEqual([["alice", "reply_to_topic"], ["bob", "reply_to_reply"], ["dave", "followed_thread"]]);
    expect(await followedRows(db, "bob")).toEqual([]);
    expect(await followedRows(db, "alice")).toEqual([]);
    // Every notification of a reply carries the topic
    expect(byEntry.every((n) => n.threadId === topic)).toBe(true);
  });

  it("makes nothing for a topic (no reply to tell about), and nothing of a reply by a suspended author", async () => {
    const { db, topic } = await setup();
    await setFollow(db, "dave", topic, true);
    expect(await rowsFor(db, "dave")).toEqual([]);
    await db.update(profiles).set({ suspendedUntil: at(60 * 24) }).where(eq(profiles.userId, "bob"));
    await reply(db, "bob", topic, { now: at(1) });
    expect(await followedRows(db, "dave")).toEqual([]);
    // After the suspension ends, replies are told again
    await db.update(profiles).set({ suspendedUntil: at(30) }).where(eq(profiles.userId, "bob"));
    await reply(db, "bob", topic, { now: at(31) });
    expect(await followedRows(db, "dave")).toMatchObject([{ mergedCount: 1 }]);
  });

  it("makes nothing when the reply or the topic is hidden or deleted at the time (notifyForNewEntry on its own)", async () => {
    const { db, topic } = await setup();
    await setFollow(db, "dave", topic, true);
    const r = await reply(db, "bob", topic, { now: at(1) });
    const before = (await followedRows(db, "dave"))[0];
    // The same reply is notified again as if new, but it is hidden now: no merge, no new row
    await hideEntry(db, { id: "op", scope: OP }, { entryId: r, reason: "spam", note: "n" });
    const made = await notifyForNewEntry(db, { entry: { id: r, kind: "reply", threadId: topic, authorId: "bob" }, topicAuthorId: "alice", parentAuthorId: null, mentioned: [], now: at(2) });
    expect(made.filter((n) => n.kind === "followed_thread")).toEqual([]);
    expect((await followedRows(db, "dave"))[0].mergedCount).toBe(before.mergedCount);
  });

  it("shows the count and the latest reply; a hidden latest reply leaves the author out and points to the topic; a hidden or deleted topic is only a placeholder", async () => {
    const { db, topic } = await setup();
    await setFollow(db, "dave", topic, true);
    const a = await reply(db, "bob", topic, { now: at(1) });
    const b = await reply(db, "carol", topic, { now: at(2) });
    expect((await listNotifications(db, "dave")).items[0]).toMatchObject({ count: 2, actorHandle: "carol", entryId: b, latestUnavailable: false, unavailable: false });
    await hideEntry(db, { id: "op", scope: OP }, { entryId: b, reason: "spam", note: "n" });
    expect((await listNotifications(db, "dave")).items[0]).toMatchObject({ count: 2, actorHandle: null, entryId: null, threadId: topic, topicTitle: "アリスの話題", latestUnavailable: true, unavailable: false });
    await hideEntry(db, { id: "op", scope: OP }, { entryId: topic, reason: "spam", note: "n" });
    expect((await listNotifications(db, "dave")).items[0]).toMatchObject({ unavailable: true, topicTitle: null, actorHandle: null, entryId: null, threadId: null });
    expect(a).toBeLessThan(b);
  });
});

describe("who is told how: the plan for one new post", () => {
  const base = { authorId: "carol", kind: "reply" as "topic" | "reply", topicAuthorId: "alice", parentAuthorId: "bob" as string | null, mentioned: [] as string[], followers: [] as string[] };
  const plan = (over: Partial<typeof base>) => {
    const p = planNewEntryNotifications({ ...base, ...over });
    return { reply: [...p.reply].sort(), mention: p.mention, mentionRecordOnly: p.mentionRecordOnly, follow: p.follow };
  };

  it("reply notifications first; followers get followed_thread only when no other notification goes to them; never the author", () => {
    expect(plan({ followers: ["alice", "bob", "carol", "dave", "erin"] })).toEqual({
      reply: [["alice", "reply_to_topic"], ["bob", "reply_to_reply"]],
      mention: [],
      mentionRecordOnly: [],
      follow: ["dave", "erin"],
    });
    expect(plan({ parentAuthorId: null, followers: ["alice", "bob"] }).follow).toEqual(["bob"]);
    // A topic has no reply recipients and no followers' notification
    expect(plan({ kind: "topic", topicAuthorId: undefined, parentAuthorId: null, followers: ["bob"] })).toEqual({ reply: [], mention: [], mentionRecordOnly: [], follow: [] });
  });

  it("the mention hook: a mention beats a follow, a reply notification beats a mention (the member is only recorded), the author is never mentioned", () => {
    expect(plan({ mentioned: ["dave", "erin", "dave"], followers: ["dave", "erin", "frank"] })).toEqual({
      reply: [["alice", "reply_to_topic"], ["bob", "reply_to_reply"]],
      mention: ["dave", "erin"],
      mentionRecordOnly: [],
      follow: ["frank"],
    });
    // bob already gets reply_to_reply: only a record is kept for the mention; he is not a follower candidate either
    expect(plan({ mentioned: ["bob", "carol", "dave"], followers: ["bob", "dave"] })).toEqual({
      reply: [["alice", "reply_to_topic"], ["bob", "reply_to_reply"]],
      mention: ["dave"],
      mentionRecordOnly: ["bob"],
      follow: [],
    });
  });
});

describe("the database rules of notifications", () => {
  it("requires a topic and a reply for followed_thread, a count of at least 1, and one unread row per member and topic", async () => {
    const { db, topic } = await setup();
    const r = await reply(db, "bob", topic);
    const failing = (values: Partial<typeof notifications.$inferInsert>) =>
      db.insert(notifications).values({ userId: "dave", kind: "followed_thread", entryId: r, threadId: topic, ...values }).then(() => null, (e: { cause?: { constraint?: string } }) => e.cause?.constraint ?? "other");
    expect(await failing({ threadId: null })).toBe("notifications_followed_thread_check");
    expect(await failing({ entryId: null })).toBe("notifications_followed_thread_check");
    expect(await failing({ mergedCount: 0 })).toBe("notifications_merged_count_check");
    expect(await failing({})).toBeNull();
    expect(await failing({})).toBe("notifications_followed_unread_unique");
    // A read row does not count; and the other kinds may repeat
    await db.update(notifications).set({ readAt: at(1) }).where(and(eq(notifications.userId, "dave"), eq(notifications.kind, "followed_thread")));
    expect(await failing({})).toBeNull();
    await db.insert(notifications).values([{ userId: "dave", kind: "reply_to_topic", entryId: r }, { userId: "dave", kind: "reply_to_topic", entryId: r }]);
  });

  it("queues the immediate email only for the kinds a member's preference sends at once (auto: replies only)", async () => {
    const { db } = await setup();
    await db.update(profiles).set({ emailPref: "auto" }).where(eq(profiles.userId, "alice"));
    await db.update(profiles).set({ emailPref: "immediate" }).where(eq(profiles.userId, "bob"));
    await db.update(profiles).set({ emailPref: "daily" }).where(eq(profiles.userId, "carol"));
    await db.update(profiles).set({ emailPref: "none" }).where(eq(profiles.userId, "dave"));
    const created = [
      { id: 1, userId: "alice", kind: "reply_to_topic" as const },
      { id: 2, userId: "alice", kind: "followed_thread" as const },
      { id: 3, userId: "bob", kind: "followed_thread" as const },
      { id: 4, userId: "carol", kind: "reply_to_topic" as const },
      { id: 5, userId: "dave", kind: "reply_to_topic" as const },
    ];
    // alice's reply and bob's followed_thread only
    expect(await enqueueImmediateEmails(db, created, { now: at(0) })).toBe(2);
  });
});

describe("the routes", () => {
  let h: RouteHarness;
  let topicId: number;
  let hiddenId: number;
  beforeAll(async () => {
    process.env.OPERATOR_EMAILS = "";
    h = await setupRouteHarness();
    await h.signIn("alice", { homeArea: "ja" });
    await h.signIn("bob", { homeArea: "ja" });
    await h.signIn("carol", { homeArea: "ja" });
    const t = await createTopic(h.db, h.ids.alice, { lang: "ja", title: "アリスの話題", body: "本文" });
    const hidden = await createTopic(h.db, h.ids.alice, { lang: "ja", title: "隠す話題", body: "本文" });
    if (!t.ok || !hidden.ok) throw new Error("topic failed");
    topicId = t.id;
    hiddenId = hidden.id;
    await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, hiddenId));
  });
  afterAll(() => {
    h.restore();
    delete process.env.OPERATOR_EMAILS;
  });

  const post = (as: string | undefined, form: Record<string, string>, headers: Record<string, string> = {}) =>
    import("~/routes/follow").then(({ action }) => h.outcome(() => action(h.args(h.request("/follow", { as, form, headers })))));
  const body = (res: { value?: unknown }) => (res.value as { data: unknown }).data;

  it("/follow answers a fetcher with the state (private, no-store) and a plain form with a redirect to returnTo", async () => {
    const res = await post("bob", { threadId: String(topicId), follow: "1" });
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ ok: true, threadId: topicId, state: "following" });
    expect((res.value as { init: { headers: Record<string, string> } }).init.headers["Cache-Control"]).toBe("private, no-store");
    expect(await getFollowState(h.db, h.ids.bob, topicId)).toBe("following");
    const nav = await post("bob", { threadId: String(topicId), follow: "0", returnTo: `/t/${topicId}#p-${topicId}` }, { "sec-fetch-dest": "document" });
    expect(nav).toMatchObject({ status: 302, location: `/t/${topicId}#p-${topicId}` });
    expect(await getFollowState(h.db, h.ids.bob, topicId)).toBe("unfollowed");
    // An address that leaves the site is not followed
    const away = await post("bob", { threadId: String(topicId), follow: "1", returnTo: "https://evil.example/" }, { "sec-fetch-dest": "document" });
    expect(away).toMatchObject({ status: 302, location: "/" });
  });

  it("/follow refuses visitors, other origins, bad input, replies, missing and hidden topics; a suspended member may still unfollow", async () => {
    expect(await post(undefined, { threadId: String(topicId), follow: "1" })).toMatchObject({ status: 302, location: "/login" });
    expect((await post("bob", { threadId: String(topicId), follow: "1" }, { origin: "https://evil.example" })).status).toBe(403);
    expect(await getFollowState(h.db, h.ids.carol, topicId)).toBeNull();
    for (const form of [{ threadId: "x", follow: "1" }, { threadId: String(topicId), follow: "yes" }, { threadId: "0", follow: "1" }, { follow: "1" }] as Array<Record<string, string>>) {
      expect((await post("carol", form)).status, JSON.stringify(form)).toBe(400);
    }
    expect((await post("carol", { threadId: "424242", follow: "1" })).status).toBe(404);
    const [reply1] = await h.db.insert(entries).values({ kind: "reply", threadId: topicId, authorId: h.ids.bob, lang: "ja", body: "r" }).returning({ id: entries.id });
    expect((await post("carol", { threadId: String(reply1.id), follow: "1" })).status).toBe(404);
    expect((await post("carol", { threadId: String(hiddenId), follow: "1" })).status).toBe(404);
    await post("carol", { threadId: String(topicId), follow: "1" });
    await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86_400_000), suspendedReason: "spam" }).where(eq(profiles.userId, h.ids.carol));
    expect(body(await post("carol", { threadId: String(topicId), follow: "0" }))).toMatchObject({ state: "unfollowed" });
    await h.db.update(profiles).set({ suspendedUntil: null, suspendedReason: null }).where(eq(profiles.userId, h.ids.carol));
  });

  it("/follow has its own per-member limit (429)", async () => {
    await seedRateLimit(h.db, `member:follow:${h.ids.carol}`, MEMBER_RATE_LIMITS.follow);
    expect((await post("carol", { threadId: String(topicId), follow: "1" })).status).toBe(429);
    // The limit is per member
    expect((await post("bob", { threadId: String(topicId), follow: "1" })).status).toBe(200);
  });

  it("/following lists the member's follows and nothing of others; the page is private and keeps its place after /follow", async () => {
    const mod = await import("~/routes/following");
    const t2 = await createTopic(h.db, h.ids.bob, { lang: "ja", title: "ボブの話題", body: "b" });
    if (!t2.ok) throw new Error("topic failed");
    const read = async (as: string, query = "?all=1") => (await h.outcome(async () => (await mod.loader(h.args(h.request(`/following${query}`, { as })))))).value as { topics: Array<{ id: number }> };
    expect((await read("bob")).topics.map((t) => t.id).sort()).toEqual([topicId, t2.id].sort());
    await setFollow(h.db, h.ids.bob, topicId, false);
    expect((await read("bob")).topics.map((t) => t.id)).toEqual([t2.id]);
    expect((await read("alice")).topics.map((t) => t.id)).toContain(topicId);
    expect((await read("alice")).topics.map((t) => t.id)).not.toContain(t2.id);
    expect((await read("bob", "?all=1&asks=1")).topics).toEqual([]);
    expect((await h.outcome(async () => (await mod.loader(h.args(h.request("/following")))))).location).toBe("/login?next=%2Ffollowing");
    expect((await h.outcome(async () => (await mod.loader(h.args(h.request("/following?page=x", { as: "bob" })))))).status).toBe(404);
    expect(mod.headers()).toEqual({ "Cache-Control": "private" });
    // The list does not read again after /follow or /stance; it does read again after anything else
    const sr = (formAction?: string) => mod.shouldRevalidate({ formAction, defaultShouldRevalidate: true } as never);
    expect([sr("/follow"), sr("/stance"), sr("/vote"), sr("/notifications"), sr(undefined)]).toEqual([false, false, false, true, true]);
  });

  it("the topic page shows the member's state without reloading after /follow, and opening it marks its followed_thread notification read", async () => {
    const mod = await import("~/routes/topic");
    const t3 = await createTopic(h.db, h.ids.alice, { lang: "ja", title: "三番目", body: "b" });
    if (!t3.ok) throw new Error("topic failed");
    const load = async (as: string) => (await h.outcome(async () => (await mod.loader(h.args(h.request(`/t/${t3.id}`, { as }), { id: String(t3.id) })))));
    expect(((await load("bob")).value as { follow: unknown }).follow).toEqual({ state: null });
    await post("bob", { threadId: String(t3.id), follow: "1" });
    expect(((await load("bob")).value as { follow: unknown }).follow).toEqual({ state: "following" });
    await post("bob", { threadId: String(t3.id), follow: "0" });
    expect(((await load("bob")).value as { follow: unknown }).follow).toEqual({ state: "unfollowed" });
    // The button consumes its own response; unrelated writes still reload.
    expect(mod.shouldRevalidate({ formAction: "/follow", currentUrl: new URL(`http://localhost/t/${t3.id}`), nextUrl: new URL(`http://localhost/t/${t3.id}`), defaultShouldRevalidate: true } as never)).toBe(false);
    expect(mod.shouldRevalidate({ formAction: `/t/${t3.id}`, defaultShouldRevalidate: true } as never)).toBe(true);
    // Opening the topic marks the unread followed_thread of the member as read
    await post("bob", { threadId: String(t3.id), follow: "1" });
    await createReply(h.db, h.ids.carol, t3.id, { lang: "ja", body: "carol の返信" });
    expect(await followedRows(h.db, h.ids.bob)).toMatchObject([{ readAt: null }]);
    await load("bob");
    expect((await followedRows(h.db, h.ids.bob)).every((n) => n.readAt !== null)).toBe(true);
    // A hidden topic that the member may not see has no follow data at all
    const hiddenPage = await h.outcome(async () => (await mod.loader(h.args(h.request(`/t/${hiddenId}`, { as: "bob" }), { id: String(hiddenId) }))));
    expect((hiddenPage.value as { follow: unknown }).follow).toBeNull();
  });

  it("/notifications links a followed_thread to the latest reply, or to the topic when that reply is hidden", async () => {
    const { loader } = await import("~/routes/notifications");
    const t4 = await createTopic(h.db, h.ids.alice, { lang: "ja", title: "四番目", body: "b" });
    if (!t4.ok) throw new Error("topic failed");
    await setFollow(h.db, h.ids.carol, t4.id, true);
    const r = await createReply(h.db, h.ids.bob, t4.id, { lang: "ja", body: "bob" });
    if (!r.ok) throw new Error("reply failed");
    const items = async () => ((await h.outcome(async () => (await loader(h.args(h.request("/notifications", { as: "carol" })))))).value as { items: Array<{ kind: string; href: string | null; count: number }> }).items;
    expect((await items()).find((n) => n.kind === "followed_thread")).toMatchObject({ href: `/t/${t4.id}#c-${r.id}`, count: 1 });
    await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, r.id));
    expect((await items()).find((n) => n.kind === "followed_thread")).toMatchObject({ href: `/t/${t4.id}`, count: 1 });
  });
});

describe("the Markdown twin /following.md", () => {
  let h: RouteHarness;
  let topicId: number;
  beforeAll(async () => {
    process.env.OPERATOR_EMAILS = "";
    h = await setupRouteHarness();
    await h.signIn("alice", { homeArea: "ja" });
    await h.signIn("bob", { homeArea: "ja" });
    const t = await createTopic(h.db, h.ids.alice, { lang: "ja", title: "アリスの話題", body: "本文" });
    const q = await createTopic(h.db, h.ids.bob, { lang: "ja", title: "ボブの問い", body: "本文", asksStance: true });
    if (!t.ok || !q.ok) throw new Error("topic failed");
    topicId = t.id;
  });
  afterAll(() => {
    h.restore();
    delete process.env.OPERATOR_EMAILS;
  });

  const get = async (path: string, as?: string, headers: Record<string, string> = {}) => {
    const { loader } = await import("~/routes/following-md");
    const res = (await loader(h.args(h.request(path, { as, headers })))) as Response;
    return { status: res.status, cache: res.headers.get("cache-control"), text: await res.text() };
  };

  it("lists only the reader's own follows, newest activity first, in the shape of the other lists, as private no-store", async () => {
    const alice = await get("/following.md?all=1", "alice");
    expect(alice.status).toBe(200);
    expect(alice.cache).toBe("private, no-store");
    expect(alice.text).toContain("unread_only: false");
    expect(alice.text).toContain(`- id: p-${topicId}`);
    expect(alice.text).not.toContain("ボブの問い");
    const bob = await get("/following.md?all=1&asks=1", "bob");
    expect(bob.text).toContain("ボブの問い");
    expect(bob.text).toContain("asks_stance: true");
    expect(bob.text).not.toContain("アリスの話題");
    // An empty list
    await setFollow(h.db, h.ids.bob, (await h.db.select({ id: entries.id }).from(entries).where(eq(entries.title, "ボブの問い")))[0].id, false);
    expect((await get("/following.md", "bob")).text).toContain("No topics.");
  });

  it("works with a read token (its owner's follows only), and refuses without credentials (401)", async () => {
    const token = await createApiToken(h.db, h.ids.alice, { name: "t", kind: "read" });
    if (!token.ok) throw new Error("token failed");
    const viaToken = await get("/following.md?all=1", undefined, { authorization: `Bearer ${token.token}` });
    expect(viaToken.status).toBe(200);
    expect(viaToken.text).toContain(`- id: p-${topicId}`);
    expect((await get("/following.md")).status).toBe(401);
    expect((await get("/following.txt")).status).toBe(401);
    // A hidden topic is left out (the twin has no viewer)
    await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, topicId));
    expect((await get("/following.md?all=1", "alice")).text).not.toContain(`p-${topicId}`);
    await h.db.update(entries).set({ hiddenAt: null }).where(eq(entries.id, topicId));
  });

  it("is not in the change feed or the manifest (a follow changes no post)", async () => {
    const { loadChanges } = await import("~/lib/md/changes.server");
    const before = await loadChanges(h.db, { since: new Date("2000-01-01T00:00:00Z") });
    await setFollow(h.db, h.ids.bob, topicId, true);
    await setFollow(h.db, h.ids.bob, topicId, false);
    expect(JSON.stringify(await loadChanges(h.db, { since: new Date("2000-01-01T00:00:00Z") }))).toBe(JSON.stringify(before));
  });
});

describe("the number of followers is shown nowhere", () => {
  it("the loaders, the Markdown twins and the messages say nothing about how many follow a topic", async () => {
    const h = await setupRouteHarness();
    try {
      await h.signIn("alice", { homeArea: "ja" });
      await h.signIn("bob", { homeArea: "ja" });
      const t = await createTopic(h.db, h.ids.alice, { lang: "ja", title: "話題", body: "本文" });
      if (!t.ok) throw new Error("topic failed");
      await createReply(h.db, h.ids.bob, t.id, { lang: "ja", body: "返信" });
      const topicMod = await import("~/routes/topic");
      const followingMod = await import("~/routes/following");
      const pages = [
        (await h.outcome(async () => (await topicMod.loader(h.args(h.request(`/t/${t.id}`, { as: "alice" }), { id: String(t.id) }))))).value,
        (await h.outcome(async () => (await followingMod.loader(h.args(h.request("/following", { as: "alice" })))))).value,
      ];
      for (const page of pages) expect(JSON.stringify(page)).not.toMatch(/follower|followCount|follow_count|followedBy/i);
      const md = await import("~/routes/following-md");
      const twin = await ((await md.loader(h.args(h.request("/following.md", { as: "alice" })))) as Response).text();
      expect(twin).not.toMatch(/follower|follow_count/i);
      const { buildThreadMarkdown } = await import("~/lib/md/thread.server");
      expect(await buildThreadMarkdown(h.db, t.id, { page: 1, lang: null, sentences: false, k: null, asks: false } as never)).not.toMatch(/follower|follow_count/i);
      for (const lang of ["en", "ja"]) {
        const messages = (await import(`../messages/${lang}.json`)) as Record<string, string>;
        const own = Object.entries(messages).filter(([key]) => key.startsWith("follow") || key.startsWith("notification_followed") || key.startsWith("mail_item_followed"));
        expect(own.length).toBeGreaterThan(8);
        for (const [key, text] of own) expect(messageText(text), key).not.toMatch(/follower|フォロワー|フォローされ/i);
      }
    } finally {
      h.restore();
    }
  });
});
