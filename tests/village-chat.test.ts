import { consentChatMembers, consentedChatPage as chatPage } from "./helpers/chat-consent";
import { afterEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { chatMessages, chatReads, chatSequences, profiles, villageMembers, villages } from "~/lib/db/schema";
import { chatChanges, chatUnreadCounts, markChatRead, mutateChat, nextChatSequence } from "~/lib/village-chat.server";
import { changeVillageMembership } from "~/lib/villages.server";
import { removeVillageMember, endVillage } from "~/lib/village-management.server";
import { signalVillageChat, villageChatEventStream } from "~/lib/village-chat-events.server";
import { chatParts } from "~/lib/village-chat";
import { assertVillageChatConfig, villageChatEnabled } from "~/lib/village-chat-enabled.server";

afterEach(() => vi.unstubAllEnvs());
async function world(kind = "open", logger?: { logQuery(query: string, params: unknown[]): void }) {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const db = await createTestDb({ logger });
  await addMember(db, "author", "chat_author", { homeArea: "en", readLangs: ["en"] });
  await addMember(db, "reader", "chat_reader");
  await addMember(db, "outside", "chat_outside");
  const [village] = await db.insert(villages).values({ slug: "chat-test", name: "Chat test", kind }).returning();
  await db.insert(villageMembers).values([{ villageId: village.id, userId: "author", role: "owner" }, { villageId: village.id, userId: "reader" }]);
  await consentChatMembers(db);
  return { db, village, slug: village.slug! };
}

it("validates both settings and requires villages at startup", () => {
  for (const [villages, chat, enabled] of [["", "", false], ["1", "", false], ["1", "1", true]] as const) {
    expect(villageChatEnabled({ VILLAGES: villages, VILLAGE_CHAT: chat })).toBe(enabled);
    expect(() => assertVillageChatConfig({ VILLAGES: villages, VILLAGE_CHAT: chat })).not.toThrow();
  }
  expect(() => assertVillageChatConfig({ VILLAGE_CHAT: "1" })).toThrow("requires VILLAGES=1");
  for (const value of ["0", "yes", "true"]) expect(() => villageChatEnabled({ VILLAGES: "1", VILLAGE_CHAT: value })).toThrow("1 or empty");
});

it("keeps literal markup and mentions, links only HTTP(S), and trims punctuation", () => {
  const parts = chatParts('<script>alert(1)</script> @chat_reader https://example.org/path).かな http://example.org/a，全文 javascript:alert(1)');
  expect(parts.filter(p => p.type === "link")).toEqual([
    { type: "link", href: "https://example.org/path", text: "https://example.org/path" },
    { type: "link", href: "http://example.org/a", text: "http://example.org/a" },
  ]);
  expect(parts.map(p => p.text).join("")).toBe('<script>alert(1)</script> @chat_reader https://example.org/path).かな http://example.org/a，全文 javascript:alert(1)');
  expect(chatParts("https:// <https://example.org/x> https://example.org/")).toEqual(expect.arrayContaining([{ type: "link", href: "https://example.org/x", text: "https://example.org/x" }]));
});

it("allocates committed village sequences, detects language, and erases deleted text", async () => {
  const { db, slug, village } = await world();
  const a = await mutateChat(db, "author", slug, "send", { body: "Hi" });
  const b = await mutateChat(db, "reader", slug, "send", { body: "こんにちは" });
  expect(a.seq).toBe(1); expect(b.seq).toBe(2); expect(a.id).toMatch(/^[a-f0-9]{32}$/);
  const page = (await chatPage(db, "reader", slug))!;
  expect(page.messages.map(m => m.lang)).toEqual(["en", "ja"]);
  expect(page.messages.map(m => m.createdSeq)).toEqual([1, 2]);
  await mutateChat(db, "author", slug, "edit", { id: a.id, body: "Changed" });
  const changes = await chatChanges(db, "reader", slug, { since: 2 });
  expect(changes).toMatchObject({ next: 3, more: false, messages: [{ id: a.id, createdSeq: 1, changedSeq: 3, edited: true }] });
  await mutateChat(db, "author", slug, "delete", { id: a.id });
  const [deleted] = await db.select().from(chatMessages).where(eq(chatMessages.id, a.id));
  expect(deleted.body).toBe(""); expect(deleted.deletedAt).not.toBeNull();
  const tombstone = (await chatChanges(db, "reader", slug, { since: 3 })).messages[0];
  expect(tombstone).toEqual({ id: a.id, createdSeq: 1, changedSeq: 4, deleted: true });
  expect((await chatPage(db, "reader", slug))!.messages.map(m => m.id)).toEqual([b.id]);
  expect(await db.select().from(chatSequences)).toMatchObject([{ villageId: village.id, seq: 4 }]);
  for (const body of ["", "   ", "x".repeat(2001)]) await expect(mutateChat(db, "author", slug, "send", { body })).rejects.toMatchObject({ code: "invalid" });
});

it("uses the author's main language for short Han messages on send and edit", async () => {
  const { db, slug } = await world();
  const sent = await mutateChat(db, "reader", slug, "send", { body: "確認" });
  expect((await db.select().from(chatMessages).where(eq(chatMessages.id, sent.id)))[0].lang).toBe("ja");
  await mutateChat(db, "reader", slug, "edit", { id: sent.id, body: "時間変更" });
  expect((await db.select().from(chatMessages).where(eq(chatMessages.id, sent.id)))[0].lang).toBe("ja");
});

it("normalizes browser newlines before applying the length limit and preserves balanced URL parentheses", async () => {
  const { db, slug } = await world();
  const text = "a\n".repeat(999) + "xy";
  const message = await mutateChat(db, "author", slug, "send", { body: text.replace(/\n/g, "\r\n") });
  expect((await db.select().from(chatMessages).where(eq(chatMessages.id, message.id)))[0].body).toBe(text);
  const parts = chatParts("https://example.org/Foo_(bar)). https://example.org/x)");
  expect(parts.filter(part => part.type === "link").map(part => part.href)).toEqual(["https://example.org/Foo_(bar)", "https://example.org/x"]);
});

it("marks historical windows and clears read cursors on leaving or removal", async () => {
  const { db, slug, village } = await world("invite_public");
  const first = await mutateChat(db, "reader", slug, "send", { body: "First" });
  await mutateChat(db, "author", slug, "send", { body: "Second" });
  expect(await chatPage(db, "reader", slug, { before: 2 })).toMatchObject({ historical: true, hasNewer: true });
  expect(await chatPage(db, "reader", slug, { at: first.id })).toMatchObject({ historical: true });
  expect(await chatPage(db, "reader", slug, { at: "missing" })).toMatchObject({ historical: false });
  await changeVillageMembership(db, "reader", slug, "leave");
  expect(await db.select().from(chatReads).where(eq(chatReads.userId, "reader"))).toEqual([]);
  await db.insert(villageMembers).values({ villageId: village.id, userId: "reader" });
  await consentChatMembers(db);
  await markChatRead(db, "reader", slug, first.seq);
  expect(await removeVillageMember(db, "author", slug, "chat_reader", "A reason")).toMatchObject({ ok: true });
  expect(await db.select().from(chatReads).where(eq(chatReads.userId, "reader"))).toEqual([]);
});

it("announces later messages only when they exist, including empty windows and deletion while polling", async () => {
  const { db, slug } = await world();
  expect(await chatPage(db, "reader", slug, { before: 100 })).toMatchObject({ historical: true, hasNewer: false, messages: [] });
  await mutateChat(db, "author", slug, "send", { body: "First" });
  const second = await mutateChat(db, "author", slug, "send", { body: "Second" });
  expect(await chatPage(db, "reader", slug, { before: 100 })).toMatchObject({ historical: true, hasNewer: false });
  expect(await chatPage(db, "reader", slug, { before: 0 })).toMatchObject({ historical: true, hasNewer: true, messages: [] });
  expect(await chatPage(db, "reader", slug, { before: 2 })).toMatchObject({ historical: true, hasNewer: true });
  expect(await chatChanges(db, "reader", slug, { since: second.seq, after: 1 })).toMatchObject({ hasNewer: true, messages: [] });
  expect(await chatChanges(db, "reader", slug, { since: second.seq })).not.toHaveProperty("hasNewer");
  await mutateChat(db, "author", slug, "delete", { id: second.id });
  expect(await chatPage(db, "reader", slug, { before: 2 })).toMatchObject({ historical: true, hasNewer: false });
  expect(await chatChanges(db, "reader", slug, { since: second.seq, after: 1 })).toMatchObject({ hasNewer: false, messages: [{ id: second.id, deleted: true }] });
});

it("enforces current membership, own-message authority, suspension, and ended villages", async () => {
  const { db, slug, village } = await world();
  const message = await mutateChat(db, "reader", slug, "send", { body: "Owned text" });
  expect(await chatPage(db, "outside", slug)).toBeNull();
  await expect(chatChanges(db, "outside", slug, { since: 0 })).rejects.toMatchObject({ code: "not_found" });
  for (const intent of ["edit", "delete"] as const) await expect(mutateChat(db, "author", slug, intent, { id: message.id, body: "Other text" })).rejects.toMatchObject({ code: "not_found" });
  await db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, "reader"));
  for (const intent of ["send", "edit"] as const) await expect(mutateChat(db, "reader", slug, intent, { id: message.id, body: "Denied" })).rejects.toMatchObject({ code: "forbidden" });
  await markChatRead(db, "reader", slug, message.seq);
  await mutateChat(db, "reader", slug, "delete", { id: message.id });
  const own = await mutateChat(db, "author", slug, "send", { body: "Last message" });
  await db.update(villages).set({ endedAt: new Date() }).where(eq(villages.id, village.id));
  expect(await chatPage(db, "author", slug)).toMatchObject({ ended: true });
  for (const intent of ["send", "edit"] as const) await expect(mutateChat(db, "author", slug, intent, { id: own.id, body: "Denied" })).rejects.toMatchObject({ code: "ended" });
  await mutateChat(db, "author", slug, "delete", { id: own.id });
  await changeVillageMembership(db, "reader", slug, "leave");
  expect(await chatPage(db, "reader", slug)).toBeNull();
  await expect(markChatRead(db, "reader", slug, 1)).rejects.toMatchObject({ code: "not_found" });
  await expect(mutateChat(db, "reader", slug, "delete", { id: message.id })).rejects.toMatchObject({ code: "not_found" });
});

