import { afterEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { consentChatMembers, consentedChatPage as chatPage } from "./helpers/chat-consent";
import { chatConsents, chatMessages, chatMessageTranslations, jobs, notifications, profiles, villageMembers, villages } from "~/lib/db/schema";
import { chatChanges, markChatRead, mutateChat } from "~/lib/village-chat.server";
import { chatSourceHash } from "~/lib/village-chat-translations.server";
import { countUnreadNotifications, listNotifications } from "~/lib/notifications.server";
import { notificationDestination } from "~/lib/notification-opening.server";
import { immediateNotifications } from "~/lib/notification-access.server";
import { groupChatNotifications } from "~/lib/group-chat-notifications";
import { createChatReport, readChatEvidence } from "~/lib/village-chat-reports.server";
import { CHAT_CASE_CONTEXT_COUNT } from "~/lib/chat-access";
import { CHAT_CONSENT_VERSION } from "~/lib/village-chat-consent";
import { changeVillageMembership } from "~/lib/villages.server";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function world() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const db = await createTestDb();
  for (const id of ["qry_writer", "qry_reader", "qry_outside", "qry_mod"]) await addMember(db, id, id, { homeArea: "en", readLangs: ["en"] });
  const [village] = await db.insert(villages).values({ slug: "chat-replies", kind: "open" }).returning();
  await db.insert(villageMembers).values(["qry_writer", "qry_reader"].map(userId => ({ villageId: village.id, userId })));
  await consentChatMembers(db);
  const parent = await mutateChat(db, "qry_reader", village.slug!, "send", { body: "Original reply target" });
  const send = (replyToId: unknown = parent.id, body = "A reply") => mutateChat(db, "qry_writer", village.slug!, "send", { body, replyToId });
  return { db, village, slug: village.slug!, parent, send };
}

it("keeps chronological order and resolves a parent outside the newest window from its current text", async () => {
  const w = await world();
  await w.db.insert(chatMessages).values(Array.from({ length: 60 }, (_, i) => ({ villageId: w.village.id, authorId: "qry_reader", lang: "en", body: `History ${i}`, createdSeq: i + 2, changedSeq: i + 2 })));
  const { chatSequences } = await import("~/lib/db/schema");
  await w.db.update(chatSequences).set({ seq: 61 });
  const reply = await w.send();
  const page = (await chatPage(w.db, "qry_writer", w.slug))!;
  expect(page.messages.some(m => m.id === w.parent.id)).toBe(false);
  expect(page.messages.at(-1)).toMatchObject({ id: reply.id, reply: { id: w.parent.id, text: "Original reply target", author: "qry_reader" } });
  expect(page.messages.map(m => m.createdSeq)).toEqual([...page.messages.map(m => m.createdSeq)].sort((a, b) => a - b));
  expect((await chatPage(w.db, "qry_writer", w.slug, { at: w.parent.id }))!.messages[0].id).toBe(w.parent.id);
  await mutateChat(w.db, "qry_reader", w.slug, "edit", { id: w.parent.id, body: "Current target\nsecond line" });
  const refreshed = (await chatPage(w.db, "qry_writer", w.slug))!.messages.at(-1)!;
  expect(refreshed.reply).toMatchObject({ text: "Current target second line", editedAt: expect.any(String) });
  await mutateChat(w.db, "qry_writer", w.slug, "edit", { id: reply.id, body: "Edited reply", replyToId: "f".repeat(32) });
  expect((await w.db.select().from(chatMessages).where(eq(chatMessages.id, reply.id)))[0].replyToId).toBe(w.parent.id);
});

it("uses only a matching current translation for the reader's language", async () => {
  const w = await world();
  await w.db.update(profiles).set({ displayLang: "ja", readLangs: ["ja"], uiLocale: "ja" }).where(eq(profiles.userId, "qry_writer"));
  await w.send();
  await w.db.insert(chatMessageTranslations).values({ messageId: w.parent.id, lang: "ja", state: "ready", sourceHash: chatSourceHash("Original reply target"), text: "返信先の訳" }).onConflictDoUpdate({ target: [chatMessageTranslations.messageId, chatMessageTranslations.lang], set: { state: "ready", text: "返信先の訳" } });
  const preview = async () => (await chatPage(w.db, "qry_writer", w.slug))!.messages.at(-1)!.reply;
  expect(await preview()).toMatchObject({ text: "返信先の訳", lang: "ja" });
  await w.db.update(chatMessages).set({ body: "New source", editedAt: new Date() }).where(eq(chatMessages.id, w.parent.id));
  expect(await preview()).toMatchObject({ text: "New source", lang: "en" });
  await w.db.update(chatMessageTranslations).set({ state: "pending", sourceHash: chatSourceHash("New source") }).where(eq(chatMessageTranslations.messageId, w.parent.id));
  expect(await preview()).toMatchObject({ text: "New source", lang: "en" });
});

