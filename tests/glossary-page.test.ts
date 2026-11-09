import { messageText } from "~/lib/i18n/messages";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { glossaryEntries, glossaryRevisions, profiles } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { PRINCIPLES_PAGE_READY } from "~/lib/glossary-page.server";
import { createGlossaryEntry, deleteGlossaryEntry, updateGlossaryEntry, type GlossaryActor } from "~/lib/glossary.server";
import { grantModerator } from "~/lib/roles.server";
import { createApiToken } from "~/lib/tokens.server";
import { getGlossaryVersion } from "~/lib/translations.server";
import { parseBlocks } from "./helpers/md";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { setTestLocale } from "./stubs/paraglide-runtime";
import en from "../messages/en.json";
import ja from "../messages/ja.json";

// /glossary and /glossary.md: entries, latest updater and history showing who changed what, when and from which proposal. Every member may read.

const day = (n: number, h = 0) => new Date(Date.UTC(2026, 9, n, h));
let h: RouteHarness;
let ids: Record<string, string>;
let entry: Record<string, number>;
let topicId: number;
const saved = process.env.OPERATOR_EMAILS;
beforeEach(() => setTestLocale("ja"));
afterEach(() => setTestLocale("en"));

type Item = {
  id: number;
  term: string;
  lang: string;
  targetLang: string;
  candidates: string[];
  note: string;
  keepOriginal: boolean;
  needsReview: boolean;
  deleted: boolean;
  lastBy: string | null;
  lastAt: string;
  canEdit: boolean;
  historyTotal: number;
  history: Array<{ id: number; kind: string; at: string; by: string | null; before: unknown; after: unknown; proposalId: number | null }>;
};
type PageData = { query: { from: string | null; to: string | null; deleted: boolean; page: number }; langs: string[]; canEditAny: boolean; objectionPath: string | null; alternate: string; aiOpen: { mdUrl: string; mdPath: string }; page: number; hasNext: boolean; items: Item[] };

