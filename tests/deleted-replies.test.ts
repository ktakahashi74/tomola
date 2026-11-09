import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries } from "~/lib/db/schema";
import { createReply, createTopic, getThread, replyLocation, replyPage, softDeleteEntry } from "~/lib/entries.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import { buildThreadMarkdown } from "~/lib/md/thread.server";
import { followedThreadHrefs, loadLatestReplyLocations } from "~/lib/reply-locations.server";
import { exportSite } from "~/lib/site-export.server";
import { addMember, createTestDb } from "./helpers/db";
import { parseThreadBlocks } from "./helpers/md";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
  await addMember(db, "writer", "writer");
});
const must = (result: { ok: true; id: number } | { ok: false; error: string }) => {
  if (!result.ok) throw new Error(result.error);
  return result.id;
};
const topic = async () => must(await createTopic(db, "writer", { lang: "ja", title: "返信の跡", body: "本文" }));
const reply = async (threadId: number, parentId?: number) => must(await createReply(db, "writer", threadId, { lang: "ja", body: "PRIVATE-REPLY-BODY", parentId }));
async function markdown(threadId: number, page = 1) {
  const text = await buildThreadMarkdown(db, threadId, { page, lang: "all", sentences: true, k: null });
  if (text === null) throw new Error("missing Markdown thread");
  return parseThreadBlocks(text);
}
async function sameOrder(threadId: number, expected: number[], page = 1) {
  const screen = (await getThread(db, threadId, { page }))!;
  const blocks = await markdown(threadId, page);
  expect(screen.replies.map(row => row.id)).toEqual(expected);
  expect(blocks.filter(block => block.fm.type === "comment").map(block => block.fm.id)).toEqual(expected.map(id => `c-${id}`));
  expect(blocks.at(-1)!.fm).toMatchObject({ page, page_count: screen.pageCount });
  return { screen, blocks };
}

