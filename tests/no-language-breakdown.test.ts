import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { profiles } from "~/lib/db/schema";
import { parse } from "yaml";
import { helpAiMd, llmsTxt } from "~/lib/api/guides.server";
import { openApiDocument } from "~/lib/api/openapi.server";
import { createReply, createTopic } from "~/lib/entries.server";
import { buildMemberExport } from "~/lib/exports.server";
import { AREAS } from "~/lib/languages";
import { getMetrics } from "~/lib/metrics.server";
import { grantModerator } from "~/lib/roles.server";
import { setStance } from "~/lib/stances.server";
import { setVote } from "~/lib/votes.server";
import { getMd, parseBlocks } from "./helpers/md";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Language breakdowns must not leak through stance, Insightful, export or guide routes.
// Question stance voters primarily use Japanese (4), English (3), French (2), and Vietnamese (1). Stance totals are agree 5, disagree 3, neither 2, across four languages.
// Viewers are a member, assigned moderator, and operator. Check (1) field names, (2) shapes such as language-tag keys with numeric values or tag/count pairs, and (3) expected totals and language counts.
const t = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 0, minutes));
const savedOperators = process.env.OPERATOR_EMAILS;

let h: RouteHarness;
let q: number;
let replyId: number;

const PEOPLE: Array<[handle: string, area: "ja" | "en" | "fr" | "vi", position: "agree" | "disagree" | "neither"]> = [
  ["ja1", "ja", "agree"],
  ["ja2", "ja", "agree"],
  ["ja3", "ja", "disagree"],
  ["ja4", "ja", "neither"],
  ["en1", "en", "agree"],
  ["en2", "en", "disagree"],
  ["en3", "en", "agree"],
  ["fr1", "fr", "disagree"],
  ["fr2", "fr", "neither"],
  ["vi1", "vi", "agree"],
];

beforeAll(async () => {
  process.env.OPERATOR_EMAILS = "operator-nlb@example.com";
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
  for (const [handle, area] of PEOPLE) await h.signIn(handle, { homeArea: area, readLangs: [area] });
  await h.signIn("watcher", { homeArea: "ja" });
  await h.signIn("jamod", { homeArea: "ja" });
  await h.signIn("opal", { homeArea: "ja", email: "operator-nlb@example.com" });
  expect((await grantModerator(h.db, h.ids.opal, h.ids.jamod, "ja")).ok).toBe(true);
  const question = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "共生は制御の代替になりうる", body: "命題です。", asksStance: true }, { now: t(0) });
  if (!question.ok) throw new Error("question failed");
  q = question.id;
  // Seed the reason before any reader takes today's immutable draw.
  const reply = await createReply(h.db, h.ids.vi1, q, { lang: "vi", body: "Lý do của tôi", stanceTag: "agree" }, { now: t(30) });
  if (!reply.ok) throw new Error("reply failed");
  replyId = reply.id;
  for (const [i, [handle, , position]] of PEOPLE.entries()) {
    const res = await setStance(h.db, h.ids[handle], { questionId: q, position, expectedVersion: 0 }, { now: t(1 + i) });
    if (!res.ok) throw new Error(`stance failed: ${res.error}`);
  }
});
afterAll(() => {
  h.restore();
  if (savedOperators === undefined) delete process.env.OPERATOR_EMAILS;
  else process.env.OPERATOR_EMAILS = savedOperators;
});

// Names that could carry a count per language: stance fields, legacy per-area votes and cross-area counts.
const FORBIDDEN_KEYS = ["byArea", "by_area", "composition", "areas", "area_counts", "voterArea", "voter_area", "insightful_by_area", "votes_by_area", "cross_area", "crossArea", "languages", "langs_by_area"];
// Language-area tags (ja, en, ..., other) and UI language names (日本語, English, ...).
const AREA_TAGS = new Set<string>(AREAS);

