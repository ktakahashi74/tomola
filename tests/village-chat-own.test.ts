import { consentChatMembers } from "./helpers/chat-consent";
import { afterEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { chatMentions, chatMessages, chatSequences, notifications, profiles, villageMembers, villages } from "~/lib/db/schema";
import { buildMemberExport, MEMBER_EXPORT_VERSION } from "~/lib/exports.server";
import { deleteOwnChat, exportOwnChat, ownChatPage, CHAT_OWN_PAGE_SIZE } from "~/lib/village-chat-own.server";
import { CHAT_OWN_DELETE_LIMIT } from "~/lib/village-chat-delete.server";
import { chatChanges, mutateChat } from "~/lib/village-chat.server";
import { m } from "~/paraglide/messages.js";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function world() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const seen: string[] = [];
  const db = await createTestDb({ logger: { logQuery(query) { seen.push(query); } } });
  for (const id of ["own-author", "own-reader"]) await addMember(db, id, id.replace("-", "_"), { homeArea: "en" });
  const [village] = await db.insert(villages).values({ slug: "own-chat-village", name: "Public own village", kind: "open" }).returning();
  await db.insert(villageMembers).values(["own-author", "own-reader"].map(userId => ({ villageId: village.id, userId })));
  await consentChatMembers(db);
  return { db, village, seen, author: "own-author", reader: "own-reader" };
}
it("lists only undeleted own messages, including left, removed, ended and hidden messages", async () => {
  const w = await world();
  const own = await mutateChat(w.db, w.author, w.village.slug!, "send", { body: "Own retained text" });
  const other = await mutateChat(w.db, w.reader, w.village.slug!, "send", { body: "Other private text" });
  const deleted = await mutateChat(w.db, w.author, w.village.slug!, "send", { body: "To delete" });
  await mutateChat(w.db, w.author, w.village.slug!, "delete", { id: deleted.id });
  expect(await ownChatPage(w.db, w.author)).toMatchObject({ groups: [{ village: { name: w.village.name }, messages: [{ id: own.id, href: expect.stringContaining(`?at=${own.id}`) }] }] });
  await w.db.delete(villageMembers).where(and(eq(villageMembers.villageId, w.village.id), eq(villageMembers.userId, w.author)));
  await w.db.update(villages).set({ endedAt: new Date() }).where(eq(villages.id, w.village.id));
  await w.db.update(chatMessages).set({ hiddenAt: new Date() }).where(eq(chatMessages.id, own.id));
  const page = await ownChatPage(w.db, w.author);
  expect(page.groups[0]).toMatchObject({ village: { name: w.village.name, chatHref: null }, messages: [{ id: own.id, body: "Own retained text", hidden: true, href: null }] });
  expect(JSON.stringify(page)).not.toContain(other.id);
  expect(JSON.stringify(page)).not.toContain(deleted.id);
  expect(JSON.stringify(page)).not.toContain(w.village.id);
});
it("masks private former village names and slugs but preserves an active member's own village name", async () => {
  const w = await world();
  await mutateChat(w.db, w.author, w.village.slug!, "send", { body: "Owned private text" });
  await w.db.update(villages).set({ kind: "closed" }).where(eq(villages.id, w.village.id));
  expect((await ownChatPage(w.db, w.author)).groups[0].village.name).toBe(w.village.name);
  await w.db.delete(villageMembers).where(eq(villageMembers.userId, w.author));
  const page = await ownChatPage(w.db, w.author), exported = await exportOwnChat(w.db, w.author);
  expect(page.groups[0].village).toEqual({ name: m.village_chat_own_former(), slug: null, chatHref: null });
  expect(exported[0].village).toBe(m.village_chat_own_former());
  for (const value of [w.village.name, w.village.slug, w.village.id]) expect(JSON.stringify({ page, exported })).not.toContain(value);
});
it("keeps own messages without constructing chat links when the village has no slug", async () => {
  const w = await world();
  const sent = await mutateChat(w.db, w.author, w.village.slug!, "send", { body: "Own text without a village slug" });
  await w.db.update(villages).set({ slug: null }).where(eq(villages.id, w.village.id));
  const page = await ownChatPage(w.db, w.author);
  expect(page.groups[0]).toMatchObject({ village: { name: w.village.name, slug: null, chatHref: null }, messages: [{ id: sent.id, href: null }] });
  expect(JSON.stringify(page)).not.toContain("/v/null/chat");
  expect(await deleteOwnChat(w.db, w.author, sent.id)).toEqual({ count: 1, more: false });
});
it("deletes own hidden messages after departure or ending and advances the shared change cursor", async () => {
  const w = await world();
  const sent = await mutateChat(w.db, w.author, w.village.slug!, "send", { body: "@own_reader A retained mention" });
  expect(await w.db.select().from(chatMentions).where(eq(chatMentions.messageId, sent.id))).toHaveLength(1);
  await w.db.update(chatMessages).set({ hiddenAt: new Date() }).where(eq(chatMessages.id, sent.id));
  await w.db.delete(villageMembers).where(eq(villageMembers.userId, w.author));
  await w.db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, w.author));
  await w.db.update(villages).set({ endedAt: new Date() }).where(eq(villages.id, w.village.id));
  expect(await deleteOwnChat(w.db, w.author, sent.id)).toEqual({ count: 1, more: false });
  const changes = await chatChanges(w.db, w.reader, w.village.slug!, { since: sent.seq });
  expect(changes.messages).toEqual([{ id: sent.id, createdSeq: sent.seq, changedSeq: sent.seq + 1, deleted: true }]);
  expect((await w.db.select().from(chatMessages).where(eq(chatMessages.id, sent.id)))[0]).toMatchObject({ body: "", deletedAt: expect.any(Date) });
  expect(await w.db.select().from(chatMentions).where(eq(chatMentions.messageId, sent.id))).toEqual([]);
  expect(await w.db.select().from(notifications).where(eq(notifications.chatMessageId, sent.id))).toEqual([]);
  expect(await deleteOwnChat(w.db, w.author, sent.id)).toEqual({ count: 0, more: false });
});
it("rejects guessed foreign messages and anchors without deleting other authors' messages", async () => {
  const w = await world();
  const other = await mutateChat(w.db, w.reader, w.village.slug!, "send", { body: "Another author's message" });
  for (const all of [false, true]) await expect(deleteOwnChat(w.db, w.author, other.id, all)).rejects.toMatchObject({ code: "not_found" });
  await expect(deleteOwnChat(w.db, w.author, "0".repeat(32))).rejects.toMatchObject({ code: "not_found" });
  expect((await w.db.select().from(chatMessages).where(eq(chatMessages.id, other.id)))[0].deletedAt).toBeNull();
});
it("paginates fifty own messages and performs no row locks or writes while reading", async () => {
  const w = await world();
  await w.db.insert(chatMessages).values(Array.from({ length: CHAT_OWN_PAGE_SIZE + 1 }, (_, i) => ({ villageId: w.village.id, authorId: w.author, body: `Own message ${i}`, lang: "en", createdSeq: i + 1, changedSeq: i + 1, createdAt: new Date(1700000000000 + i * 1000) })));
  const seen = w.seen; seen.length = 0;
  const first = await ownChatPage(w.db, w.author), second = await ownChatPage(w.db, w.author, { page: 2 });
  expect(first).toMatchObject({ page: 1, hasNext: true }); expect(first.groups[0].messages).toHaveLength(CHAT_OWN_PAGE_SIZE);
  expect(second.groups[0].messages.map(m => m.body)).toEqual(["Own message 0"]);
  expect(first.groups[0].messages[0].body).toBe(`Own message ${CHAT_OWN_PAGE_SIZE}`);
  expect(seen).toHaveLength(2);
  expect(seen.every(q => !/\b(?:insert|update|delete)\b|\bfor\s+(?:share|update)\b/i.test(q))).toBe(true);
});
it("caps bulk deletion and retains every tombstone across bounded change pages", async () => {
  const w = await world(), total = CHAT_OWN_DELETE_LIMIT + 3;
  const rows = await w.db.insert(chatMessages).values(Array.from({ length: total }, (_, i) => ({ villageId: w.village.id, authorId: w.author, body: `Own bulk ${i}`, lang: "en", createdSeq: i + 1, changedSeq: i + 1 }))).returning({ id: chatMessages.id });
  await w.db.insert(chatSequences).values({ villageId: w.village.id, seq: total });
  await w.db.delete(villageMembers).where(eq(villageMembers.userId, w.author));
  const seen = w.seen; seen.length = 0;
  expect(await deleteOwnChat(w.db, w.author, rows[0].id, true)).toEqual({ count: CHAT_OWN_DELETE_LIMIT, more: true });
  expect(seen.filter(q => /^update\s+"chat_sequences"/i.test(q))).toHaveLength(1);
  expect(seen.filter(q => /^update\s+"chat_messages"/i.test(q))).toHaveLength(1);
  let since = total, more = true; const deletedIds: string[] = [];
  const changeSeqs: number[] = [];
  while (more) {
    const result = await chatChanges(w.db, w.reader, w.village.slug!, { since });
    expect(result.messages.every(message => message.deleted)).toBe(true);
    deletedIds.push(...result.messages.map(message => message.id)); since = result.next; more = result.more;
    changeSeqs.push(...result.messages.map(message => message.changedSeq));
  }
  expect(new Set(deletedIds).size).toBe(CHAT_OWN_DELETE_LIMIT);
  expect(changeSeqs).toEqual(Array.from({ length: CHAT_OWN_DELETE_LIMIT }, (_, i) => total + i + 1));
  expect(await deleteOwnChat(w.db, w.author, rows[0].id, true)).toEqual({ count: total - CHAT_OWN_DELETE_LIMIT, more: false });
  expect((await ownChatPage(w.db, w.author)).groups).toEqual([]);
}, 60000);
it("exports only own undeleted chat data and preserves other fields when either flag closes", async () => {
  const w = await world();
  const sent = await mutateChat(w.db, w.author, w.village.slug!, "send", { body: "Original export text" });
  await mutateChat(w.db, w.author, w.village.slug!, "edit", { id: sent.id, body: "Edited export text" });
  await w.db.update(chatMessages).set({ hiddenAt: new Date() }).where(eq(chatMessages.id, sent.id));
  await mutateChat(w.db, w.reader, w.village.slug!, "send", { body: "Other exported author" });
  const now = new Date("2026-10-14T00:00:00Z");
  const open = await buildMemberExport(w.db, w.author, { now });
  expect(open.version).toBe(MEMBER_EXPORT_VERSION);
  expect(open.chat_messages).toEqual([{ id: sent.id, village: w.village.slug, lang: "en", body: "Edited export text", created_at: expect.any(String), edited_at: expect.any(String), hidden: true }]);
  const seen = w.seen; seen.length = 0;
  for (const [v, c] of [["1", ""], ["", "1"], ["", ""]]) {
    vi.stubEnv("VILLAGES", v); vi.stubEnv("VILLAGE_CHAT", c);
    const closed = await buildMemberExport(w.db, w.author, { now });
    expect(closed).toEqual({ ...open, chat_messages: [] });
    expect(await ownChatPage(w.db, w.author)).toMatchObject({ groups: [] });
    await expect(deleteOwnChat(w.db, w.author, sent.id)).rejects.toMatchObject({ code: "not_found" });
  }
  // Village icons are exported whenever villages are open; only chat reads must stop with the chat.
  expect(seen.filter(q => !/icon_media_id/.test(q) && /\b(?:from|join)\s+"?(?:chat_[a-z_]+|villages|village_members)"?/i.test(q))).toEqual([]);
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  await deleteOwnChat(w.db, w.author, sent.id);
  expect((await buildMemberExport(w.db, w.author)).chat_messages).toEqual([]);
});

it.each([null, "ja"])("exports a public village without a slug using its disclosed name (language %s)", async language => {
  const w = await world();
  const [village] = await w.db.insert(villages).values({ kind: "open", name: "Public village without slug", language, system: language !== null }).returning();
  expect(village.slug).toBeNull();
  await w.db.insert(chatMessages).values({ villageId: village.id, authorId: w.author, body: "Retained public message", lang: "en", createdSeq: 1, changedSeq: 1 });
  const page = await ownChatPage(w.db, w.author);
  const disclosed = page.groups.find(group => group.messages.some(message => message.body === "Retained public message"))!.village;
  expect(disclosed.name).not.toBe(m.village_chat_own_former());
  expect((await exportOwnChat(w.db, w.author))[0].village).toBe(disclosed.name);
  expect(disclosed.chatHref).toBeNull();
});
