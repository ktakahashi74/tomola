import { quietLogger as quiet } from "./helpers/logger";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, jobs, notifications, profiles, translations } from "~/lib/db/schema";
import { decideAppeal, createAppeal } from "~/lib/appeals.server";
import { createReply, createTopic, softDeleteEntry } from "~/lib/entries.server";
import { setFollow } from "~/lib/follows.server";
import { createNotificationHandlers, digestDate, ensureDigestScheduled, ensureDigestScheduledThrottled, nextDigestAt } from "~/lib/jobs/notification-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createMailer } from "~/lib/mail/mail.server";
import { digestMail, excerptOf, notificationMail } from "~/lib/mail/notification.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { deleteEntry, excludeReactions, fixEntry, hideEntry, includeReactions, suspendMember, unsuspendMember } from "~/lib/moderation.server";
import { sourceHash } from "~/lib/source-hash.server";
import { setStance } from "~/lib/stances.server";
import { listNotifications, SEND_DIGEST_JOB, SEND_NOTIFICATION_EMAIL_JOB } from "~/lib/notifications.server";
import { m } from "~/paraglide/messages.js";
import { escapeRegex } from "./helpers/message-markup";
import { addMember, createTestDb } from "./helpers/db";
import { responsePostLine } from "~/lib/response-post.server";
import { configurePush } from "./helpers/push";

// Notification mail: immediate delivery for the immediate setting and a daily digest at 00:00 UTC for daily. Use the recipient's UI language; excerpts use a translation into their display language or the source.
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const jaOptions = { locale: "ja" as const };
const enOptions = { locale: "en" as const };
// Match the actual message frame while assertions below independently check
// excerpts, destinations, privacy, delivery counts and timestamps.
const replyIntro = (title: string, locale: "ja" | "en" = "en") =>
  m.mail_item_reply_to_topic({ handle: "bob", title, excerpt: "", url: "" }, { locale }).split("\n\n")[0];
const followIntro = (count: number, title = "アリスの話題", locale: "ja" | "en" = "en") =>
  m.mail_item_followed_thread({ count, handle: "bob", title, excerpt: "", url: "" }, { locale }).split("\n\n")[0];


const OP = { operator: true, langs: [] };
const SITE = "http://localhost:5173";

async function setup() {
  const db = await createTestDb();
  await addMember(db, "alice", "alice", { readLangs: ["ja"], email: "alice@example.com" });
  await addMember(db, "bob", "bob", { readLangs: ["ja"], email: "bob@example.com" });
  await addMember(db, "op", "opal", { readLangs: ["ja"] });
  const topic = await createTopic(db, "alice", { lang: "ja", title: "アリスの話題", body: "本文" });
  if (!topic.ok) throw new Error("topic failed");
  const box = createMemoryMailbox();
  const mailer = createMailer(box.transport, "tomola <no-reply@example.org>");
  const handlers = createNotificationHandlers({ mailer: () => mailer });
  const run = (now: Date, limit = 100) => runDueJobs(db, handlers, { now, logger: quiet, limit });
  return { db, topic: topic.id, box, run };
}

const setPrefs = (db: Db, userId: string, values: Partial<typeof profiles.$inferInsert>) => db.update(profiles).set(values).where(eq(profiles.userId, userId));

it("mails response notices immediately by default, linking the response and naming the source, and suppresses unavailable posts", async () => {
  for (const unavailable of [null, "source", "response"] as const) {
    const { db, topic, box, run } = await setup();
    const response = await createTopic(db, "bob", { lang: "ja", title: "New response", body: "Response excerpt" }, { responseTo: topic });
    if (!response.ok) throw new Error(response.error);
    if (unavailable) await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, unavailable === "source" ? topic : response.id));
    expect(await run(new Date(Date.now() + 6 * 60_000))).toMatchObject({ failed: 0 });
    expect(box.sent).toHaveLength(unavailable ? 0 : 1);
    if (!unavailable) {
      expect(box.sent[0].subject).toBe(m.mail_subject_response_to_topic({ handle: "bob" }, jaOptions));
      expect(box.sent[0].text).toContain("アリスの話題");
      expect(box.sent[0].text).toContain("Response excerpt");
      expect(box.sent[0].text).toContain(`${SITE}/t/${response.id}`);
      expect(box.sent[0].text).not.toContain(`#c-${response.id}`);
    }
  }
});
it.each([false, true])("omits the generated opening from response mail, including opening-only posts (translated: %s)", async translated => {
  const { db, topic, box, run } = await setup();
  await setPrefs(db, "alice", { displayLang: translated ? "en" : "ja" });
  for (const rest of ["Body-only excerpt", ""]) {
    const opening = responsePostLine(topic, "Unique opening label", "alice", "ja");
    const response = await createTopic(db, "bob", { lang: "ja", body: opening + "\n\n" + rest }, { responseTo: topic });
    if (!response.ok) throw new Error(response.error);
    if (translated) {
      const [entry] = await db.select().from(entries).where(eq(entries.id, response.id));
      await db.insert(translations).values({ entryId: response.id, field: "body", kind: "primary", lang: "en",
        text: responsePostLine(topic, "Translated opening label", "alice", "en") + "\n\n" + rest,
        sourceHash: entry.sourceHash, mentionRevision: entry.mentionRevision });
    }
    expect(await run(new Date(Date.now() + 6 * 60_000))).toMatchObject({ failed: 0 });
    const mail = box.sent.at(-1)!;
    expect(mail.text).toContain(m.mail_item_response_to_topic({ handle: "bob", title: "アリスの話題", excerpt: rest, url: `${SITE}/t/${response.id}` }, jaOptions));
  }
  expect(box.sent).toHaveLength(2);
});

const emailJobs = (db: Db) => db.select().from(jobs).where(eq(jobs.kind, SEND_NOTIFICATION_EMAIL_JOB));
const rowsFor = (db: Db, userId: string) => db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(notifications.id);
// Immediate mail is sent five minutes after creation, the default delay. Run after that time.
// Taken when it is called, never at the load of the file: the job is due 5 minutes after the reply, and a slow machine must not move "the reply" past a time fixed earlier.
const after = () => new Date(Date.now() + 6 * 60_000);

afterEach(() => vi.restoreAllMocks());

