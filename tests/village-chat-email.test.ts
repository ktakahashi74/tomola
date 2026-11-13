import { consentChatMembers } from "./helpers/chat-consent";
import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { selectedTables } from "./helpers/query-tables";
import { chatMessages, entries, jobs, notifications, profiles, villageMembers, villages } from "~/lib/db/schema";
import * as plainText from "~/lib/plain-text.server";
import { mutateChat } from "~/lib/village-chat.server";
import { changeVillageMembership } from "~/lib/villages.server";
import { createNotificationHandlers, ensureDigestScheduled } from "~/lib/jobs/notification-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createMailer } from "~/lib/mail/mail.server";
import { notificationMail } from "~/lib/mail/notification.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { chatMailVillageName } from "~/lib/village-chat-villages.server";
import { m } from "~/paraglide/messages.js";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function world(pref = "auto", kind = "open", reply = false) {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const db = await createTestDb();
  await addMember(db, "writer", "vcm_writer"); await addMember(db, "target", "vcm_target");
  await db.update(profiles).set({ emailPref: pref, uiLocale: "en" }).where(eq(profiles.userId, "target"));
  const [village] = await db.insert(villages).values({ slug: "mail-village", name: "Public village name", kind }).returning();
  await db.insert(villageMembers).values(["writer", "target"].map(userId => ({ villageId: village.id, userId })));
  await consentChatMembers(db);
  const parent = reply ? await mutateChat(db, "target", village.slug!, "send", { body: "sensitive-reply-parent" }) : null;
  const sent = await mutateChat(db, "writer", village.slug!, "send", { body: "sensitive-body-marker @vcm_target", replyToId: parent?.id });
  const [notice] = await db.select().from(notifications);
  const box = createMemoryMailbox(); const mailer = createMailer(box.transport, "tomola <no-reply@example.org>");
  const handlers = createNotificationHandlers({ mailer: () => mailer });
  const run = (now = new Date(Date.now() + 6 * 60_000)) => runDueJobs(db, handlers, { now, logger: { warn() {}, error() {} }, limit: 100 });
  return { db, village, sent, notice, box, run };
}

it.each(["open", "invite_public"])("delivers auto mentions after five minutes with only the public village name and destination (%s)", async kind => {
  const { db, village, sent, box, run, notice } = await world("auto", kind);
  const [job] = await db.select().from(jobs);
  expect(job.runAt.getTime() - notice.createdAt.getTime()).toBe(300_000);
  await run(new Date(notice.createdAt.getTime() + 299_000)); expect(box.sent).toHaveLength(0);
  const seen = selectedTables(db);
  await run();
  expect(box.sent).toHaveLength(1);
  expect(box.sent[0].subject).toBe(m.mail_subject_chat_mention({}, { locale: "en" }));
  expect(box.sent[0].text).toContain(village.name);
  expect(box.sent[0].text).toContain(`/v/${village.slug}/chat?at=${sent.id}#chat-${sent.id}`);
  for (const secret of ["sensitive-body-marker", "vcm_writer", "vcm_target"]) expect(box.sent[0].text).not.toContain(secret);
  expect([...seen.tables]).not.toContain("entries");
  expect([...seen.tables]).not.toContain("translations");
  expect((await db.select().from(notifications))[0].emailedAt).not.toBeNull();
  seen.restore();
});

it("keeps nonpublic village names out of the mail item and ignores supplied author/body/excerpt fields", () => {
  expect(chatMailVillageName({ kind: "private", name: "secret-village-name", language: null }, "en")).toBeUndefined();
  const mail = notificationMail({ to: "target@example.org", locale: "en", settingsUrl: "https://example.org/settings", item: {
    kind: "chat_mention", url: "https://example.org/v/slug/chat?at=id", handle: "secret-author", title: "secret-title", excerpt: "secret-body",
  } });
  expect(mail.text).toContain(m.mail_item_chat_mention({ url: "https://example.org/v/slug/chat?at=id" }, { locale: "en" }));
  expect(JSON.stringify(mail)).not.toContain("secret-");
});

it.each(["left", "deleted", "hidden", "suspended", "closed", "villages-closed"])("rechecks availability at immediate delivery and suppresses %s", async state => {
  const { db, village, sent, notice, box, run } = await world();
  if (state === "left") await db.delete(villageMembers).where(eq(villageMembers.userId, "target"));
  if (state === "deleted") await db.update(chatMessages).set({ body: "", deletedAt: new Date() }).where(eq(chatMessages.id, sent.id));
  if (state === "hidden") await db.update(chatMessages).set({ hiddenAt: new Date() }).where(eq(chatMessages.id, sent.id));
  if (state === "suspended") await db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, "writer"));
  if (state === "closed") vi.stubEnv("VILLAGE_CHAT", "");
  if (state === "villages-closed") { vi.stubEnv("VILLAGE_CHAT", ""); vi.stubEnv("VILLAGES", ""); }
  const seen = selectedTables(db);
  await run(); expect(box.sent).toEqual([]);
  expect((await db.select().from(notifications).where(eq(notifications.id, notice.id)))[0].emailedAt).not.toBeNull();
  if (state.endsWith("closed")) expect([...seen.tables]).not.toContain("chat_messages");
  seen.restore();
});

