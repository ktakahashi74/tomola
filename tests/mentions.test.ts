import { quietLogger as quiet } from "./helpers/logger";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, jobs, notifications, notifiedMentions, profiles, translations } from "~/lib/db/schema";
import { createDraft, publishDraft } from "~/lib/drafts.server";
import { createReply, createTopic, editEntry, getThread } from "~/lib/entries.server";
import { setFollow } from "~/lib/follows.server";
import { createNotificationHandlers, ensureDigestScheduled } from "~/lib/jobs/notification-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createMailer } from "~/lib/mail/mail.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { RENDER_VERSION, renderMarkdown } from "~/lib/markdown.server";
import { deleteEntry, hideEntry, suspendMember, unhideEntry } from "~/lib/moderation.server";
import { AUTO_IMMEDIATE_KINDS, effectiveEmailMode, NOTIFICATION_KINDS } from "~/lib/notifications";
import { listNotifications, notifyMentions } from "~/lib/notifications.server";
import { MENTION_NOTIFY_LIMIT } from "~/lib/mention-notifications";
import { addMember, createTestDb } from "./helpers/db";

// @mentions in a post: the member link, the notification of each named member, the record that tells a member once per post.
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const OP = { operator: true, langs: [] };


async function setup(...more: string[]) {
  const db = await createTestDb();
  for (const handle of ["alice", "bob", "carol", ...more]) await addMember(db, handle, handle, { readLangs: ["ja", "en"], email: `${handle}@example.com` });
  await addMember(db, "op", "opal", { readLangs: ["ja"] });
  return db;
}

const mentionRows = (db: Db, userId: string) => db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.kind, "mention"))).orderBy(notifications.id);
const recorded = async (db: Db, entryId: number) => (await db.select().from(notifiedMentions).where(eq(notifiedMentions.entryId, entryId))).map((r) => r.userId).sort();
const html = async (db: Db, id: number) => (await db.select({ html: entries.html }).from(entries).where(eq(entries.id, id)))[0].html;
const mentionLink = async (db: Db, userId: string, text: string) => {
  const [profile] = await db.select({ publicId: profiles.publicId }).from(profiles).where(eq(profiles.userId, userId));
  if (!profile) throw new Error(`No profile for ${userId}`);
  return `<a class="mention" href="/u/id/${profile.publicId}">${text}</a>`;
};
const must = <T extends { ok: boolean }>(res: T): Extract<T, { ok: true }> => {
  if (!res.ok) throw new Error(`failed: ${JSON.stringify(res)}`);
  return res as Extract<T, { ok: true }>;
};

describe("the mention kind and the email default", () => {
  it("is a notification kind, and one of the kinds that go out at once when the preference takes the default", () => {
    expect(NOTIFICATION_KINDS).toContain("mention");
    expect(AUTO_IMMEDIATE_KINDS).toContain("mention");
    expect(effectiveEmailMode("auto", "mention")).toBe("immediate");
    expect(effectiveEmailMode("auto", "reply_to_topic")).toBe("immediate");
    expect(effectiveEmailMode("auto", "moderation")).toBe("daily");
    // A preference that is not `auto` decides for every kind.
    expect(effectiveEmailMode("daily", "mention")).toBe("daily");
    expect(effectiveEmailMode("immediate", "mention")).toBe("immediate");
    expect(effectiveEmailMode("none", "mention")).toBe("none");
  });
});