// Traverse parsed data to detect language-breakdown shapes; return their locations, or an empty list if none exist.
function findBreakdowns(value: unknown, where = "$"): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      // Arrays of language-tag/count pairs: [tag, number] or { area|lang|language: tag, count|n|total: number }.
      if (Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && AREA_TAGS.has(item[0]) && typeof item[1] === "number") found.push(`${where}[${i}] is a [tag, number] pair`);
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item as Record<string, unknown>);
        // A language field (area, lang, language) containing an area tag alongside a numeric field (count, n, total, votes, agree, ...). A source lang paired with reply counts is not a counted field.
        const COUNT_KEYS = ["count", "n", "total", "number", "votes", "people", "members", "agree", "disagree", "neither"];
        if (entries.some(([k, v]) => ["area", "lang", "language"].includes(k) && typeof v === "string" && AREA_TAGS.has(v)) && entries.some(([k, v]) => COUNT_KEYS.includes(k) && typeof v === "number")) found.push(`${where}[${i}] pairs a language tag with a number`);
      }
      found.push(...findBreakdowns(item, `${where}[${i}]`));
    });
    return found;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key] of entries) if (FORBIDDEN_KEYS.includes(key)) found.push(`${where}.${key} is a forbidden name`);
    // An object whose keys are all language-area tags and whose values are numbers.
    if (entries.length > 0 && entries.every(([k, v]) => AREA_TAGS.has(k) && typeof v === "number")) found.push(`${where} maps language tags to numbers`);
    for (const [key, child] of entries) found.push(...findBreakdowns(child, `${where}.${key}`));
  }
  return found;
}

const asJson = (text: string) => JSON.parse(text) as unknown;
// The first object in the data that is the list item of the question `id` (it has the Insightful count of the topic).
function findItem(value: unknown, id: number): { insightful?: { total: number; langs: number } } | undefined {
  if (Array.isArray(value)) return value.map((v) => findItem(v, id)).find((v) => v !== undefined);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o.id === id && "insightful" in o) return o as { insightful?: { total: number; langs: number } };
    return Object.values(o).map((v) => findItem(v, id)).find((v) => v !== undefined);
  }
  return undefined;
}
const blocks = (text: string) => parseBlocks(text).map((b) => b.fm);

describe("the detector itself (so that a pass means something)", () => {
  it("finds the forms of a per-language breakdown, and lets the display shape through", () => {
    expect(findBreakdowns({ byArea: [] })).not.toEqual([]);
    expect(findBreakdowns({ a: { ja: 4, en: 3 } })).not.toEqual([]);
    expect(findBreakdowns({ a: [{ area: "ja", count: 4 }] })).not.toEqual([]);
    expect(findBreakdowns({ a: [{ lang: "ja", agree: 2, disagree: 1 }] })).not.toEqual([]);
    // A source lang paired with reply counts is not a counted field.
    expect(findBreakdowns({ topics: [{ id: 1, lang: "ja", replyCount: 3 }] })).toEqual([]);
    expect(findBreakdowns({ a: [["ja", 4], ["en", 3]] })).not.toEqual([]);
    expect(findBreakdowns({ a: { composition: 1 } })).not.toEqual([]);
    expect(findBreakdowns({ total: 10, counts: { agree: 5, disagree: 3, neither: 2 }, total_langs: 4, langs: 4, lang: "ja" })).toEqual([]);
    // the old shapes of the votes are found: the per-area votes, the cross-area number, and the Markdown map
    expect(findBreakdowns({ votes: [{ area: "ja", count: 3 }], crossArea: 2 })).not.toEqual([]);
    expect(findBreakdowns({ votes_by_area: {} })).not.toEqual([]);
    expect(findBreakdowns({ cross_area: 2 })).not.toEqual([]);
    expect(findBreakdowns({ votes_by_area: { ja: 3, en: 2 } })).not.toEqual([]);
    // the Insightful state as members get it passes
    expect(findBreakdowns({ reactions: { insightful: { total: 9, langs: 3 }, mine: true } })).toEqual([]);
  });
});

