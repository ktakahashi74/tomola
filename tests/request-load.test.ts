import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getAuth } from "~/lib/auth/auth.server";
import { getReader, getSessionUser, requireMember, requireWriter } from "~/lib/auth/session.server";
import { withMarkdownScope } from "~/lib/markdown-budget.server";
import { markdownFixture } from "./helpers/markdown-fixture";
import { entries, notifications, rateLimits, entryMentionSnapshots } from "~/lib/db/schema";
import { countUnreadNotifications } from "~/lib/notifications.server";
import { hitBrowserReadLimit } from "~/lib/rate-limit.server";
import { loadReplyParents } from "~/lib/reply-branches.server";
import { createReply, createTopic, editEntry } from "~/lib/entries.server";
import { addMember } from "./helpers/db";
import * as markdown from "~/lib/markdown.server";
import { prepareEntryRender, sameMentionRender, withEntryRender } from "~/lib/entry-render-preparation.server";
import { createDraft, publishDraft } from "~/lib/drafts.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("load_reader"); });
afterAll(() => h.restore());

it("reloads shared navigation after a one-tap action redirects to another URL", async () => {
  const routes = await Promise.all([import("~/root"), import("~/routes/member-layout"), import("~/routes/topic")]);
  for (const { shouldRevalidate } of routes) for (const formAction of ["/vote", "/stance", "/follow"]) {
    const args = { formAction, currentUrl: new URL("http://localhost/t/1"), nextUrl: new URL("http://localhost/t/1"), defaultShouldRevalidate: true };
    expect(shouldRevalidate(args as never)).toBe(false);
    expect(shouldRevalidate({ ...args, nextUrl: new URL("http://localhost/suspended") } as never)).toBe(true);
    expect(shouldRevalidate({ ...args, nextUrl: new URL("http://localhost/t/1?notice=denied") } as never)).toBe(true);
    expect(shouldRevalidate({ ...args, formAction: "/notifications" } as never)).toBe(true);
    expect(shouldRevalidate({ ...args, defaultShouldRevalidate: false } as never)).toBe(false);
  }
});

it("restores the member's rendering budget in every loader context consuming cached auth", async () => {
  const request = h.request("/t/1", { as: "load_reader" });
  const gates = [getReader, requireMember, requireWriter, getSessionUser];
  await withMarkdownScope("read", undefined, async () => { for (const gate of gates) await gate(request); });
  const fixture = markdownFixture();
  const pool = fixture.executor({ readWaitMs: 25 });
  const held = fixture.marker("cached-auth");
  await pool.run("echo", ["Warm cached auth"]);
  const active = withMarkdownScope("read", h.ids.load_reader, () => pool.run("hold", [held]));
  try {
    await fixture.started(held);
    for (const [i, gate] of gates.entries()) {
      await expect(withMarkdownScope("read", undefined, async () => {
        await gate(request);
        return pool.run("echo", [`Another loader ${i}`]);
      })).rejects.toMatchObject({ status: 503 });
    }
  } finally { fixture.release(held); await active; await pool.stop(); fixture.remove(); }
});

it("shares session and membership resolution across the loaders of one request", async () => {
  vi.stubEnv("PUBLIC_READING", "1");
  const auth = await getAuth();
  const spy = vi.spyOn(auth.api, "getSession");
  try {
    const made = await createTopic(h.db, h.ids.load_reader, { lang: "ja", body: "A session read" });
    if (!made.ok) throw new Error(made.error);
    const request = h.request(`/t/${made.id}`, { as: "load_reader" });
    const readers = await Promise.all([getReader(request), getReader(request), requireMember(request)]);
    expect(readers.every(r => r.user?.id === h.ids.load_reader)).toBe(true);
    const [layout, topic] = await Promise.all([import("~/routes/member-layout"), import("~/routes/topic")]);
    await Promise.all([layout.loader(h.args(request)), topic.loader(h.args(request, { id: String(made.id) }))]);
    expect(spy).toHaveBeenCalledTimes(1);
    await getReader(h.request("/t/1", { as: "load_reader" }));
    expect(spy).toHaveBeenCalledTimes(2);
  } finally { spy.mockRestore(); vi.unstubAllEnvs(); }
});

it("browser reads never persist counters in the database", async () => {
  const before = await h.db.select().from(rateLimits);
  const request = h.request("/t/1", { as: "load_reader" });
  const results = await Promise.all([hitBrowserReadLimit(h.db, request, h.ids.load_reader), hitBrowserReadLimit(h.db, request, h.ids.load_reader)]);
  expect(results[0]).toBe(results[1]);
  expect(await h.db.select().from(rateLimits)).toEqual(before);
});

it("caps unread counts at 100 while retaining mark-read semantics", async () => {
  await h.db.insert(notifications).values(Array.from({ length: 130 }, () => ({ userId: h.ids.load_reader, kind: "reply_to_topic" })));
  expect(await countUnreadNotifications(h.db, h.ids.load_reader)).toBe(100);
  await h.db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.userId, h.ids.load_reader));
  expect(await countUnreadNotifications(h.db, h.ids.load_reader)).toBe(0);
});