describe("rendering", () => {
  it("links the named member's public id with the characters of the source, and stores it with the current render version", async () => {
    const db = await setup();
    const t = must(await createTopic(db, "alice", { lang: "en", title: "t", body: "Hello @Bob, and ＠CAROL! `@bob` stays code. [@bob](https://example.com) stays a link." }));
    const stored = (await html(db, t.id))!;
    expect(stored).toContain(await mentionLink(db, "bob", "@Bob"));
    expect(stored).toContain(await mentionLink(db, "carol", "＠CAROL"));
    expect(stored).toContain("<code>@bob</code>");
    expect(stored).toContain('href="https://example.com"');
    // Two member links and the ordinary link that the author wrote.
    expect(stored.match(/<a /g)).toHaveLength(3);
    expect(stored).not.toContain("data-");
    expect((await db.select({ v: entries.htmlVersion }).from(entries).where(eq(entries.id, t.id)))[0].v).toBe(RENDER_VERSION);
    expect(RENDER_VERSION).toBeGreaterThanOrEqual(3);
  });

  it("does not emphasize a handle that is not a member, and nothing without targets", async () => {
    const db = await setup();
    const t = must(await createTopic(db, "alice", { lang: "en", title: "t", body: "@nobody and @bob" }));
    const stored = (await html(db, t.id))!;
    expect(stored).toContain(`@nobody and ${await mentionLink(db, "bob", "@bob")}`);
    expect((await renderMarkdown("@bob"))).toBe("<p>@bob</p>");
  });

  it("posts invalid references safely and never renders or notifies an escaped handle after indentation or a multi-code-point reference", async () => {
    const db = await setup();
    const topic = must(await createTopic(db, "alice", {
      lang: "en", title: "References and indentation",
      body: "- text &NotEqualTilde;\n  \\@bob and @carol\n\n&#x110000; safe",
    }));
    expect(await html(db, topic.id)).not.toMatch(/class="mention"[^>]*>@bob<\/a>/);
    expect(await html(db, topic.id)).toContain(await mentionLink(db, "carol", "@carol"));
    expect(await mentionRows(db, "bob")).toHaveLength(0);
    expect(await mentionRows(db, "carol")).toHaveLength(1);
    expect(await recorded(db, topic.id)).toEqual(["carol"]);
  });

  it("renders and notifies a plain handle after a decoded ampersand while leaving an escaped handle untouched", async () => {
    const db = await setup();
    const t = must(await createTopic(db, "alice", { lang: "en", title: "Ampersand", body: "&amp; \\@bob @carol" }));
    expect(await html(db, t.id)).not.toMatch(/class="mention"[^>]*>@bob<\/a>/);
    expect(await html(db, t.id)).toContain(await mentionLink(db, "carol", "@carol"));
    expect(await mentionRows(db, "bob")).toHaveLength(0);
    expect(await mentionRows(db, "carol")).toHaveLength(1);
  });

  it("emphasizes a mention inside a block quote, a heading and a table", async () => {
    const db = await setup();
    const t = must(await createTopic(db, "alice", { lang: "en", title: "t", body: "> @bob said\n\n# @carol\n\n| x |\n|---|\n| @bob |" }));
    expect(((await html(db, t.id))!.match(/class="mention"/g) ?? []).length).toBe(3);
  });

  it("keeps an unresolved spelling plain after a member joins and the stored rendering is rebuilt", async () => {
    const db = await setup();
    const t = must(await createTopic(db, "alice", { lang: "en", title: "t", body: "Hi @newbie" }));
    expect(await html(db, t.id)).not.toContain("mention");
    await addMember(db, "newbie", "newbie");
    // The stored rendering is still the old one: reading does not render again while the version is current.
    expect((await getThread(db, t.id))?.topic.html).not.toContain("mention");
    await db.update(entries).set({ htmlVersion: RENDER_VERSION - 1 }).where(eq(entries.id, t.id));
    const thread = await getThread(db, t.id);
    expect(thread?.topic.html).toContain("@newbie");
    expect(thread?.topic.html).not.toContain('class="mention"');
    expect(await html(db, t.id)).not.toContain('class="mention"');
  });

  it("rebuilds all the rows of a thread using their saved mention targets", async () => {
    const db = await setup();
    const t = must(await createTopic(db, "alice", { lang: "en", title: "t", body: "@bob" }));
    for (const body of ["@carol", "@bob again", "no mention"]) must(await createReply(db, "bob", t.id, { lang: "en", body }));
    await db.update(entries).set({ htmlVersion: 0 });
    const thread = await getThread(db, t.id);
    expect(thread?.replies.map((r) => r.html.includes('class="mention"'))).toEqual([true, true, false]);
  });
});