describe("a question's stances, by every route a member can read", () => {
  const VIEWERS = ["watcher", "jamod", "opal"] as const;

  it("the page and the lists give the totals and the number of languages, and no breakdown by language, to a member, a moderator and an operator", async () => {
    for (const as of VIEWERS) {
      const page = await (await import("~/routes/topic")).loader(h.args(h.request(`/t/${q}?peek=1`, { as }), { id: String(q) }) as never);
      expect(findBreakdowns(asJson(JSON.stringify(page))), `${as}: topic page`).toEqual([]);
      const dist = (page as unknown as { question: { stance: { distribution: { total: number; counts: Record<string, number>; langs: number } } } }).question.stance.distribution;
      expect(dist, as).toMatchObject({ total: 10, counts: { agree: 5, disagree: 3, neither: 2 }, langs: 4 });
      for (const [route, path, params] of [["latest", `/latest?peek=${q}`, {}], ["home", `/?peek=${q}`, {}], ["area", `/a/ja?peek=${q}`, { lang: "ja" }]] as const) {
        const data = await ((await import(`../app/routes/${route}.tsx`)) as { loader: (a: never) => unknown }).loader(h.args(h.request(path, { as }), params));
        expect(findBreakdowns(asJson(JSON.stringify(data))), `${as}: ${route}`).toEqual([]);
        expect(JSON.stringify(data), `${as}: ${route}`).toContain('"langs":4');
      }
    }
  });

  it("/stance answers with the totals and the number of languages only (success and conflict)", async () => {
    const mod = await import("~/routes/stance");
    const send = (version: string, position: string) =>
      h.outcome(() => mod.action(h.args(h.request("/stance", { as: "ja1", form: { questionId: String(q), position, version }, headers: { "sec-fetch-dest": "empty" } }))));
    const ok = await send("1", "agree");
    expect((ok.value as { data: unknown }).data).toMatchObject({ ok: true, distribution: { total: 10, counts: { agree: 5, disagree: 3, neither: 2 }, langs: 4 } });
    const stale = await send("0", "disagree");
    expect(stale.status).toBe(409);
    for (const r of [ok, stale]) expect(findBreakdowns(asJson(JSON.stringify((r.value as { data: unknown }).data)))).toEqual([]);
  });

  it("the Markdown twins carry the totals and total_langs only: the thread, the distribution (md and txt), the lists, the change feed, the manifest and the search", async () => {
    for (const as of VIEWERS) {
      for (const path of [`/t/${q}.md`, `/t/${q}/stances.md`, `/t/${q}/stances.txt`, "/latest.md", "/home.md", "/a/ja.md", "/latest.md?asks=1"]) {
        const res = await getMd(h, path, { as });
        expect(res.status, `${as} ${path}`).toBe(200);
        const text = await res.text();
        for (const fm of blocks(text)) expect(findBreakdowns(fm), `${as} ${path}`).toEqual([]);
        // No field named after a language-area tag may appear anywhere in front matter, including a line starting with "ja: 4".
        expect(text, `${as} ${path}`).not.toMatch(/^\s+(?:ja|en|fr|de|zh-Hant|zh-Hans|ko|th|vi|other): \d+$/m);
      }
      const stancesMd = await (await getMd(h, `/t/${q}/stances.md`, { as })).text();
      expect(blocks(stancesMd)[0]).toMatchObject({ type: "stances", total: 10, counts: { agree: 5, disagree: 3, neither: 2 }, total_langs: 4 });
      expect(Object.keys(blocks(stancesMd)[0]).sort()).toEqual(["as_of", "canonical", "content_trust", "counts", "lang", "question", "title", "total", "total_langs", "type"]);
      // Thread Markdown does not include the distribution.
      expect(await (await getMd(h, `/t/${q}.md`, { as })).text()).not.toMatch(/total_langs|^counts:/m);
      for (const mod of ["changes-md", "manifest"] as const) {
        const path = mod === "changes-md" ? "/changes.md?since=2026-01-01T00:00:00Z" : "/manifest.json";
        const text = await (await ((await import(`~/routes/${mod}`)) as { loader: (a: never) => Promise<Response> }).loader(h.args(h.request(path, { as })))).text();
        if (mod === "manifest") expect(findBreakdowns(asJson(text)), `${as} ${mod}`).toEqual([]);
        else for (const fm of blocks(text)) expect(findBreakdowns(fm), `${as} ${mod}`).toEqual([]);
        expect(text, `${as} ${mod}`).not.toMatch(/total_langs/);
      }
      const search = await (await getMd(h, "/search.md?q=symbiosis", { as })).text();
      for (const fm of blocks(search)) expect(findBreakdowns(fm), `${as} search`).toEqual([]);
    }
  });

  it("the YAML of the distribution parses to plain numbers (the shape check does not depend on the parser)", async () => {
    const text = await (await getMd(h, `/t/${q}/stances.md`, { as: "watcher" })).text();
    const yaml = text.split("\n---\n")[0].replace(/^---\n/, "");
    const fm = parse(yaml) as Record<string, unknown>;
    expect(fm.total).toBe(10);
    expect(fm.total_langs).toBe(4);
    expect(findBreakdowns(fm)).toEqual([]);
  });
});

