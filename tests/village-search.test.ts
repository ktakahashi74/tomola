import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { profiles, rateLimits, villages, villageTranslations } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { villageName } from "~/lib/village-name";
import { searchVillages } from "~/lib/village-search.server";
import { villageSourceHash } from "~/lib/village-translations.server";
import { ensureLanguageVillages, listVillages } from "~/lib/villages.server";
import { MAX_QUERY_LENGTH } from "~/lib/search";
import { getMd } from "./helpers/md";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { setTestMessages } from "./stubs/paraglide-messages";
import { setTestLocale } from "./stubs/paraglide-runtime";
import en from "../messages/en.json";
import ja from "../messages/ja.json";
import { routeElement } from "./helpers/route-fixtures";

let h: RouteHarness;
let route: typeof import("~/routes/search");
let topicId: number;
beforeAll(async () => {
  vi.stubEnv("VILLAGES", "1");
  h = await setupRouteHarness();
  await ensureLanguageVillages(h.db);
  setTestMessages({
    village_language_name: (params, options) => (options?.locale === "ja" ? ja : en).village_language_name.replace("{language}", String(params?.language)),
    language_name_en: (_params, options) => (options?.locale === "ja" ? ja : en).language_name_en,
  });
  route = await import("~/routes/search");
  await h.signIn("village_seeker", { homeArea: "en", readLangs: ["en"] });
  await h.signIn("original_reader", { homeArea: "en", readLangs: ["en", "ja"] });
  await h.signIn("not_enrolled", { profile: false });
  await h.db.update(profiles).set({ displayName: "Fieldwork reader" }).where(eq(profiles.userId, h.ids.village_seeker));
  const add = async (slug: string, name: string, description = "", kind = "open") => {
    const [row] = await h.db.insert(villages).values({ slug, name, description, kind, sourceLang: "ja" }).returning();
    return row;
  };
  await add("fieldwork", "Fieldwork circle", "Shared observations");
  await add("description", "Other circle", "Follow the FIELDWORK notes", "invite_public");
  await add("width", "Ａｌｐｈａ ｶﾀｶﾅ", "ＢＥＴＡ notes");
  await add("literal", "Literal % _ \\", "Symbols % _ \\");
  await add("plain", "Literal X Y Z", "Symbols X Y Z");
  await add("closed", "Fieldwork closed", "", "closed");
  const ended = await add("ended", "Fieldwork ended");
  await h.db.update(villages).set({ endedAt: new Date() }).where(eq(villages.id, ended.id));
  const translated = await add("translated", "数学の集い", "証明の読み方");
  await h.db.insert(villageTranslations).values([
    { villageId: translated.id, lang: "en", name: "Geometry circle", description: "Euclidean proofs", state: "ready", sourceHash: villageSourceHash(translated) },
    { villageId: translated.id, lang: "fr", name: "Cercle géométrique", description: "Preuves euclidiennes", state: "ready", sourceHash: villageSourceHash(translated) },
  ]);
  for (const state of ["pending", "failed", "ready"] as const) {
    const row = await add(`invalid-${state}`, "古い集い");
    await h.db.insert(villageTranslations).values({ villageId: row.id, lang: "en", name: "Invalid translation", state, sourceHash: state === "ready" ? "0".repeat(64) : villageSourceHash(row) });
  }
  for (let i = 0; i < 12; i++) {
    await add(`cap-${String(i).padStart(2, "0")}`, "Limit names");
  }
  for (let i = 0; i < 60; i++) {
    const stale = await add(`before-cap-${i}`, "Original unrelated");
    await h.db.insert(villageTranslations).values({ villageId: stale.id, lang: "en", name: "Limit names", state: "ready", sourceHash: "0".repeat(64) });
  }
  await add("rank-z", "Ranking name");
  await add("rank-a", "Original name", "Ranking description");
  const rankTranslated = await add("rank-m", "訳の名前");
  await h.db.insert(villageTranslations).values({ villageId: rankTranslated.id, lang: "en", name: "Ranking translated", state: "ready", sourceHash: villageSourceHash(rankTranslated) });
  const rankStale = await add("rank-b", "Other name", "Ranking description");
  await h.db.insert(villageTranslations).values({ villageId: rankStale.id, lang: "en", name: "Ranking stale", state: "ready", sourceHash: "0".repeat(64) });
  const topic = await createTopic(h.db, h.ids.village_seeker, { lang: "en", title: "Fieldwork post", body: "Fieldwork observations", village: "@village_seeker" });
  if (!topic.ok) throw new Error(topic.error);
  topicId = topic.id;
});
afterAll(() => { h.restore(); setTestMessages(); vi.unstubAllEnvs(); });

