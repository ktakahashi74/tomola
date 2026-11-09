import { consentChatMembers } from "./helpers/chat-consent";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { chatMentions, chatSequences, notifications, profiles, villageMembers, villages } from "~/lib/db/schema";
import { chatChanges, mutateChat } from "~/lib/village-chat.server";
import { addMember } from "./helpers/db";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { expectPending, expectSettlesWithin, holdTx, waitForLockWait } from "./helpers/pg-concurrency";

describe.skipIf(!REAL_PG_URL)("chat mentions PostgreSQL lock and commit ordering", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb, index = 0;
  beforeAll(async () => { scratch = await createScratchDb(); }, 120_000);
  afterAll(async () => { await scratch?.drop(); }, 60_000);
  afterEach(async () => { vi.unstubAllEnvs(); await scratch?.closeOpened(); });
  async function world() {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
    const db = await scratch.open(), writer = `vcm_pg_writer${++index}`, target = `vcm_pg_target${index}`, other = `vcm_pg_other${index}`;
    for (const id of [writer, target, other]) await addMember(db, id, id);
    const [village] = await db.insert(villages).values({ slug: `mentions-pg-${index}`, kind: "open" }).returning();
    await db.insert(villageMembers).values([writer, target, other].map(userId => ({ villageId: village.id, userId })));
    await consentChatMembers(db);
    return { db, writer, target, other, village, slug: village.slug! };
  }

  it("creates bindings, deferred message references and queued mail without locking either profile", async () => {
    const { db, writer, target, slug } = await world();
    const held = holdTx(db, async tx => {
      for (const id of [writer, target]) await tx.select().from(profiles).where(eq(profiles.userId, id)).for("update");
    });
    await held.ready;
    try {
      const other = await scratch.open("mentions-profile-independent");
      const sent = await expectSettlesWithin(mutateChat(other, writer, slug, "send", { body: `@${target}` }), 2500, "mention send with locked author and recipient profiles");
      expect(sent.seq).toBe(1);
      expect(await other.select().from(notifications).where(eq(notifications.chatMessageId, sent.id))).toMatchObject([{ userId: target, kind: "chat_mention" }]);
      expect((await chatChanges(other, target, slug, { since: 0 })).messages[0].parts).toMatchObject([{ type: "mention", text: `@${target}` }]);
    } finally { await held.rollback(); }
  });

  it("does not lock an outside longer-name profile or notify the village member with the shorter prefix", async () => {
    const { db, writer, target, slug } = await world();
    const outside = `${target}-long`;
    await addMember(db, outside, outside);
    const held = holdTx(db, tx => tx.select().from(profiles).where(eq(profiles.userId, outside)).for("update"));
    await held.ready;
    try {
      const sender = await scratch.open("mentions-global-name-independent");
      const sent = await expectSettlesWithin(mutateChat(sender, writer, slug, "send", { body: `@${outside}` }), 2500, "global name lookup with an outside profile locked");
      expect(await sender.select().from(notifications).where(eq(notifications.chatMessageId, sent.id))).toEqual([]);
      expect(await sender.select().from(chatMentions).where(eq(chatMentions.messageId, sent.id))).toEqual([]);
      expect((await chatChanges(sender, target, slug, { since: 0 })).messages[0].parts).toEqual([{ type: "text", text: `@${outside}` }]);
    } finally { await held.rollback(); }
  });

  it("takes binding locks before the allocator so an independent message commits first", async () => {
    const { db, writer, target, other, slug } = await world();
    const initial = await mutateChat(db, writer, slug, "send", { body: `@${target}` });
    const held = holdTx(db, tx => tx.select().from(chatMentions).where(eq(chatMentions.messageId, initial.id)).for("update"));
    await held.ready;
    const editor = await scratch.open("mentions-edit-waiter");
    const editing = mutateChat(editor, writer, slug, "edit", { id: initial.id, body: `Edited @${target}` });
    try {
      await waitForLockWait(await scratch.admin(), "mentions-edit-waiter"); await expectPending(editing);
      const independent = await scratch.open("mentions-independent-send");
      const sent = await expectSettlesWithin(mutateChat(independent, other, slug, "send", { body: "Independent" }), 2500, "send while edit waits on bindings");
      expect(sent.seq).toBe(2);
      expect((await chatChanges(independent, target, slug, { since: 1 })).messages.map(message => message.changedSeq)).toEqual([2]);
    } finally { await held.commit(); }
    expect((await editing).seq).toBe(3);
    expect((await chatChanges(editor, target, slug, { since: 1 })).messages.map(message => message.changedSeq)).toEqual([2, 3]);
  });

  it("holds the target's membership through commit while waiting at the sequence horizon", async () => {
    const { db, writer, target, village, slug } = await world();
    await db.insert(chatSequences).values({ villageId: village.id });
    const held = holdTx(db, tx => tx.select().from(chatSequences).where(eq(chatSequences.villageId, village.id)).for("update"));
    await held.ready;
    const sender = await scratch.open("mentions-sequence-waiter");
    const sending = mutateChat(sender, writer, slug, "send", { body: `@${target}` });
    await waitForLockWait(await scratch.admin(), "mentions-sequence-waiter");
    const remover = await scratch.open("mentions-membership-waiter");
    const leaving = remover.delete(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, target))).execute();
    try {
      await waitForLockWait(await scratch.admin(), "mentions-membership-waiter"); await expectPending(leaving);
      expect((await chatChanges(remover, target, slug, { since: 0 })).messages).toEqual([]);
    } finally { await held.commit(); }
    expect((await sending).seq).toBe(1); await leaving;
    await expect(chatChanges(remover, target, slug, { since: 0 })).rejects.toMatchObject({ code: "not_found" });
  });
});
