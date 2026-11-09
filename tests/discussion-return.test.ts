import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { drafts, entries, notifications, profiles } from "~/lib/db/schema";
import { createReply, createTopic, softDeleteEntry } from "~/lib/entries.server";
import { setFollow } from "~/lib/follows.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  for (const handle of ["return_author", "return_reader", "return_writer"]) await h.signIn(handle, { homeArea: "en", readLangs: ["en"] });
});
afterAll(() => h.restore());

async function topic() {
  const result = await createTopic(h.db, h.ids.return_author, { lang: "en", title: "Returning to a discussion", body: "Topic body", asksStance: true });
  if (!result.ok) throw new Error(result.error);
  return result.id;
}
async function reply(threadId: number, parentId?: number) {
  const result = await createReply(h.db, h.ids.return_writer, threadId, { lang: "en", body: "Reply body", parentId });
  if (!result.ok) throw new Error(result.error);
  return result.id;
}
async function load(threadId: number, query = "", as?: string) {
  const { loader } = await import("~/routes/topic");
  return (await loader(h.args(h.request(`/t/${threadId}${query}`, { as }), { id: String(threadId) })));
}

it("uses the selected reply for posts and drafts ahead of pasted frontmatter, alongside a stance tag", async () => {
  const id = await topic();
  const a = await reply(id), b = await reply(id);
  const { action } = await import("~/routes/topic");
  for (const intent of ["reply", "draft"]) {
    const req = h.request(`/t/${id}?reply_to=c-${a}`, { as: "return_reader", form: {
      intent, parentId: String(a), lang: "en", stanceTag: "agree",
      body: `---\ntype: reply\nreply_to: c-${b}\n---\nSelected reply wins.`,
    } });
    const outcome = await h.outcome(() => action(h.args(req, { id: String(id) })));
    expect(outcome.status).toBe(302);
    const rows = intent === "reply"
      ? await h.db.select().from(entries).where(and(eq(entries.threadId, id), eq(entries.authorId, h.ids.return_reader)))
      : await h.db.select().from(drafts).where(eq(drafts.authorId, h.ids.return_reader));
    expect(rows.at(-1)).toMatchObject({ parentId: a, stanceTag: "agree", body: "Selected reply wins." });
  }
});

it("clears an explicit form target and preserves every question tag with a selected parent", async () => {
  const id = await topic(), parent = await reply(id);
  expect((await load(id, "?reply_to=", "return_reader")).replyToTopic).toBe(true);
  const { action } = await import("~/routes/topic");
  for (const stanceTag of ["agree", "disagree", "neither", "objection"]) {
    const outcome = await h.outcome(() => action(h.args(h.request(`/t/${id}`, { as: "return_reader", form: {
      parentId: String(parent), lang: "en", stanceTag, body: `Tagged selected parent: ${stanceTag}`,
    } }), { id: String(id) })));
    expect(outcome.status).toBe(302);
    expect((await h.db.select().from(entries).where(eq(entries.body, `Tagged selected parent: ${stanceTag}`)))[0]).toMatchObject({ parentId: parent, stanceTag });
  }
  const outcome = await h.outcome(() => action(h.args(h.request(`/t/${id}`, { as: "return_reader", form: {
    parentId: "", lang: "en", body: `---\ntype: reply\nreply_to: c-${parent}\n---\nA reply to the topic.`,
  } }), { id: String(id) })));
  expect(outcome.status).toBe(302);
  expect((await h.db.select().from(entries).where(eq(entries.body, "A reply to the topic.")))[0].parentId).toBeNull();
});

it("rejects missing, cross-topic, deleted, hidden and malformed form targets for both posts and drafts", async () => {
  const id = await topic(), other = await topic();
  const cross = await reply(other), deleted = await reply(id), hidden = await reply(id);
  await softDeleteEntry(h.db, deleted);
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, hidden));
  const { action } = await import("~/routes/topic");
  for (const parentId of [String(cross), String(deleted), String(hidden), "999999999", "NaN", "0", "1.5"]) {
    for (const intent of ["reply", "draft"]) {
      const outcome = await h.outcome(() => action(h.args(h.request(`/t/${id}`, { as: "return_reader", form: { intent, parentId, lang: "en", body: "Keep this input." } }), { id: String(id) })));
      expect(outcome).toMatchObject({ status: 400, value: { data: { error: "parent_not_in_thread", input: { body: "Keep this input." } } } });
    }
  }
});