describe("notifications of a new post", () => {
  it("tells each named member with a mention that points at the post, never the author, nobody who does not exist", async () => {
    const db = await setup();
    const now = new Date("2026-10-05T00:00:00Z");
    const t = must(await createTopic(db, "alice", { lang: "en", title: "A topic", body: "@bob @alice @nobody @carol" }, { now }));
    expect(await mentionRows(db, "bob")).toMatchObject([{ kind: "mention", entryId: t.id, actorId: "alice", createdAt: now, readAt: null, emailedAt: null }]);
    expect(await mentionRows(db, "carol")).toHaveLength(1);
    expect(await mentionRows(db, "alice")).toEqual([]);
    expect(await recorded(db, t.id)).toEqual(["bob", "carol"]);
  });

  it("tells for a mention in a reply, pointing at the reply", async () => {
    const db = await setup();
    const t = must(await createTopic(db, "alice", { lang: "en", title: "A topic", body: "x" }));
    const r = must(await createReply(db, "bob", t.id, { lang: "en", body: "@carol look" }));
    expect(await mentionRows(db, "carol")).toMatchObject([{ entryId: r.id, actorId: "bob" }]);
  });

  it("a member who gets a reply notification for the same post is recorded, and gets no mention notification (reply > mention)", async () => {
    const db = await setup("dave");
    const t = must(await createTopic(db, "alice", { lang: "en", title: "A topic", body: "x" }));
    const first = must(await createReply(db, "bob", t.id, { lang: "en", body: "first" }));
    // carol replies to bob's reply and mentions the topic author (reply_to_topic), the parent author (reply_to_reply), and dave (a mention).
    const r = must(await createReply(db, "carol", t.id, { lang: "en", body: "@alice @bob @dave", parentId: first.id }));
    const rows = await db.select().from(notifications).where(eq(notifications.entryId, r.id)).orderBy(notifications.userId);
    expect(rows.map((n) => [n.userId, n.kind])).toEqual([["alice", "reply_to_topic"], ["bob", "reply_to_reply"], ["dave", "mention"]]);
    expect(await recorded(db, r.id)).toEqual(["alice", "bob", "dave"]);
  });

  it("tells at most ten members of one post; the eleventh is not recorded and gets nothing, but is still emphasized", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `member${String(i + 1).padStart(2, "0")}`);
    const db = await setup(...names);
    expect(MENTION_NOTIFY_LIMIT).toBe(10);
    const t = must(await createTopic(db, "alice", { lang: "en", title: "t", body: names.map((n) => `@${n}`).join(" ") }));
    expect((await recorded(db, t.id)).length).toBe(10);
    expect(await recorded(db, t.id)).toEqual(names.slice(0, 10));
    for (const n of names.slice(0, 10)) expect(await mentionRows(db, n)).toHaveLength(1);
    for (const n of names.slice(10)) expect(await mentionRows(db, n)).toEqual([]);
    expect(((await html(db, t.id))!.match(/class="mention"/g) ?? []).length).toBe(12);
  });

  it("keeps reply recipients in source order for the quota and tells the eleventh mentioned follower through followed_thread", async () => {
    const names = Array.from({ length: 9 }, (_, i) => `member${String(i + 1).padStart(2, "0")}`);
    const db = await setup(...names);
    const t = must(await createTopic(db, "alice", { lang: "en", title: "Priority and quota", body: "x" }));
    const first = must(await createReply(db, "bob", t.id, { lang: "en", body: "first" }));
    for (const name of names) must(await setFollow(db, name, t.id, true));
    const targets = ["alice", "bob", ...names];
    const r = must(await createReply(db, "carol", t.id, { lang: "en", body: targets.map((n) => `@${n}`).join(" "), parentId: first.id }));
    const rows = await db.select().from(notifications).where(eq(notifications.entryId, r.id)).orderBy(notifications.userId);
    expect(rows.map((n) => [n.userId, n.kind])).toEqual([
      ["alice", "reply_to_topic"], ["bob", "reply_to_reply"],
      ...names.slice(0, 8).map((n) => [n, "mention"]),
      [names[8], "followed_thread"],
    ]);
    expect(await recorded(db, r.id)).toEqual(targets.slice(0, 10).sort());
    expect(await mentionRows(db, names[8])).toEqual([]);
    expect((await html(db, r.id))!.match(/class="mention"/g)).toHaveLength(11);
  });

  it("a member named only inside a block quote is emphasized but not told, not recorded and not counted towards the ten", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `member${String(i + 1).padStart(2, "0")}`);
    const db = await setup("quoted", ...names);
    const body = `> @quoted wrote this before\n\n${names.map((n) => `@${n}`).join(" ")}`;
    const t = must(await createTopic(db, "alice", { lang: "en", title: "t", body }));
    expect(await mentionRows(db, "quoted")).toEqual([]);
    expect((await recorded(db, t.id))).toEqual(names);
    expect(await html(db, t.id)).toContain(await mentionLink(db, "quoted", "@quoted"));
    // The same member named outside a quote as well is told.
    const u = must(await createTopic(db, "alice", { lang: "en", title: "t", body: "> @quoted\n\n@quoted again" }));
    expect(await mentionRows(db, "quoted")).toMatchObject([{ entryId: u.id }]);
  });

  it("a draft that is saved tells nobody; publishing it does", async () => {
    const db = await setup();
    const draft = must(await createDraft(db, "alice", { kind: "topic", lang: "en", title: "Draft", body: "@bob please read" }));
    expect(await mentionRows(db, "bob")).toEqual([]);
    const pub = must(await publishDraft(db, "alice", draft.id));
    expect(await mentionRows(db, "bob")).toMatchObject([{ entryId: pub.id }]);
  });
});