it("caps unread counts at 100, excludes own/hidden/deleted, and advances reads monotonically", async () => {
  const { db, slug, village } = await world();
  // Bulk fixtures exercise bounded scans without exceeding production send limits.
  await db.insert(chatMessages).values(Array.from({ length: 110 }, (_, i) => ({ villageId: village.id, authorId: "author", lang: "en", body: `Message ${i}`, createdSeq: i + 1, changedSeq: i + 1 })));
  await db.insert(chatSequences).values({ villageId: village.id, seq: 110 });
  const run = vi.spyOn(db, "select");
  expect((await chatUnreadCounts(db, "reader")).get(slug)).toBe(100);
  expect(run).toHaveBeenCalledTimes(1); run.mockRestore();
  expect((await chatUnreadCounts(db, "author")).get(slug)).toBe(0);
  await markChatRead(db, "reader", slug, 105); await markChatRead(db, "reader", slug, 1);
  expect((await chatUnreadCounts(db, "reader")).get(slug)).toBe(5);
  const [read] = await db.select().from(chatReads).where(eq(chatReads.userId, "reader")); expect(read.seq).toBe(105);
  await db.transaction(async tx => {
    await tx.select().from(chatMessages).where(eq(chatMessages.createdSeq, 106)).for("update");
    const changedSeq = await nextChatSequence(tx, village.id);
    await tx.update(chatMessages).set({ hiddenAt: new Date(), changedSeq }).where(eq(chatMessages.createdSeq, 106));
  });
  await mutateChat(db, "author", slug, "delete", { id: (await db.select().from(chatMessages).where(eq(chatMessages.createdSeq, 107)))[0].id });
  expect((await chatUnreadCounts(db, "reader")).get(slug)).toBe(3);
  expect((await chatChanges(db, "reader", slug, { since: 110 })).messages[0]).toMatchObject({ hidden: true, parts: [] });
  const hidden = (await chatPage(db, "reader", slug))!.messages.find(m => m.createdSeq === 106)!; expect(hidden).toMatchObject({ hidden: true, parts: [] });
  await markChatRead(db, "reader", slug, 99999);
  expect((await db.select().from(chatReads).where(eq(chatReads.userId, "reader")))[0].seq).toBe(110);
  const sent = await mutateChat(db, "reader", slug, "send", { body: "Read my send" });
  expect((await db.select().from(chatReads).where(eq(chatReads.userId, "reader")))[0].seq).toBe(110);
  expect((await chatUnreadCounts(db, "reader")).get(slug)).toBe(0);
});