describe("immediate emails", () => {
  it("queue one job per notification (deduped by the notification id) only when the member's actual mode is immediate: `auto` for a reply, or `immediate`", async () => {
    const { db, topic } = await setup();
    // The default is `auto`: a reply is sent at once
    await createReply(db, "bob", topic, { lang: "ja", body: "r1" });
    const [first] = await rowsFor(db, "alice");
    expect((await emailJobs(db)).map((j) => j.dedupeKey)).toEqual([`notification-email:${first.id}`]);
    await db.delete(jobs).where(eq(jobs.kind, SEND_NOTIFICATION_EMAIL_JOB));
    // `daily` and `none` queue nothing
    await setPrefs(db, "alice", { emailPref: "daily" });
    await createReply(db, "bob", topic, { lang: "ja", body: "r1b" });
    await setPrefs(db, "alice", { emailPref: "none" });
    await createReply(db, "bob", topic, { lang: "ja", body: "r2" });
    expect(await emailJobs(db)).toEqual([]);
    await setPrefs(db, "alice", { emailPref: "immediate" });
    const r3 = await createReply(db, "bob", topic, { lang: "ja", body: "r3" });
    if (!r3.ok) throw new Error("reply failed");
    const [n] = (await rowsFor(db, "alice")).slice(-1);
    expect((await emailJobs(db)).map((j) => [j.payload, j.dedupeKey])).toEqual([[{ notificationId: n.id }, `notification-email:${n.id}`]]);
  });

  it("send one plain text email in the recipient's UI language with the reply's excerpt and an absolute link to the thread (no token), and mark emailed_at", async () => {
    const { db, topic, box, run } = await setup();
    await setPrefs(db, "alice", { emailPref: "immediate", uiLocale: "ja" });
    const body = "これは返信です。".repeat(40);
    const r = await createReply(db, "bob", topic, { lang: "ja", body });
    if (!r.ok) throw new Error("reply failed");
    const now = new Date(Date.now() + 6 * 60_000);
    expect(await run(now)).toMatchObject({ done: 1, failed: 0 });
    expect(box.sent).toHaveLength(1);
    const mail = box.sent[0];
    expect(mail).toMatchObject({ to: "alice@example.com", from: "tomola <no-reply@example.org>" });
    expect(mail.subject).toBe(m.mail_subject_reply_to_topic({ handle: "bob" }, jaOptions));
    expect(mail.text).toContain(replyIntro("アリスの話題", "ja"));
    // Excerpts are capped at 200 characters and omit the full body.
    const excerpt = mail.text.split("\n\n")[1];
    expect([...excerpt].length).toBe(201);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(mail.text).not.toContain(body);
    // An absolute thread URL with a reply anchor and no token.
    expect(mail.text).toContain(`${SITE}/t/${topic}#c-${r.id}`);
    expect(mail.text).not.toMatch(/[?&]k=|token/i);
    expect(mail.text).toContain(`${SITE}/settings`);
    expect(mail.html).toBeUndefined();
    expect((await rowsFor(db, "alice"))[0].emailedAt).toEqual(now);
    // A second run does not send again.
    await run(new Date(now.getTime() + 1000));
    expect(box.sent).toHaveLength(1);
  });

  it("writes the excerpt of the reply as plain text, without Markdown marks", async () => {
    const { db, topic, box, run } = await setup();
    await setPrefs(db, "alice", { emailPref: "immediate", uiLocale: "en" });
    await createReply(db, "bob", topic, { lang: "ja", body: "## 返信\n\n**大事**な[リンク](https://example.org/x)と $\\frac{a}{b}$ です。" });
    await run(after());
    const excerpt = box.sent[0].text.split("\n\n")[1];
    expect(excerpt).toBe("返信 大事なリンクと です。");
  });

  it("writes in the main language when the interface language is not stored, and in English when that is not usable either", async () => {
    const { db, topic, box, run } = await setup();
    await setPrefs(db, "alice", { emailPref: "immediate", uiLocale: "en" });
    await createReply(db, "bob", topic, { lang: "ja", body: "hello" });
    await run(after());
    expect(box.sent[0].subject).toBe(m.mail_subject_reply_to_topic({ handle: "bob" }, enOptions));
    expect(box.sent[0].text).toContain(replyIntro("アリスの話題"));
    box.clear();
    // No stored interface language: the main language (ja) decides.
    await setPrefs(db, "alice", { uiLocale: null });
    await createReply(db, "bob", topic, { lang: "ja", body: "again" });
    await run(after());
    expect(box.sent[0].subject).toBe(m.mail_subject_reply_to_topic({ handle: "bob" }, jaOptions));
    box.clear();
    // Neither a stored interface language nor a usable main language: the site default.
    await setPrefs(db, "alice", { uiLocale: null, homeArea: "other" });
    await createReply(db, "bob", topic, { lang: "ja", body: "third" });
    await run(after());
    expect(box.sent[0].subject).toBe(m.mail_subject_reply_to_topic({ handle: "bob" }, enOptions));
  });

  it("defaults email excerpts to stored UI locale above original-reading order, below an explicit preference", async () => {
    const { db, topic, box, run } = await setup();
    await setPrefs(db, "alice", { emailPref: "immediate", uiLocale: "en", readLangs: ["ja"], displayLang: null });
    const reply = await createReply(db, "bob", topic, { lang: "ja", body: "日本語の通知原文" });
    if (!reply.ok) throw new Error(reply.error);
    const [source] = await db.select().from(entries).where(eq(entries.id, reply.id));
    await db.insert(translations).values({ entryId: reply.id, field: "body", lang: "en", kind: "primary", text: "Stored English mail translation", engine: "fake", sourceHash: source.sourceHash });
    await run(after());
    expect(box.sent[0].subject).toBe(m.mail_subject_reply_to_topic({ handle: "bob" }, enOptions));
    expect(box.sent[0].text).toContain("Stored English mail translation");
    expect(box.sent[0].text).not.toContain("日本語の通知原文");
    box.clear();
    await setPrefs(db, "alice", { displayLang: "ja" });
    const original = await createReply(db, "bob", topic, { lang: "ja", body: "明示した日本語の本文" });
    if (!original.ok) throw new Error(original.error);
    await run(after());
    expect(box.sent[0].text).toContain("明示した日本語の本文");
  });

  it("uses the translation in the recipient's display language for the excerpt and the title when there is one, else the original", async () => {
    const { db, topic, box, run } = await setup();
    await setPrefs(db, "alice", { emailPref: "immediate", uiLocale: "en", readLangs: ["en"], displayLang: "en" });
    const r = await createReply(db, "bob", topic, { lang: "ja", body: "日本語の本文。" });
    if (!r.ok) throw new Error("reply failed");
    const [row] = await db.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, r.id));
    const [trow] = await db.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, topic));
    await db.insert(translations).values([
      { entryId: r.id, field: "body", lang: "en", kind: "primary", text: "The English translation.", engine: "fake", model: "m", sourceHash: row.hash },
      { entryId: topic, field: "title", lang: "en", kind: "primary", text: "Alice's topic", engine: "fake", model: "m", sourceHash: trow.hash },
      // Do not use translations into languages other than the display language.
      { entryId: r.id, field: "body", lang: "fr", kind: "primary", text: "La traduction française.", engine: "fake", model: "m", sourceHash: row.hash },
    ]);
    await run(after());
    expect(box.sent[0].text).toContain("The English translation.");
    expect(box.sent[0].text).toContain(replyIntro("Alice's topic"));
    expect(box.sent[0].text).not.toContain("日本語の本文。");
    // Use the source for a reply that has no translation yet.
    box.clear();
    const r2 = await createReply(db, "bob", topic, { lang: "ja", body: "訳のない本文。" });
    if (!r2.ok) throw new Error("reply failed");
    await run(after());
    expect(box.sent[0].text).toContain("訳のない本文。");
    // Prefer a translation into the display language even if the recipient can read the source; mail cannot toggle languages like the UI.
    box.clear();
    await setPrefs(db, "alice", { readLangs: ["ja", "en"] });
    const r3 = await createReply(db, "bob", topic, { lang: "ja", body: "読める原文。" });
    if (!r3.ok) throw new Error("reply failed");
    const [row3] = await db.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, r3.id));
    await db.insert(translations).values({ entryId: r3.id, field: "body", lang: "en", kind: "primary", text: "Readable original (translated).", engine: "fake", model: "m", sourceHash: row3.hash });
    await run(after());
    expect(box.sent[0].text).toContain("Readable original (translated).");
    expect(box.sent[0].text).not.toContain("読める原文。");
    // Do not use a translation of an old source version; use the current source.
    box.clear();
    const r4 = await createReply(db, "bob", topic, { lang: "ja", body: "今の原文。" });
    if (!r4.ok) throw new Error("reply failed");
    await db.insert(translations).values({ entryId: r4.id, field: "body", lang: "en", kind: "primary", text: "Stale translation.", engine: "fake", model: "m", sourceHash: "an-older-version" });
    await run(after());
    expect(box.sent[0].text).toContain("今の原文。");
    expect(box.sent[0].text).not.toContain("Stale translation.");
    // Use the source when its language is the display language.
    box.clear();
    await setPrefs(db, "alice", { displayLang: "ja", readLangs: ["ja"] });
    await createReply(db, "bob", topic, { lang: "ja", body: "表示言語と同じ原語。" });
    await run(after());
    expect(box.sent[0].text).toContain("表示言語と同じ原語。");
  });

  it("does not send for a hidden or deleted reply or topic (it only marks the notification), nor after the preference changed, nor twice", async () => {
    const { db, topic, box, run } = await setup();
    await setPrefs(db, "alice", { emailPref: "immediate" });
    const hidden = await createReply(db, "bob", topic, { lang: "ja", body: "SECRET-HIDDEN" });
    const deleted = await createReply(db, "bob", topic, { lang: "ja", body: "SECRET-DELETED" });
    const moved = await createReply(db, "bob", topic, { lang: "ja", body: "preference changed" });
    if (!hidden.ok || !deleted.ok || !moved.ok) throw new Error("reply failed");
    await hideEntry(db, { id: "op", scope: OP }, { entryId: hidden.id, reason: "spam", note: "n" });
    await softDeleteEntry(db, deleted.id);
    await setPrefs(db, "alice", { emailPref: "none" });
    await run(after());
    // The setting changed to none: do not send or mark it. A digest can pick it up if the setting returns to daily.
    expect(box.sent).toEqual([]);
    expect((await rowsFor(db, "alice")).map((n) => n.emailedAt)).toEqual([null, null, null]);
    // Switch back to immediate and rerun: mark the hidden and deleted items without sending; send the remaining item.
    await setPrefs(db, "alice", { emailPref: "immediate" });
    await db.update(jobs).set({ status: "queued", runAt: new Date(0) }).where(eq(jobs.kind, SEND_NOTIFICATION_EMAIL_JOB));
    await run(after());
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0].text).toContain("preference changed");
    expect(JSON.stringify(box.sent)).not.toContain("SECRET");
    expect((await rowsFor(db, "alice")).every((n) => n.emailedAt !== null)).toBe(true);
  });

  it("does not mail a reply in a hidden or deleted topic either (the topic title is hidden content)", async () => {
    const { db, box, run } = await setup();
    await setPrefs(db, "alice", { emailPref: "immediate", uiLocale: "en" });
    const secret = await createTopic(db, "alice", { lang: "ja", title: "SECRET-TOPIC-TITLE", body: "b" });
    const gone = await createTopic(db, "alice", { lang: "ja", title: "DELETED-TOPIC-TITLE", body: "b" });
    if (!secret.ok || !gone.ok) throw new Error("topic failed");
    await createReply(db, "bob", secret.id, { lang: "ja", body: "reply in the hidden topic" });
    await createReply(db, "bob", gone.id, { lang: "ja", body: "reply in the deleted topic" });
    await hideEntry(db, { id: "op", scope: OP }, { entryId: secret.id, reason: "spam", note: "n" });
    await softDeleteEntry(db, gone.id);
    await run(after());
    // Do not email the reply notification. Only the affected member's moderation notification is emailed, without content.
    expect(box.sent.map((s) => s.subject)).toEqual([m.mail_subject_moderation({}, enOptions)]);
    expect(JSON.stringify(box.sent)).not.toMatch(/SECRET-TOPIC-TITLE|DELETED-TOPIC-TITLE|reply in the/);
    expect((await rowsFor(db, "alice")).map((n) => [n.kind, n.emailedAt !== null])).toEqual([["reply_to_topic", true], ["reply_to_topic", true], ["moderation", true]]);
  });

  it("mails the result of an appeal without the post's content, pointing to the notifications page", async () => {
    const { db, topic, box, run } = await setup();
    await setPrefs(db, "bob", { emailPref: "immediate", uiLocale: "ja" });
    const r = await createReply(db, "bob", topic, { lang: "ja", body: "SECRET-CONTENT" });
    if (!r.ok) throw new Error("reply failed");
    const hid = await hideEntry(db, { id: "op", scope: OP }, { entryId: r.id, reason: "spam", note: "n" });
    if (!hid.ok) throw new Error("hide failed");
    const made = await createAppeal(db, "bob", hid.actionId, "not spam");
    if (!made.ok) throw new Error("appeal failed");
    await decideAppeal(db, { id: "alice", scope: { operator: false, langs: ["ja"] } }, made.id, { decision: "overturned", note: "fine" });
    await run(after());
    const mails = box.sent.filter((s) => s.to === "bob@example.com");
    // Two messages: the moderation notification and the appeal result.
    expect(mails.map((s) => s.subject)).toEqual([m.mail_subject_moderation({}, jaOptions), m.mail_subject_appeal({}, jaOptions)]);
    expect(mails[1].text).toContain(m.mail_item_appeal_overturned({ url: `${SITE}/notifications` }, jaOptions));
    expect(mails[1].text).toContain(`${SITE}/notifications`);
    expect(JSON.stringify(mails)).not.toContain("SECRET-CONTENT");
    expect(JSON.stringify(mails)).not.toContain("fine");
  });

  it("says in the appeal result email when nothing had to be reversed", async () => {
    const { db, box, run } = await setup();
    await setPrefs(db, "bob", { emailPref: "immediate", uiLocale: "en" });
    const sus = await suspendMember(db, { id: "op", scope: OP }, { userId: "bob", reason: "spam", note: "n", days: 1 }, { now: new Date("2026-09-01T00:00:00Z") });
    if (!sus.ok) throw new Error("suspend failed");
    const made = await createAppeal(db, "bob", sus.actionId, "x");
    if (!made.ok) throw new Error("appeal failed");
    await decideAppeal(db, { id: "alice", scope: { operator: false, langs: ["ja"] } }, made.id, { decision: "overturned", note: "fine" });
    await run(after());
    const last = box.sent.filter((s) => s.to === "bob@example.com").at(-1)!;
    expect(last.subject).toBe(m.mail_subject_appeal({}, enOptions));
    expect(last.text).toContain(m.mail_item_appeal_overturned_nochange({ url: `${SITE}/notifications` }, enOptions));
  });

  it("tells the affected member of a moderation decision without the post's content, pointing to the notifications page", async () => {
    const { db, topic, box, run } = await setup();
    await setPrefs(db, "bob", { emailPref: "immediate", uiLocale: "ja" });
    const r = await createReply(db, "bob", topic, { lang: "ja", body: "SECRET-CONTENT" });
    if (!r.ok) throw new Error("reply failed");
    await hideEntry(db, { id: "op", scope: OP }, { entryId: r.id, reason: "harassment", note: "SECRET-NOTE" });
    await deleteEntry(db, { id: "op", scope: OP }, { entryId: (await createReply(db, "bob", topic, { lang: "ja", body: "x" }).then((x) => (x.ok ? x.id : 0))), reason: "spam", note: "n" });
    await suspendMember(db, { id: "op", scope: OP }, { userId: "bob", reason: "infohazard", note: "n", days: 2 }, { now: new Date("2026-10-10T00:00:00Z") });
    await unsuspendMember(db, { id: "op", scope: OP }, { userId: "bob", reason: "other", note: "lifted" }, { now: new Date("2026-10-10T01:00:00Z") });
    // Excluding stances and "なるほど" votes from counts, and undoing that action.
    await excludeReactions(db, { id: "op", scope: OP }, { userId: "bob", reason: "spam", note: "SECRET-NOTE" }, { now: new Date("2026-10-10T02:00:00Z") });
    await includeReactions(db, { id: "op", scope: OP }, { userId: "bob", reason: "other", note: "SECRET-NOTE" }, { now: new Date("2026-10-10T03:00:00Z") });
    // Correcting a typo in a locked question (alice's stance locked bob's question).
    const question = await createTopic(db, "bob", { lang: "ja", title: "問いです", body: "SECRET-BODY", asksStance: true });
    if (!question.ok) throw new Error("question failed");
    await setStance(db, "alice", { questionId: question.id, position: "agree", expectedVersion: 0 }, { now: new Date("2026-10-10T03:30:00Z") });
    await fixEntry(db, { id: "op", scope: OP }, { entryId: question.id, title: "問いです。", body: "SECRET-FIXED", note: "SECRET-NOTE", sourceHash: sourceHash("問いです", "SECRET-BODY", "ja") }, { now: new Date("2026-10-10T04:00:00Z") });
    await run(after());
    const bobMails = box.sent.filter((s) => s.to === "bob@example.com");
    expect(bobMails.map((s) => s.subject)).toEqual(Array(7).fill(m.mail_subject_moderation({}, jaOptions)));
    expect(bobMails[0].text).toContain(m.mail_item_moderation_hide({ reason: m.reason_harassment({}, jaOptions), url: `${SITE}/notifications` }, jaOptions));
    expect(bobMails[0].text).toContain(m.reason_harassment({}, jaOptions));
    expect(bobMails[1].text).toContain(m.mail_item_moderation_delete({ reason: m.reason_spam({}, jaOptions), url: `${SITE}/notifications` }, jaOptions));
    expect(bobMails[2].text).toContain("2026-10-12 00:00");
    expect(bobMails[3].text).toContain(m.mail_item_moderation_unsuspend({ url: `${SITE}/notifications` }, jaOptions));
    expect(bobMails[4].text).toContain(m.mail_item_moderation_exclude({ reason: m.reason_spam({}, jaOptions), url: `${SITE}/notifications` }, jaOptions));
    expect(bobMails[4].text).toContain(m.reason_spam({}, jaOptions));
    expect(bobMails[5].text).toContain(m.mail_item_moderation_include({ url: `${SITE}/notifications` }, jaOptions));
    expect(bobMails[6].text).toContain(m.mail_item_moderation_fix({ reason: m.reason_other({}, jaOptions), url: `${SITE}/notifications` }, jaOptions));
    for (const s of bobMails) expect(s.text).toContain(`${SITE}/notifications`);
    // The email contains no post content, explanation (note), or actor display name.
    expect(JSON.stringify(bobMails)).not.toMatch(/SECRET-CONTENT|SECRET-NOTE|SECRET-BODY|SECRET-FIXED|opal/);
  });
});

