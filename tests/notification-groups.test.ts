import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { entries, notifications, translations } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { groupThreadNotifications } from "~/lib/group-thread-notifications";
import { countUnreadNotifications, hasUnreadFollowedThread, listNotifications, markThreadNotificationsRead } from "~/lib/notifications.server";
import { addMember, createTestDb } from "./helpers/db";

const item = (id: number, over: Partial<Parameters<typeof groupThreadNotifications>[0][number]> = {}) => ({ id, kind: "reply_to_topic", read: false, threadId: 1, entryId: id + 100, unavailable: false, actorHandle: `u${id}`, ...over });

describe("notices about one post", () => {
  it("are one row while unread, standing in the place of the newest and opening at the oldest", () => {
    const rows = groupThreadNotifications([item(9), item(8, { kind: "mention" }), item(7, { threadId: 2 }), item(6, { kind: "followed_thread" })]);
    expect(rows.map(row => [row.id, row.threadSize, row.threadOldestId, row.threadHandles])).toEqual([[9, 3, 6, ["u9", "u8", "u6"]], [7, 1, 7, ["u7"]]]);
  });
  it("say whether the people mentioned or replied, and keep a row with nobody named", () => {
    expect(groupThreadNotifications([item(3, { kind: "mention" }), item(2, { kind: "mention" })])[0].threadMentionsOnly).toBe(true);
    expect(groupThreadNotifications([item(3, { kind: "mention" }), item(2)])[0].threadMentionsOnly).toBe(false);
    expect(groupThreadNotifications([item(3, { kind: "followed_thread", actorHandle: null }), item(2, { kind: "followed_thread", actorHandle: null })])[0].threadHandles).toEqual([]);
  });
  it("keeps each report result separate from other results and reply activity", () => {
    const rows = groupThreadNotifications([item(5, { kind: "translation_report_result" }), item(4), item(3, { kind: "translation_report_result" }), item(2)]);
    expect(rows.map(row => [row.id, row.threadSize])).toEqual([[5, 1], [4, 2], [3, 1]]);
  });
  it("stay one by one when read, when the post cannot be shown, and for other kinds", () => {
    const rows = groupThreadNotifications([item(5, { read: true }), item(4, { read: true }), item(3, { unavailable: true }), item(2, { unavailable: true }), item(1, { kind: "moderation" })]);
    expect(rows.map(row => row.threadSize)).toEqual([1, 1, 1, 1, 1]);
  });
});

describe("the bell counts only what is addressed to the member", () => {
  it("leaves out a new reply in a followed post, which is a dot; opening a grouped row reads them all", async () => {
    const db = await createTestDb();
    for (const [id, handle] of [["alice", "alice"], ["bob", "bob"], ["carol", "carol"]]) await addMember(db, id, handle);
    const topic = await createTopic(db, "alice", { lang: "ja", title: "話題", body: "本文" });
    if (!topic.ok) throw new Error("topic failed");
    const mine = await createReply(db, "bob", topic.id, { lang: "ja", body: "alice へ。\n二行目" });
    if (!mine.ok) throw new Error("reply failed");
    // carol follows the topic through a reply; bob's later reply is a new reply in a followed post for her.
    await createReply(db, "carol", topic.id, { lang: "ja", body: "carol の返信" });
    const later = await createReply(db, "bob", topic.id, { lang: "ja", body: "carol が見る返信" });
    if (!later.ok) throw new Error("reply failed");
    expect(await countUnreadNotifications(db, "alice")).toBe(3);
    expect(await countUnreadNotifications(db, "carol")).toBe(0);
    expect(await hasUnreadFollowedThread(db, "carol")).toBe(true);
    const listed = await listNotifications(db, "alice", { excerpts: true, display: { readLangs: ["ja"], displayLang: "ja" } });
    expect(listed.items.map(row => [row.excerpt, row.entryLang])).toEqual([["carol が見る返信", "ja"], ["carol の返信", "ja"], ["alice へ。", "ja"]]);
    expect(await markThreadNotificationsRead(db, "alice", topic.id)).toBe(3);
    expect(await countUnreadNotifications(db, "alice")).toBe(0);
    expect((await db.select().from(notifications).where(eq(notifications.userId, "carol"))).every(row => row.readAt === null)).toBe(true);
  });
});

describe("the excerpt of a notification", () => {
  it("is marked with the language it is written in: the reader's own for a translation, the original's otherwise", async () => {
    const db = await createTestDb();
    for (const handle of ["alice", "bob"]) await addMember(db, handle, handle);
    const topic = await createTopic(db, "alice", { lang: "ja", title: "話題", body: "本文" });
    if (!topic.ok) throw new Error("topic failed");
    const reply = await createReply(db, "bob", topic.id, { lang: "en", body: "A reply in English." });
    if (!reply.ok) throw new Error("reply failed");
    const options = { excerpts: true, display: { readLangs: ["ja" as const], displayLang: "ja" as const } };
    const original = (await listNotifications(db, "alice", options)).items[0];
    expect([original.excerpt, original.excerptLang, original.entryLang]).toEqual(["A reply in English.", "en", "en"]);
    const [stored] = await db.select({ sourceHash: entries.sourceHash }).from(entries).where(eq(entries.id, reply.id));
    await db.insert(translations).values({ entryId: reply.id, field: "body", lang: "ja", kind: "primary", text: "日本語の返信。", sourceHash: stored.sourceHash });
    const translated = (await listNotifications(db, "alice", options)).items[0];
    expect([translated.excerpt, translated.excerptLang, translated.entryLang]).toEqual(["日本語の返信。", "ja", "en"]);
  });
});