const slugs = async (query: string, lang: "en" | "fr" = "en") => (await searchVillages(h.db, query, lang)).map(row => row.slug);
const load = async (query: string, suffix = "") => route.loader(h.args(h.request(`/search?q=${encodeURIComponent(query)}&lang=en${suffix}`, { as: "village_seeker" })));
const dataOf = (value: Awaited<ReturnType<typeof load>>) => "data" in value ? value.data : value;

describe("village matching", () => {
  it("matches original name and description substrings, including open and invitation-only villages", async () => {
    expect(await slugs("ieldwork")).toEqual(["fieldwork", "description"]);
    expect(await slugs("数学")).toEqual(["translated"]);
    expect(await slugs("読み方")).toEqual(["translated"]);
  });

  it("matches only current ready translations in the display language and returns original rows", async () => {
    expect(await slugs("Geometry")).toEqual(["translated"]);
    expect(await slugs("Euclidean")).toEqual(["translated"]);
    expect((await searchVillages(h.db, "Geometry", "en"))[0]).toMatchObject({ name: "数学の集い", description: "証明の読み方", language: null });
    expect(await slugs("géométrique")).toEqual([]);
    expect(await slugs("géométrique", "fr")).toEqual(["translated"]);
    expect(await slugs("Geometry", "fr")).toEqual([]);
    expect(await slugs("Invalid translation")).toEqual([]);
    expect((await searchVillages(h.db, "古い", "en")).every(row => row.name === "古い集い")).toBe(true);
  });

  it("normalizes width and case and escapes LIKE metacharacters in both fields", async () => {
    for (const query of ["alpha", "ＡＬＰＨＡ", "カタカナ", "ｶﾀｶﾅ", "beta", "ｂｅｔａ"]) expect(await slugs(query)).toEqual(["width"]);
    for (const query of ["%", "_", "\\", "％", "＿", "＼", "Symbols %", "Literal %"]) expect(await slugs(query), query).toEqual(["literal"]);
  });

  it("shares directory visibility, excludes ended, closed and personal villages, and finds generated language names", async () => {
    const directory = await listVillages(h.db);
    const visible = new Set(directory.map(row => row.slug));
    expect(visible.has("closed")).toBe(false);
    expect(visible.has("ended")).toBe(false);
    const found = await searchVillages(h.db, "village", "en");
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(row => visible.has(row.slug) && row.kind !== "personal")).toBe(true);
    expect(found.some(row => row.language && villageName(row, "en").includes("village"))).toBe(true);
    expect(await slugs(en.language_name_en)).toContain("en");
    expect(await slugs("Fieldwork")).toEqual(["fieldwork", "description"]);
  });

  it("ranks names before descriptions, orders ties by slug and limits after excluding stale matches", async () => {
    expect(await slugs("Ranking")).toEqual(["rank-m", "rank-z", "rank-a", "rank-b"]);
    expect(await slugs("Limit")).toEqual(Array.from({ length: 10 }, (_, i) => `cap-${String(i).padStart(2, "0")}`));
  });

  it("matches generated names in the interface language when the display language differs", async () => {
    setTestLocale("ja");
    try {
      expect(await slugs(ja.village_language_name.replace("{language}", ja.language_name_en))).toContain("en");
      expect(await slugs(en.village_language_name.replace("{language}", en.language_name_en))).not.toContain("en");
    } finally { setTestLocale("en"); }
  });

  it("keeps later name matches ahead of descriptions across candidate batches", async () => {
    await h.db.insert(villages).values([
      ...Array.from({ length: 55 }, (_, i) => ({ slug: `batch-a-${String(i).padStart(2, "0")}`, name: "Other name", description: "Batch priority", kind: "open" })),
      ...Array.from({ length: 12 }, (_, i) => ({ slug: `batch-z-${String(i).padStart(2, "0")}`, name: "Batch priority", kind: "open" })),
    ]);
    expect(await slugs("Batch priority")).toEqual(Array.from({ length: 10 }, (_, i) => `batch-z-${String(i).padStart(2, "0")}`));
  });
});