describe("the delay of immediate emails", () => {
  it("queues the job 5 minutes after the notification (env NOTIFICATION_EMAIL_DELAY_SECONDS changes it), and a job that is not yet due sends nothing", async () => {
    const { db, topic, box, run } = await setup();
    await setPrefs(db, "alice", { emailPref: "immediate" });
    // The times are given to createReply and to the worker: nothing here reads the clock, so a slow machine cannot move the bounds.
    const at = new Date("2026-10-05T00:00:00Z");
    await createReply(db, "bob", topic, { lang: "ja", body: "r1" }, { now: at });
    const [job] = await emailJobs(db);
    expect(job.runAt).toEqual(new Date(at.getTime() + 300_000));
    // Do not send after one minute; send after five.
    await run(new Date(at.getTime() + 60_000));
    expect(box.sent).toEqual([]);
    await run(new Date(at.getTime() + 6 * 60_000));
    expect(box.sent).toHaveLength(1);
    const { notificationEmailDelaySeconds } = await import("~/lib/notifications.server");
    expect(notificationEmailDelaySeconds({})).toBe(300);
    expect(notificationEmailDelaySeconds({ NOTIFICATION_EMAIL_DELAY_SECONDS: "0" })).toBe(0);
    expect(notificationEmailDelaySeconds({ NOTIFICATION_EMAIL_DELAY_SECONDS: " 15 " })).toBe(15);
    for (const bad of ["", "-1", "1.5", "abc", "9999999"]) expect(notificationEmailDelaySeconds({ NOTIFICATION_EMAIL_DELAY_SECONDS: bad }), bad).toBe(300);
    const saved = process.env.NOTIFICATION_EMAIL_DELAY_SECONDS;
    process.env.NOTIFICATION_EMAIL_DELAY_SECONDS = "0";
    const at2 = new Date("2026-10-05T01:00:00Z");
    try {
      await createReply(db, "bob", topic, { lang: "ja", body: "r2" }, { now: at2 });
    } finally {
      if (saved === undefined) delete process.env.NOTIFICATION_EMAIL_DELAY_SECONDS;
      else process.env.NOTIFICATION_EMAIL_DELAY_SECONDS = saved;
    }
    const jobs2 = await emailJobs(db);
    expect(jobs2[1].runAt).toEqual(at2);
  });

  it("does not mail what became hidden or deleted while it waited, and uses a translation that became ready in the meantime", async () => {
    const { db, topic, box, run } = await setup();
    await setPrefs(db, "alice", { emailPref: "immediate", uiLocale: "en", readLangs: ["en"], displayLang: "en" });
    const hiddenLater = await createReply(db, "bob", topic, { lang: "ja", body: "SECRET-LATER-HIDDEN" });
    const translated = await createReply(db, "bob", topic, { lang: "ja", body: "翻訳が待つあいだにできる。" });
    if (!hiddenLater.ok || !translated.ok) throw new Error("reply failed");
    // While waiting, one item becomes hidden and another gains a translation.
    await hideEntry(db, { id: "op", scope: OP }, { entryId: hiddenLater.id, reason: "spam", note: "n" });
    const [row] = await db.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, translated.id));
    await db.insert(translations).values({ entryId: translated.id, field: "body", lang: "en", kind: "primary", text: "The translation that became ready.", engine: "fake", model: "m", sourceHash: row.hash });
    await run(after());
    const replyMails = box.sent.filter((s) => s.subject === m.mail_subject_reply_to_topic({ handle: "bob" }, enOptions));
    expect(replyMails).toHaveLength(1);
    expect(replyMails[0].text).toContain("The translation that became ready.");
    expect(JSON.stringify(box.sent)).not.toContain("SECRET-LATER-HIDDEN");
  });
});

