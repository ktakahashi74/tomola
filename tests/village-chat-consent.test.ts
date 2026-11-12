import { afterEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { selectedTables } from "./helpers/query-tables";
import { chatAccessLog, chatConsents, chatMessages, chatReads, chatSequences, villageMembers, villages } from "~/lib/db/schema";
import { acceptChatConsent, chatAccess, chatChanges, chatPage, chatUnreadCounts, markChatRead, mutateChat } from "~/lib/village-chat.server";
import { changeVillageMembership } from "~/lib/villages.server";
import { removeVillageMember } from "~/lib/village-management.server";
import { createChatReport, readChatEvidence } from "~/lib/village-chat-reports.server";
import { deleteOwnChat, exportOwnChat, ownChatPage } from "~/lib/village-chat-own.server";

const consentVersion = vi.hoisted(() => ({ value: 1 }));
vi.mock("~/lib/village-chat-consent", () => ({ get CHAT_CONSENT_VERSION() { return consentVersion.value; } }));
afterEach(() => { consentVersion.value = 1; vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function world(kind = "open") {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const db = await createTestDb();
  for (const id of ["cc_owner", "cc_member", "cc_outside", "cc_operator"]) await addMember(db, id, id, { homeArea: "en" });
  const [village] = await db.insert(villages).values({ slug: "consent-test", name: "Consent village", kind }).returning();
  await db.insert(villageMembers).values(["cc_owner", "cc_member"].map(userId => ({ villageId: village.id, userId, role: userId === "cc_owner" ? "owner" : "member" })));
  const messages = await db.insert(chatMessages).values(["cc_owner", "cc_member"].map((authorId, i) => ({ villageId: village.id, authorId, lang: "en", body: `Protected ${authorId}`, createdSeq: i + 1, changedSeq: i + 1 }))).returning();
  await db.insert(chatSequences).values({ villageId: village.id, seq: 2 });
  return { db, village, slug: village.slug!, messages };
}

it("requires consent from both members and owners before selecting messages, writing or counting unread", async () => {
  const w = await world();
  for (const userId of ["cc_owner", "cc_member"]) {
    expect(await chatAccess(w.db, w.slug, userId)).toMatchObject({ consented: false, village: { id: w.village.id } });
    const seen = selectedTables(w.db);
    const page = await chatPage(w.db, userId, w.slug, { at: w.messages[0].id, before: 3 }); seen.restore();
    expect(page).toEqual({ readers: 2, consentRequired: true, consentVersion: 1, previousConsentVersion: null, village: expect.objectContaining({ slug: w.slug }) });
    expect(seen.queries).toHaveLength(1);
    expect(seen.tables.has("chat_messages")).toBe(false);
    expect(seen.tables.has("chat_sequences")).toBe(false);
    await expect(chatChanges(w.db, userId, w.slug, { since: 0 })).rejects.toMatchObject({ code: "not_found" });
    for (const intent of ["send", "edit", "delete"] as const) await expect(mutateChat(w.db, userId, w.slug, intent, { body: "Denied", id: w.messages.find(m => m.authorId === userId)!.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(markChatRead(w.db, userId, w.slug, 2)).rejects.toMatchObject({ code: "not_found" });
    expect(await chatUnreadCounts(w.db, userId)).toEqual(new Map());
  }
  expect(await chatAccess(w.db, w.slug, "cc_outside")).toBeNull();
  expect(await chatPage(w.db, "cc_outside", w.slug)).toBeNull();
  await expect(acceptChatConsent(w.db, "cc_outside", w.slug)).rejects.toMatchObject({ code: "not_found" });
  expect(await w.db.select().from(chatConsents)).toEqual([]);
  expect(await w.db.select().from(chatReads)).toEqual([]);
  expect((await w.db.select().from(chatMessages)).map(m => m.body)).toEqual(w.messages.map(m => m.body));
});

it("records current consent per village and member and permits every chat operation", async () => {
  const w = await world();
  await acceptChatConsent(w.db, "cc_owner", w.slug); await acceptChatConsent(w.db, "cc_owner", w.slug);
  expect(await w.db.select().from(chatConsents)).toMatchObject([{ villageId: w.village.id, userId: "cc_owner", version: 1, consentedAt: expect.any(Date) }]);
  expect(await chatPage(w.db, "cc_member", w.slug)).toHaveProperty("consentRequired", true);
  await acceptChatConsent(w.db, "cc_member", w.slug);
  expect(await chatPage(w.db, "cc_member", w.slug)).toMatchObject({ consentRequired: false, messages: [{ id: w.messages[0].id }, { id: w.messages[1].id }] });
  expect((await chatChanges(w.db, "cc_member", w.slug, { since: 0 })).messages).toHaveLength(2);
  expect((await chatUnreadCounts(w.db, "cc_member")).get(w.slug)).toBe(1);
  await markChatRead(w.db, "cc_member", w.slug, 2);
  expect((await chatUnreadCounts(w.db, "cc_member")).get(w.slug)).toBe(0);
  const sent = await mutateChat(w.db, "cc_member", w.slug, "send", { body: "Accepted" });
  await mutateChat(w.db, "cc_member", w.slug, "edit", { id: sent.id, body: "Changed" });
  await mutateChat(w.db, "cc_member", w.slug, "delete", { id: sent.id });
  expect((await chatChanges(w.db, "cc_owner", w.slug, { since: sent.seq })).messages).toEqual([{ id: sent.id, createdSeq: sent.seq, changedSeq: sent.seq + 2, deleted: true }]);
  const [other] = await w.db.insert(villages).values({ slug: "other-consent", kind: "open" }).returning();
  await w.db.insert(villageMembers).values({ villageId: other.id, userId: "cc_member" });
  expect(await chatPage(w.db, "cc_member", other.slug!)).toHaveProperty("consentRequired", true);
  expect((await chatUnreadCounts(w.db, "cc_member")).has(other.slug!)).toBe(false);
});

it("requires fresh consent when the code version increases", async () => {
  const w = await world(); await acceptChatConsent(w.db, "cc_member", w.slug);
  consentVersion.value = 2;
  await expect(acceptChatConsent(w.db, "cc_member", w.slug, "1")).rejects.toMatchObject({ code: "invalid" });
  expect(await w.db.select().from(chatConsents)).toMatchObject([{ version: 1 }]);
  const seen = selectedTables(w.db);
  expect(await chatPage(w.db, "cc_member", w.slug)).toMatchObject({ consentRequired: true, previousConsentVersion: 1 });
  seen.restore();
  expect(seen.queries).toHaveLength(1);
  const [other] = await w.db.insert(villages).values({ slug: "fresh-consent", kind: "open" }).returning();
  await w.db.insert(villageMembers).values({ villageId: other.id, userId: "cc_member" });
  expect(await chatPage(w.db, "cc_member", other.slug!)).toMatchObject({ consentRequired: true, previousConsentVersion: null });
  await expect(chatChanges(w.db, "cc_member", w.slug, { since: 0 })).rejects.toMatchObject({ code: "not_found" });
  await expect(mutateChat(w.db, "cc_member", w.slug, "send", { body: "Old consent" })).rejects.toMatchObject({ code: "not_found" });
  await expect(markChatRead(w.db, "cc_member", w.slug, 2)).rejects.toMatchObject({ code: "not_found" });
  expect(await chatUnreadCounts(w.db, "cc_member")).toEqual(new Map());
  await acceptChatConsent(w.db, "cc_member", w.slug);
  expect(await w.db.select().from(chatConsents)).toMatchObject([{ version: 2 }]);
  expect(await chatPage(w.db, "cc_member", w.slug)).toHaveProperty("consentRequired", false);
});

it.each(["leave", "remove"])("clears consent atomically on %s even while chat is closed and requires consent on rejoin", async operation => {
  const w = await world("invite_public");
  for (const id of ["cc_member", "cc_owner"]) await acceptChatConsent(w.db, id, w.slug);
  const [other] = await w.db.insert(villages).values({ slug: "retained-consent", kind: "open" }).returning();
  await w.db.insert(villageMembers).values({ villageId: other.id, userId: "cc_member" });
  await acceptChatConsent(w.db, "cc_member", other.slug!);
  vi.stubEnv("VILLAGE_CHAT", "");
  if (operation === "leave") expect(await changeVillageMembership(w.db, "cc_member", w.slug, "leave")).toBe(true);
  else expect(await removeVillageMember(w.db, "cc_owner", w.slug, "cc_member", "Membership reason")).toMatchObject({ ok: true });
  expect(await w.db.select().from(chatConsents).where(and(eq(chatConsents.userId, "cc_member"), eq(chatConsents.villageId, w.village.id)))).toEqual([]);
  expect(await w.db.select().from(chatConsents)).toHaveLength(2);
  expect((await w.db.select().from(chatMessages).where(eq(chatMessages.villageId, w.village.id))).map(row => row.body)).toEqual(w.messages.map(row => row.body));
  await w.db.insert(villageMembers).values({ villageId: w.village.id, userId: "cc_member" });
  vi.stubEnv("VILLAGE_CHAT", "1");
  expect(await chatPage(w.db, "cc_member", w.slug)).toHaveProperty("consentRequired", true);
});

it("keeps audited evidence and own-message deletion/export accessible after consent is cleared", async () => {
  const w = await world(); vi.stubEnv("OPERATOR_EMAILS", "cc_operator@example.com");
  await acceptChatConsent(w.db, "cc_member", w.slug);
  const report = await createChatReport(w.db, "cc_member", { slug: w.slug, messageId: w.messages[0].id, reason: "spam" });
  await changeVillageMembership(w.db, "cc_member", w.slug, "leave");
  const evidence = await readChatEvidence(w.db, { id: "cc_operator", scope: { operator: true, langs: [] } }, { kind: "report", id: report.id }, { intent: "open" });
  expect(JSON.stringify(evidence)).toContain("Protected cc_owner");
  expect(await w.db.select().from(chatAccessLog)).toHaveLength(1);
  expect(JSON.stringify(await ownChatPage(w.db, "cc_member"))).toContain("Protected cc_member");
  expect(JSON.stringify(await exportOwnChat(w.db, "cc_member"))).toContain("Protected cc_member");
  expect(await deleteOwnChat(w.db, "cc_member", w.messages[1].id)).toMatchObject({ count: 1 });
  expect(await w.db.select().from(chatConsents)).toEqual([]);
});

it("keeps closed chat free of consent reads and rejects consent writes", async () => {
  const w = await world(); vi.stubEnv("VILLAGE_CHAT", "");
  const seen = selectedTables(w.db);
  expect(await chatAccess(w.db, w.slug, "cc_member")).toBeNull();
  expect(await chatPage(w.db, "cc_member", w.slug)).toBeNull();
  expect(await chatUnreadCounts(w.db, "cc_member")).toEqual(new Map());
  await expect(acceptChatConsent(w.db, "cc_member", w.slug)).rejects.toMatchObject({ code: "not_found" });
  seen.restore(); expect(seen.tables.size).toBe(0);
});