it("loads only displayed replies and their ancestors, including withheld ancestors", async () => {
  const [topic] = await h.db.insert(entries).values({ kind: "topic", authorId: h.ids.load_reader, lang: "ja", body: "t" }).returning();
  const [root] = await h.db.insert(entries).values({ kind: "reply", threadId: topic.id, authorId: h.ids.load_reader, lang: "ja", body: "root", deletedAt: new Date() }).returning();
  const [child] = await h.db.insert(entries).values({ kind: "reply", threadId: topic.id, parentId: root.id, authorId: h.ids.load_reader, lang: "ja", body: "child" }).returning();
  await h.db.insert(entries).values({ kind: "reply", threadId: topic.id, authorId: h.ids.load_reader, lang: "ja", body: "unrelated" });
  const parents = await loadReplyParents(h.db, topic.id, [child.id]);
  expect(parents.map(r => r.id).sort((a, b) => a - b)).toEqual([root.id, child.id]);
  expect(await loadReplyParents(h.db, topic.id, [])).toEqual([]);
});

it("renders new topics, replies and language corrections before opening the write transaction", async () => {
  const transaction = h.db.transaction.bind(h.db);
  let inside = false;
  const txSpy = vi.spyOn(h.db, "transaction").mockImplementation(async (work, config) => transaction(async tx => {
    inside = true;
    try { return await work(tx); } finally { inside = false; }
  }, config));
  const topicRender = markdown.renderEntryOrPlain, replyRender = markdown.renderMarkdownResult;
  const observed: boolean[] = [];
  const a = vi.spyOn(markdown, "renderEntryOrPlain").mockImplementation((...args) => { observed.push(inside); return topicRender(...args); });
  const b = vi.spyOn(markdown, "renderMarkdownResult").mockImplementation((...args) => { observed.push(inside); return replyRender(...args); });
  try {
    const topic = await createTopic(h.db, h.ids.load_reader, { lang: "ja", body: "a[^x]\n\n[^x]: note" });
    if (!topic.ok) throw new Error(topic.error);
    expect(await createReply(h.db, h.ids.load_reader, topic.id, { lang: "ja", body: "reply" })).toMatchObject({ ok: true });
    expect(await editEntry(h.db, h.ids.load_reader, topic.id, { title: null, body: "a[^x]\n\n[^x]: note", lang: "en" })).toMatchObject({ ok: true });
    const [saved] = await h.db.select().from(entries).where(eq(entries.id, topic.id));
    expect(saved.lang).toBe("en");
    expect(saved.html).toContain("Footnotes");
    expect(saved.html).not.toContain("脚注");
    expect(observed.length).toBeGreaterThanOrEqual(3);
    expect(observed).not.toContain(true);
  } finally { txSpy.mockRestore(); a.mockRestore(); b.mockRestore(); }
});

it("counts the header after acknowledging this topic even when both loaders start together", async () => {
  const made = await createTopic(h.db, h.ids.load_reader, { lang: "ja", body: "Read acknowledgement" });
  if (!made.ok) throw new Error(made.error);
  await h.db.insert(notifications).values([
    { userId: h.ids.load_reader, kind: "followed_thread", threadId: made.id, entryId: made.id },
    { userId: h.ids.load_reader, kind: "reply_to_topic", threadId: made.id },
  ]);
  const request = h.request(`/t/${made.id}.data`, { as: "load_reader" });
  const [layout, topic] = await Promise.all([import("~/routes/member-layout"), import("~/routes/topic")]);
  const [navigation] = await Promise.all([layout.loader(h.args(request)), topic.loader(h.args(request, { id: String(made.id) }))]);
  expect(navigation).toMatchObject({ unreadNotifications: 1 });
});

it("renders the edited draft form once before its signed publication transaction", async () => {
  const draft = await createDraft(h.db, h.ids.load_reader, { kind: "topic", body: "Saved body", lang: "ja" });
  if (!draft.ok) throw new Error(draft.error);
  const { action } = await import("~/routes/draft");
  const transaction = h.db.transaction.bind(h.db);
  let inside = false;
  const txSpy = vi.spyOn(h.db, "transaction").mockImplementation(async (work, config) => transaction(async tx => {
    inside = true;
    try { return await work(tx); } finally { inside = false; }
  }, config));
  const render = markdown.renderEntryOrPlain;
  const observed: { inside: boolean; body: string }[] = [];
  const spy = vi.spyOn(markdown, "renderEntryOrPlain").mockImplementation((...args) => { observed.push({ inside, body: args[0] }); return render(...args); });
  const body = "Edited form[^note]\n\n[^note]: Fresh note";
  try {
    const result = await h.outcome(() => action(h.args(h.request(`/drafts/${draft.id}`, { as: "load_reader", form: { intent: "publish", version: "1", body, lang: "en" } }), { id: String(draft.id) })));
    expect(result.status).toBe(302);
    const id = Number(/\/t\/(\d+)/.exec(result.location!)?.[1]);
    const [saved] = await h.db.select().from(entries).where(eq(entries.id, id));
    expect(saved).toMatchObject({ body, lang: "en" });
    expect(saved.html).toContain("Footnotes");
    expect(observed).toEqual([{ inside: false, body }]);
  } finally { spy.mockRestore(); txSpy.mockRestore(); }
});