describe("the daily digest schedule", () => {
  it("is the next UTC midnight, with one future job per date (idempotent)", async () => {
    const { db } = await setup();
    const now = new Date("2026-10-05T13:45:00Z");
    expect(nextDigestAt(now)).toEqual(new Date("2026-10-06T00:00:00Z"));
    expect(nextDigestAt(new Date("2026-10-05T00:00:00Z"))).toEqual(new Date("2026-10-06T00:00:00Z"));
    expect(nextDigestAt(new Date("2026-12-31T23:59:59Z"))).toEqual(new Date("2027-01-01T00:00:00Z"));
    expect(digestDate(new Date("2026-10-06T00:00:00Z"))).toBe("2026-10-06");
    expect(await ensureDigestScheduled(db, now)).toMatchObject({ date: "2026-10-06", created: true });
    expect(await ensureDigestScheduled(db, now)).toMatchObject({ date: "2026-10-06", created: false });
    expect(await ensureDigestScheduled(db, new Date("2026-10-05T23:59:00Z"))).toMatchObject({ created: false });
    const queued = await db.select().from(jobs).where(eq(jobs.kind, SEND_DIGEST_JOB));
    expect(queued.map((j) => [j.dedupeKey, j.runAt, j.status, j.payload])).toEqual([["digest:2026-10-06", new Date("2026-10-06T00:00:00Z"), "queued", { date: "2026-10-06" }]]);
    // The next day gets its own job.
    expect(await ensureDigestScheduled(db, new Date("2026-10-06T00:00:01Z"))).toMatchObject({ date: "2026-10-07", created: true });
  });

  it("the worker's pre-run step keeps exactly one future digest job, at most once a minute", async () => {
    const { db } = await setup();
    const t0 = new Date("2026-10-05T10:00:00Z");
    await ensureDigestScheduledThrottled(db, t0);
    await ensureDigestScheduledThrottled(db, new Date(t0.getTime() + 1000));
    expect((await db.select().from(jobs).where(eq(jobs.kind, SEND_DIGEST_JOB))).length).toBe(1);
    // Recheck after an interval; requeue the job if it was lost.
    await db.delete(jobs).where(eq(jobs.kind, SEND_DIGEST_JOB));
    await ensureDigestScheduledThrottled(db, new Date(t0.getTime() + 30_000));
    expect((await db.select().from(jobs).where(eq(jobs.kind, SEND_DIGEST_JOB))).length).toBe(0);
    await ensureDigestScheduledThrottled(db, new Date(t0.getTime() + 61_000));
    expect((await db.select().from(jobs).where(eq(jobs.kind, SEND_DIGEST_JOB))).length).toBe(1);
  });
});