it("paginates snapshots and changes without moving creation order on edits", async () => {
  const { db, slug, village } = await world();
  const rows = await db.insert(chatMessages).values(Array.from({ length: 120 }, (_, i) => ({ villageId: village.id, authorId: "author", lang: "en", body: `Message ${i}`, createdSeq: i + 1, changedSeq: i + 1 }))).returning();
  await db.insert(chatSequences).values({ villageId: village.id, seq: 120 });
  const latest = (await chatPage(db, "reader", slug))!;
  expect(latest.messages.map(m => m.createdSeq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 71)); expect(latest.before).toBe(71);
  const previous = (await chatPage(db, "reader", slug, { before: 71 }))!;
  expect(previous.messages[0].createdSeq).toBe(21); expect(previous.messages.at(-1)!.createdSeq).toBe(70);
  const around = (await chatPage(db, "reader", slug, { at: rows[59].id }))!;
  expect(around.messages.map(m => m.createdSeq)).toEqual(Array.from({ length: 51 }, (_, i) => i + 35));
  expect(await chatPage(db, "reader", slug, { at: "missing" })).toMatchObject({ targetUnavailable: true, messages: [] });
  const chunk = await chatChanges(db, "reader", slug, { since: 0 }); expect(chunk.next).toBe(100); expect(chunk.more).toBe(true); expect(chunk.messages).toHaveLength(100);
  const rest = await chatChanges(db, "reader", slug, { since: chunk.next }); expect(rest.next).toBe(120); expect(rest.more).toBe(false); expect(rest.messages).toHaveLength(20);
  const older = await chatChanges(db, "reader", slug, { since: 120, before: 110 }); expect(older.more).toBe(true); expect(older.messages).toHaveLength(50); expect(older.messages[0].createdSeq).toBe(60); expect(older.before).toBe(60);
  await mutateChat(db, "author", slug, "edit", { id: rows[0].id, body: "Edited first" });
  expect((await chatChanges(db, "reader", slug, { since: 120 })).messages[0]).toMatchObject({ createdSeq: 1, changedSeq: 121 });
  await mutateChat(db, "author", slug, "delete", { id: rows[59].id });
  expect(await chatPage(db, "reader", slug, { at: rows[59].id })).toMatchObject({ targetUnavailable: true, messages: [] });
});