describe("editing", () => {
  it("tells only the member that an edit adds, and tells nobody again when a mention is removed and written again", async () => {
    const db = await setup();
    const t = must(await createTopic(db, "alice", { lang: "en", title: "t", body: "@bob" }));
    expect(await recorded(db, t.id)).toEqual(["bob"]);
    // Add carol: only carol is told.
    must(await editEntry(db, "alice", t.id, { title: "t", body: "@bob @carol" }));
    expect(await mentionRows(db, "bob")).toHaveLength(1);
    expect(await mentionRows(db, "carol")).toHaveLength(1);
    // Remove bob, then write bob again: nobody is told again.
    must(await editEntry(db, "alice", t.id, { title: "t", body: "@carol" }));
    must(await editEntry(db, "alice", t.id, { title: "t", body: "@bob @carol again" }));
    expect(await mentionRows(db, "bob")).toHaveLength(1);
    expect(await mentionRows(db, "carol")).toHaveLength(1);
    expect(await recorded(db, t.id)).toEqual(["bob", "carol"]);
    // The stored rendering follows the edit.
    expect(await html(db, t.id)).toContain(await mentionLink(db, "bob", "@bob"));
  });

  it("does not tell for an edit of the title, and keeps counting the ten across the edits", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `member${String(i + 1).padStart(2, "0")}`);
    const db = await setup(...names);
    const t = must(await createTopic(db, "alice", { lang: "en", title: "t", body: names.slice(0, 8).map((n) => `@${n}`).join(" ") }));
    must(await editEntry(db, "alice", t.id, { title: "new title", body: names.slice(0, 8).map((n) => `@${n}`).join(" ") }));
    expect((await recorded(db, t.id)).length).toBe(8);
    // Four new members: only two fit under the limit (8 + 2 = 10).
    must(await editEntry(db, "alice", t.id, { title: "new title", body: names.map((n) => `@${n}`).join(" ") }));
    expect(await recorded(db, t.id)).toEqual(names.slice(0, 10));
    expect(await mentionRows(db, names[10])).toEqual([]);
  });

  it("an edit that adds a mention in a quote does not tell", async () => {
    const db = await setup();
    const t = must(await createTopic(db, "alice", { lang: "en", title: "t", body: "plain" }));
    must(await editEntry(db, "alice", t.id, { title: "t", body: "> @bob\n\nplain" }));
    expect(await mentionRows(db, "bob")).toEqual([]);
    expect(await recorded(db, t.id)).toEqual([]);
  });

  it("tells for a mention added in a reply's edit", async () => {
    const db = await setup();
    const t = must(await createTopic(db, "alice", { lang: "en", title: "t", body: "x" }));
    const r = must(await createReply(db, "bob", t.id, { lang: "en", body: "reply" }));
    must(await editEntry(db, "bob", r.id, { body: "reply for @carol" }, { kind: "reply" }));
    expect(await mentionRows(db, "carol")).toMatchObject([{ entryId: r.id, actorId: "bob" }]);
  });
});