describe("the daily digest", () => {
  it("fans out by member without sending mail in the scheduling job", async () => {
    const { db, topic, box, run } = await setup();
    await setPrefs(db, "alice", { emailPref: "daily" });
    await createReply(db, "bob", topic, { lang: "ja", body: "digest item" });
    await ensureDigestScheduled(db, new Date("2026-10-05T23:00:00Z"));
    const now = new Date("2026-10-06T00:00:00Z");
    await run(now, 1);
    expect(box.sent).toHaveLength(0);
    const children = await db.select().from(jobs).where(eq(jobs.kind, "send_member_digest"));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ dedupeKey: "digest:2026-10-06:alice", payload: { date: "2026-10-06", userId: "alice" }, priority: 0 });
    await run(now, 1);
    expect(box.sent).toHaveLength(1);
  });
  it("sends each daily member one email with their unread, un-emailed notifications, marks them, and schedules the next day", async () => {
    const { db, topic, box, run } = await setup();
    await addMember(db, "carol", "carol", { readLangs: ["ja"], email: "carol@example.com" });
    await setPrefs(db, "alice", { uiLocale: "ja", emailPref: "daily" });
    await setPrefs(db, "bob", { emailPref: "none" });
    const a = await createReply(db, "bob", topic, { lang: "ja", body: "返信1" });
    const b = await createReply(db, "carol", topic, { lang: "ja", body: "返信2", parentId: a.ok ? a.id : undefined });
    if (!a.ok || !b.ok) throw new Error("reply failed");
    // bob uses none, so receives nothing. carol uses daily; a reply to bob's reply targets bob (none). alice receives two items in Japanese.
    const midnight = new Date("2026-10-06T00:00:00Z");
    const t = new Date("2026-10-05T23:59:00Z");
    const created = await ensureDigestScheduled(db, t);
    expect(created.runAt).toEqual(midnight);
    // Do not run before the deadline.
    expect(await run(t)).toMatchObject({ ran: 0 });
    expect(box.sent).toEqual([]);
    expect(await run(midnight)).toMatchObject({ ran: 2, done: 2 });
    const toAlice = box.sent.filter((s) => s.to === "alice@example.com");
    expect(box.sent).toHaveLength(1);
    expect(toAlice[0].subject).toBe(m.mail_digest_subject({ count: 2 }, jaOptions));
    expect(toAlice[0].text).toContain(m.mail_digest_intro({ count: 2 }, jaOptions));
    expect(toAlice[0].text).toContain("返信1");
    expect(toAlice[0].text).toContain("返信2");
    expect(toAlice[0].text).toContain(`${SITE}/t/${topic}#c-${a.id}`);
    expect((await rowsFor(db, "alice")).map((n) => n.emailedAt)).toEqual([midnight, midnight]);
    // Do not mark notifications for members using none, since nothing is sent.
    expect((await rowsFor(db, "bob")).every((n) => n.emailedAt === null)).toBe(true);
    // Exactly one job is queued for the next day.
    const future = await db.select().from(jobs).where(eq(jobs.kind, SEND_DIGEST_JOB));
    expect(future.filter((j) => j.status === "queued").map((j) => j.dedupeKey)).toEqual(["digest:2026-10-07"]);
    expect(future.filter((j) => j.status === "done")).toHaveLength(1);
    // Running again on the same day does not send duplicates.
    await db.update(jobs).set({ status: "queued", runAt: midnight }).where(eq(jobs.dedupeKey, "digest:2026-10-06"));
    await run(midnight);
    expect(box.sent).toHaveLength(1);
    expect((await db.select().from(jobs).where(eq(jobs.kind, SEND_DIGEST_JOB))).filter((j) => j.status === "queued")).toHaveLength(1);
  });

  it("skips read notifications and old ones (7 days), and leaves out hidden and deleted content but marks it", async () => {
    const { db, topic, box, run } = await setup();
    await setPrefs(db, "alice", { emailPref: "daily", uiLocale: "en" });
    const now = new Date("2026-10-20T00:00:00Z");
    const old = await createReply(db, "bob", topic, { lang: "ja", body: "OLD-REPLY" }, { now: new Date("2026-10-01T00:00:00Z") });
    const read = await createReply(db, "bob", topic, { lang: "ja", body: "READ-REPLY" }, { now: new Date("2026-10-19T00:00:00Z") });
    const hidden = await createReply(db, "bob", topic, { lang: "ja", body: "SECRET-HIDDEN" }, { now: new Date("2026-10-19T01:00:00Z") });
    const gone = await createReply(db, "bob", topic, { lang: "ja", body: "SECRET-GONE" }, { now: new Date("2026-10-19T02:00:00Z") });
    const fresh = await createReply(db, "bob", topic, { lang: "ja", body: "FRESH-REPLY" }, { now: new Date("2026-10-19T03:00:00Z") });
    if (!old.ok || !read.ok || !hidden.ok || !gone.ok || !fresh.ok) throw new Error("reply failed");
    await db.update(notifications).set({ readAt: new Date("2026-10-19T12:00:00Z") }).where(eq(notifications.entryId, read.id));
    await hideEntry(db, { id: "op", scope: OP }, { entryId: hidden.id, reason: "spam", note: "n" });
    await softDeleteEntry(db, gone.id);
    await ensureDigestScheduled(db, new Date("2026-10-19T23:00:00Z"));
    await run(now);
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0].text).toContain("FRESH-REPLY");
    expect(box.sent[0].subject).toBe(m.mail_digest_subject({ count: 1 }, enOptions));
    for (const s of ["OLD-REPLY", "READ-REPLY", "SECRET"]) expect(box.sent[0].text).not.toContain(s);
    const byEntry = Object.fromEntries((await rowsFor(db, "alice")).map((n) => [n.entryId, n.emailedAt]));
    expect(byEntry[fresh.id]).toEqual(now);
    expect(byEntry[hidden.id]).toEqual(now);
    expect(byEntry[gone.id]).toEqual(now);
    expect(byEntry[old.id]).toBeNull();
    expect(byEntry[read.id]).toBeNull();
  });

  it("lists at most 50 and says how many more, and one member's failure does not stop the others; a retry sends only what failed", async () => {
    const { db, topic } = await setup();
    await addMember(db, "dave", "dave", { readLangs: ["ja"], email: "dave@example.com" });
    await setPrefs(db, "alice", { emailPref: "daily", uiLocale: "en" });
    await setPrefs(db, "dave", { emailPref: "daily", uiLocale: "en" });
    const dtopic = await createTopic(db, "dave", { lang: "ja", title: "デイブの話題", body: "b" });
    if (!dtopic.ok) throw new Error("topic failed");
    for (let i = 0; i < 52; i++) await createReply(db, "bob", topic, { lang: "ja", body: `r${i}` }, { now: new Date(Date.UTC(2026, 9, 19, 0, i)) });
    await createReply(db, "bob", dtopic.id, { lang: "ja", body: "dave's reply" }, { now: new Date("2026-10-19T05:00:00Z") });
    const box = createMemoryMailbox();
    let failFor: string | null = "alice@example.com";
    const mailer = createMailer({ kind: "memory", async send(mail) { if (mail.to === failFor) throw new Error("smtp down"); await box.transport.send(mail); } }, "a@example.org");
    const handlers = createNotificationHandlers({ mailer: () => mailer });
    const now = new Date("2026-10-20T00:00:00Z");
    await ensureDigestScheduled(db, new Date("2026-10-19T23:00:00Z"));
    const first = await runDueJobs(db, handlers, { now, logger: quiet });
    expect(first).toMatchObject({ retried: 1 });
    // dave received the message; alice failed and remains unmarked.
    expect(box.sent.map((s) => s.to)).toEqual(["dave@example.com"]);
    expect((await rowsFor(db, "alice")).every((n) => n.emailedAt === null)).toBe(true);
    // The next day's job is queued even after failure.
    expect((await db.select().from(jobs).where(eq(jobs.kind, SEND_DIGEST_JOB))).filter((j) => j.dedupeKey === "digest:2026-10-21")).toHaveLength(1);
    // Between failure and retry, dave receives a new notification after that day's 00:00 UTC.
    const fresh = await createReply(db, "bob", dtopic.id, { lang: "ja", body: "dave's second reply" }, { now: new Date("2026-10-20T00:01:00Z") });
    if (!fresh.ok) throw new Error("reply failed");
    // Retry after the delay: send only to alice; do not send dave a second message that day.
    failFor = null;
    const retry = await runDueJobs(db, handlers, { now: new Date(now.getTime() + 10 * 60_000), logger: quiet });
    expect(retry).toMatchObject({ done: 1 });
    expect(box.sent.map((s) => s.to)).toEqual(["dave@example.com", "alice@example.com"]);
    expect((await db.select().from(notifications).where(eq(notifications.entryId, fresh.id)))[0].emailedAt).toBeNull();
    const toAlice = box.sent[1];
    expect(toAlice.subject).toBe(m.mail_digest_subject({ count: 52 }, enOptions));
    // List at most 50 items and report the count of the rest.
    expect(toAlice.text.match(new RegExp(escapeRegex(replyIntro("アリスの話題")), "g"))).toHaveLength(50);
    expect(toAlice.text).toContain(m.mail_digest_more({ count: 2, url: `${SITE}/notifications` }, enOptions));
    expect(toAlice.text).toContain(`${SITE}/notifications`);
    expect((await rowsFor(db, "alice")).every((n) => n.emailedAt !== null)).toBe(true);
    // The new notification belongs in the next day's digest.
    const next = await runDueJobs(db, handlers, { now: new Date("2026-10-21T00:00:00Z"), logger: quiet });
    expect(next).toMatchObject({ done: 2 });
    expect(box.sent.map((s) => [s.to, s.subject])).toEqual([
      ["dave@example.com", m.mail_digest_subject({ count: 1 }, enOptions)],
      ["alice@example.com", m.mail_digest_subject({ count: 52 }, enOptions)],
      ["dave@example.com", m.mail_digest_subject({ count: 1 }, enOptions)],
    ]);
    expect(box.sent[2].text).toContain("dave's second reply");
    expect((await db.select().from(notifications).where(eq(notifications.entryId, fresh.id)))[0].emailedAt).toEqual(new Date("2026-10-21T00:00:00Z"));
  });
});

