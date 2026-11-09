import { and, eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { entries, entryReferences, follows, notifications, translations } from "~/lib/db/schema";
import { createReply, createTopic, editEntry, softDeleteEntry } from "~/lib/entries.server";
import { listRelatedDiscussions } from "~/lib/related-discussions.server";
import { deleteEntry, hideEntry, unhideEntry } from "~/lib/moderation.server";
import { createAppeal, decideAppeal } from "~/lib/appeals.server";
import { buildRelatedMarkdown } from "~/lib/md/related.server";
import { buildThreadMarkdown } from "~/lib/md/thread.server";
import { serveThreadMd } from "~/lib/md/twin.server";
import Topic, { loader as topicLoader } from "~/routes/topic";
import { loader as relatedLoader } from "~/routes/topic-related";
import { loader as relatedMdLoader } from "~/routes/related-md";
import { addMember } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { parseBlocks } from "./helpers/md";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let h: RouteHarness, sequence = 0;
const start = Date.UTC(2030, 0, 1);
const now = () => new Date(start + ++sequence * 1_000);
const display = { readLangs: ["en"] as const, displayLang: "en" as const, lang: "ja" as const };
beforeAll(async () => {
  h = await setupRouteHarness();
  for (const handle of ["related_author", "related_reader", "related_operator"]) await h.signIn(handle, { homeArea: "en", readLangs: ["en"] });
});
afterAll(() => { h.restore(); vi.unstubAllEnvs(); });
async function topic(body = "Original discussion", author = h.ids.related_author, title = `Related topic ${sequence}`) {
  const result = await createTopic(h.db, author, { lang: "en", title, body }, { now: now() });
  if (!result.ok) throw new Error(result.error);
  return result.id;
}
async function reply(id: number, body: string, author = h.ids.related_author) {
  const result = await createReply(h.db, author, id, { lang: "en", body }, { now: now() });
  if (!result.ok) throw new Error(result.error);
  return result.id;
}

it("typesets related titles only on screens and retains saved titles in both Markdown readers", async () => {
  await h.signIn("typeset_related_reader", { homeArea: "fr", readLangs: ["fr"] });
  const hub = await topic(), referenced = await topic("Referenced discussion");
  await reply(hub, `[reference](/t/${referenced})`);
  const source = await row(referenced);
  const raw = '"L\'IA"...';
  const shown = '«\u00a0L’IA\u00a0»…';
  await h.db.insert(translations).values((['title', 'body'] as const).map(field => ({ entryId: referenced, field, lang: 'fr', kind: 'primary', sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: raw })));
  expect((await listRelatedDiscussions(h.db, hub, { readLangs: [], displayLang: "fr" })).rows[0].title.text).toBe(raw);
  expect((await listRelatedDiscussions(h.db, hub, { readLangs: [], displayLang: "fr", typesetTitles: true })).rows[0].title.text).toBe(shown);
  const screen = await relatedLoader(h.args(h.request(`/t/${hub}/related?lang=fr`, { as: "typeset_related_reader" }), { id: String(hub) }));
  expect(screen.rows[0].title.text).toBe(shown);
  const thread = await topicLoader(h.args(h.request(`/t/${hub}?lang=fr`, { as: "typeset_related_reader" }), { id: String(hub) }));
  expect(thread.related.rows[0].title.text).toBe(shown);
  for (const markdown of [
    await buildThreadMarkdown(h.db, hub, { page: 1, lang: "fr", displayLang: "fr", k: null, sentences: false }),
    await buildRelatedMarkdown(h.db, hub, { page: 1, lang: "fr", k: null }),
    await (await relatedMdLoader(h.args(h.request(`/t/${hub}/related.md?lang=fr`, { as: "typeset_related_reader" }), { id: String(hub) }))).text(),
    await (await serveThreadMd(h.request(`/t/${hub}.md?lang=fr`, { as: "typeset_related_reader" }), String(hub))).text(),
  ]) {
    expect(markdown).toContain(`[${raw}](`);
    expect(markdown).not.toContain(shown);
  }
  expect((await h.db.select().from(translations).where(eq(translations.entryId, referenced))).every(row => row.text === raw)).toBe(true);
});
const list = (id: number, inline = true, page = 1) => listRelatedDiscussions(h.db, id, { ...display, inline, page });
const md = (id: number) => buildThreadMarkdown(h.db, id, { page: 1, lang: "ja", readLangs: ["en"], k: null, sentences: false });
const row = async (id: number) => (await h.db.select().from(entries).where(eq(entries.id, id)))[0];

it("validates reply ownership and keeps source text unchanged, deduplicating real endpoints", async () => {
  const a = await topic(), b = await topic(), c = await reply(a, "Destination reply");
  const body = `[valid](/t/${a}.md?lang=ja&k=secret#c-${c}) [duplicate](/t/${a}#c-${c}) [wrong](/t/${b}#c-${c}) [missing](/t/${a}#c-999999999) [self](/t/${b})`;
  const source = await reply(b, body);
  expect(await h.db.select().from(entryReferences).where(eq(entryReferences.sourceEntryId, source))).toEqual([{ sourceEntryId: source, targetEntryId: c }]);
  expect((await row(source)).body).toBe(body);
  expect(JSON.stringify((await list(b)).rows)).not.toContain("secret");
});

it("groups each topic once, keeps both directions and newest source posts, and resolves reply pages with language", async () => {
  const a = await topic(), b = await topic();
  await h.db.insert(entries).values(Array.from({ length: 100 }, () => ({ kind: "reply", threadId: a, authorId: h.ids.related_author, lang: "en", body: "Page fixture", createdAt: now() })));
  const target = await reply(a, "Page two destination");
  await reply(b, `[old reference](/t/${a})`);
  const latest = await reply(b, `[source explanation](/t/${a}#c-${target})`);
  const reverse = await reply(a, `[other direction](/t/${b})`);
  const result = await list(a);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ id: b,
    incoming: { sourceHref: `/t/${b}?lang=ja#c-${latest}`, targetHref: `/t/${a}?page=2&lang=ja#c-${target}` },
    outgoing: { sourceHref: `/t/${a}?page=2&lang=ja#c-${reverse}`, targetHref: `/t/${b}?lang=ja#p-${b}` },
  });
  expect((await list(b)).rows[0].outgoing?.sourceHref).toBe(`/t/${b}?lang=ja#c-${latest}`);
  const firstPage = await md(a);
  expect(firstPage).toContain(`/t/${b}?lang=ja#c-${latest}`);
  expect(firstPage).toContain(`/t/${a}?page=2&lang=ja#c-${reverse}`);
  expect(await buildThreadMarkdown(h.db, a, { page: 2, lang: "ja", k: null, sentences: false })).not.toContain("type: related");
});