it("completes pending jobs without mail after transactional leave or message deletion removes the notification", async () => {
  const { db, village, box, run } = await world();
  await changeVillageMembership(db, "target", village.slug!, "leave");
  await run(); expect(box.sent).toEqual([]);
  expect(await db.select().from(notifications)).toEqual([]);
});

it("includes chat mentions in daily digests and suppresses hidden items at digest delivery", async () => {
  const { db, village, sent, notice, box, run } = await world("daily");
  expect(await db.select().from(jobs)).toEqual([]);
  const second = await mutateChat(db, "writer", village.slug!, "send", { body: "another-secret @vcm_target" });
  await db.update(chatMessages).set({ hiddenAt: new Date() }).where(eq(chatMessages.id, second.id));
  const next = await ensureDigestScheduled(db);
  await run(next.runAt);
  expect(box.sent).toHaveLength(1);
  expect(box.sent[0].text).toContain(`/chat?at=${sent.id}#chat-${sent.id}`);
  expect(box.sent[0].text).not.toContain(`/chat?at=${second.id}`);
  for (const secret of ["sensitive-body-marker", "another-secret", "vcm_writer"]) expect(box.sent[0].text).not.toContain(secret);
  expect((await db.select().from(notifications)).every(row => row.emailedAt !== null)).toBe(true);
  expect(notice.kind).toBe("chat_mention");
});

it("rechecks chat membership after preparing post excerpts in a mixed digest", async () => {
  const { db, sent, notice, box, run } = await world("daily");
  const [post] = await db.insert(entries).values({ authorId: "writer", kind: "topic", lang: "en", title: "Public post title", body: "Public post text", sourceHash: "a".repeat(64) }).returning();
  await db.insert(notifications).values({ userId: "target", kind: "mention", actorId: "writer", entryId: post.id, threadId: post.id });
  const excerpt = plainText.plainExcerpt;
  const preparing = vi.spyOn(plainText, "plainExcerpt").mockImplementationOnce(async (...args) => {
    await db.delete(villageMembers).where(eq(villageMembers.userId, "target"));
    return excerpt(...args);
  });
  const next = await ensureDigestScheduled(db);
  await run(next.runAt);
  expect(preparing).toHaveBeenCalled();
  expect(box.sent).toHaveLength(1);
  expect(box.sent[0].text).toContain("Public post text");
  expect(box.sent[0].text).not.toContain(`/chat?at=${sent.id}`);
  expect((await db.select().from(notifications).where(eq(notifications.id, notice.id)))[0].emailedAt).not.toBeNull();
});

it("does no chat/village lookup for ordinary notification jobs even when chat is enabled", async () => {
  const { db, box, run } = await world();
  await db.delete(jobs); await db.delete(notifications);
  await db.update(profiles).set({ emailPref: "immediate" }).where(eq(profiles.userId, "target"));
  const { enqueueImmediateEmails } = await import("~/lib/notifications.server");
  const [row] = await db.insert(notifications).values({ userId: "target", kind: "moderation" }).returning();
  await enqueueImmediateEmails(db, [{ ...row, kind: "moderation" }]);
  const seen = selectedTables(db);
  await run(); expect(box.sent).toHaveLength(1);
  expect([...seen.tables]).not.toContain("chat_messages"); expect([...seen.tables]).not.toContain("villages");
  seen.restore();
});

it.each([["", ""], ["1", ""], ["1", "1"]])("preserves digest query parameters when chat is closed (%s/%s)", async (villageFlag, chatFlag) => {
  const { db, box, run } = await world();
  await db.delete(jobs); await db.delete(notifications);
  await db.insert(notifications).values({ userId: "target", kind: "moderation" });
  vi.stubEnv("VILLAGES", villageFlag); vi.stubEnv("VILLAGE_CHAT", chatFlag);
  const next = await ensureDigestScheduled(db);
  const seen = selectedTables(db);
  await run(next.runAt);
  expect(box.sent).toHaveLength(1);
  const pending = seen.queries.find(query => query.sql.includes('inner join "profiles"') && query.sql.includes('"emailed_at" is null'));
  expect(pending).toBeDefined();
  expect(pending!.params.includes("chat_mention")).toBe(chatFlag === "1");
  expect(pending!.sql.includes('"chat_message_id"')).toBe(chatFlag === "1");
  expect([...seen.tables]).not.toContain("chat_messages"); expect([...seen.tables]).not.toContain("villages");
  seen.restore();
});

it.each(["auto", "daily"])("delivers chat replies without source, reply, or author text (%s)", async pref => {
  const { db, sent, notice, box, run } = await world(pref, "open", true);
  expect(notice.kind).toBe("chat_reply");
  if (pref === "daily") { const next = await ensureDigestScheduled(db); await run(next.runAt); }
  else await run();
  expect(box.sent).toHaveLength(1);
  expect(box.sent[0].text).toContain(`/chat?at=${sent.id}`);
  for (const marker of ["sensitive-body-marker", "sensitive-reply-parent", "vcm_writer", "vcm_target"]) expect(JSON.stringify(box.sent)).not.toContain(marker);
});

it("suppresses queued reply mail after the recipient leaves", async () => {
  const { db, box, run } = await world("auto", "open", true);
  await db.delete(villageMembers).where(eq(villageMembers.userId, "target"));
  await run();
  expect(box.sent).toEqual([]);
});