it.each(["missing", "malformed", "file", "other-village", "deleted", "hidden"])("uniformly rejects an unavailable reply target (%s)", async state => {
  const w = await world();
  let id: unknown = w.parent.id;
  if (state === "missing") id = "f".repeat(32);
  if (state === "malformed") id = "bad-id";
  if (state === "file") id = new File(["id"], "target");
  if (state === "other-village") {
    const [other] = await w.db.insert(villages).values({ slug: "other-chat-replies", kind: "open" }).returning();
    await w.db.update(chatMessages).set({ villageId: other.id }).where(eq(chatMessages.id, w.parent.id));
  }
  if (state === "deleted") await mutateChat(w.db, "qry_reader", w.slug, "delete", { id: w.parent.id });
  if (state === "hidden") await w.db.update(chatMessages).set({ hiddenAt: new Date() }).where(eq(chatMessages.id, w.parent.id));
  await expect(w.send(id)).rejects.toMatchObject({ code: "invalid_reply", message: "invalid_reply" });
  expect(await w.db.select().from(notifications)).toEqual([]);
});

it.each(["deleted", "hidden"])("redacts unavailable parents and destinations without explaining why (%s)", async state => {
  const w = await world(); const reply = await w.send();
  if (state === "deleted") await mutateChat(w.db, "qry_reader", w.slug, "delete", { id: w.parent.id });
  else await w.db.update(chatMessages).set({ hiddenAt: new Date() }).where(eq(chatMessages.id, w.parent.id));
  const message = (await chatPage(w.db, "qry_writer", w.slug))!.messages.find(m => m.id === reply.id)!;
  expect(message.reply).toEqual({ id: w.parent.id, changedSeq: expect.any(Number), unavailable: true });
  expect(JSON.stringify(message)).not.toContain("Original reply target");
  const destination = (await chatPage(w.db, "qry_writer", w.slug, { at: w.parent.id }))!;
  expect(destination).toMatchObject({ targetUnavailable: true, messages: [] });
});

it("shares the once-per-message notification ledger with mentions, including edits after notice cleanup", async () => {
  const w = await world(); const sent = await w.send(w.parent.id, "A private reply @qry_reader");
  expect(await w.db.select().from(notifications)).toMatchObject([{ userId: "qry_reader", kind: "chat_reply", chatMessageId: sent.id }]);
  await w.db.delete(notifications);
  await mutateChat(w.db, "qry_writer", w.slug, "edit", { id: sent.id, body: "Edited @qry_reader" });
  expect(await w.db.select().from(notifications)).toEqual([]);
  await w.send(); await mutateChat(w.db, "qry_writer", w.slug, "send", { body: "Mention @qry_reader" });
  const listed = (await listNotifications(w.db, "qry_reader")).items;
  expect(groupChatNotifications(listed)).toMatchObject([{ chatCount: 2, chatHasReply: true }]);
  expect(await countUnreadNotifications(w.db, "qry_reader")).toBe(2);
  expect(await markChatRead(w.db, "qry_reader", w.slug, 99)).toBe(2);
  expect(await countUnreadNotifications(w.db, "qry_reader")).toBe(0);
});

it.each(["self", "left", "no-consent", "old-consent", "suspended"])("does not notify an ineligible reply recipient (%s)", async state => {
  const w = await world();
  if (state === "left") await w.db.delete(villageMembers).where(eq(villageMembers.userId, "qry_reader"));
  if (state === "no-consent") await w.db.delete(chatConsents).where(eq(chatConsents.userId, "qry_reader"));
  if (state === "old-consent") await w.db.update(chatConsents).set({ version: CHAT_CONSENT_VERSION - 1 }).where(eq(chatConsents.userId, "qry_reader"));
  if (state === "suspended") await w.db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, "qry_reader"));
  if (state === "self") await mutateChat(w.db, "qry_reader", w.slug, "send", { body: "Self reply", replyToId: w.parent.id });
  else await w.send();
  expect(await w.db.select().from(notifications)).toEqual([]);
});

