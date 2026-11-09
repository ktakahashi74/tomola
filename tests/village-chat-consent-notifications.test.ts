import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { selectedTables } from "./helpers/query-tables";
import { chatConsents, chatMentions, jobs, notifications, profiles, villageMembers, villages } from "~/lib/db/schema";
import { acceptChatConsent, mutateChat } from "~/lib/village-chat.server";
import { countUnreadNotifications, listNotifications } from "~/lib/notifications.server";
import { chatNotificationLocations } from "~/lib/village-chat-notifications.server";
import { createNotificationHandlers, ensureDigestScheduled } from "~/lib/jobs/notification-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createMailer } from "~/lib/mail/mail.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";

const consentVersion = vi.hoisted(() => {
  // Database setup imports notification helpers before test mocks are installed.
  vi.resetModules();
  return { value: 1 };
});
vi.mock("~/lib/village-chat-consent", () => ({ get CHAT_CONSENT_VERSION() { return consentVersion.value; } }));
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
afterEach(() => { consentVersion.value = 1; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function world(pref = "auto", consented = false) {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const db = await createTestDb();
  for (const id of ["cn_writer", "cn_target"]) await addMember(db, id, id, { homeArea: "en" });
  await db.update(profiles).set({ emailPref: pref, uiLocale: "en" }).where(eq(profiles.userId, "cn_target"));
  const [village] = await db.insert(villages).values({ slug: "consent-notices", name: "Consent notices", kind: "open" }).returning();
  await db.insert(villageMembers).values(["cn_writer", "cn_target"].map(userId => ({ villageId: village.id, userId })));
  await acceptChatConsent(db, "cn_writer", village.slug!);
  if (consented) await acceptChatConsent(db, "cn_target", village.slug!);
  const box = createMemoryMailbox(), mailer = createMailer(box.transport, "tomola <no-reply@example.org>");
  const handlers = createNotificationHandlers({ mailer: () => mailer });
  const run = (now: Date) => runDueJobs(db, handlers, { now, logger: { warn() {}, error() {} }, limit: 100 });
  return { db, village, box, run };
}

it.each(["absent", "different-version", "other-village"])("keeps %s consent out of notification generation and permits a first notice after consent and editing", async state => {
  const w = await world();
  if (state === "different-version") await w.db.insert(chatConsents).values({ villageId: w.village.id, userId: "cn_target", version: 2 });
  if (state === "other-village") {
    const [other] = await w.db.insert(villages).values({ slug: "other-notices", kind: "open" }).returning();
    await w.db.insert(villageMembers).values({ villageId: other.id, userId: "cn_target" });
    await acceptChatConsent(w.db, "cn_target", other.slug!);
  }
  const sent = await mutateChat(w.db, "cn_writer", w.village.slug!, "send", { body: "Protected text @cn_target" });
  expect(await w.db.select().from(chatMentions)).toMatchObject([{ messageId: sent.id, userId: "cn_target", notifiedAt: null, tokens: [{ spelling: "@cn_target", prefix: "cn_target" }] }]);
  expect(await w.db.select().from(notifications)).toEqual([]);
  expect(await w.db.select().from(jobs)).toEqual([]);
  expect(await countUnreadNotifications(w.db, "cn_target")).toBe(0);
  expect(await listNotifications(w.db, "cn_target")).toMatchObject({ items: [], hasNext: false });
  await w.run(new Date(Date.now() + 6 * 60_000)); expect(w.box.sent).toEqual([]);
  await acceptChatConsent(w.db, "cn_target", w.village.slug!);
  await mutateChat(w.db, "cn_writer", w.village.slug!, "edit", { id: sent.id, body: "Edited protected text @cn_target" });
  expect(await w.db.select().from(chatMentions)).toMatchObject([{ notifiedAt: expect.any(Date) }]);
  expect(await w.db.select().from(notifications)).toMatchObject([{ kind: "chat_mention", userId: "cn_target", chatMessageId: sent.id }]);
  expect(await countUnreadNotifications(w.db, "cn_target")).toBe(1);
  expect((await listNotifications(w.db, "cn_target")).items).toMatchObject([{ kind: "chat_mention", chat: { id: sent.id, slug: w.village.slug } }]);
  await w.run(new Date(Date.now() + 6 * 60_000));
  expect(w.box.sent).toHaveLength(1); expect(w.box.sent[0].text).toContain(`/chat?at=${sent.id}#chat-${sent.id}`);
  expect(w.box.sent[0].text).not.toContain("Edited protected text");
  await mutateChat(w.db, "cn_writer", w.village.slug!, "edit", { id: sent.id, body: "Another edit @cn_target" });
  expect(await w.db.select().from(notifications)).toHaveLength(1);
  await w.run(new Date(Date.now() + 6 * 60_000)); expect(w.box.sent).toHaveLength(1);
});

it.each(["auto", "daily"])("hides existing notifications and suppresses pending %s mail after a code version increase", async pref => {
  const w = await world(pref, true);
  const sent = await mutateChat(w.db, "cn_writer", w.village.slug!, "send", { body: "Pending private text @cn_target" });
  const [notice] = await w.db.select().from(notifications);
  expect(await countUnreadNotifications(w.db, "cn_target")).toBe(1);
  expect((await listNotifications(w.db, "cn_target")).items).toHaveLength(1);
  consentVersion.value = 2;
  expect(await countUnreadNotifications(w.db, "cn_target")).toBe(0);
  const page = await listNotifications(w.db, "cn_target");
  expect(page).toMatchObject({ items: [], hasNext: false });
  expect(JSON.stringify(page)).not.toContain(sent.id);
  expect(await chatNotificationLocations(w.db, [notice], "cn_target")).toEqual(new Map());
  const now = pref === "daily" ? (await ensureDigestScheduled(w.db)).runAt : new Date(Date.now() + 6 * 60_000);
  await w.run(now); expect(w.box.sent).toEqual([]);
  expect((await w.db.select().from(notifications))[0].emailedAt).not.toBeNull();
});

it("removes outdated chat notifications before pagination without hiding an ordinary notification", async () => {
  const w = await world("daily", true);
  const sent = await mutateChat(w.db, "cn_writer", w.village.slug!, "send", { body: "Outdated private text @cn_target" });
  await w.db.insert(notifications).values(Array.from({ length: 30 }, () => ({ userId: "cn_target", kind: "chat_mention", villageId: w.village.id, chatMessageId: sent.id })));
  const [ordinary] = await w.db.insert(notifications).values({ userId: "cn_target", kind: "moderation", createdAt: new Date(Date.now() - 60_000) }).returning();
  consentVersion.value = 2;
  expect(await countUnreadNotifications(w.db, "cn_target")).toBe(1);
  const page = await listNotifications(w.db, "cn_target");
  expect(page).toMatchObject({ items: [{ id: ordinary.id, kind: "moderation" }], hasNext: false });
  expect(page.items).toHaveLength(1); expect(JSON.stringify(page)).not.toContain(sent.id);
  await w.run((await ensureDigestScheduled(w.db)).runAt);
  expect(w.box.sent).toHaveLength(1); expect(w.box.sent[0].text).not.toContain(`/chat?at=${sent.id}`);
});

it("does no consent lookup in closed notification counts, lists or mail locations", async () => {
  const w = await world("daily", true);
  const sent = await mutateChat(w.db, "cn_writer", w.village.slug!, "send", { body: "Closed private text @cn_target" });
  const [notice] = await w.db.select().from(notifications);
  for (const villagesFlag of ["", "1"]) {
    vi.stubEnv("VILLAGES", villagesFlag); vi.stubEnv("VILLAGE_CHAT", "");
    const seen = selectedTables(w.db);
    expect(await countUnreadNotifications(w.db, "cn_target")).toBe(0);
    expect(await listNotifications(w.db, "cn_target")).toMatchObject({ items: [], hasNext: false });
    expect(await chatNotificationLocations(w.db, [notice], "cn_target")).toEqual(new Map());
    seen.restore(); expect(seen.tables.has("chat_consents")).toBe(false);
    expect(seen.tables.has("chat_messages")).toBe(false); expect(seen.tables.has("villages")).toBe(false);
  }
  expect(sent.id).toBe(notice.chatMessageId);
});