it("closes signals after leave, removal, and village end, and never carries text", async () => {
  const { db, slug, village } = await world("invite_public");
  for (const operation of ["remove", "leave", "end"]) {
    if (operation !== "remove") await db.insert(villageMembers).values({ villageId: village.id, userId: "reader" }).onConflictDoNothing();
    await consentChatMembers(db);
    const response = villageChatEventStream(village.id, "reader", 0, new AbortController().signal);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: change\ndata: 0\n\n");
    signalVillageChat(village.id, 42);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: change\ndata: 42\n\n");
    if (operation === "remove") expect(await removeVillageMember(db, "author", slug, "chat_reader", "A reason")).toMatchObject({ ok: true });
    if (operation === "leave") expect(await changeVillageMembership(db, "reader", slug, "leave")).toBe(true);
    if (operation === "end") expect(await endVillage(db, "author", slug)).toMatchObject({ ok: true });
    expect((await reader.read()).done).toBe(true);
  }
});

it("does not query chat tables when disabled and cascades only village deletion", async () => {
  const { db, village } = await world();
  for (const [villagesFlag, chatFlag] of [["", ""], ["1", ""]]) {
    vi.stubEnv("VILLAGES", villagesFlag); vi.stubEnv("VILLAGE_CHAT", chatFlag);
    const select = vi.spyOn(db, "select");
    expect(await chatUnreadCounts(db, "reader")).toEqual(new Map()); expect(await chatPage(db, "reader", "chat-test")).toBeNull(); expect(select).not.toHaveBeenCalled(); select.mockRestore();
  }
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  await mutateChat(db, "author", "chat-test", "send", { body: "Survives profile deletion" });
  await db.delete(profiles).where(eq(profiles.userId, "author")); expect(await db.select().from(chatMessages)).toHaveLength(1);
  await db.delete(villages).where(eq(villages.id, village.id));
  for (const table of [chatMessages, chatSequences, chatReads]) expect(await db.select().from(table)).toHaveLength(0);
});

