import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { entries } from "~/lib/db/schema";
import { checkPagination } from "~/lib/pagination";
import { NO_SCOPE } from "~/lib/roles.server";
import { readThreadReplyPage, replyPagesOf } from "~/lib/thread-page.server";
import { addMember, createTestDb } from "./helpers/db";

it("retains reply slots across page boundaries and applies visibility after paging", async () => {
  const db = await createTestDb();
  const authorId = "page_author";
  await addMember(db, authorId, authorId);
  const post = { authorId, lang: "en" as const, body: "Page fixture" };
  const [{ id: threadId }] = await db.insert(entries).values({ ...post, kind: "topic" }).returning({ id: entries.id });
  const early = new Date("2026-10-01T00:00:00Z");
  const late = new Date("2026-10-01T00:00:01Z");
  const reply = { ...post, kind: "reply" as const, threadId, stanceTag: "agree" as const };
  const [{ id: child }, { id: omitted }, { id: parent }, { id: visible }, { id: otherStance }] = await db.insert(entries).values([
    { ...reply, createdAt: late, hiddenAt: late },
    { ...reply, createdAt: early, deletedAt: late },
    { ...reply, createdAt: early, deletedAt: late },
    { ...reply, createdAt: late },
    { ...reply, createdAt: late, stanceTag: "disagree" },
  ]).returning({ id: entries.id });
  await db.update(entries).set({ parentId: parent }).where(eq(entries.id, child));

  const limit = 2;
  const targets = [child, omitted, parent, visible, otherStance].map(id => ({ id, threadId }));
  const read = (page: number, opts?: Parameters<typeof readThreadReplyPage>[4]) =>
    readThreadReplyPage(db, threadId, checkPagination({ page, limit }), { kind: entries.kind }, opts);
  const positions = ({ replies }: Awaited<ReturnType<typeof read>>) => replies.map(row => [row.id, row.visibility]);
  const first = await read(1);
  expect(first.replyTotal).toBe(5);
  expect(positions(first)).toEqual([[parent, "deleted"]]);
  const second = await read(2);
  expect(positions(second)).toEqual([[child, "hidden-redacted"], [visible, "visible"]]);
  const pages = await replyPagesOf(db, targets, { limit });
  for (const { id } of first.replies) expect(pages.get(id)).toBe(1);
  for (const { id } of second.replies) expect(pages.get(id)).toBe(2);
  expect(pages.get(omitted)).toBe(1);
  expect(positions(await read(2, { viewer: { userId: authorId, scope: NO_SCOPE } }))).toEqual([[child, "hidden"], [visible, "visible"]]);
  expect(positions(await read(3))).toEqual([[otherStance, "visible"]]);
  expect(await read(4)).toEqual({ replyTotal: 5, replies: [] });
  const stance = { stanceTag: "agree" } as const;
  const filtered = await read(1, stance);
  expect(filtered.replyTotal).toBe(1);
  expect(positions(filtered)).toEqual([[visible, "visible"]]);
  expect(await replyPagesOf(db, targets, { ...stance, limit })).toEqual(
    new Map(filtered.replies.map(({ id }) => [id, 1])),
  );
  expect(await read(1, { stanceTag: "neither" })).toEqual({ replyTotal: 0, replies: [] });
  await db.update(entries).set({ deletedAt: late }).where(eq(entries.id, child));
  expect(await read(1)).toEqual({ replyTotal: 5, replies: [] });
  expect(positions(await read(2))).toEqual([[visible, "visible"]]);
});