it.each(["identical", "changed", "timer"])("consumes a prepared entry id once across %s writes in one async scope", async mode => {
  const input = { kind: "topic" as const, body: "Prepared topic", lang: "ja" };
  let later: Promise<Awaited<ReturnType<typeof createTopic>>> | undefined;
  const first = await withEntryRender(h.db, input, async () => {
    const first = await createTopic(h.db, h.ids.load_reader, input);
    const next = () => createTopic(h.db, h.ids.load_reader, { ...input, body: mode === "changed" ? "Different topic" : input.body });
    later = mode === "timer" ? new Promise((resolve, reject) => setTimeout(() => { next().then(resolve, reject); }, 0)) : next();
    return first;
  }, h.ids.load_reader);
  const second = await later!;
  expect(first.ok && second.ok).toBe(true);
  if (!first.ok || !second.ok) throw new Error("creation failed");
  expect(second.id).not.toBe(first.id);
});

it("keeps a topic preparation for a topic when a reply is created first in the same scope", async () => {
  const topic = await createTopic(h.db, h.ids.load_reader, { body: "Parent", lang: "ja" });
  if (!topic.ok) throw new Error(topic.error);
  const input = { kind: "topic" as const, body: "Prepared topic", lang: "ja" };
  await withEntryRender(h.db, input, async () => {
    const reply = await createReply(h.db, h.ids.load_reader, topic.id, { body: "Reply", lang: "ja" });
    const nextTopic = await createTopic(h.db, h.ids.load_reader, input);
    expect(reply.ok && nextTopic.ok).toBe(true);
    if (!reply.ok || !nextTopic.ok) throw new Error("creation failed");
    expect(nextTopic.id).not.toBe(reply.id);
  }, h.ids.load_reader);
});

it("reuses a mention render across JSON object key order changes and Map insertion order changes", async () => {
  const prepared = await prepareEntryRender(h.db, { kind: "topic", body: "Hello @load_reader", lang: "ja" });
  const bindings = prepared.bindings.map(({ spelling, prefix, userId }) => ({ prefix, userId, spelling }));
  const targets = new Map([...prepared.targets].reverse().map(([key, { handle, userId, prefix, publicId }]) => [key, { publicId, prefix, userId, handle }]));
  expect(sameMentionRender(prepared, bindings, targets)).toBe(true);
  expect(sameMentionRender(prepared, bindings.map(binding => ({ ...binding, userId: "different" })), targets)).toBe(false);
  expect(sameMentionRender(prepared, bindings, new Map([...targets].map(([key, target]) => [key, { ...target, publicId: "other00000001" }])))).toBe(false);
});

it.each([
  ["topic", "create"], ["reply", "create"],
  ["topic", "edit"], ["reply", "edit"],
  ["topic", "publish"], ["reply", "publish"],
] as const)("stores current mention HTML when bindings change between preparation and %s %s", async (kind, operation) => {
  const authorId = h.ids.load_reader;
  const handle = `load_race_${kind}_${operation}`;
  const body = `Hello @${handle}`;
  const input = { kind, lang: "ja", body };
  const parent = await createTopic(h.db, authorId, { body: "Parent for the mention race", lang: "ja" });
  if (!parent.ok) throw new Error(parent.error);
  const create = (body: string) => kind === "topic" ? createTopic(h.db, authorId, { ...input, body }) : createReply(h.db, authorId, parent.id, { ...input, body });
  const original = operation === "edit" ? await create("Original text") : null;
  if (original && !original.ok) throw new Error(original.error);
  const draft = operation === "publish" ? await createDraft(h.db, authorId, { ...input, ...(kind === "reply" ? { threadId: parent.id } : {}) }) : null;
  if (draft && !draft.ok) throw new Error(draft.error);
  const made = await withEntryRender(h.db, { ...input, ...(original?.ok ? { id: original.id } : {}) }, async () => {
    // Another request claims the previously unresolved spelling after preparation.
    await addMember(h.db, handle, handle);
    if (original?.ok) return editEntry(h.db, authorId, original.id, { title: null, body });
    if (draft?.ok) return publishDraft(h.db, authorId, draft.id);
    return create(body);
  }, authorId);
  if (!made.ok) throw new Error(made.error);
  const [saved] = await h.db.select().from(entries).where(eq(entries.id, made.id));
  const [snapshot] = await h.db.select().from(entryMentionSnapshots).where(and(eq(entryMentionSnapshots.entryId, made.id), eq(entryMentionSnapshots.revision, saved.mentionRevision)));
  expect(saved.html).toContain('class="mention"');
  expect(saved.html).toContain(handle);
  expect(saved.html).toContain("Hello");
  expect(snapshot.bindings).toMatchObject([{ userId: handle }]);
  expect(await h.db.select().from(notifications).where(eq(notifications.userId, handle))).toHaveLength(1);
});