it("opens around unread messages outside the latest page while explicit targets and history keep priority", async () => {
  const { db, slug, village } = await world();
  const rows = await db.insert(chatMessages).values(Array.from({ length: 120 }, (_, i) => ({ villageId: village.id, authorId: "author", lang: "en", body: `Unread ${i + 1}`, createdSeq: i + 1, changedSeq: i + 1 }))).returning();
  await db.insert(chatSequences).values({ villageId: village.id, seq: 120 });
  await markChatRead(db, "reader", slug, 10);
  const unread = (await chatPage(db, "reader", slug, { unread: true }))!;
  expect(unread.messages.some(message => message.id === rows[10].id)).toBe(true);
  expect(unread.hasNewer).toBe(true);
  expect((await chatPage(db, "reader", slug, { unread: true, at: rows[90].id }))!.messages.some(message => message.id === rows[90].id)).toBe(true);
  expect((await chatPage(db, "reader", slug, { unread: true, before: 71 }))!.messages.at(-1)!.createdSeq).toBe(70);
  const newest = (await chatPage(db, "reader", slug, { unread: false }))!;
  expect(newest.messages.at(-1)!.createdSeq).toBe(120);
});


it.each(["own", "hidden", "deleted", "event"])("certifies the unread start across a %s-only prefix, but never for explicit windows", async kind => {
  const { db, slug, village } = await world();
  const rows = await db.insert(chatMessages).values(Array.from({ length: 61 }, (_, i) => ({
    villageId: village.id, authorId: kind === "own" && i === 10 ? "reader" : "author", lang: "en", body: kind === "deleted" && i === 10 ? "" : `Prefix ${i + 1}`,
    createdSeq: i + 1, changedSeq: i + 1,
    hiddenAt: kind === "hidden" && i === 10 ? new Date() : null,
    deletedAt: kind === "deleted" && i === 10 ? new Date() : null,
  })).filter(row => kind !== "event" || row.createdSeq !== 11)).returning();
  await db.insert(chatSequences).values({ villageId: village.id, seq: 61 });
  await markChatRead(db, "reader", slug, 10);
  const page = (await chatPage(db, "reader", slug, { unread: true }))!;
  expect(page.messages[0].createdSeq).toBe(12);
  expect(page).toMatchObject({ readSeq: 10, readFrom: 10, before: 12, hasNewer: false });
  for (const opts of [{ unread: false }, { unread: true, before: 61 }, { unread: true, after: 10 }, { unread: true, at: rows[20].id }, { unread: true, at: "missing" }]) {
    expect((await chatPage(db, "reader", slug, opts))!.readFrom).toBeNull();
  }
});

it.each(["append", "unhide", "unhide-only"])("withholds the unread certificate when %s moves the first unread outside the fetched window", async kind => {
  const { db, slug, village } = await world();
  const rows = await db.insert(chatMessages).values(Array.from({ length: kind === "append" ? 61 : 62 }, (_, i) => ({
    villageId: village.id, authorId: i === 10 || kind === "unhide-only" && i > 11 ? "reader" : "author",
    lang: "en", body: `Concurrent ${i + 1}`, createdSeq: i + 1, changedSeq: i + 1,
    hiddenAt: kind !== "append" && i === 11 ? new Date() : null,
  }))).returning();
  await db.insert(chatSequences).values({ villageId: village.id, seq: rows.length });
  await markChatRead(db, "reader", slug, 10);
  const client = (db as unknown as { $client: { query: (...args: unknown[]) => Promise<unknown> } }).$client;
  const run = client.query.bind(client);
  let changed = false;
  const spy = vi.spyOn(client, "query").mockImplementation(async (...args) => {
    const result = await run(...args);
    const input = args[0];
    const query = typeof input === "string" ? input : input && typeof input === "object" && "text" in input ? String(input.text) : "";
    if (!changed && query.startsWith('select "created_seq" from "chat_messages"') && query.includes(' desc limit ')) {
      changed = true;
      if (kind === "append") await mutateChat(db, "author", slug, "send", { body: "A message between the two latest queries" });
      else {
        await db.update(chatMessages).set({ hiddenAt: null, changedSeq: 63 }).where(eq(chatMessages.id, rows[11].id));
        await db.update(chatSequences).set({ seq: 63 }).where(eq(chatSequences.villageId, village.id));
      }
    }
    return result;
  });
  try {
    const page = (await chatPage(db, "reader", slug, { unread: true }))!;
    expect(changed).toBe(true);
    expect(page.messages[0].createdSeq).toBe(13);
    expect(page.messages.some(message => message.createdSeq === 12)).toBe(false);
    expect(page.readFrom).toBeNull();
  } finally { spy.mockRestore(); }
});