it.each(["left", "old-consent", "suspended", "hidden", "disabled"])("rechecks reply access before immediate delivery and notification opening (%s)", async state => {
  const w = await world(); const sent = await w.send();
  const [notice] = await w.db.select().from(notifications);
  expect((await immediateNotifications(w.db, "qry_reader", [notice.id])).size).toBe(1);
  if (state === "left") await w.db.delete(villageMembers).where(eq(villageMembers.userId, "qry_reader"));
  if (state === "old-consent") await w.db.update(chatConsents).set({ version: CHAT_CONSENT_VERSION - 1 }).where(eq(chatConsents.userId, "qry_reader"));
  if (state === "suspended") await w.db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, "qry_reader"));
  if (state === "hidden") await w.db.update(chatMessages).set({ hiddenAt: new Date() }).where(eq(chatMessages.id, sent.id));
  if (state === "disabled") vi.stubEnv("VILLAGE_CHAT", "");
  expect((await immediateNotifications(w.db, "qry_reader", [notice.id])).size).toBe(0);
  expect(await notificationDestination(w.db, "qry_reader", notice.id, null)).toBeNull();
});

it("enforces the same-village reference in the database too", async () => {
  const w = await world();
  const [other] = await w.db.insert(villages).values({ slug: "reply-fk-other", kind: "open" }).returning();
  await expect(w.db.insert(chatMessages).values({ villageId: other.id, authorId: "qry_writer", body: "Forged reply", lang: "en", replyToId: w.parent.id, createdSeq: 1, changedSeq: 1 })).rejects.toThrow();
});

it("clears reply notices on village departure and never recreates them after rejoining and editing", async () => {
  const w = await world(); const sent = await w.send();
  await changeVillageMembership(w.db, "qry_reader", w.slug, "leave");
  expect(await w.db.select().from(notifications)).toEqual([]);
  await w.db.insert(villageMembers).values({ villageId: w.village.id, userId: "qry_reader" });
  await consentChatMembers(w.db);
  await mutateChat(w.db, "qry_writer", w.slug, "edit", { id: sent.id, body: "Changed @qry_reader" });
  expect(await w.db.select().from(notifications)).toEqual([]);
});

it("never reads reply targets beyond the audited moderation context", async () => {
  const w = await world();
  for (let i = 0; i <= CHAT_CASE_CONTEXT_COUNT; i++) await mutateChat(w.db, "qry_writer", w.slug, "send", { body: `Intervening ${i}` });
  const distant = await w.send();
  const near = await w.send(distant.id, "Nearby reply");
  const report = await createChatReport(w.db, "qry_reader", { slug: w.slug, messageId: distant.id, reason: "spam" });
  const actor = { id: "qry_mod", scope: { operator: false, langs: ["en" as const] } };
  const opened = await readChatEvidence(w.db, actor, { kind: "report", id: report.id }, { intent: "open" });
  expect(opened.snapshot!.reply).toEqual({ outside: true });
  const evidence = await readChatEvidence(w.db, actor, { kind: "report", id: report.id }, { intent: "context" });
  expect(evidence.context.find(m => m.id === distant.id)!.reply).toEqual({ outside: true });
  expect(evidence.context.find(m => m.id === near.id)!.reply).toMatchObject({ id: distant.id, text: "A reply" });
  expect(JSON.stringify(evidence)).not.toContain("Original reply target");
  expect(evidence.context.length).toBeLessThanOrEqual(CHAT_CASE_CONTEXT_COUNT * 2 + 1);
  expect((await chatChanges(w.db, "qry_writer", w.slug, { since: 0 })).messages.find(m => m.id === near.id)!.reply).toMatchObject({ id: distant.id });
  expect(await w.db.select().from(jobs).where(and(eq(jobs.kind, "translate_chat"), eq(jobs.status, "queued")))).toEqual([]);
});