describe("hidden posts and suspended authors", () => {
  it("tells nobody from a post that is hidden, and not afterwards when it is shown again", async () => {
    const db = await setup();
    const t = must(await createTopic(db, "alice", { lang: "en", title: "t", body: "x" }));
    const r = must(await createReply(db, "bob", t.id, { lang: "en", body: "reply" }));
    expect((await hideEntry(db, { id: "op", scope: OP }, { entryId: r.id, reason: "spam", note: "ad" })).ok).toBe(true);
    // The author's edit of a hidden post: no record, no notification.
    must(await editEntry(db, "bob", r.id, { body: "reply with @carol" }, { kind: "reply" }));
    expect(await mentionRows(db, "carol")).toEqual([]);
    expect(await recorded(db, r.id)).toEqual([]);
    expect((await unhideEntry(db, { id: "op", scope: OP }, { entryId: r.id, reason: "other" })).ok).toBe(true);
    expect(await mentionRows(db, "carol")).toEqual([]);
    // After it is shown, a new edit counts as a first mention.
    must(await editEntry(db, "bob", r.id, { body: "reply with @carol again" }, { kind: "reply" }));
    expect(await mentionRows(db, "carol")).toHaveLength(1);
  });

  it("notifyMentions does nothing for a hidden post or for an author who is suspended now, and counts the suspension at the given time", async () => {
    const db = await setup();
    const t = must(await createTopic(db, "alice", { lang: "en", title: "t", body: "x" }));
    const now = new Date("2026-10-05T00:00:00Z");
    const entry = { id: t.id, kind: "topic" as const, threadId: t.id, authorId: "alice" };
    expect(await notifyMentions(db, { entry: { ...entry, hidden: true }, mentioned: ["bob"], subsumed: new Set(), now })).toEqual({ created: [], recorded: [] });
    await db.update(profiles).set({ suspendedUntil: new Date("2026-10-06T00:00:00Z") }).where(eq(profiles.userId, "alice"));
    expect(await notifyMentions(db, { entry: { ...entry, hidden: false }, mentioned: ["bob"], subsumed: new Set(), now })).toEqual({ created: [], recorded: [] });
    // The suspension has ended: the author is not suspended any more.
    const later = new Date("2026-10-07T00:00:00Z");
    expect((await notifyMentions(db, { entry: { ...entry, hidden: false }, mentioned: ["bob"], subsumed: new Set(), now: later })).recorded).toEqual(["bob"]);
  });

  it("a suspended author's post tells nobody", async () => {
    const db = await setup();
    must(await suspendMember(db, { id: "op", scope: OP }, { userId: "alice", reason: "spam", note: "n", days: 3 }));
    const t = must(await createTopic(db, "alice", { lang: "en", title: "t", body: "@bob" }));
    expect(await mentionRows(db, "bob")).toEqual([]);
    expect(await recorded(db, t.id)).toEqual([]);
    // It is still emphasized.
    expect(await html(db, t.id)).toContain("mention");
  });
});