it("reads each continuation in creation order without marking unseen messages read or recounting other villages", async () => {
  const queries: string[] = [];
  const { db, slug, village } = await world("open", { logQuery: query => queries.push(query) });
  await db.insert(chatMessages).values(Array.from({ length: 120 }, (_, i) => ({ villageId: village.id, authorId: "author", lang: "en", body: `Continuation ${i + 1}`, createdSeq: i + 1, changedSeq: i + 1 })));
  await db.insert(chatSequences).values({ villageId: village.id, seq: 120 });
  await markChatRead(db, "reader", slug, 10);
  const first = (await chatPage(db, "reader", slug, { unread: true }))!;
  expect(first.messages.at(-1)!.createdSeq).toBe(36);
  expect(first.unreadAfter).toBe(84);
  queries.length = 0;
  const next = await chatChanges(db, "reader", slug, { since: 120, forward: 36 });
  expect(queries.filter(query => query.includes("capped") && query.includes('from "village_members"'))).toHaveLength(0);
  expect(next.messages.map(message => message.createdSeq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 37));
  expect(next).toMatchObject({ next: 120, hasNewer: true, unreadAfter: 34 });
  expect(next).not.toHaveProperty("unreadCounts");
  const last = await chatChanges(db, "reader", slug, { since: 120, forward: 86 });
  expect(last.messages.map(message => message.createdSeq)).toEqual(Array.from({ length: 34 }, (_, i) => i + 87));
  expect(last).toMatchObject({ hasNewer: false, unreadAfter: 0 });
  expect((await db.select().from(chatReads).where(eq(chatReads.userId, "reader")))[0].seq).toBe(10);
  const native = (await chatPage(db, "reader", slug, { after: 36, unread: true }))!;
  expect(native.messages.map(message => message.createdSeq)).toEqual(next.messages.map(message => message.createdSeq));
  expect(await chatPage(db, "reader", slug, { after: 999 })).toMatchObject({ hasNewer: false, unreadAfter: 0 });
  expect((await chatChanges(db, "reader", slug, { since: 120, counts: true })).unreadCounts).toMatchObject({ [slug]: 100 });
  expect(queries.filter(query => query.includes("capped") && query.includes('from "village_members"'))).toHaveLength(1);
  await expect(chatChanges(db, "outside", slug, { since: 0, forward: 36 })).rejects.toMatchObject({ code: "not_found" });
  expect(await chatPage(db, "outside", slug, { after: 36 })).toBeNull();
});


it("bounds both current-window unread scans before counting", async () => {
  const queries: string[] = [];
  const { db, village, slug } = await world("open", { logQuery(query) { queries.push(query); } });
  await db.insert(chatMessages).values(Array.from({ length: 250 }, (_, i) => ({ villageId: village.id, authorId: "author", lang: "en", body: `Many ${i}`, createdSeq: i + 1, changedSeq: i + 1 })));
  await db.insert(chatSequences).values({ villageId: village.id, seq: 250 });
  queries.length = 0;
  expect(await chatChanges(db, "reader", slug, { since: 250, after: 10 })).toMatchObject({ unread: 100, unreadAfter: 100 });
  const countQueries = queries.filter(query => /count\(\*\)/i.test(query));
  expect(countQueries.length).toBeGreaterThan(0);
  expect(countQueries.every(query => /limit/i.test(query))).toBe(true);
});