describe("the mail templates", () => {
  it("truncate the excerpt to 200 characters by code point, on whitespace-normalized text", () => {
    expect(excerptOf("  a  b\n\nc ")).toBe("a b c");
    expect(excerptOf("x".repeat(200))).toBe("x".repeat(200));
    expect(excerptOf("x".repeat(201))).toBe(`${"x".repeat(200)}…`);
    // Do not split a surrogate pair.
    const emoji = "😀".repeat(201);
    expect([...excerptOf(emoji)].length).toBe(201);
    expect(excerptOf(emoji).startsWith("😀".repeat(200))).toBe(true);
  });

  it("are plain text in the given language, for a digest and for one notification", () => {
    const item = { kind: "reply_to_reply" as const, handle: "bob", title: "題", excerpt: "抜粋", url: `${SITE}/t/1#c-2` };
    const one = notificationMail({ to: "a@example.com", locale: "ja", item, settingsUrl: `${SITE}/settings` });
    expect(one.subject).toBe(m.mail_subject_reply_to_reply({ handle: "bob" }, jaOptions));
    expect(one.text).toContain(m.mail_item_reply_to_reply(item, jaOptions));
    const digest = digestMail({ to: "a@example.com", locale: "en", items: [item], more: 0, allUrl: `${SITE}/notifications`, settingsUrl: `${SITE}/settings` });
    expect(digest.subject).toBe(m.mail_digest_subject({ count: 1 }, enOptions));
    expect(digest.text).toContain(m.mail_item_reply_to_reply(item, enOptions));
    expect(digest.html).toBeUndefined();
  });
});

// ----: the `auto` default, followed_thread by email, and the race of a reply merged while the email is being sent ----

async function followSetup(carolPref: "auto" | "immediate" | "daily" | "none" = "auto") {
  const base = await setup();
  const { db } = base;
  await addMember(db, "carol", "carol", { readLangs: ["ja"], email: "carol@example.com" });
  await setPrefs(db, "carol", { emailPref: carolPref, uiLocale: "en" });
  await setFollow(db, "carol", base.topic, true);
  return base;
}
const fromBob = async (db: Db, topic: number, body: string, now: Date) => {
  const r = await createReply(db, "bob", topic, { lang: "ja", body }, { now });
  if (!r.ok) throw new Error("reply failed");
  return r.id;
};
const T = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 0, minutes));

describe("the `auto` preference", () => {
  it("sends a reply notification after the delay and keeps followed_thread for the daily digest, which then carries the merged count and the latest reply", async () => {
    const { db, topic, box, run } = await followSetup("auto");
    const first = await fromBob(db, topic, "最初の返信", T(1));
    const latest = await fromBob(db, topic, "最新の返信", T(2));
    // alice (auto) gets her two reply notifications mailed at once; carol (auto) gets nothing yet
    expect(await run(T(10))).toMatchObject({ done: 2, failed: 0 });
    expect(box.sent.map((s) => s.to)).toEqual(["alice@example.com", "alice@example.com"]);
    expect(await rowsFor(db, "carol")).toMatchObject([{ kind: "followed_thread", mergedCount: 2, entryId: latest, emailedAt: null }]);
    // the digest at the next UTC midnight: carol gets one mail with the count and the latest reply; alice has nothing left
    box.clear();
    await ensureDigestScheduled(db, T(60));
    expect(await run(new Date("2026-10-06T00:00:00Z"))).toMatchObject({ done: 2 });
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0].to).toBe("carol@example.com");
    expect(box.sent[0].text).toContain(followIntro(2));
    expect(box.sent[0].text).toContain("最新の返信");
    expect(box.sent[0].text).toContain(`${SITE}/t/${topic}#c-${first}`);
    expect((await rowsFor(db, "carol"))[0].emailedAt).toEqual(new Date("2026-10-06T00:00:00Z"));
  });

  it("never sends a followed_thread notification at once, whatever the delay", async () => {
    const { db, topic, box, run } = await followSetup("auto");
    await fromBob(db, topic, "返信", T(1));
    const [carolRow] = await rowsFor(db, "carol");
    expect((await emailJobs(db)).filter((j) => (j.payload as { notificationId: number }).notificationId === carolRow.id)).toEqual([]);
    await run(new Date("2026-10-05T12:00:00Z"));
    expect(box.sent.filter((s) => s.to === "carol@example.com")).toEqual([]);
  });

  it("`daily` and `immediate` override every kind: followed_thread is mailed at once for `immediate`, and in the digest for `daily`", async () => {
    const imm = await followSetup("immediate");
    await fromBob(imm.db, imm.topic, "即時", T(1));
    expect(await imm.run(T(10))).toMatchObject({ done: 2 });
    expect(imm.box.sent.map((s) => s.to).sort()).toEqual(["alice@example.com", "carol@example.com"]);
    expect(imm.box.sent.find((s) => s.to === "carol@example.com")?.subject).toBe(m.mail_subject_followed_thread({}, enOptions));
    const daily = await followSetup("daily");
    await setPrefs(daily.db, "alice", { emailPref: "daily" });
    await fromBob(daily.db, daily.topic, "まとめ", T(1));
    expect(await emailJobs(daily.db)).toEqual([]);
    await ensureDigestScheduled(daily.db, T(60));
    await daily.run(new Date("2026-10-06T00:00:00Z"));
    expect(daily.box.sent.map((s) => s.to).sort()).toEqual(["alice@example.com", "carol@example.com"]);
    // `none` sends nothing, and the notification is still in the list
    const none = await followSetup("none");
    await fromBob(none.db, none.topic, "なし", T(1));
    await ensureDigestScheduled(none.db, T(60));
    await none.run(new Date("2026-10-06T00:00:00Z"));
    expect(none.box.sent.filter((s) => s.to === "carol@example.com")).toEqual([]);
    expect(await rowsFor(none.db, "carol")).toHaveLength(1);
  });
});