it("uses the same one-per-author selection in the thread and its Markdown twin", async () => {
  const hub = await topic();
  const first = await topic(`[first](/t/${hub})`);
  const latest = await topic(`[latest](/t/${hub})`);
  const secondAuthor = "related_second_author";
  await addMember(h.db, secondAuthor, secondAuthor);
  const second = await topic(`[another reference](/t/${hub})`, secondAuthor);
  expect((await list(hub)).rows.map(item => item.id)).toEqual([second, latest]);
  const shared = (await md(hub))!.split("type: related")[1]!;
  expect(shared).toContain(`/t/${second}`);
  expect(shared).toContain(`/t/${latest}`);
  expect(shared).not.toContain(`/t/${first}?`);
  expect(await buildRelatedMarkdown(h.db, hub, { page: 1, lang: "ja", k: null })).toContain(`/t/${first}`);
});

it("caps the inline list at five distinct reference authors and exposes every skipped row on paginated pages", async () => {
  const hub = await topic();
  const repeated: number[] = [];
  for (let i = 0; i < 5; i++) repeated.push(await topic(`[reference](/t/${hub})`));
  expect((await list(hub)).rows.map(item => item.id)).toEqual([repeated.at(-1)]);
  expect((await list(hub)).omitted).toBe(true);
  expect((await list(hub, false)).rows).toHaveLength(5);
  for (let i = 0; i < 6; i++) {
    const id = `related_diversity_${i}`;
    await addMember(h.db, id, id);
    await topic(`[reference](/t/${hub})`, id);
  }
  const inline = await list(hub);
  expect(inline.rows).toHaveLength(5);
  const allBefore = (await list(hub, false)).rows.map(item => item.id);
  const older = repeated[0];
  await editEntry(h.db, h.ids.related_author, older, { title: "Edited old reference", body: `[still linked](/t/${hub})` }, { now: new Date("2035-01-01") });
  expect((await list(hub, false)).rows.map(item => item.id)).toEqual(allBefore);
  for (let i = 0; i < 11; i++) await topic(`[reference](/t/${hub})`);
  expect((await list(hub, false)).rows).toHaveLength(20);
  expect(await list(hub, false)).toMatchObject({ hasNext: true, pageCount: 2 });
  expect((await list(hub, false, 2)).rows).toHaveLength(2);
  expect(await buildRelatedMarkdown(h.db, hub, { page: 2, lang: "en", k: null })).toContain("page: 2");
  expect(await buildRelatedMarkdown(h.db, hub, { page: 3, lang: "en", k: null })).toBeNull();
  const firstPage = await md(hub);
  expect(firstPage).toContain(`/t/${hub}/related.md?lang=ja`);
  const allThread = await buildThreadMarkdown(h.db, hub, { page: 1, lang: "all", displayLang: "ja", sentences: false, k: null, readLangs: ["en"] });
  expect(allThread).toContain(`/t/${hub}/related.md?lang=all`);
  const allRelated = await relatedMdLoader(h.args(h.request(`/t/${hub}/related.md?lang=all`, { as: "related_reader" }), { id: String(hub) }));
  expect(allRelated.status).toBe(200);
  expect(new URL(parseBlocks(await allRelated.text())[0].fm.next as string).searchParams.get("lang")).toBe("all");
  for (const skipped of repeated) expect(firstPage).not.toContain(`](${`http://localhost:5173/t/${skipped}?lang=ja`}`);
});

it("invalidates both topics on removal, hiding and restoration without activity, edits, destination mail or auto-follow", async () => {
  const a = await topic(), before = await row(a);
  const b = await topic(`[reference](/t/${a})`);
  const linked = await row(a);
  expect(linked.metaChangedAt!.getTime()).toBeGreaterThan(before.createdAt.getTime());
  expect(linked.lastActivityAt).toEqual(before.lastActivityAt);
  expect(linked.editedAt).toBeNull();
  expect(await h.db.select().from(notifications).where(eq(notifications.entryId, b))).toEqual([]);
  expect(await h.db.select().from(follows).where(and(eq(follows.userId, h.ids.related_reader), eq(follows.threadId, a)))).toEqual([]);
  const actor = { id: h.ids.related_operator, scope: { operator: true, langs: [] } };
  expect((await hideEntry(h.db, actor, { entryId: b, reason: "spam", note: "fixture" }, { now: now() })).ok).toBe(true);
  expect((await list(a)).rows).toEqual([]);
  const hiddenMeta = (await row(a)).metaChangedAt;
  expect((await unhideEntry(h.db, actor, { entryId: b, reason: "spam", note: "fixture" }, { now: now() })).ok).toBe(true);
  expect((await list(a)).rows).toHaveLength(1);
  expect((await row(a)).metaChangedAt!.getTime()).toBeGreaterThan(hiddenMeta!.getTime());
  const deletion = await deleteEntry(h.db, actor, { entryId: b, reason: "spam", note: "fixture" }, { now: now() });
  if (!deletion.ok) throw new Error(deletion.error);
  expect((await list(a)).rows).toEqual([]);
  const deletedMeta = (await row(a)).metaChangedAt;
  const appeal = await createAppeal(h.db, h.ids.related_author, deletion.actionId, "Restore the reference", { now: now() });
  if (!appeal.ok) throw new Error(appeal.error);
  const restored = await decideAppeal(h.db, { id: h.ids.related_reader, scope: { operator: true, langs: [] } }, appeal.id, { decision: "overturned", note: "Restore fixture" }, { now: now() });
  expect(restored).toMatchObject({ ok: true, reversed: true });
  expect((await list(a)).rows).toHaveLength(1);
  expect((await row(a)).metaChangedAt!.getTime()).toBeGreaterThan(deletedMeta!.getTime());
  expect((await editEntry(h.db, h.ids.related_author, b, { title: "Removed reference", body: "No link now" }, { now: now() })).ok).toBe(true);
  expect((await list(a)).rows).toEqual([]);
  expect(await md(a)).not.toContain("type: related");
  expect((await row(a)).lastActivityAt).toEqual(before.lastActivityAt);
  expect((await row(a)).editedAt).toBeNull();
});

it("qualifies all four endpoints even with a stale index and excludes hidden rows from data, HTML and Markdown for all readers", async () => {
  vi.stubEnv("PUBLIC_READING", "1");
  vi.stubEnv("OPERATOR_EMAILS", "related_operator@example.com");
  const a = await topic(), destination = await reply(a, "Target explanation");
  const b = await topic("Other discussion", h.ids.related_author, "Private reference title");
  const source = await reply(b, `[context](/t/${a}#c-${destination})`);
  for (const withheld of [source, b, destination, a]) {
    for (const field of ["hiddenAt", "deletedAt"] as const) {
      await h.db.update(entries).set({ [field]: now() }).where(eq(entries.id, withheld));
      for (const as of [undefined, "related_reader", "related_operator"]) {
        if (withheld !== a) {
          const result = await relatedLoader(h.args(h.request(`/t/${a}/related`, { as }), { id: String(a) }));
          expect(result).toMatchObject({ rows: [], hasNext: false, pageCount: 1 });
          const screen = await topicLoader(h.args(h.request(`/t/${a}`, { as }), { id: String(a) }));
          expect(screen.related.rows).toEqual([]);
          const router = createMemoryRouter([{ path: "/t/:id", element: createElement(Topic, { loaderData: screen, params: {}, matches: [] } as never) }], { initialEntries: [`/t/${a}`] });
          expect(renderToStaticMarkup(createElement(RouterProvider, { router }))).not.toContain('id="related"');
          const twin = await relatedMdLoader(h.args(h.request(`/t/${a}/related.md`, { as }), { id: String(a) }));
          expect(twin.status).toBe(200);
          expect(await twin.text()).not.toContain("Private reference title");
        } else {
          expect(await h.outcome(async () => (await relatedLoader(h.args(h.request(`/t/${a}/related`, { as }), { id: String(a) }))))).toMatchObject({ status: 404 });
          expect((await relatedMdLoader(h.args(h.request(`/t/${a}/related.md`, { as }), { id: String(a) }))).status).toBe(404);
        }
      }
      expect((await list(a, false)).rows).toEqual([]);
      expect((await md(a)) ?? "").not.toContain("Private reference title");
      await h.db.update(entries).set({ [field]: null }).where(eq(entries.id, withheld));
      expect((await list(a)).rows).toHaveLength(1);
    }
  }
  await softDeleteEntry(h.db, source, { now: now() });
  expect((await list(a)).rows).toEqual([]);
  expect(await h.db.select().from(entryReferences).where(eq(entryReferences.sourceEntryId, source))).toHaveLength(1);
});

it("uses the public reading gate on HTML and twins, preserves lang and places the panel after replies and the form", async () => {
  const a = await topic(), b = await topic(`[reference](/t/${a})`);
  for (const publicOn of [false, true]) {
    vi.stubEnv("PUBLIC_READING", publicOn ? "1" : "");
    for (const as of [undefined, "related_reader", "related_operator"]) {
      const outcome = await h.outcome(async () => (await relatedLoader(h.args(h.request(`/t/${a}/related?lang=ja`, { as }), { id: String(a) }))));
      expect(outcome.status).toBe(as || publicOn ? 200 : 302);
      for (const suffix of ["md", "txt"]) {
        const twin = await relatedMdLoader(h.args(h.request(`/t/${a}/related.${suffix}?lang=ja`, { as }), { id: String(a) }));
        expect(twin.status).toBe(as || publicOn ? 200 : 401);
        if (twin.ok) { expect(twin.headers.get("Cache-Control")).toContain("no-store"); expect(await twin.text()).toContain(`/t/${b}?lang=ja#p-${b}`); }
      }
    }
  }
  const screen = await topicLoader(h.args(h.request(`/t/${a}?lang=ja`, { as: "related_reader" }), { id: String(a) }));
  const router = createMemoryRouter([{ path: "/t/:id", element: createElement(Topic, { loaderData: screen, params: {}, matches: [] } as never) }], { initialEntries: [`/t/${a}?lang=ja`] });
  const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
  expect(html.indexOf('id="related"')).toBeGreaterThan(html.indexOf('id="reply"'));
  expect(html.indexOf('id="reply"')).toBeGreaterThan(html.indexOf('id="replies"'));
  const before = await serveThreadMd(h.request(`/t/${a}.md`), String(a));
  expect(await before.text()).toContain("type: related");
  await editEntry(h.db, h.ids.related_author, b, { title: "No longer related", body: "Removed" }, { now: now() });
  const after = await serveThreadMd(h.request(`/t/${a}.md`), String(a));
  expect(await after.text()).not.toContain("type: related");
});