describe("village results on the search screen", () => {
  it("renders name links without icons or descriptions before members and unchanged post results", async () => {
    const screen = dataOf(await load("Fieldwork"));
    expect(screen.villages.map(row => row.slug)).toEqual(["fieldwork", "description"]);
    expect(screen.members).toEqual([{ handle: "village_seeker", name: "Fieldwork reader" }]);
    expect(screen.hits.some(hit => hit.id === topicId)).toBe(true);
    const html = await renderInRouter(() => routeElement(route.default, { loaderData: screen }), "/search");
    const start = html.indexOf('<section aria-labelledby="search-villages-heading"');
    const end = html.indexOf("</section>", start);
    const section = html.slice(start, end);
    expect(section).toContain('href="/v/fieldwork?lang=en"');
    expect(section).toContain("Fieldwork circle");
    expect(section).not.toContain("Shared observations");
    expect(section).not.toContain("<img");
    expect(end).toBeLessThan(html.indexOf('aria-labelledby="search-members-heading"'));
    expect(end).toBeLessThan(html.indexOf('href="/search.md?'));
    const translated = dataOf(await load("Geometry"));
    const translatedHtml = await renderInRouter(() => routeElement(route.default, { loaderData: translated }), "/search");
    expect(translatedHtml).toContain("Geometry circle");
    expect(translatedHtml).toContain('title="数学の集い"');
  });

  it("shows original names to readers of the source language while still matching translations", async () => {
    const screen = dataOf(await route.loader(h.args(h.request("/search?q=Geometry", { as: "original_reader" }))));
    expect(screen.villages).toMatchObject([{ slug: "translated", name: "数学の集い" }]);
    const html = await renderInRouter(() => routeElement(route.default, { loaderData: screen }), "/search");
    expect(html).toContain('href="/v/translated"');
    expect(html).toContain("数学の集い");
    expect(html).not.toContain("Geometry circle");
    expect(html).not.toContain('title="数学の集い"');
    const overridden = dataOf(await route.loader(h.args(h.request("/search?q=Geometry&lang=en", { as: "original_reader" }))));
    expect(overridden.villages).toMatchObject([{ slug: "translated", name: "Geometry circle", translation: { originalName: "数学の集い", shown: true } }]);
  });

  it("omits unmatched and scoped results, including an explicitly empty scope", async () => {
    for (const suffix of ["&village=fieldwork", "&village=@village_seeker", "&village=missing", "&village="]) {
      expect(dataOf(await load("Fieldwork", suffix)).villages).toEqual([]);
    }
    const screen = dataOf(await load("no-such-village"));
    const html = await renderInRouter(() => routeElement(route.default, { loaderData: screen }), "/search");
    expect(html).not.toContain("search-villages-heading");
  });

  it("requires membership in both reading modes and respects the feature flag", async () => {
    for (const publicReading of ["", "1"]) {
      vi.stubEnv("PUBLIC_READING", publicReading);
      expect(await h.outcome(() => route.loader(h.args(h.request("/search?q=Fieldwork"))))).toMatchObject({ status: 302, location: "/login?next=%2Fsearch%3Fq%3DFieldwork" });
      expect(await h.outcome(() => route.loader(h.args(h.request("/search?q=Fieldwork", { as: "not_enrolled" }))))).toMatchObject({ status: 302 });
    }
    vi.stubEnv("PUBLIC_READING", "");
    vi.stubEnv("VILLAGES", "");
    try { expect(dataOf(await load("Fieldwork")).villages).toEqual([]); }
    finally { vi.stubEnv("VILLAGES", "1"); }
  });

  it("uses one shared allowance and returns no villages for invalid, empty or limited queries", async () => {
    const key = `member:search:${h.ids.village_seeker}`;
    await h.db.delete(rateLimits).where(eq(rateLimits.key, key));
    expect(dataOf(await load("Fieldwork")).villages).toHaveLength(2);
    expect((await h.db.select().from(rateLimits).where(eq(rateLimits.key, key)))[0].count).toBe(1);
    expect(dataOf(await load("x".repeat(MAX_QUERY_LENGTH + 1)))).toMatchObject({ state: "too_long", villages: [] });
    expect(dataOf(await load(" "))).toMatchObject({ state: "start", villages: [] });
    await h.db.update(rateLimits).set({ count: 60 }).where(eq(rateLimits.key, key));
    expect(dataOf(await load("Fieldwork"))).toMatchObject({ state: "rate_limited", villages: [] });
    await h.db.delete(rateLimits).where(eq(rateLimits.key, key));
  });

  it("keeps village results out of Markdown and plain text search", async () => {
    for (const extension of ["md", "txt"]) {
      const response = await getMd(h, `/search.${extension}?q=Geometry&lang=en`, { as: "village_seeker" });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("Geometry circle");
      expect(text).not.toContain("/v/translated");
    }
  });
});