describe("followed_thread by email (a member who chose `immediate`)", () => {
  it("one email with the latest reply and the count when replies were merged before it was sent; a second email for a reply that comes after", async () => {
    const { db, topic, box, run } = await followSetup("immediate");
    await setPrefs(db, "alice", { emailPref: "none" });
    const first = await fromBob(db, topic, "一つ目", T(1));
    const second = await fromBob(db, topic, "二つ目", T(2));
    // one job, because the second merge kept the same notification (dedupe)
    const [row] = await rowsFor(db, "carol");
    expect((await emailJobs(db)).filter((j) => (j.payload as { notificationId: number }).notificationId === row.id)).toHaveLength(1);
    expect(await run(T(20))).toMatchObject({ done: 1 });
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0].text).toContain(followIntro(2));
    expect(box.sent[0].text).toContain("二つ目");
    expect(box.sent[0].text).toContain(`${SITE}/t/${topic}#c-${first}`);
    expect((await rowsFor(db, "carol"))[0].emailedAt).toEqual(T(20));
    // still unread: the next reply merges into the same row (count 3), clears the mark and is mailed as a second email
    const third = await fromBob(db, topic, "三つ目", T(30));
    expect((await rowsFor(db, "carol"))[0]).toMatchObject({ mergedCount: 3, entryId: third, emailedAt: null });
    expect(await run(T(50))).toMatchObject({ done: 1 });
    expect(box.sent).toHaveLength(2);
    expect(box.sent[1].text).toContain(followIntro(3));
    expect(box.sent[1].text).toContain("三つ目");
  });

  it("a reply merged while the first email is being sent is not lost: the mark does not take, the job is deferred and sends the latest reply", async () => {
    const base = await followSetup("immediate");
    const { db, topic } = base;
    await setPrefs(db, "alice", { emailPref: "none" });
    await fromBob(db, topic, "最初", T(1));
    const box = createMemoryMailbox();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const sending = new Promise<void>((resolve) => (started = resolve));
    let blocking = true;
    const mailer = createMailer(
      {
        kind: "memory",
        async send(mail) {
          if (blocking) {
            blocking = false;
            started();
            await gate;
          }
          await box.transport.send(mail);
        },
      },
      "a@example.org",
    );
    const handlers = createNotificationHandlers({ mailer: () => mailer });
    const running = runDueJobs(db, handlers, { now: T(10), logger: quiet });
    await sending;
    // while the first email is being sent, another reply is merged: emailed_at goes back to NULL, and the job that the merge tried to queue is dropped by the dedupe (this one is running)
    const late = await fromBob(db, topic, "送信中の返信", T(11));
    expect((await rowsFor(db, "carol"))[0]).toMatchObject({ mergedCount: 2, entryId: late, emailedAt: null });
    release();
    expect(await running).toMatchObject({ ran: 1, deferred: 1, done: 0, failed: 0 });
    // the first email went out with the reply it knew; the mark did not take, so the latest reply is still to be told
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0].text).toContain("最初");
    expect((await rowsFor(db, "carol"))[0].emailedAt).toBeNull();
    const [job] = await emailJobs(db);
    expect(job).toMatchObject({ status: "queued", attempts: 0, runAt: new Date(T(11).getTime() + 5 * 60_000) });
    // too early: nothing; at the new time: the second email, with the latest reply, and the mark
    expect(await runDueJobs(db, handlers, { now: T(12), logger: quiet })).toMatchObject({ ran: 0 });
    expect(await runDueJobs(db, handlers, { now: T(20), logger: quiet })).toMatchObject({ ran: 1, done: 1 });
    expect(box.sent).toHaveLength(2);
    expect(box.sent[1].text).toContain("送信中の返信");
    expect(box.sent[1].text).toContain(followIntro(2));
    expect((await rowsFor(db, "carol"))[0].emailedAt).toEqual(T(20));
  });

  it("the opposite order (merged before the send reads the row) is one email with the latest reply, and no second job", async () => {
    const { db, topic, box, run } = await followSetup("immediate");
    await setPrefs(db, "alice", { emailPref: "none" });
    await fromBob(db, topic, "最初", T(1));
    await fromBob(db, topic, "あとから", T(2));
    expect(await run(T(10))).toMatchObject({ done: 1, deferred: 0 });
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0].text).toContain("あとから");
    expect(await run(T(30))).toMatchObject({ ran: 0 });
  });

  it("is not sent again when the member read the topic while a newer reply was merged during the send", async () => {
    const { db, topic } = await followSetup("immediate");
    await setPrefs(db, "alice", { emailPref: "none" });
    await fromBob(db, topic, "最初", T(1));
    const box = createMemoryMailbox();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const sending = new Promise<void>((resolve) => (started = resolve));
    const mailer = createMailer({ kind: "memory", async send(mail) { started(); await gate; await box.transport.send(mail); } }, "a@example.org");
    const running = runDueJobs(db, createNotificationHandlers({ mailer: () => mailer }), { now: T(10), logger: quiet });
    await sending;
    await fromBob(db, topic, "送信中", T(11));
    await db.update(notifications).set({ readAt: T(12) }).where(eq(notifications.userId, "carol"));
    release();
    expect(await running).toMatchObject({ done: 0, deferred: 1 });
    await runDueJobs(db, createNotificationHandlers({ mailer: () => mailer }), { now: T(20), logger: quiet });
    expect(box.sent).toHaveLength(1);
  });

  it("mails a reply committed after the handler's final check but before the queue marks completion", async () => {
    const { db, topic, box } = await followSetup("immediate");
    await setPrefs(db, "alice", { emailPref: "none" });
    await fromBob(db, topic, "first reply", T(1));
    const mailer = createMailer(box.transport, "a@example.org");
    const handlers = createNotificationHandlers({ mailer: () => mailer });
    const send = handlers[SEND_NOTIFICATION_EMAIL_JOB];
    let first = true;
    const wrapped = { ...handlers, [SEND_NOTIFICATION_EMAIL_JOB]: async (...args: Parameters<typeof send>) => {
      await send(...args);
      if (first) {
        first = false;
        await fromBob(db, topic, "reply at the completion boundary", T(11));
      }
    } };
    expect(await runDueJobs(db, wrapped, { now: T(10), logger: quiet })).toMatchObject({ ran: 1, deferred: 1, done: 0 });
    expect((await rowsFor(db, "carol"))[0].emailedAt).toBeNull();
    expect(await runDueJobs(db, wrapped, { now: T(20), logger: quiet })).toMatchObject({ ran: 1, done: 1 });
    expect(box.sent).toHaveLength(2);
    expect(box.sent[1].text).toContain("reply at the completion boundary");
    expect((await rowsFor(db, "carol"))[0].emailedAt).toEqual(T(20));
  });

  it("a hidden latest reply is mailed as the count and the topic only (no author, no excerpt); a hidden topic is not mailed but marked", async () => {
    const { db, topic, box, run } = await followSetup("immediate");
    await setPrefs(db, "alice", { emailPref: "none" });
    const r = await fromBob(db, topic, "SECRET-LATEST", T(1));
    await hideEntry(db, { id: "op", scope: OP }, { entryId: r, reason: "spam", note: "n" });
    expect(await run(T(10))).toMatchObject({ done: 1 });
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0].text).toContain(`${SITE}/t/${topic}`);
    expect(box.sent[0].text).not.toContain("SECRET-LATEST");
    expect(box.sent[0].text).not.toContain("@bob");
    expect((await rowsFor(db, "carol"))[0].emailedAt).toEqual(T(10));
    // a hidden topic
    box.clear();
    const other = await createTopic(db, "alice", { lang: "ja", title: "SECRET-TOPIC", body: "b" }, { now: T(20) });
    if (!other.ok) throw new Error("topic failed");
    await setFollow(db, "carol", other.id, true);
    await fromBob(db, other.id, "r", T(21));
    await hideEntry(db, { id: "op", scope: OP }, { entryId: other.id, reason: "spam", note: "n" });
    expect(await run(T(40))).toMatchObject({ done: 1 });
    expect(box.sent).toEqual([]);
    expect(JSON.stringify(box.sent)).not.toContain("SECRET-TOPIC");
    expect((await rowsFor(db, "carol")).find((n) => n.threadId === other.id)?.emailedAt).toEqual(T(40));
  });

  it("the digest does not mark a followed_thread row that another reply was merged into while the digest was being sent: it goes into the next digest", async () => {
    const { db, topic } = await followSetup("auto");
    await fromBob(db, topic, "最初", T(1));
    const box = createMemoryMailbox();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const sending = new Promise<void>((resolve) => (started = resolve));
    const mailer = createMailer({ kind: "memory", async send(mail) { if (mail.to === "carol@example.com") { started(); await gate; } await box.transport.send(mail); } }, "a@example.org");
    const handlers = createNotificationHandlers({ mailer: () => mailer });
    await ensureDigestScheduled(db, T(60));
    const midnight = new Date("2026-10-06T00:00:00Z");
    const running = runDueJobs(db, handlers, { now: midnight, logger: quiet });
    await sending;
    const late = await fromBob(db, topic, "ダイジェスト中", new Date("2026-10-05T23:30:00Z"));
    release();
    await running;
    expect(box.sent.filter((s) => s.to === "carol@example.com")).toHaveLength(1);
    expect((await rowsFor(db, "carol"))[0]).toMatchObject({ entryId: late, mergedCount: 2, emailedAt: null });
    // the next day
    await runDueJobs(db, handlers, { now: new Date("2026-10-07T00:00:00Z"), logger: quiet });
    const mails = box.sent.filter((s) => s.to === "carol@example.com");
    expect(mails).toHaveLength(2);
    expect(mails[1].text).toContain("ダイジェスト中");
  });
});

