import { consentChatMembers, consentedChatPage as chatPage } from "./helpers/chat-consent";
import { afterEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { selectedTables } from "./helpers/query-tables";
import { chatMentions, chatMessages, chatReads, chatSequences, jobs, notifications, profiles, villageMembers, villages } from "~/lib/db/schema";
import { chatChanges, markChatRead, mutateChat } from "~/lib/village-chat.server";
import { resolveChatMentions } from "~/lib/village-chat-mentions.server";
import { countUnreadNotifications, listNotifications } from "~/lib/notifications.server";
import { changeVillageMembership } from "~/lib/villages.server";
import { removeVillageMember } from "~/lib/village-management.server";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function world(kind = "open") {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const queries: string[] = [];
  const db = await createTestDb({ logger: { logQuery(query) { queries.push(query); } } });
  for (const id of ["writer", "target", "fresh", "outsider"]) await addMember(db, id, `vcm_${id}`);
  const [village] = await db.insert(villages).values({ slug: "chat-mentions", name: "Village name", kind }).returning();
  await db.insert(villageMembers).values(["writer", "target", "fresh"].map(userId => ({ villageId: village.id, userId, role: userId === "writer" ? "owner" : "member" })));
  await consentChatMembers(db);
  return { db, village, queries, slug: village.slug! };
}
const notices = (db: Awaited<ReturnType<typeof createTestDb>>) => db.select().from(notifications).where(eq(notifications.kind, "chat_mention"));

it("resolves the longest global name before testing membership, without falling back to a shorter village name", async () => {
  const { db, slug, village } = await world();
  for (const handle of ["ann", "ann-marie", "ann_m"]) await addMember(db, handle, handle);
  await db.insert(villageMembers).values({ villageId: village.id, userId: "ann" });
  await consentChatMembers(db);
  const body = "@ann-marie @ann_m ＠ａｎｎ－ｍａｒｉｅ";
  await db.transaction(async tx => {
    const seen = selectedTables(tx);
    expect(await resolveChatMentions(tx, village.id, body)).toEqual([]);
    expect(seen.queries.filter(query => query.sql.includes('from "profiles"'))).toHaveLength(1);
    expect(seen.queries.filter(query => query.sql.includes('from "village_members"'))).toHaveLength(1);
    seen.restore();
  });
  const sent = await mutateChat(db, "writer", slug, "send", { body });
  expect((await chatPage(db, "target", slug))!.messages[0].parts).toEqual([{ type: "text", text: body }]);
  for (const table of [chatMentions, notifications, jobs]) expect(await db.select().from(table)).toEqual([]);
  await db.insert(villageMembers).values({ villageId: village.id, userId: "ann-marie" });
  await consentChatMembers(db);
  await mutateChat(db, "writer", slug, "edit", { id: sent.id, body });
  expect((await notices(db)).map(row => row.userId)).toEqual(["ann-marie"]);
  expect((await chatPage(db, "target", slug))!.messages[0].parts!.filter(part => part.type === "mention").map(part => part.text)).toEqual(["@ann-marie", "＠ａｎｎ－ｍａｒｉｅ"]);
});

it.each(["leave", "remove"])("cleans persistent chat state on %s while chat is closed and keeps it gone after reopening and rejoining", async operation => {
  const { db, village, slug } = await world("invite_public");
  const sent = await mutateChat(db, "writer", slug, "send", { body: "@vcm_target" });
  await markChatRead(db, "target", slug, sent.seq);
  expect(await notices(db)).toHaveLength(1);
  expect(await db.select().from(chatReads).where(eq(chatReads.userId, "target"))).toHaveLength(1);
  vi.stubEnv("VILLAGE_CHAT", "");
  if (operation === "leave") expect(await changeVillageMembership(db, "target", slug, "leave")).toBe(true);
  else expect(await removeVillageMember(db, "writer", slug, "vcm_target", "Reason")).toMatchObject({ ok: true });
  expect(await notices(db)).toEqual([]);
  expect(await db.select().from(chatReads).where(eq(chatReads.userId, "target"))).toEqual([]);
  await db.insert(villageMembers).values({ villageId: village.id, userId: "target" });
  await consentChatMembers(db);
  vi.stubEnv("VILLAGE_CHAT", "1");
  expect((await listNotifications(db, "target")).items.filter(item => item.kind === "chat_mention")).toEqual([]);
  await mutateChat(db, "writer", slug, "edit", { id: sent.id, body: "@vcm_target" });
  expect(await notices(db)).toEqual([]);
});

it("installs a partial message-reference index for notification deletion and foreign-key cascades", async () => {
  const db = await createTestDb();
  const result = await db.execute(sql`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'notifications' and indexname = 'notifications_chat_message_idx'`) as { rows: Array<{ indexdef: string }> };
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].indexdef).toContain("USING btree (chat_message_id)");
  expect(result.rows[0].indexdef).toContain("WHERE (chat_message_id IS NOT NULL)");
});