// "Insightful": the total and the number of languages it came from, by every route a member can read. Presses on the question: ja1, ja2, ja3 (ja), en1, en2 (en), fr1 (fr) = 6 from
// 3 languages; on a reply (tagged agree, by vi1): ja1 and en1 = 2 from 2 languages.
describe("Insightful, by every route a member can read", () => {
  const VIEWERS = ["watcher", "jamod", "opal"] as const;
  beforeAll(async () => {
    for (const who of ["ja1", "ja2", "ja3", "en1", "en2", "fr1"]) expect((await setVote(h.db, h.ids[who], q, true, { now: t(31) })).ok).toBe(true);
    for (const who of ["ja1", "en1"]) expect((await setVote(h.db, h.ids[who], replyId, true, { now: t(32) })).ok).toBe(true);
  });

  it("the page (the post, the replies and the reasons panel) and the lists give the total and the number of languages only", async () => {
    type Reactions = { insightful: { total: number; langs: number }; mine: boolean };
    for (const as of VIEWERS) {
      const page = (await (await import("~/routes/topic")).loader(h.args(h.request(`/t/${q}`, { as }), { id: String(q) }) as never)) as unknown as {
        topic: { reactions: Reactions };
        replies: Array<{ reactions: Reactions }>;
        question: { reasons: Record<string, Array<{ reactions: Reactions }>> };
      };
      expect(findBreakdowns(asJson(JSON.stringify(page))), `${as}: topic page`).toEqual([]);
      expect(page.topic.reactions.insightful, as).toEqual({ total: 6, langs: 3 });
      expect(page.replies[0].reactions.insightful, as).toEqual({ total: 2, langs: 2 });
      // the same reply in the reasons panel has the same two numbers
      expect(page.question.reasons.agree[0].reactions.insightful, as).toEqual({ total: 2, langs: 2 });
      // the loader data of a post has the two numbers and the viewer's own press, and no key for a language
      expect(Object.keys(page.topic.reactions).sort()).toEqual(["insightful", "mine"]);
      expect(Object.keys(page.topic.reactions.insightful).sort()).toEqual(["langs", "total"]);
      for (const [route, path, params] of [["latest", "/latest", {}], ["home", "/", {}], ["area", "/a/ja", { lang: "ja" }]] as const) {
        const data = await ((await import(`../app/routes/${route}.tsx`)) as { loader: (a: never) => unknown }).loader(h.args(h.request(path, { as }), params));
        expect(findBreakdowns(asJson(JSON.stringify(data))), `${as}: ${route}`).toEqual([]);
        // the item of the question, wherever the route puts its list (the home has a local list and one of other languages)
        const item = findItem(asJson(JSON.stringify(data)), q);
        expect(item?.insightful, `${as}: ${route}`).toEqual({ total: 6, langs: 3 });
      }
    }
  });

  it("the cards of the home and of a language list, in every order and filter, and the original of a card, carry no breakdown", async () => {
    for (const as of VIEWERS) {
      for (const [route, path, params] of [
        ["home", "/?order=activity", {}],
        ["home", "/?asks=1", {}],
        ["home", "/?long=1&order=created", {}],
        ["area", "/a/ja?order=activity&long=1", { lang: "ja" }],
      ] as const) {
        const data = await ((await import(`../app/routes/${route}.tsx`)) as { loader: (a: never) => unknown }).loader(h.args(h.request(path, { as }), params));
        const json = asJson(JSON.stringify(data));
        expect(findBreakdowns(json), `${as}: ${path}`).toEqual([]);
        const card = findItem(json, q) as { insightful?: object; distribution?: object | null } | undefined;
        expect(card, `${as}: ${path}`).toBeDefined();
        expect(Object.keys(card?.insightful ?? {}).sort(), `${as}: ${path}`).toEqual(["langs", "total"]);
        expect(Object.keys(card?.distribution ?? { asOf: 1, counts: 1, langs: 1, questionId: 1, total: 1 }).sort(), `${as}: ${path}`).toEqual(["asOf", "counts", "langs", "questionId", "total"]);
      }

    }
  });

  it("the reasons panel data names no writer's home area (the language of a reply is the language of its text)", async () => {
    const page = await (await import("~/routes/topic")).loader(h.args(h.request(`/t/${q}`, { as: "watcher" }), { id: String(q) }) as never);
    const reasons = JSON.stringify((page as unknown as { question: { reasons: unknown } }).question.reasons);
    expect(reasons).toContain("vi1");
    expect(reasons).toContain('"lang":"vi"');
    for (const name of ["homeArea", "home_area", "writerArea", "authorArea", "author_area", "authorId"]) expect(reasons, name).not.toContain(name);
    expect(findBreakdowns(asJson(reasons))).toEqual([]);
  });

  it("/vote answers with the post's new state: the total, the number of languages and the viewer's own press", async () => {
    const mod = await import("~/routes/vote");
    const press = async (as: string, entryId: number, on: "1" | "0") => (await h.outcome(() => mod.action(h.args(h.request("/vote", { as, form: { entryId: String(entryId), on }, headers: { "sec-fetch-dest": "empty" } })))));
    const added = await press("vi1", q, "1");
    expect((added.value as { data?: unknown }).data ?? added.value).toMatchObject({ ok: true, entryId: q, voted: true, reactions: { insightful: { total: 7, langs: 4 }, mine: true } });
    const removed = await press("vi1", q, "0");
    const body = (removed.value as { data?: unknown }).data ?? removed.value;
    expect(body).toMatchObject({ ok: true, voted: false, reactions: { insightful: { total: 6, langs: 3 }, mine: false } });
    expect(findBreakdowns(asJson(JSON.stringify(body)))).toEqual([]);
    expect(Object.keys((body as { reactions: object }).reactions).sort()).toEqual(["insightful", "mine"]);
  });

  it("the Markdown twins (the thread, the lists) carry insightful and insightful_langs and no map per language or cross-area number", async () => {
    for (const as of VIEWERS) {
      for (const path of [`/t/${q}.md`, "/latest.md", "/home.md", "/a/ja.md", "/latest.md?asks=1"]) {
        const text = await (await getMd(h, path, { as })).text();
        for (const fm of blocks(text)) expect(findBreakdowns(fm), `${as} ${path}`).toEqual([]);
        expect(text, `${as} ${path}`).toMatch(/insightful: \d+\n\s*insightful_langs: \d+/);
        for (const word of ["votes_by_area", "insightful_by_area", "cross_area"]) expect(text, `${as} ${path}: ${word}`).not.toContain(word);
      }
      // The overview that starts a thread file has no post; the posts follow it.
      const thread = blocks(await (await getMd(h, `/t/${q}.md`, { as })).text()).filter((fm) => !("replies_readable" in fm));
      expect(thread[0]).toMatchObject({ id: `p-${q}`, insightful: 6, insightful_langs: 3 });
      expect(thread.find((fm) => fm.id === `c-${replyId}`)).toMatchObject({ insightful: 2, insightful_langs: 2 });
    }
  });

  it("the guides and the OpenAPI document do not describe a count per language or a cross-area number", () => {
    for (const [name, text] of [["llms.txt", llmsTxt()], ["help/ai.md", helpAiMd()], ["openapi.json", JSON.stringify(openApiDocument())]] as const) {
      for (const word of ["votes_by_area", "insightful_by_area", "cross_area", "votes per language area"]) expect(text, `${name}: ${word}`).not.toContain(word);
    }
    expect(llmsTxt()).toContain("insightful_langs");
  });
});