beforeAll(async () => {
  process.env.OPERATOR_EMAILS = "boss@example.com";
  h = await setupRouteHarness();
  await h.signIn("boss", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("jamod", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("aki", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("ben", { homeArea: "en", readLangs: ["en", "ja"] });
  await h.signIn("susp", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("halfway", { profile: false });
  ids = h.ids;
  await grantModerator(h.db, ids.boss, ids.jamod, "ja");
  await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86_400_000), suspendedReason: "spam" }).where(eq(profiles.userId, ids.susp));
  const topic = await createTopic(h.db, ids.aki, { lang: "ja", title: "「alignment」を日本語で「」と訳す", body: "- 語：`alignment`", asksStance: true });
  if (!topic.ok) throw new Error("topic failed");
  topicId = topic.id;

  const boss: GlossaryActor = { userId: ids.boss, scope: { operator: true, langs: [] } };
  const jamod: GlossaryActor = { userId: ids.jamod, scope: { operator: false, langs: ["ja"] } };
  entry = {};
  const make = async (key: string, input: Parameters<typeof createGlossaryEntry>[2], now: Date) => {
    const res = await createGlossaryEntry(h.db, boss, input, { now });
    if (!res.ok) throw new Error(`create ${key} failed: ${res.error}`);
    entry[key] = res.id;
  };
  await make("enJa", { term: "alignment", lang: "en", targetLang: "ja", candidates: "アラインメント", note: "AI safety" }, day(1));
  await make("jaEn", { term: "整合性", lang: "ja", targetLang: "en", candidates: "alignment" }, day(1));
  await make("enFr", { term: "alignment", lang: "en", targetLang: "fr", candidates: "alignement", needsReview: true, keepOriginal: true }, day(1));
  await make("gone", { term: "corrigibility", lang: "en", targetLang: "ja", candidates: "修正可能性" }, day(1));
  // Moderator jamod changes candidates based on aki's proposal; an operator deletes another entry.
  expect(await updateGlossaryEntry(h.db, jamod, entry.enJa, { term: "alignment", candidates: "アラインメント\nアライメント", note: "AI safety" }, { now: day(2), proposal: `/t/${topicId}` })).toEqual({ ok: true, changed: true });
  expect(await deleteGlossaryEntry(h.db, boss, entry.gone, { now: day(3) })).toEqual({ ok: true });
  // An entry without an updater, backfilled by migration with updated_by=null.
  const [orphan] = await h.db.insert(glossaryEntries).values({ term: "orphan", lang: "en", targetLang: "ja", candidates: ["孤児"], updatedAt: day(4) }).returning({ id: glossaryEntries.id });
  await h.db.insert(glossaryRevisions).values({ entryId: orphan.id, before: null, after: { term: "orphan", candidates: ["孤児"], note: "", keepOriginal: false, needsReview: false }, editorId: null, via: "import", createdAt: day(4) });
  entry.orphan = orphan.id;
  // Many German-target entries for pagination; no history needed.
  await h.db.insert(glossaryEntries).values(Array.from({ length: 120 }, (_, i) => ({ term: `bulk-${String(i).padStart(3, "0")}`, lang: "en", targetLang: "de", candidates: [`x${i}`], updatedAt: day(5) })));
});
afterAll(() => {
  h.restore();
  if (saved === undefined) delete process.env.OPERATOR_EMAILS;
  else process.env.OPERATOR_EMAILS = saved;
});

const page = async () => import("~/routes/glossary");
const load = (query: string, as: string | null = "aki") => h.outcome(async () => (await (await page()).loader(h.args(h.request(`/glossary${query}`, { as: as ?? undefined })))));
const data = async (query: string, as = "aki") => (await load(query, as)).value as PageData;

describe("/glossary", () => {
  it("opens for every member, including a suspended one; a visitor goes to the login and a user mid-signup to onboarding", async () => {
    expect(await load("", null)).toMatchObject({ status: 302, location: "/login?next=%2Fglossary" });
    expect(await load("", "halfway")).toMatchObject({ status: 302, location: "/onboarding" });
    for (const as of ["aki", "ben", "susp", "jamod", "boss"]) expect((await load("", as)).status, as).toBe(200);
  });

  it("lists the entries of the viewer's display language (the target), every term language, in the order of the terms, with the last editor and date and the history", async () => {
    const d = await data("");
    expect(d.query).toEqual({ from: null, to: "ja", deleted: false, page: 1 });
    expect(d.items.map((e) => [e.term, e.lang, e.targetLang])).toEqual([["alignment", "en", "ja"], ["orphan", "en", "ja"]]);
    const [align, orphan] = d.items;
    expect(align).toMatchObject({ id: entry.enJa, candidates: ["アラインメント", "アライメント"], note: "AI safety", keepOriginal: false, needsReview: false, deleted: false, lastBy: "@jamod", lastAt: "2026-10-02", canEdit: false });
    // History newest first: type, before/after content, actor, date and source proposal.
    expect(align.history.map((r) => [r.kind, r.at, r.by, r.proposalId])).toEqual([["updated", "2026-10-02", "@jamod", topicId], ["created", "2026-10-01", "@boss", null]]);
    expect(align.history[0].before).toEqual({ term: "alignment", candidates: ["アラインメント"], note: "AI safety", keepOriginal: false, needsReview: false });
    expect(align.history[0].after).toEqual({ term: "alignment", candidates: ["アラインメント", "アライメント"], note: "AI safety", keepOriginal: false, needsReview: false });
    expect(align.history[1].before).toBeNull();
    // Without an actor record, by is null and the screen shows "記録なし".
    expect(orphan).toMatchObject({ lastBy: null, lastAt: "2026-10-04" });
    expect(orphan.history.map((r) => [r.kind, r.by])).toEqual([["created", null]]);
    // Viewer ben, whose display language is English, receives English-target entries.
    setTestLocale("en");
    const ben = await data("", "ben");
    expect(ben.query.to).toBe("en");
    expect(ben.items.map((e) => e.term)).toEqual(["整合性"]);
  });

  it("defaults the target to the current interface, independently of the page lang override", async () => {
    setTestLocale("en");
    expect((await data("?lang=fr")).query.to).toBe("en");
    expect((await data("?to=ja")).query.to).toBe("ja");
    setTestLocale("ja");
    expect((await data("")).query.to).toBe("ja");
  });

  it("filters by the language of the term and the target language (an invalid value falls back to the default), and shows the deleted entries with their history", async () => {
    expect((await data("?to=fr")).items.map((e) => [e.term, e.keepOriginal, e.needsReview])).toEqual([["alignment", true, true]]);
    expect((await data("?from=ja&to=en")).items.map((e) => e.term)).toEqual(["整合性"]);
    expect((await data("?from=ja")).items).toEqual([]);
    expect((await data("?to=xx")).query.to).toBe("ja");
    expect((await data("?from=xx&to=en")).query).toMatchObject({ from: null, to: "en" });
    // ?lang= selects display language, not glossary filtering.
    expect((await data("?lang=fr")).query.to).toBe("ja");
    const deleted = await data("?deleted=1");
    expect(deleted.items.map((e) => [e.term, e.deleted, e.lastBy, e.lastAt])).toEqual([["corrigibility", true, "@boss", "2026-10-03"]]);
    expect(deleted.items[0].history.map((r) => r.kind)).toEqual(["deleted", "created"]);
    expect(deleted.items[0].history[0].after).toBeNull();
  });

  it("pages by 100 entries (a bad page is a 404)", async () => {
    const first = await data("?to=de");
    expect(first.items).toHaveLength(100);
    expect(first.hasNext).toBe(true);
    expect(first.items[0].term).toBe("bulk-000");
    const second = await data("?to=de&page=2");
    expect(second.items).toHaveLength(20);
    expect(second.hasNext).toBe(false);
    expect(second.items[0].term).toBe("bulk-100");
    expect((await load("?page=0")).status).toBe(404);
    expect((await load("?page=abc")).status).toBe(404);
  });

  it("shows the newest 20 changes of an entry and says how many there are; ?history=all shows every change", async () => {
    const boss: GlossaryActor = { userId: ids.boss, scope: { operator: true, langs: [] } };
    const made = await createGlossaryEntry(h.db, boss, { term: "many changes", lang: "en", targetLang: "ko", candidates: "v0" }, { now: day(10) });
    if (!made.ok) throw new Error("create failed");
    for (let i = 1; i <= 24; i++) await updateGlossaryEntry(h.db, boss, made.id, { term: "many changes", candidates: `v${i}` }, { now: day(10, i) });
    const capped = (await data("?to=ko")).items.find((e) => e.id === made.id)!;
    expect(capped.historyTotal).toBe(25);
    expect(capped.history).toHaveLength(20);
    // Newest first: v24 down to v5
    expect(capped.history.map((r) => (r.after as { candidates: string[] }).candidates[0])).toEqual(Array.from({ length: 20 }, (_, i) => `v${24 - i}`));
    const all = (await data("?to=ko&history=all")).items.find((e) => e.id === made.id)!;
    expect(all.historyTotal).toBe(25);
    expect(all.history).toHaveLength(25);
    expect(all.history.at(-1)?.kind).toBe("created");
    // An entry with a few changes is shown in full, with no cap
    expect((await data("")).items[0].history.length).toBe((await data("")).items[0].historyTotal);
  });

  it("offers the edit link only for the entries the viewer can edit; a member without a role gets none", async () => {
    expect((await data("")).items.every((e) => !e.canEdit)).toBe(true);
    expect((await data("")).canEditAny).toBe(false);
    const mod = await data("?to=ja", "jamod");
    expect(mod.items.map((e) => [e.term, e.canEdit])).toEqual([["alignment", true], ["orphan", true]]);
    expect(mod.canEditAny).toBe(true);
    // A Japanese moderator cannot edit English-target entries.
    expect((await data("?to=en", "jamod")).items.map((e) => e.canEdit)).toEqual([false]);
    expect((await data("?to=en", "boss")).items.map((e) => e.canEdit)).toEqual([true]);
  });

  it("has no list of proposals, no count of stances and no list of the people in charge in its data; the objection link waits for the /principles page", async () => {
    const d = await load("");
    expect(Object.keys(d.value as object).sort()).toEqual(["alternate", "aiOpen", "canEditAny", "hasNext", "items", "langs", "objectionPath", "page", "query"].sort());
    expect(JSON.stringify(d.value)).not.toMatch(/stance|moderator|votes?\b/i);
    const principles = path.join(import.meta.dirname, "..", "app", "routes", "principles.tsx");
    // When /principles is implemented, set PRINCIPLES_PAGE_READY=true to show its link.
    expect(PRINCIPLES_PAGE_READY, "the /principles route exists: set PRINCIPLES_PAGE_READY to true in app/lib/glossary-page.server.ts").toBe(fs.existsSync(principles));
    expect((d.value as PageData).objectionPath).toBe(PRINCIPLES_PAGE_READY ? "/principles#objections" : null);
  });

  it("explains that an entry is a recommendation, that a change does not touch the existing translations, and that adoption is not decided by the number of stances", () => {
    for (const messages of [en, ja] as Array<Record<string, string>>) {
      for (const key of ["glossary_intro", "glossary_scope_note", "glossary_decide_note"]) expect(messages[key].length, key).toBeGreaterThan(20);
    }
    expect(en.glossary_decide_note).toContain("not by the number of stances");
    expect(en.glossary_decide_note).toContain("operator or the moderator of the target language");
    expect(ja.glossary_decide_note).toContain("立場の数では決まりません");
    expect(en.glossary_scope_note).toContain("Translations that already exist do not change");
    expect(en.glossary_intro).toContain("not requirements");
    // Do not imply numeric acceptance criteria, discuss AI usage or mention agibook.
    for (const text of [...Object.entries(en), ...Object.entries(ja)].filter(([k]) => /^(glossary_|proposal_)/.test(k)).map(([, v]) => v)) {
      expect(messageText(text)).not.toMatch(/agibook|majority|most votes|賛成が多/i);
    }
  });
});

// ---- Markdown twin ----

const mdLoader = async (query: string, init: { as?: string; headers?: Record<string, string>; method?: string } = {}) => {
  const req = h.request(`/glossary.md${query}`, { as: init.as, headers: init.headers });
  return (await (await import("~/routes/glossary-md")).loader(h.args(init.method ? new Request(req, { method: init.method }) : req))) as Awaited<Promise<Response>>;
};
// Structure: initial frontmatter block, item-array body, then pagination block. parseBlocks associates body text with the preceding block.
const mdBody = async (query: string, as = "aki") => {
  const res = await mdLoader(query, { as });
  expect(res.status).toBe(200);
  const blocks = parseBlocks(await res.text());
  return { res, blocks, items: (parse(blocks[0].body, { schema: "core" }) ?? []) as Array<Record<string, unknown>> };
};

describe("/glossary.md", () => {
  it("needs the same authentication as the other Markdown twins: 401 for a visitor, a read token reads, a draft token is refused (403)", async () => {
    expect((await mdLoader("")).status).toBe(401);
    const read = await createApiToken(h.db, ids.aki, { name: "r", kind: "read" });
    const draft = await createApiToken(h.db, ids.aki, { name: "d", kind: "draft" });
    if (!read.ok || !draft.ok) throw new Error("token failed");
    const ok = await mdLoader("", { headers: { authorization: `Bearer ${read.token}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect((await mdLoader("", { headers: { authorization: `Bearer ${draft.token}` } })).status).toBe(403);
    expect((await mdLoader("", { as: "aki", method: "POST" })).status).toBe(405);
    const head = await mdLoader("", { as: "aki", method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("says what the page says: the entries with the last editor, and the history with the editor, the change, before and after, and the proposal post (its URL and its Markdown twin); the glossary version and the trust note are in the frontmatter", async () => {
    const { blocks, items } = await mdBody("?to=ja");
    expect(blocks[0].fm).toMatchObject({ type: "glossary", title: "Glossary: recommended translations", to: "ja", content_trust: "untrusted_user_content" });
    expect(blocks[0].fm.glossary_version).toBe(await getGlossaryVersion(h.db));
    expect(String(blocks[0].fm.canonical)).toMatch(/\/glossary\?to=ja$/);
    expect(items.map((i) => i.id)).toEqual([`g-${entry.enJa}`, `g-${entry.orphan}`]);
    const [align, orphan] = items as Array<Record<string, unknown> & { history: Array<Record<string, unknown>> }>;
    expect(align).toMatchObject({ term: "alignment", lang: "en", target_lang: "ja", candidates: ["アラインメント", "アライメント"], note: "AI safety", keep_original: false, needs_review: false, last_edited_by: "@jamod", last_edited_at: "2026-10-02T00:00:00Z" });
    expect(align.history.map((r) => [r.change, r.by, r.at])).toEqual([["updated", "@jamod", "2026-10-02T00:00:00Z"], ["created", "@boss", "2026-10-01T00:00:00Z"]]);
    expect(align.history[0]).toMatchObject({ before: { term: "alignment", candidates: ["アラインメント"], keep_original: false, needs_review: false }, after: { candidates: ["アラインメント", "アライメント"] } });
    expect(String(align.history[0].proposal)).toMatch(new RegExp(`/t/${topicId}$`));
    expect(String(align.history[0].proposal_md)).toMatch(new RegExp(`/t/${topicId}\\.md$`));
    expect(align.history[1]).not.toHaveProperty("before");
    expect(align.history[1]).not.toHaveProperty("proposal");
    // Omit the actor key entirely when no updater is recorded.
    expect(orphan).not.toHaveProperty("last_edited_by");
    expect(orphan.history[0]).not.toHaveProperty("by");
    expect(blocks[1].fm).toMatchObject({ type: "index", page: 1, next: null });
  });

  it("takes the same arguments as the page, but the default is no filter, whoever reads (400 invalid_lang for a bad language, 404 for a bad page); ?deleted=1 lists the deleted entries", async () => {
    const all = await mdBody("");
    const ben = await mdBody("", "ben");
    expect(all.items.map((i) => i.id)).toEqual(ben.items.map((i) => i.id));
    expect(all.items.length).toBe(100);
    expect(all.blocks[1].fm.next).toMatch(/\/glossary\.md\?page=2$/);
    // 125 total: four entries, 120 German-target entries and one added by the history-limit test. Page two has 25; later pages are empty.
    expect((await mdBody("?page=2")).items).toHaveLength(25);
    expect(await (await mdLoader("?page=3", { as: "aki" })).text()).toContain("No entries.");
    expect((await mdBody("?to=fr&from=en")).items.map((i) => [i.term, i.needs_review, i.keep_original])).toEqual([["alignment", true, true]]);
    const bad = await mdLoader("?to=xx", { as: "aki" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("invalid_lang");
    expect((await mdLoader("?from=xx", { as: "aki" })).status).toBe(400);
    expect((await mdLoader("?page=0", { as: "aki" })).status).toBe(404);
    const deleted = await mdBody("?deleted=1");
    expect(deleted.items).toHaveLength(1);
    expect(deleted.items[0]).toMatchObject({ term: "corrigibility", deleted: true, last_edited_by: "@boss" });
    expect(deleted.blocks[0].fm).toMatchObject({ deleted: true });
    // Ignore ?lang=, the translation selector.
    expect((await mdBody("?lang=en&to=fr")).items).toHaveLength(1);
  });

  it("has no user id and no e-mail address anywhere in the text (the handles are all it says about people)", async () => {
    for (const query of ["", "?to=ja", "?deleted=1", "?to=ko"]) {
      const text = await (await mdLoader(query, { as: "aki" })).text();
      for (const [handle, userId] of Object.entries(ids)) {
        expect(text, `user id of ${handle} in ${query}`).not.toContain(userId);
        expect(text, `e-mail of ${handle}`).not.toContain(`${handle}@example.com`);
      }
      expect(text).not.toMatch(/@example\.com|"email"|user_id|editor_id|updated_by/i);
    }
  });

  it("keeps a query credential out of the next-page link, like the other twins", async () => {
    const read = await createApiToken(h.db, ids.aki, { name: "k", kind: "read" });
    if (!read.ok) throw new Error("token failed");
    const res = await mdLoader(`?k=${read.token}&to=de`);
    const blocks = parseBlocks(await res.text());
    expect(String(blocks[1].fm.next)).not.toContain("k=");
    expect(JSON.stringify(blocks)).not.toContain(read.token);
    expect(String(blocks[1].fm.next)).toContain("to=de");
    expect(String(blocks[1].fm.next)).toContain("page=2");
  });

  it("does not appear in the change feed or the manifest (it is a list page: the version in the frontmatter says whether it changed)", async () => {
    const feed = await (await import("~/routes/changes-md")).loader(h.args(h.request("/changes.md?since=2026-01-01", { as: "aki" }))) as Response;
    const manifest = await (await import("~/routes/manifest")).loader(h.args(h.request("/manifest.json", { as: "aki" }))) as Response;
    for (const res of [feed, manifest]) {
      expect(res.status).toBe(200);
      expect(await res.text()).not.toMatch(/glossary|g-\d+/i);
    }
  });
});

// ---- the enabled languages: the page and its Markdown twin offer and accept only the languages of the site ----
describe("the glossary and ENABLED_LANGS", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("offers the two enabled languages as the filter choices; the entries whose target is fr are not listed; ?to=fr and ?from=fr fall back to the defaults", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const d = await data("");
    expect(d.langs).toEqual(["ja", "en"]);
    expect(d.items.map((e) => e.targetLang)).toEqual(["ja", "ja"]);
    // fr is not enabled: ?to=fr is the default (the viewer's display language, ja), and no entry whose target is fr is listed
    const to = await data("?to=fr");
    expect(to.query).toMatchObject({ from: null, to: "ja" });
    expect(to.items.map((e) => e.term)).toEqual(["alignment", "orphan"]);
    expect(to.items.some((e) => e.targetLang === "fr")).toBe(false);
    // ?from=fr is "any language of the term"
    expect((await data("?from=fr&to=en")).query).toMatchObject({ from: null, to: "en" });
    expect((await data("?from=en&to=en")).query).toMatchObject({ from: "en", to: "en" });
    // The current English interface selects the English target.
    setTestLocale("en");
    expect((await data("", "ben")).query.to).toBe("en");
  });

  it("with every language enabled (the development default) fr is a choice and ?to=fr filters", async () => {
    const d = await data("?to=fr");
    expect(d.langs).toEqual(["ja", "en", "fr", "de", "zh-Hant", "zh-Hans", "ko", "th", "vi"]);
    expect(d.query.to).toBe("fr");
    expect(d.items.map((e) => e.term)).toEqual(["alignment"]);
  });

  it("the Markdown twin answers 400 invalid_lang for a language that is not enabled, naming the enabled ones, and still accepts an enabled one", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    for (const query of ["?to=fr", "?from=fr", "?from=en&to=fr"]) {
      const res = await mdLoader(query, { as: "aki" });
      expect(res.status, query).toBe(400);
      const text = await res.text();
      expect(text).toContain("invalid_lang");
      expect(text).toContain("ja, en");
    }
    expect((await mdLoader("?to=ja&from=en", { as: "aki" })).status).toBe(200);
    expect((await mdBody("?to=ja")).items.map((i) => i.term)).toEqual(["alignment", "orphan"]);
  });

  it("the YAML download and /admin/glossary keep the entries of all nine languages", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const res = (await (await import("~/routes/glossary-export")).loader(h.args(h.request("/glossary.yaml", { as: "aki" })))) as Response;
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("alignement");
    expect(text).toContain("x0");
  });
});