it("binds only current village members, retains plain text and longest original spelling, and never notifies oneself", async () => {
  const { db, slug } = await world();
  const body = '<b>＠ＶＣＭ＿ＴＡＲＧＥＴ-san</b> @vcm_target @vcm_writer @vcm_outsider @missing a@vcm_fresh.com https://example.org/@vcm_fresh';
  const sent = await mutateChat(db, "writer", slug, "send", { body });
  const page = (await chatPage(db, "target", slug))!;
  const parts = page.messages[0].parts!;
  expect(parts.map(part => part.text).join("")).toBe(body);
  expect(parts.filter(part => part.type === "mention")).toEqual([
    { type: "mention", text: "＠ＶＣＭ＿ＴＡＲＧＥＴ", href: expect.stringMatching(/^\/u\/id\//) },
    { type: "mention", text: "@vcm_target", href: expect.stringMatching(/^\/u\/id\//) },
    { type: "mention", text: "@vcm_writer", href: expect.stringMatching(/^\/u\/id\//) },
  ]);
  expect(await notices(db)).toMatchObject([{ userId: "target", actorId: null, entryId: null, chatMessageId: sent.id }]);
  expect(await db.select().from(chatMentions)).toHaveLength(2);
  expect((await chatChanges(db, "target", slug, { since: 0 })).messages[0].parts).toEqual(parts);
});

it("freezes affinity across renaming and leaving, re-resolves edits, and tells a recipient once per message even after cleanup", async () => {
  const { db, slug, village } = await world();
  const sent = await mutateChat(db, "writer", slug, "send", { body: "@vcm_target" });
  const href = (await chatPage(db, "writer", slug))!.messages[0].parts![0];
  await db.update(profiles).set({ handle: "vcm_renamed", handleKey: "vcm_renamed" }).where(eq(profiles.userId, "target"));
  expect((await chatPage(db, "writer", slug))!.messages[0].parts![0]).toEqual(href);
  await changeVillageMembership(db, "target", slug, "leave");
  expect(await notices(db)).toHaveLength(0);
  expect((await chatPage(db, "writer", slug))!.messages[0].parts![0]).toEqual(href);
  await mutateChat(db, "writer", slug, "edit", { id: sent.id, body: "@vcm_target @vcm_renamed @vcm_fresh" });
  expect((await chatPage(db, "writer", slug))!.messages[0].parts!.filter(p => p.type === "mention").map(p => p.text)).toEqual(["@vcm_fresh"]);
  expect((await notices(db)).map(row => row.userId)).toEqual(["fresh"]);
  await db.insert(villageMembers).values({ villageId: village.id, userId: "target" });
  await consentChatMembers(db);
  await mutateChat(db, "writer", slug, "edit", { id: sent.id, body: "@vcm_renamed @vcm_fresh" });
  expect((await notices(db)).map(row => row.userId)).toEqual(["fresh"]);
  expect((await chatPage(db, "writer", slug))!.messages[0].parts!.filter(p => p.type === "mention")).toHaveLength(2);
  await mutateChat(db, "writer", slug, "delete", { id: sent.id });
  expect(await db.select().from(chatMentions)).toEqual([]);
  expect(await notices(db)).toEqual([]);
});

it("limits bindings and lifetime notifications to ten distinct people in source order", async () => {
  const { db, slug, village } = await world();
  for (let i = 0; i < 12; i++) {
    await addMember(db, `extra${i}`, `vcm_extra${i}`);
    await db.insert(villageMembers).values({ villageId: village.id, userId: `extra${i}` });
    await consentChatMembers(db);
  }
  const sent = await mutateChat(db, "writer", slug, "send", { body: Array.from({ length: 12 }, (_, i) => `@vcm_extra${i}`).join(" ") });
  expect((await notices(db)).map(row => row.userId)).toEqual(Array.from({ length: 10 }, (_, i) => `extra${i}`));
  const before = (await chatPage(db, "writer", slug))!.messages[0].parts!;
  expect(before.filter(part => part.type === "mention")).toHaveLength(10);
  await mutateChat(db, "writer", slug, "edit", { id: sent.id, body: "@vcm_extra10 @vcm_extra11" });
  expect((await chatPage(db, "writer", slug))!.messages[0].parts!.filter(part => part.type === "mention")).toHaveLength(2);
  expect(await notices(db)).toHaveLength(10);
});

it("cleans notices on removal and deletion, filters stale/hidden notices and excludes them from unread counts", async () => {
  const { db, village, slug } = await world("invite_public");
  const sent = await mutateChat(db, "writer", slug, "send", { body: "secret-marker @vcm_target" });
  const list = await listNotifications(db, "target");
  expect(list.items).toMatchObject([{ kind: "chat_mention", chat: { id: sent.id, slug, name: village.name }, actorHandle: "vcm_writer", topicTitle: null, entryId: null }]);
  expect(JSON.stringify(list)).not.toContain("secret-marker");
  expect(list.items[0].actorHandle).toBe("vcm_writer");
  expect(await countUnreadNotifications(db, "target")).toBe(1);
  await db.update(chatMessages).set({ hiddenAt: new Date() }).where(eq(chatMessages.id, sent.id));
  expect((await listNotifications(db, "target")).items).toEqual([]);
  expect(await countUnreadNotifications(db, "target")).toBe(0);
  await db.update(chatMessages).set({ hiddenAt: null }).where(eq(chatMessages.id, sent.id));
  await db.delete(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, "target")));
  expect((await listNotifications(db, "target")).items).toEqual([]);
  expect(await countUnreadNotifications(db, "target")).toBe(0);
  await db.insert(villageMembers).values({ villageId: village.id, userId: "target" });
  await consentChatMembers(db);
  expect(await removeVillageMember(db, "writer", slug, "vcm_target", "reason")).toMatchObject({ ok: true });
  expect(await notices(db)).toEqual([]);
  const another = await mutateChat(db, "writer", slug, "send", { body: "@vcm_fresh" });
  await mutateChat(db, "writer", slug, "delete", { id: another.id });
  expect(await countUnreadNotifications(db, "fresh")).toBe(0);
});

it("keeps list shape and query scope unchanged when closed, and skips chat/village reads for nonchat pages even when open", async () => {
  const { db, slug } = await world();
  await db.insert(notifications).values({ userId: "fresh", kind: "moderation" });
  const baseline = await listNotifications(db, "fresh");
  for (const [villagesFlag, chatFlag] of [["", ""], ["1", ""], ["1", "1"]]) {
    vi.stubEnv("VILLAGES", villagesFlag); vi.stubEnv("VILLAGE_CHAT", chatFlag);
    const seen = selectedTables(db);
    expect(await listNotifications(db, "fresh")).toEqual(baseline);
    expect([...seen.tables]).not.toEqual(expect.arrayContaining(["chat_messages"]));
    expect([...seen.tables]).not.toContain("villages");
    seen.restore();
  }
  await mutateChat(db, "writer", slug, "send", { body: "@vcm_target" });
  for (const flags of [["", ""], ["1", ""]]) {
    vi.stubEnv("VILLAGES", flags[0]); vi.stubEnv("VILLAGE_CHAT", flags[1]);
    const seen = selectedTables(db);
    expect((await listNotifications(db, "target")).items).toEqual([]);
    expect(await countUnreadNotifications(db, "target")).toBe(0);
    expect([...seen.tables]).not.toContain("chat_messages");
    expect([...seen.tables]).not.toContain("villages");
    seen.restore();
  }
});

it("rolls bindings, notices and jobs back when sequence allocation fails, and enforces erased deleted bodies", async () => {
  const { db, village, slug } = await world();
  await db.insert(chatSequences).values({ villageId: village.id, seq: Number.MAX_SAFE_INTEGER });
  await expect(mutateChat(db, "writer", slug, "send", { body: "@vcm_target" })).rejects.toThrow("Village chat write failed");
  for (const table of [chatMentions, chatMessages, notifications, jobs]) expect(await db.select().from(table)).toEqual([]);
  await expect(db.insert(chatMessages).values({ villageId: village.id, authorId: "writer", body: "must erase", lang: "en", createdSeq: 1, changedSeq: 1, deletedAt: new Date() })).rejects.toMatchObject({ cause: { constraint: "chat_messages_deleted_body_check" } });
  const error = await db.transaction(tx => tx.insert(chatMentions).values({ messageId: "missing", userId: "target", publicId: "id" })).then(() => null, (error: { constraint?: string; cause?: { constraint?: string } }) => error.cause ?? error);
  expect(error).toMatchObject({ constraint: "chat_mentions_message_id_chat_messages_id_fk" });
});

it("sends new unmentioned messages without reading or clearing old mention bindings", async () => {
  const w = await world(); w.queries.length = 0;
  const sent = await mutateChat(w.db, "writer", w.slug, "send", { body: "Plain message" });
  expect(w.queries.some(query => query.includes('insert into "chat_messages"'))).toBe(true);
  expect(w.queries.filter(query => /\b(?:from|update|into)\s+"chat_mentions"/i.test(query))).toEqual([]);
  await mutateChat(w.db, "writer", w.slug, "edit", { id: sent.id, body: "@vcm_target" });
  expect(await notices(w.db)).toMatchObject([{ userId: "target" }]);
  await mutateChat(w.db, "writer", w.slug, "edit", { id: sent.id, body: "Plain again" });
  expect((await chatPage(w.db, "target", w.slug))!.messages[0].parts).toEqual([{ type: "text", text: "Plain again" }]);
  expect(await notices(w.db)).toHaveLength(1);
});

it.each(["hidden", "deleted", "departed", "private", "mismatched", "slugless"])("filters %s chat notices before pagination and preserves full visible pages", async state => {
  const { db, village, slug } = await world();
  const sent = await mutateChat(db, "writer", slug, "send", { body: "Unavailable @vcm_target" });
  await db.insert(notifications).values(Array.from({ length: 31 }, () => ({ userId: "target", kind: "chat_mention", villageId: village.id, chatMessageId: sent.id })));
  const ordinary = await db.insert(notifications).values(Array.from({ length: 31 }, (_, i) => ({ userId: "target", kind: "moderation", createdAt: new Date(Date.now() - 60_000 - i * 1000) }))).returning({ id: notifications.id });
  if (state === "hidden") await db.update(chatMessages).set({ hiddenAt: new Date() }).where(eq(chatMessages.id, sent.id));
  if (state === "deleted") await db.update(chatMessages).set({ deletedAt: new Date(), body: "" }).where(eq(chatMessages.id, sent.id));
  if (state === "departed") await db.delete(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, "target")));
  if (state === "private") await db.update(villages).set({ kind: "closed" }).where(eq(villages.id, village.id));
  if (state === "slugless") await db.update(villages).set({ slug: null }).where(eq(villages.id, village.id));
  if (state === "mismatched") {
    const [other] = await db.insert(villages).values({ slug: "wrong-chat-location", kind: "open" }).returning();
    await db.insert(villageMembers).values({ villageId: other.id, userId: "target" }); await consentChatMembers(db);
    await db.update(notifications).set({ villageId: other.id }).where(eq(notifications.kind, "chat_mention"));
  }
  const first = await listNotifications(db, "target"), second = await listNotifications(db, "target", { page: 2 });
  expect(first.items.map(item => item.id)).toEqual(ordinary.slice(0, 30).map(item => item.id)); expect(first.hasNext).toBe(true);
  expect(second.items.map(item => item.id)).toEqual([ordinary[30].id]); expect(second.hasNext).toBe(false);
});

it("reading a chat marks only this recipient's mentions in this village through the visible cursor", async () => {
  const { db, slug, village } = await world();
  const first = await mutateChat(db, "writer", slug, "send", { body: "First @vcm_target @vcm_fresh" });
  const later = await mutateChat(db, "writer", slug, "send", { body: "Later @vcm_target" });
  const [other] = await db.insert(villages).values({ slug: "other-mentions", kind: "open" }).returning();
  await db.insert(villageMembers).values(["writer", "target"].map(userId => ({ villageId: other.id, userId })));
  await consentChatMembers(db);
  const elsewhere = await mutateChat(db, "writer", other.slug!, "send", { body: "Elsewhere @vcm_target" });
  await db.insert(notifications).values({ userId: "target", kind: "moderation", villageId: village.id });
  await markChatRead(db, "target", slug, first.seq);
  const rows = await db.select().from(notifications);
  expect(rows.filter(row => row.readAt !== null)).toMatchObject([{ userId: "target", chatMessageId: first.id }]);
  expect(rows.filter(row => row.chatMessageId === later.id || row.chatMessageId === elsewhere.id || row.userId === "fresh" || row.kind === "moderation").every(row => row.readAt === null)).toBe(true);
  expect((await chatChanges(db, "target", slug, { since: later.seq, counts: true })).unreadCounts).toMatchObject({ [slug]: 1, [other.slug!]: 1 });
  await markChatRead(db, "target", slug, later.seq);
  expect((await chatChanges(db, "target", slug, { since: later.seq })).unread).toBe(0);
  expect(await countUnreadNotifications(db, "target")).toBe(2);
});


it.each([10, 121])("sending preserves read progress and mention state at cursor %i, and never adds own unread messages", async readSeq => {
  const { db, village, slug } = await world();
  await db.insert(chatMessages).values(Array.from({ length: 120 }, (_, i) => ({ villageId: village.id, authorId: "writer", lang: "en", body: `Unread ${i + 1}`, createdSeq: i + 1, changedSeq: i + 1 })));
  await db.insert(chatSequences).values({ villageId: village.id, seq: 120 });
  const mention = await mutateChat(db, "writer", slug, "send", { body: "Unseen @vcm_target" });
  await markChatRead(db, "target", slug, readSeq);
  const before = await notices(db);
  const sent = await mutateChat(db, "target", slug, "send", { body: "My reply" });
  expect(sent.seq).toBe(122);
  expect((await db.select().from(chatReads).where(eq(chatReads.userId, "target")))[0].seq).toBe(readSeq);
  expect(await notices(db)).toEqual(before);
  expect((await chatChanges(db, "target", slug, { since: sent.seq })).unread).toBe(readSeq === 10 ? 100 : 0);
  await markChatRead(db, "target", slug, mention.seq);
  expect((await notices(db))[0].readAt).not.toBeNull();
});