it("links to visible parents with handles and withholds identities for unavailable parents and redacted children", async () => {
  const id = await topic(), first = await reply(id);
  // Hidden/deleted replies occupy pagination positions too.
  await h.db.insert(entries).values(Array.from({ length: 100 }, () => ({ kind: "reply", threadId: id, authorId: h.ids.return_writer, lang: "en", body: "Pagination fixture" })));
  const parent = await reply(id), child = await reply(id, parent);
  const screen = await load(id, `?page=2&reply_to=c-${first}`, "return_reader");
  expect(screen.replyTarget).toMatchObject({ id: first, handle: "return_writer", href: `/t/${id}#c-${first}` });
  expect(screen.replies.find(r => r.id === child)).toMatchObject({ parent: { state: "visible", authorHandle: "return_writer", href: `/t/${id}?page=2#c-${parent}` } });
  const parentData = screen.replies.find(r => r.id === child)!;
  expect("parent" in parentData && Object.keys(parentData.parent!).sort()).toEqual(["authorHandle", "href", "state"]);
  expect(parentData).not.toHaveProperty("replyCount");
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, parent));
  expect((await load(id, "?page=2", "return_reader")).replies.find(r => r.id === child)).toMatchObject({ parent: { state: "unavailable" } });
  const hiddenChild = (await load(id, `?page=2&reply_to=c-${parent}`, "return_reader")).replies.find(r => r.id === child)!;
  expect("parent" in hiddenChild && hiddenChild.parent).toEqual({ state: "unavailable" });
  expect((await load(id, `?reply_to=c-${parent}`, "return_reader")).replyTarget).toEqual({ id: parent, href: null, handle: null });
  await softDeleteEntry(h.db, parent);
  expect((await load(id, "?page=2", "return_reader")).replies.find(r => r.id === child)).toMatchObject({ parent: { state: "deleted" } });
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, child));
  expect((await load(id, "?page=2", "return_reader")).replies.find(r => r.id === child)).toEqual({ id: child, placeholder: "hidden" });
  await softDeleteEntry(h.db, child);
  const deleted = await load(id, "?page=2", "return_reader");
  expect(deleted.replies.find(r => r.id === child)).toBeUndefined();
  expect(deleted.replies.find(r => r.id === parent)).toBeUndefined();
});

it("keeps the first unread reply through merging and shares its destination with the following card, falling back safely", async () => {
  const id = await topic();
  await setFollow(h.db, h.ids.return_reader, id, true);
  const first = await reply(id), last = await reply(id);
  const [row] = await h.db.select().from(notifications).where(and(eq(notifications.userId, h.ids.return_reader), eq(notifications.threadId, id), eq(notifications.kind, "followed_thread")));
  expect(row).toMatchObject({ firstEntryId: first, entryId: last, mergedCount: 2 });
  const { loader: notify } = await import("~/routes/notifications");
  const { loader: following } = await import("~/routes/following");
  const current = async () => {
    const notice = (await notify(h.args(h.request("/notifications", { as: "return_reader" })))).items.find(n => n.id === row.id)!;
    const card = (await following(h.args(h.request("/following?all=1", { as: "return_reader" })))).topics.find(t => t.id === id)!;
    return { notice, card };
  };
  let result = await current();
  expect(result.notice.href).toBe(`/t/${id}#c-${first}`);
  expect(result.card.newReplies).toEqual({ count: 2, href: result.notice.href });
  await softDeleteEntry(h.db, first);
  result = await current();
  expect(result.notice.href).toBe(`/t/${id}#c-${last}`);
  expect(result.card.newReplies?.href).toBe(result.notice.href);
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, last));
  result = await current();
  expect(result.notice.href).toBe(`/t/${id}`);
  expect(result.card.newReplies?.href).toBe(result.notice.href);
  await load(id, "", "return_reader");
  expect((await current()).card.newReplies).toBeNull();
  const next = await reply(id);
  const unread = await h.db.select().from(notifications).where(and(eq(notifications.userId, h.ids.return_reader), eq(notifications.entryId, next)));
  expect(unread).toMatchObject([{ firstEntryId: next, mergedCount: 1, readAt: null }]);
});

it("binds a signature's preview and published reply to the form's selected parent", async () => {
  const id = await topic(), first = await reply(id), second = await reply(id);
  await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, h.ids.return_reader));
  try {
    const { action } = await import("~/routes/topic");
    const args = await h.signedArgs(h.request(`/t/${id}`, { as: "return_reader", form: {
      parentId: String(first), lang: "en", body: `---\ntype: reply\nreply_to: c-${second}\n---\nSigned selected target.`,
    } }), { id: String(id) });
    expect(await h.outcome(() => action(args))).toMatchObject({ status: 302 });
    expect((await h.db.select().from(entries).where(eq(entries.body, "Signed selected target.")))[0]).toMatchObject({ parentId: first });
  } finally {
    await h.db.update(profiles).set({ signPosts: false }).where(eq(profiles.userId, h.ids.return_reader));
  }
});