describe("deleted reply placeholders", () => {
  it("omits an unreferenced deletion, keeps its database row and pagination slot, and preserves hidden placeholders", async () => {
    const t = await topic(), gone = await reply(t), hidden = await reply(t);
    await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, hidden));
    await softDeleteEntry(db, gone);
    const { screen } = await sameOrder(t, [hidden]);
    expect(screen).toMatchObject({ replyCount: 1, replyTotal: 2, pageCount: 1 });
    expect(screen.replies[0]).toMatchObject({ visibility: "hidden-redacted", body: "", authorId: "" });
    const [saved] = await db.select().from(entries).where(eq(entries.id, gone));
    expect(saved.deletedAt).toBeInstanceOf(Date);
    expect(saved.body).toBe("PRIVATE-REPLY-BODY");
    await softDeleteEntry(db, t);
    expect(await getThread(db, t)).toBeNull();
    expect(await buildThreadMarkdown(db, t, { page: 1, lang: null, sentences: false, k: null })).toBeNull();
  });

  it.each([false, true])("retains a redacted parent while its child is undeleted (hidden child: %s)", async hidden => {
    const t = await topic(), parent = await reply(t), child = await reply(t, parent);
    if (hidden) await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, child));
    await softDeleteEntry(db, parent);
    const { screen, blocks } = await sameOrder(t, [parent, child]);
    expect(screen.replies[0]).toMatchObject({ visibility: "deleted", body: "", html: "", authorId: "", authorHandle: "", title: null });
    expect(screen.replies[0]).not.toHaveProperty("hasUndeletedChild");
    const parentBlock = blocks.find(block => block.fm.id === `c-${parent}`)!;
    expect(parentBlock.fm).toEqual({ type: "comment", id: `c-${parent}`, thread: `p-${t}`, reply_to: `p-${t}`, deleted: true, content_trust: "untrusted_user_content" });
    expect(parentBlock.body).toBe("");
    expect(blocks.find(block => block.fm.id === `c-${child}`)!.fm.reply_to).toBe(`c-${parent}`);
    await softDeleteEntry(db, child);
    expect((await sameOrder(t, [])).screen).toMatchObject({ replyCount: 0, replyTotal: 2, pageCount: 1 });
  });

  it("counts direct undeleted children rather than undeleted descendants in a deletion chain", async () => {
    const t = await topic(), a = await reply(t), b = await reply(t, a), c = await reply(t, b);
    await softDeleteEntry(db, a);
    await sameOrder(t, [a, b, c]);
    await softDeleteEntry(db, b);
    await sameOrder(t, [b, c]);
    await softDeleteEntry(db, c);
    await sameOrder(t, []);
  });

  it("keeps page boundaries and destinations while finding a child on another page", async () => {
    const t = await topic(), base = Date.parse("2026-10-01T00:00:00Z");
    const rows = await db.insert(entries).values(Array.from({ length: 105 }, (_, i) => ({
      kind: "reply", threadId: t, authorId: "writer", lang: "ja", body: `返信${i}`, html: `<p>返信${i}</p>`, htmlVersion: RENDER_VERSION,
      createdAt: new Date(base + i * 1000), updatedAt: new Date(base + i * 1000),
    }))).returning({ id: entries.id });
    const ids = rows.map(row => row.id), last = ids[104];
    await db.update(entries).set({ parentId: ids[0] }).where(eq(entries.id, ids[100]));
    await db.update(entries).set({ replyCount: 105 }).where(eq(entries.id, t));
    const destinations = async () => ({
      latest: (await loadLatestReplyLocations(db, [t])).get(t),
      notification: (await followedThreadHrefs(db, [{ id: 1, threadId: t, entryId: last, firstEntryId: last }])).get(1),
      reply: await replyLocation(db, t, last),
      childPage: await replyPage(db, t, ids[100]),
    });
    const before = await destinations();
    await sameOrder(t, ids.slice(0, 100));
    await sameOrder(t, ids.slice(100), 2);
    for (const i of [0, 1, 98, 101]) await softDeleteEntry(db, ids[i]);
    const first = await sameOrder(t, ids.slice(0, 100).filter((_, i) => i !== 1 && i !== 98));
    const second = await sameOrder(t, ids.slice(100).filter((_, i) => i !== 1), 2);
    expect(first.screen).toMatchObject({ replyTotal: 105, replyCount: 101, pageCount: 2 });
    expect(first.screen.replies[0].visibility).toBe("deleted");
    expect(second.screen.replies[0].id).toBe(ids[100]);
    expect(second.blocks[0].fm.canonical).toMatch(new RegExp(`/t/${t}\\?page=2#c-${ids[100]}$`));
    expect(await destinations()).toEqual(before);
    expect(before).toMatchObject({ latest: { id: last, page: 2 }, reply: `/t/${t}?page=2#c-${last}`, childPage: 2 });
    await softDeleteEntry(db, ids[100]);
    expect((await getThread(db, t))!.replies.map(row => row.id)).not.toContain(ids[0]);
    expect((await getThread(db, t))!.pageCount).toBe(2);
  });

  it("exports the same retained placeholders in HTML and Markdown, including hidden children", async () => {
    const t = await topic(), unused = await reply(t), parent = await reply(t), child = await reply(t, parent);
    const hiddenParent = await reply(t), hiddenChild = await reply(t, hiddenParent), hiddenAlone = await reply(t);
    for (const id of [hiddenChild, hiddenAlone]) await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, id));
    for (const id of [unused, parent, hiddenParent]) await softDeleteEntry(db, id);
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "deleted-replies-export-")), out = path.join(temporary, "export");
    try {
      const check = async (expected: number[]) => {
        await sameOrder(t, expected);
        await exportSite(db, { outDir: out, langs: ["ja", "en"] });
        for (const lang of ["ja", "en"]) {
          for (const extension of ["html", "md"]) {
            const text = await fs.readFile(path.join(out, lang, "t", `${t}.${extension}`), "utf8");
            expect([...text.matchAll(/id="c-(\d+)"/g)].map(match => Number(match[1]))).toEqual(expected);
            expect(text).not.toContain(`id="c-${unused}"`);
          }
        }
      };
      await check([parent, child, hiddenParent, hiddenChild, hiddenAlone]);
      for (const id of [child, hiddenChild]) await softDeleteEntry(db, id);
      await check([hiddenAlone]);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
});