describe("the notification list and the email", () => {
  it("lists a mention with the author, the topic title and the post; and shows nothing of it once the post is hidden or deleted", async () => {
    const db = await setup();
    const t = must(await createTopic(db, "alice", { lang: "en", title: "A topic", body: "x" }));
    const r = must(await createReply(db, "bob", t.id, { lang: "en", body: "@carol hello" }));
    let { items } = await listNotifications(db, "carol");
    expect(items).toMatchObject([{ kind: "mention", unavailable: false, actorHandle: "bob", topicTitle: "A topic", threadId: t.id, entryId: r.id }]);
    await hideEntry(db, { id: "op", scope: OP }, { entryId: r.id, reason: "spam", note: "ad" });
    ({ items } = await listNotifications(db, "carol"));
    expect(items[0]).toMatchObject({ kind: "mention", unavailable: true, actorHandle: null, topicTitle: null, entryId: null });
    await unhideEntry(db, { id: "op", scope: OP }, { entryId: r.id, reason: "other" });
    await deleteEntry(db, { id: "op", scope: OP }, { entryId: r.id, reason: "harassment", note: "rude" });
    ({ items } = await listNotifications(db, "carol"));
    expect(items[0]).toMatchObject({ unavailable: true });
  });

  async function mailSetup(pref: "auto" | "immediate" = "immediate") {
    const db = await setup();
    const box = createMemoryMailbox();
    const mailer = createMailer(box.transport, "tomola <no-reply@example.org>");
    const handlers = createNotificationHandlers({ mailer: () => mailer });
    const run = (now: Date) => runDueJobs(db, handlers, { now, logger: quiet, limit: 100 });
    // Isolate Carol's mention mail from the reply mail sent by the new `auto` default to other recipients.
    await db.update(profiles).set({ emailPref: "none" });
    await db.update(profiles).set({ emailPref: pref, uiLocale: "en" }).where(eq(profiles.userId, "carol"));
    return { db, box, run };
  }
  const after = () => new Date(Date.now() + 6 * 60_000);

  it.each(["auto", "immediate"] as const)("emails a mention once with preference %s, after the delay, with the excerpt and the link to the post", async (pref) => {
    const { db, box, run } = await mailSetup(pref);
    const t = must(await createTopic(db, "alice", { lang: "en", title: "A topic", body: "Hello @carol, thoughts?" }));
    const r = must(await createReply(db, "bob", t.id, { lang: "en", body: "@carol see this" }));
    expect((await db.select().from(jobs).where(eq(jobs.kind, "send_notification_email"))).length).toBe(2);
    expect(await run(after())).toMatchObject({ done: 2, failed: 0 });
    expect(box.sent).toHaveLength(2);
    const [forTopic, forReply] = box.sent;
    expect(forTopic.subject).toBe("@alice mentioned you");
    expect(forTopic.text).toContain('@alice mentioned you in "A topic"');
    expect(forTopic.text).toContain("Hello @carol, thoughts?");
    expect(forTopic.text).toContain(`http://localhost:5173/t/${t.id}\n`);
    expect(forReply.subject).toBe("@bob mentioned you");
    expect(forReply.text).toContain(`http://localhost:5173/t/${t.id}#c-${r.id}`);
  });

  it("names a topic without a title by the beginning of its body, in the list and in the mail (a short remark that mentions someone)", async () => {
    const { db, box, run } = await mailSetup();
    const t = must(await createTopic(db, "alice", { lang: "en", body: "Lunch at noon, @carol? It is a short remark without a title." }));
    expect((await listNotifications(db, "carol")).items).toMatchObject([{ kind: "mention", unavailable: false, topicTitle: "Lunch at noon, @carol? It is a short remark without a title.", threadId: t.id, entryId: t.id }]);
    await run(after());
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0].text).toContain('@alice mentioned you in "Lunch at noon, @carol? It is a short remark without a title."');
    expect(box.sent[0].text).toContain(`http://localhost:5173/t/${t.id}\n`);
    // A mention in a reply to such a topic names the topic the same way.
    const r = must(await createReply(db, "bob", t.id, { lang: "en", body: "@carol me too" }));
    expect((await listNotifications(db, "carol")).items[0]).toMatchObject({ entryId: r.id, topicTitle: "Lunch at noon, @carol? It is a short remark without a title." });
  });

  it("does not email a mention whose author was suspended after it was made, by the immediate mail and by the daily digest; the list keeps it", async () => {
    const { db, box, run } = await mailSetup();
    const t = must(await createTopic(db, "alice", { lang: "en", title: "A topic", body: "@carol hi" }));
    must(await createReply(db, "bob", t.id, { lang: "en", body: "@carol hi from bob" }));
    await db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86_400_000 * 5) }).where(eq(profiles.userId, "alice"));
    await run(after());
    // Only the mention from bob is sent; the one from the suspended alice is marked as handled without a mail.
    expect(box.sent.map((m) => m.subject)).toEqual(["@bob mentioned you"]);
    const rows = await mentionRows(db, "carol");
    expect(rows.every((n) => n.emailedAt !== null)).toBe(true);
    expect((await listNotifications(db, "carol")).items.map((i) => i.actorHandle).sort()).toEqual(["alice", "bob"]);
    // The daily digest: carol wants the digest, and alice's mention made before her suspension is not in it.
    const db2 = await setup();
    const box2 = createMemoryMailbox();
    const handlers2 = createNotificationHandlers({ mailer: () => createMailer(box2.transport, "tomola <no-reply@example.org>") });
    await db2.update(profiles).set({ emailPref: "daily", uiLocale: "en" }).where(eq(profiles.userId, "carol"));
    const t2 = must(await createTopic(db2, "alice", { lang: "en", title: "Another", body: "@carol hi" }, { now: new Date("2026-10-05T01:00:00Z") }));
    must(await createReply(db2, "bob", t2.id, { lang: "en", body: "@carol hi", }, { now: new Date("2026-10-05T01:00:00Z") }));
    await db2.update(profiles).set({ suspendedUntil: new Date("2026-10-30T00:00:00Z") }).where(eq(profiles.userId, "alice"));
    const digestAt = new Date("2026-10-06T00:00:00Z");
    await ensureDigestScheduled(db2, new Date("2026-10-05T12:00:00Z"));
    await runDueJobs(db2, handlers2, { now: digestAt, logger: quiet, limit: 100 });
    const toCarol = box2.sent.filter((m) => m.to === "carol@example.com");
    expect(toCarol).toHaveLength(1);
    expect(toCarol[0].text).toContain("@bob mentioned you");
    expect(toCarol[0].text).not.toContain("@alice mentioned you");
    expect((await mentionRows(db2, "carol")).every((n) => n.emailedAt !== null)).toBe(true);
  });

  it("does not email a mention of a post that is hidden by the time the mail is due", async () => {
    const { db, box, run } = await mailSetup();
    const t = must(await createTopic(db, "alice", { lang: "en", title: "A topic", body: "x" }));
    const r = must(await createReply(db, "bob", t.id, { lang: "en", body: "@carol hi" }));
    await hideEntry(db, { id: "op", scope: OP }, { entryId: r.id, reason: "spam", note: "ad" });
    await run(after());
    expect(box.sent).toEqual([]);
  });
});

