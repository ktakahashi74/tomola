import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { entries, votes } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { setVote } from "~/lib/votes.server";
import { addMember } from "./helpers/db";
import { expectSettlesWithin, holdTx } from "./helpers/pg-concurrency";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";

describe.skipIf(!REAL_PG_URL)("vote visibility serialization", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb;
  beforeAll(async () => { scratch = await createScratchDb(); });
  afterAll(async () => { await scratch?.drop(); });
  it("allows independent voters to add and remove votes while another vote transaction remains open", async () => {
    const first = await scratch.open("vote-concurrent-first"), second = await scratch.open("vote-concurrent-second");
    await addMember(first, "concurrent-owner", "sec_concurrent_owner");
    await addMember(first, "concurrent-first", "sec_concurrent_first");
    await addMember(first, "concurrent-second", "sec_concurrent_second");
    const topic = await createTopic(first, "concurrent-owner", { title: "Concurrent votes", body: "Shared source", lang: "en" });
    if (!topic.ok) throw new Error(topic.error);
    const reply = await createReply(first, "concurrent-owner", topic.id, { body: "Concurrent reply votes", lang: "en" });
    if (!reply.ok) throw new Error(reply.error);
    // Topic votes already serialize on the listing counter. A reply has no
    // counter row, isolating the entry visibility/history lock from that wait.
    const entryId = reply.id;
    // Concurrent first reactions establish the latch before later votes share
    // their locks. Neither adding nor removing may rewrite an existing latch.
    expect(await Promise.all([setVote(first, "concurrent-first", entryId, true), setVote(second, "concurrent-second", entryId, true)])).toMatchObject([{ ok: true }, { ok: true }]);
    const [before] = await first.select({ started: entries.historyStartedAt }).from(entries).where(eq(entries.id, entryId));
    expect(before.started).not.toBeNull();
    for (const on of [false, true]) {
      const held = holdTx(first, tx => setVote(tx, "concurrent-first", entryId, on));
      await held.ready;
      try {
        expect(await expectSettlesWithin(setVote(second, "concurrent-second", entryId, on), 5_000, "independent vote")).toEqual({ ok: true, voted: on, changed: true });
      } finally { await held.rollback(); }
      expect(await setVote(first, "concurrent-first", entryId, on)).toEqual({ ok: true, voted: on, changed: true });
    }
    const [after] = await first.select({ started: entries.historyStartedAt }).from(entries).where(eq(entries.id, entryId));
    expect(after.started).toEqual(before.started);
    for (const on of [true, false]) {
      expect(await Promise.all([setVote(first, "concurrent-first", topic.id, on), setVote(second, "concurrent-second", topic.id, on)])).toMatchObject([
        { ok: true, voted: on, changed: true }, { ok: true, voted: on, changed: true },
      ]);
    }
  });
  it.each(["topic", "reply", "root"])("waits for a %s hide and rejects the vote after visibility changes", async target => {
    const writer = await scratch.open();
    const name = `vote-${target}`;
    const reader = await scratch.open(name);
    const admin = await scratch.admin();
    const owner = `owner-${target}`, voter = `voter-${target}`;
    await addMember(writer, owner, `sec_owner_${target}`);
    await addMember(writer, voter, `sec_voter_${target}`);
    const topic = await createTopic(writer, owner, { title: "Visibility race", body: "Topic body", lang: "en" });
    if (!topic.ok) throw new Error(topic.error);
    const reply = await createReply(writer, owner, topic.id, { body: "Reply body", lang: "en" });
    if (!reply.ok) throw new Error(reply.error);
    const entryId = target === "topic" ? topic.id : reply.id;
    const hiddenId = target === "reply" ? reply.id : topic.id;
    const hiding = holdTx(writer, tx => tx.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, hiddenId)));
    await hiding.ready;
    let settled = false;
    const voting = setVote(reader, voter, entryId, true).finally(() => { settled = true; });
    voting.catch(() => {});
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const result = await admin.query("select 1 from pg_stat_activity where datname = current_database() and application_name = $1 and wait_event_type = 'Lock'", [name]);
        if (result.rows.length) break;
        expect(settled, "vote bypassed the visibility lock").toBe(false);
        if (Date.now() >= deadline) throw new Error("Vote did not wait for the visibility update");
      }
      await hiding.commit();
      expect(await voting).toEqual({ ok: false, error: "not_found" });
      expect(await reader.select().from(votes).where(eq(votes.entryId, entryId))).toEqual([]);
    } finally { await hiding.rollback(); await voting.catch(() => {}); }
  });
  it("does not deadlock when a reply editor locks its topic first", async () => {
    const editor = await scratch.open("vote-edit-writer"), reader = await scratch.open("vote-edit-reader"), admin = await scratch.admin();
    await addMember(editor, "order-owner", "sec_order_owner");
    await addMember(editor, "order-voter", "sec_order_voter");
    const topic = await createTopic(editor, "order-owner", { title: "Lock order", body: "Topic", lang: "en" });
    if (!topic.ok) throw new Error(topic.error);
    const reply = await createReply(editor, "order-owner", topic.id, { body: "Reply", lang: "en" });
    if (!reply.ok) throw new Error(reply.error);
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const editing = editor.transaction(async tx => {
      await tx.select({ id: entries.id }).from(entries).where(eq(entries.id, topic.id)).for("no key update");
      locked(); await gate;
      await tx.update(entries).set({ body: "Edited while adding a related-topic reference" }).where(eq(entries.id, reply.id));
    });
    await ready;
    const voting = reader.transaction(tx => setVote(tx, "order-voter", reply.id, true));
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await admin.query("select 1 from pg_stat_activity where application_name = 'vote-edit-reader' and wait_event_type = 'Lock'");
        if (waiting.rows.length) break;
        if (Date.now() > deadline) throw new Error("Expected visibility writer wait");
      }
      release();
      expect(await voting).toMatchObject({ ok: true, voted: true });
      await editing;
    } finally { release(); await Promise.allSettled([editing, voting]); }
  });

});