describe("followed_thread in a topic without a title", () => {
  it("names the topic by the beginning of its body, in the notification list and in the email, never by an empty title", async () => {
    const { db, box, run } = await followSetup("immediate");
    await setPrefs(db, "alice", { emailPref: "none" });
    const first = "朝のうちは涼しかったのに、昼には暑くなった。";
    const bare = await createTopic(db, "alice", { lang: "ja", body: `${first}\n\n二段落目。` }, { now: T(0) });
    if (!bare.ok) throw new Error("topic failed");
    await setFollow(db, "carol", bare.id, true);
    await fromBob(db, bare.id, "返信です", T(1));
    expect((await listNotifications(db, "carol")).items.find((n) => n.kind === "followed_thread")).toMatchObject({ topicTitle: first, count: 1 });
    await run(T(10));
    const mail = box.sent.find((s) => s.to === "carol@example.com" && s.text.includes(followIntro(1, first)));
    expect(mail?.text).toContain("返信です");
    expect(mail?.text).not.toContain(followIntro(1, ""));
  });
});

describe("the mail text of followed_thread", () => {
  it("says the count, the latest author, the excerpt and the link, in the recipient's language; without a handle it points to the topic only", () => {
    const item = { kind: "followed_thread" as const, count: 3, handle: "bob", title: "題", excerpt: "抜粋", url: `${SITE}/t/1#c-2` };
    const ja = notificationMail({ to: "a@example.com", locale: "ja", item, settingsUrl: `${SITE}/settings` });
    expect(ja.subject).toBe(m.mail_subject_followed_thread({}, jaOptions));
    expect(ja.text).toContain(m.mail_item_followed_thread(item, jaOptions));
    expect(ja.text).toContain("抜粋");
    const en = notificationMail({ to: "a@example.com", locale: "en", item, settingsUrl: `${SITE}/settings` });
    expect(en.text).toContain(m.mail_item_followed_thread(item, enOptions));
    const bare = notificationMail({ to: "a@example.com", locale: "en", item: { kind: "followed_thread", count: 2, title: "題", url: `${SITE}/t/1` }, settingsUrl: `${SITE}/settings` });
    expect(bare.text).toContain(m.mail_item_followed_thread_nolatest({ count: 2, title: "題", url: `${SITE}/t/1` }, enOptions));
    expect(bare.text).not.toContain("@");
  });
});

describe("a reply to a topic without a title", () => {
  const FIRST_LINE = "朝のうちは涼しかったのに、昼には暑くなった。";

  async function bareTopic(db: Db, body = `${FIRST_LINE}\n\n二段落目。`) {
    const topic = await createTopic(db, "alice", { lang: "ja", body });
    if (!topic.ok) throw new Error("topic failed");
    return topic.id;
  }

  it("names the topic by the beginning of its body (the sentence keeps its form), in the recipient's language", async () => {
    const { db, box, run } = await setup();
    await setPrefs(db, "alice", { emailPref: "immediate", uiLocale: "ja" });
    const id = await bareTopic(db);
    await createReply(db, "bob", id, { lang: "ja", body: "同じです。" });
    await run(after());
    expect(box.sent[0].text).toContain(replyIntro(FIRST_LINE, "ja"));
    box.clear();
    await setPrefs(db, "alice", { uiLocale: "en" });
    await createReply(db, "bob", id, { lang: "ja", body: "もう一つ。" });
    await run(after());
    expect(box.sent[0].text).toContain(replyIntro(FIRST_LINE));
  });

  it("cuts a long first line at 80 characters with an ellipsis, and uses the translation in the recipient's display language when there is one", async () => {
    const { db, box, run } = await setup();
    await setPrefs(db, "alice", { emailPref: "immediate", uiLocale: "en", readLangs: ["en"], displayLang: "en" });
    const id = await bareTopic(db, `${"あ".repeat(100)}\n\n続き`);
    await createReply(db, "bob", id, { lang: "ja", body: "返信。" });
    await run(after());
    expect(box.sent[0].text).toContain(replyIntro(`${"あ".repeat(80)}…`));
    box.clear();
    const [row] = await db.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, id));
    await db.insert(translations).values({ entryId: id, field: "body", lang: "en", kind: "primary", text: "## A heading in English\n\nThe rest.", engine: "fake", model: "m", sourceHash: row.hash });
    await createReply(db, "bob", id, { lang: "ja", body: "返信2。" });
    await run(after());
    expect(box.sent[0].text).toContain(replyIntro("A heading in English"));
    // A translation of an older version is not used (the original line is).
    box.clear();
    await db.update(translations).set({ sourceHash: "old" }).where(eq(translations.entryId, id));
    await createReply(db, "bob", id, { lang: "ja", body: "返信3。" });
    await run(after());
    expect(box.sent[0].text).toContain(replyIntro(`${"あ".repeat(80)}…`));
  });

  it("says so, in the recipient's language, when the body of the topic has no text", async () => {
    const { db, box, run } = await setup();
    await setPrefs(db, "alice", { emailPref: "immediate", uiLocale: "ja" });
    const id = await bareTopic(db, "![](https://example.com/a.png)");
    await createReply(db, "bob", id, { lang: "ja", body: "いい写真。" });
    await run(after());
    expect(box.sent[0].text).toContain(replyIntro(m.headline_empty({}, jaOptions), "ja"));
  });

  it("is the same in the daily digest, and a topic with a title is as before", async () => {
    const { db, topic, box, run } = await setup();
    await setPrefs(db, "alice", { emailPref: "daily", uiLocale: "en" });
    const id = await bareTopic(db);
    await createReply(db, "bob", id, { lang: "ja", body: "ダイジェスト用。" }, { now: new Date("2026-10-19T03:00:00Z") });
    await createReply(db, "bob", topic, { lang: "ja", body: "題のある話題への返信。" }, { now: new Date("2026-10-19T04:00:00Z") });
    await ensureDigestScheduled(db, new Date("2026-10-19T23:00:00Z"));
    await run(new Date("2026-10-20T00:00:00Z"));
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0].text).toContain(replyIntro(FIRST_LINE));
    expect(box.sent[0].text).toContain(replyIntro("アリスの話題"));
  });
});

it.each([false, true])("batches the shared immediate check only when push is enabled (%s)", async enabled => {
  if (enabled) configurePush(); else vi.stubEnv("WEB_PUSH", "");
  const access = await import("~/lib/notification-access.server");
  const check = vi.spyOn(access, "immediateNotifications");
  try {
    const { db, topic, box, run } = await setup();
    await setPrefs(db, "alice", { emailPref: "daily", uiLocale: "en" });
    await createReply(db, "bob", topic, { lang: "en", body: "First digest reply" });
    await createReply(db, "bob", topic, { lang: "en", body: "Second digest reply" });
    const now = new Date(Date.now() + 86400000); const date = now.toISOString().slice(0, 10);
    await db.insert(jobs).values({ kind: "send_member_digest", payload: { date, userId: "alice" }, runAt: now });
    expect(await run(now)).toMatchObject({ failed: 0 }); expect(box.sent).toHaveLength(1);
    expect(check).toHaveBeenCalledTimes(enabled ? 1 : 0);
    if (enabled) expect(check.mock.calls[0][2]).toHaveLength(2);
  } finally { check.mockRestore(); vi.unstubAllEnvs(); }
});