// Two worlds with the same totals and the same number of languages, but a different breakdown by language: everything a member can read must come out byte for byte the same.
// (The checks above look for the forms of a breakdown and for the right numbers; this one catches a leak that has no recognisable form, because the only thing that could differ between
// the two worlds is the per-language composition.) The question has 6 presses from 3 languages in both: world A is ja 3, en 2, fr 1; world B is ja 1, en 1, fr 4. The reply has 2 presses
// from 2 languages: A is ja and en, B is ja and fr. Members who pressed the same things in both worlds (ja1) and members who pressed nothing read the pages. The only fields left out
// of the comparison are the times at which a page or an answer was made (`loadedAt`, `at`, `asOf`, `as_of`) and the signed read token of the "open in AI" link (`?k=`, which holds the member's
// random id), which differ between any two calls.
describe("Insightful: the same totals and the same number of languages from a different composition give the same bytes", () => {
  const MEMBERS: Array<[handle: string, area: "ja" | "en" | "fr" | "vi"]> = [
    ["ja1", "ja"],
    ["ja2", "ja"],
    ["ja3", "ja"],
    ["en1", "en"],
    ["en2", "en"],
    ["fr1", "fr"],
    ["fr2", "fr"],
    ["fr3", "fr"],
    ["fr4", "fr"],
    ["vi1", "vi"],
  ];
  type Pos = "agree" | "disagree" | "neither";
  type World = { question: string[]; reply: string[]; stances: Array<[handle: string, position: Pos]> };
  // The stances too: 6 of them from 3 languages in both worlds (agree 3, disagree 2, neither 1); A is ja 3, en 2, fr 1 and B is ja 1, en 1, fr 4. ja1 holds the same stance in both.
  const STANCES_A: World["stances"] = [["ja1", "agree"], ["ja2", "agree"], ["ja3", "disagree"], ["en1", "disagree"], ["en2", "neither"], ["fr1", "agree"]];
  const STANCES_B: World["stances"] = [["ja1", "agree"], ["en1", "agree"], ["fr1", "agree"], ["fr2", "disagree"], ["fr3", "disagree"], ["fr4", "neither"]];
  const WORLD_A: World = { question: ["ja1", "ja2", "ja3", "en1", "en2", "fr1"], reply: ["ja1", "en1"], stances: STANCES_A };
  const WORLD_B: World = { question: ["ja1", "en1", "fr1", "fr2", "fr3", "fr4"], reply: ["ja1", "fr1"], stances: STANCES_B };
  const READERS = ["watcher", "jamod", "opal", "ja1"] as const;
  // The member exports that must not tell the two worlds apart: those of members who did the same in both (ja1 pressed and chose the same), who did nothing, who wrote the question
  // (hana: her question got 6 presses and 6 stances) and who wrote the reply (vi1: it got 2 presses). The time of the profile is the clock of the call, not the content.
  const EXPORTERS = ["watcher", "jamod", "opal", "ja1", "hana", "vi1"] as const;
  // the times of the call and the signed read token: not part of the content
  const withoutClock = (text: string) =>
    text
      .replace(/"(loadedAt|at|asOf)":"[^"]*"/g, '"$1":"<time>"')
      .replace(/^(\s*)(as_of|generated|at): .*$/gm, "$1$2: <time>")
      .replace(/([?&])k=[^"&\s)]+/g, "$1k=<token>");

  async function observe(world: World): Promise<Record<string, string>> {
    const w = await setupRouteHarness();
    try {
      await w.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
      for (const [handle, area] of MEMBERS) await w.signIn(handle, { homeArea: area, readLangs: [area] });
      await w.signIn("watcher", { homeArea: "ja" });
      await w.signIn("jamod", { homeArea: "ja" });
      await w.signIn("opal", { homeArea: "ja", email: "operator-nlb@example.com" });
      // The same logical members keep their public identities across worlds, including their generated avatars.
      for (const [handle, userId] of Object.entries(w.ids)) {
        await w.db.update(profiles).set({ publicId: createHash("sha256").update(handle).digest("hex").slice(0, 12) }).where(eq(profiles.userId, userId));
      }
      expect((await grantModerator(w.db, w.ids.opal, w.ids.jamod, "ja")).ok).toBe(true);
      const question = await createTopic(w.db, w.ids.hana, { lang: "ja", title: "共生は制御の代替になりうる", body: "命題です。", asksStance: true }, { now: t(0) });
      if (!question.ok) throw new Error("question failed");
      const reply = await createReply(w.db, w.ids.vi1, question.id, { lang: "vi", body: "Lý do của tôi", stanceTag: "agree" }, { now: t(30) });
      if (!reply.ok) throw new Error("reply failed");
      for (const who of world.question) expect((await setVote(w.db, w.ids[who], question.id, true, { now: t(31) })).ok).toBe(true);
      for (const who of world.reply) expect((await setVote(w.db, w.ids[who], reply.id, true, { now: t(32) })).ok).toBe(true);
      for (const [who, position] of world.stances) expect((await setStance(w.db, w.ids[who], { questionId: question.id, position, expectedVersion: 0 }, { now: t(33) })).ok).toBe(true);

      const out: Record<string, string> = {};
      const id = question.id;
      for (const as of READERS) {
        const page = await (await import("~/routes/topic")).loader(w.args(w.request(`/t/${id}`, { as }), { id: String(id) }) as never);
        // Account UUIDs differ between worlds; independently verify the account binding before normalizing that identity.
        expect(page.ownerId).toBe(w.ids[as]);
        out[`${as} loader /t/${id}`] = withoutClock(JSON.stringify({ ...page, ownerId: as }));
        for (const [route, path, params] of [["latest", "/latest", {}], ["home", "/", {}], ["area", "/a/ja", { lang: "ja" }]] as const) {
          const data = await ((await import(`../app/routes/${route}.tsx`)) as { loader: (a: never) => unknown }).loader(w.args(w.request(path, { as }), params));
          out[`${as} loader ${path}`] = withoutClock(JSON.stringify(data));
        }
        for (const path of [`/t/${id}.md`, "/latest.md", "/home.md", "/a/ja.md", "/latest.md?asks=1"]) out[`${as} ${path}`] = withoutClock(await (await getMd(w, path, { as })).text());
      }
      // The member exports (the route's body): nothing in them says how many came from which language, so they are the same bytes in both worlds
      for (const who of EXPORTERS) {
        const res = await w.outcome(() => import("~/routes/settings-export").then(async (mod) => (await mod.loader(w.args(w.request("/settings/export", { as: who }))))));
        const unclocked = (exported: { generated_at: string; profile: { created_at: string } | null }) => {
          exported.generated_at = "<time>";
          if (exported.profile) exported.profile.created_at = "<time>";
          return JSON.stringify(exported);
        };
        out[`${who} /settings/export`] = unclocked(JSON.parse(await (res.value as Response).text()));
        out[`${who} buildMemberExport`] = unclocked(JSON.parse(JSON.stringify(await buildMemberExport(w.db, w.ids[who], { now: t(60) }))));
      }
      // /vote: a member from a fourth language presses the question and takes it back; the answers carry the new state of the post
      const vote = await import("~/routes/vote");
      for (const on of ["1", "0"] as const) {
        const res = await w.outcome(() => vote.action(w.args(w.request("/vote", { as: "vi1", form: { entryId: String(id), on }, headers: { "sec-fetch-dest": "empty" } }))));
        out[`vi1 /vote on=${on}`] = withoutClock(JSON.stringify((res.value as { data?: unknown }).data ?? res.value));
      }
      return out;
    } finally {
      w.restore();
    }
  }

  it("is byte-identical for the loaders, the /vote answers, the thread twin and the list twins, for a member, a moderator, an operator and a member who pressed the same", { timeout: 60_000 }, async () => {
    const a = await observe(WORLD_A);
    const b = await observe(WORLD_B);
    expect(Object.keys(b)).toEqual(Object.keys(a));
    // the outputs are not empty, and they do carry the numbers (a comparison of two empty things would pass whatever leaked)
    expect(a[`watcher loader /t/1`]).toContain('"insightful":{"total":6,"langs":3}');
    expect(a["watcher /t/1.md"]).toMatch(/insightful: 6\n\s*insightful_langs: 3/);
    expect(a["vi1 /vote on=1"]).toContain('"total":7');
    for (const key of Object.keys(a)) expect(b[key], key).toBe(a[key]);
    // the check can fail: a world with another total is told apart (so that "identical" means something)
    const c = await observe({ ...WORLD_A, question: WORLD_A.question.slice(0, 5) });
    expect(c["watcher loader /t/1"]).not.toBe(a["watcher loader /t/1"]);
  });

  it("gives the member exports of the two worlds byte for byte (the export has the member's own rows, never a count, a total or a number of languages)", { timeout: 90_000 }, async () => {
    const a = await observe(WORLD_A);
    const b = await observe(WORLD_B);
    for (const who of EXPORTERS) {
      expect(b[`${who} /settings/export`], `${who} /settings/export`).toBe(a[`${who} /settings/export`]);
      expect(b[`${who} buildMemberExport`], `${who} buildMemberExport`).toBe(a[`${who} buildMemberExport`]);
      // the route and the function give the same body
      expect(a[`${who} /settings/export`], who).toBe(a[`${who} buildMemberExport`]);
    }
    // the export is not empty: ja1 has the press and the stance of its own, hana the question that got them, vi1 the reply
    const ja1 = JSON.parse(a["ja1 /settings/export"]) as { insightful: unknown[]; stances: Array<{ position: string }>; stance_changes: unknown[] };
    expect(ja1.insightful).toHaveLength(2);
    expect(ja1.stances.map((x) => x.position)).toEqual(["agree"]);
    expect(ja1.stance_changes).toHaveLength(1);
    expect(JSON.parse(a["hana /settings/export"]).entries).toHaveLength(1);
    expect(JSON.parse(a["vi1 /settings/export"]).entries).toHaveLength(1);
    // the check can fail: if the press of ja1 on the reply goes (a different own row), the export of ja1 is told apart; so is a different stance of ja1
    const c = await observe({ ...WORLD_A, reply: ["en1"] });
    expect(c["ja1 /settings/export"]).not.toBe(a["ja1 /settings/export"]);
    const d = await observe({ ...WORLD_A, stances: [["ja1", "disagree"], ...STANCES_A.slice(1)] });
    expect(d["ja1 /settings/export"]).not.toBe(a["ja1 /settings/export"]);
    // the other members' exports do not move with someone else's stance or press
    expect(d["watcher /settings/export"]).toBe(a["watcher /settings/export"]);
    expect(d["hana /settings/export"]).toBe(a["hana /settings/export"]);
  });
});

// The export paths and the operators' paths. The member's own export has the rows of the member (the language of a row is the language the member had at the time: the member's own
// voter_area, area and trigger_area), and nothing about anyone else: no total, no number of languages, no count per language. Per-language numbers are on the operators' paths only.
describe("the member export and the operators' paths", () => {
  // The keys that hold the member's own language at the time (they are the member's own, not a count of other members).
  const OWN_ROW_AREA_KEYS = ["voter_area", "area", "trigger_area"];
  const OWN_ROW_LISTS = ["insightful", "stances", "stance_changes"];
  const NO_TOTALS = ["total", "counts", "langs", "total_langs", "insightful_langs", "distribution", "composition"];

  function withoutOwnRowAreas(body: Record<string, unknown>): Record<string, unknown> {
    const copy = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    for (const list of OWN_ROW_LISTS) for (const row of (copy[list] ?? []) as Array<Record<string, unknown>>) for (const key of OWN_ROW_AREA_KEYS) delete row[key];
    return copy;
  }
  const keysDeep = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysDeep) : value && typeof value === "object" ? Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [k, ...keysDeep(v)]) : []);

  it("has no breakdown by language, no total and no number of languages, for a member, a moderator, an operator, the author of the question and the writer of a reply", async () => {
    for (const as of ["watcher", "jamod", "opal", "hana", "vi1", "ja1", "en1"]) {
      const res = await h.outcome(() => import("~/routes/settings-export").then(async (mod) => (await mod.loader(h.args(h.request("/settings/export", { as }))))));
      expect(res.status, as).toBe(200);
      const body = JSON.parse(await (res.value as Response).text()) as Record<string, unknown>;
      expect(findBreakdowns(withoutOwnRowAreas(body)), `${as}: the export`).toEqual([]);
      const keys = keysDeep(body);
      for (const name of NO_TOTALS) expect(keys, `${as}: ${name}`).not.toContain(name);
      // the three keys of the member's own language appear only in the member's own rows
      const rest = new Set(keysDeep(withoutOwnRowAreas(body)));
      for (const name of OWN_ROW_AREA_KEYS) expect(rest.has(name), `${as}: ${name} outside the member's own rows`).toBe(false);
    }
  });

  it("gives the member's own rows their own language and nothing else: ja1's stance row is one row, with its own area", async () => {
    const res = await h.outcome(() => import("~/routes/settings-export").then(async (mod) => (await mod.loader(h.args(h.request("/settings/export", { as: "ja1" }))))));
    const body = JSON.parse(await (res.value as Response).text()) as { stances: Array<Record<string, unknown>>; insightful: Array<Record<string, unknown>> };
    expect(body.stances).toHaveLength(1);
    expect(body.stances[0]).toMatchObject({ question_id: q, position: "agree", area: "ja" });
    expect(Object.keys(body.stances[0]).sort()).toEqual(["area", "created_at", "position", "question_id", "updated_at", "version"]);
    expect(body.insightful.length).toBeGreaterThan(0);
    for (const row of body.insightful) expect(Object.keys(row).sort()).toEqual(["created_at", "entry_id", "voter_area"]);
  });

  it("has no per-language count in the OpenAPI document (its examples and descriptions), /llms.txt and /help/ai.md", () => {
    expect(findBreakdowns(JSON.parse(JSON.stringify(openApiDocument())))).toEqual([]);
    for (const [name, text] of [["llms.txt", llmsTxt()], ["help/ai.md", helpAiMd()]] as const) {
      expect(text, name).not.toMatch(/^\s*(?:ja|en|fr|de|zh-Hant|zh-Hans|ko|th|vi|other): \d+/m);
      expect(text, name).not.toMatch(/\b(?:agree|disagree|neither)_by_(?:area|lang)/);
    }
  });

  it("/admin/metrics and /admin/export are for operators only (404 for a member and a moderator), and the per-language numbers are on those paths only", async () => {
    for (const route of ["admin-metrics", "admin-export"] as const) {
      const load = () => (route === "admin-metrics" ? import("~/routes/admin-metrics") : import("~/routes/admin-export")) as Promise<{ loader: (a: never) => unknown }>;
      const call = (as?: string) => h.outcome(() => load().then(async (mod) => (await mod.loader(h.args(h.request(`/${route.replace("-", "/")}`, { as }))))));
      for (const as of ["watcher", "jamod", "ja1"]) expect(await call(as), `${route} as ${as}`).toMatchObject({ status: 404 });
      expect(await call(), route).toMatchObject({ status: 302, location: `/login?next=${encodeURIComponent(`/${route.replace("-", "/")}`)}` });
      expect((await call("opal")).status, route).toBe(200);
    }
    // on the operators' path the numbers by language are there: the first stances of the four languages (4, 3, 2 and 1 members), summed across questions
    const metrics = await getMetrics(h.db, new Date("2026-10-06T00:00:00Z"));
    expect(metrics.firstStances.map((r) => [r.area, r.people])).toEqual([["ja", 4], ["en", 3], ["fr", 2], ["vi", 1]]);
    // and on the operators' export path the question has its totals and the number of languages only
    const { buildObservationExport } = await import("~/lib/exports.server");
    const exported = await buildObservationExport(h.db, { model: null, now: new Date("2026-10-06T00:00:00Z") });
    expect(exported.questions[0].distribution).toMatchObject({ total: 10, langs: 4 });
    expect(findBreakdowns(JSON.parse(JSON.stringify(exported.questions)))).toEqual([]);
  });
});