describe("the translation of a post with a mention", () => {
  it("keeps the translation's mention only where the source has it (a handle that only the translation has is not emphasized)", async () => {
    const db = await setup();
    const t = must(await createTopic(db, "alice", { lang: "ja", title: "題", body: "@bob さんへ" }));
    // A translation that mentions carol, who is not in the source.
    await db.insert(translations).values({ entryId: t.id, field: "body", lang: "en", kind: "primary", text: "To @bob and @carol", engine: "fake", model: "fake", promptVersion: "x", sourceHash: "h", flags: [], html: null, htmlVersion: 0 });
    const { loadEntryDisplays } = await import("~/lib/entry-display.server");
    const [row] = await db.select({ sourceHash: entries.sourceHash }).from(entries).where(eq(entries.id, t.id));
    await db.update(translations).set({ sourceHash: row.sourceHash! }).where(eq(translations.entryId, t.id));
    const displays = await loadEntryDisplays(db, [{ id: t.id, kind: "topic", lang: "ja", sourceHash: row.sourceHash }], { readLangs: ["ja"], displayLang: "en" });
    const shown = displays.get(t.id)?.translation?.html ?? "";
    expect(shown).toContain(await mentionLink(db, "bob", "@bob"));
    expect(shown).toContain("@carol");
    expect(shown).not.toMatch(/class="mention"[^>]*>@carol<\/a>/);
  });
});
