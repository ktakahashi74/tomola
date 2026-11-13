import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { divergences, drafts, entries, entryEmbeddings, profiles, rateLimits, translations, votes } from "~/lib/db/schema";
import { createDraft } from "~/lib/drafts.server";
import { createReply, createTopic, editEntry, softDeleteEntry } from "~/lib/entries.server";
import { authorKeyOf, AUTHOR_KEY_LENGTH, buildMemberExport, buildObservationExport, MEMBER_EXPORT_VERSION, OBSERVATION_EXPORT_VERSION } from "~/lib/exports.server";
import { FLAG_JUDGED } from "~/lib/llm/flags";
import { fakeEmbeddingVector, FAKE_EMBEDDING_MODEL } from "~/lib/llm/engines/fake-embedding.server";
import { setFollow } from "~/lib/follows.server";
import { hideEntry } from "~/lib/moderation.server";
import { MEMBER_RATE_LIMITS } from "~/lib/rate-limit.server";
import { setVote } from "~/lib/votes.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Exports: operator observation excludes email, user IDs, handles, titles and bodies. Personal exports exclude other members' personal data.
const savedOperators = process.env.OPERATOR_EMAILS;
let h: RouteHarness;
const ids: Record<string, number> = {};

beforeAll(async () => {
  process.env.OPERATOR_EMAILS = "oscar.operator@example.com";
  h = await setupRouteHarness();
  await h.signIn("hanako_unique", { homeArea: "ja", readLangs: ["ja", "en"], email: "hanako.secret@example.com" });
  await h.signIn("johnny_unique", { homeArea: "en", readLangs: ["en"], email: "johnny.secret@example.com" });
  await h.signIn("somchai_unique", { homeArea: "th", readLangs: ["th"], email: "somchai.secret@example.com" });
  await h.signIn("oscar_unique", { homeArea: "en", readLangs: ["en"], email: "oscar.operator@example.com" });
  const day = (n: number) => new Date(Date.UTC(2026, 8, n));
  const mk = async (as: string, input: Record<string, unknown>, at: Date) => {
    const res = await createTopic(h.db, h.ids[as], input, { now: at });
    if (!res.ok) throw new Error("topic failed");
    return res.id;
  };
  ids.hanakoTopic = await mk("hanako_unique", { lang: "ja", title: "SECRET-TITLE-hanako", body: "SECRET-BODY-hanako", aiAssistance: "draft" }, day(1));
  ids.johnnyTopic = await mk("johnny_unique", { lang: "en", title: "SECRET-TITLE-johnny", body: "SECRET-BODY-johnny" }, day(2));
  ids.somchaiHidden = await mk("somchai_unique", { lang: "th", title: "SECRET-TITLE-hidden", body: "SECRET-BODY-hidden" }, day(3));
  ids.johnnyDeleted = await mk("johnny_unique", { lang: "en", title: "SECRET-TITLE-deleted", body: "SECRET-BODY-deleted" }, day(4));
  const reply = await createReply(h.db, h.ids.johnny_unique, ids.hanakoTopic, { lang: "en", body: "SECRET-REPLY-johnny", aiAssistance: "polish" }, { now: day(5) });
  if (!reply.ok) throw new Error("reply failed");
  ids.johnnyReply = reply.id;
  const hanakoHidden = await mk("hanako_unique", { lang: "ja", title: "SECRET-TITLE-hanako-hidden", body: "SECRET-BODY-hanako-hidden" }, day(6));
  ids.hanakoHidden = hanakoHidden;
  const hanakoDeleted = await mk("hanako_unique", { lang: "ja", title: "SECRET-TITLE-hanako-deleted", body: "SECRET-BODY-hanako-deleted" }, day(7));
  ids.hanakoDeleted = hanakoDeleted;
  await editEntry(h.db, h.ids.hanako_unique, ids.hanakoTopic, { title: "SECRET-TITLE-hanako-v2", body: "SECRET-BODY-hanako-v2" }, { now: day(8) });
  const actor = { id: h.ids.oscar_unique, scope: { operator: true, langs: [] } };
  await hideEntry(h.db, actor, { entryId: ids.somchaiHidden, reason: "spam", note: "SECRET-NOTE-hide" }, { now: day(9) });
  await hideEntry(h.db, actor, { entryId: ids.hanakoHidden, reason: "spam", note: "SECRET-NOTE-hide2" }, { now: day(9) });
  await softDeleteEntry(h.db, ids.johnnyDeleted, { now: day(10) });
  await softDeleteEntry(h.db, ids.hanakoDeleted, { now: day(10) });
  // Votes on hanako's Japanese topic from johnny=en, somchai=th and oscar=en.
  await setVote(h.db, h.ids.johnny_unique, ids.hanakoTopic, true);
  await setVote(h.db, h.ids.somchai_unique, ids.hanakoTopic, true);
  await setVote(h.db, h.ids.oscar_unique, ids.hanakoTopic, true);
  await setVote(h.db, h.ids.hanako_unique, ids.johnnyTopic, true);
  // Translations and divergences.
  const [e] = await h.db.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, ids.hanakoTopic));
  await h.db.insert(translations).values([
    { entryId: ids.hanakoTopic, field: "body", lang: "en", kind: "primary", text: "SECRET-TRANSLATION", engine: "claude", model: "claude-haiku-4-5", sourceHash: e.hash },
    { entryId: ids.hanakoTopic, field: "body", lang: "en", kind: "secondary", text: "SECRET-TRANSLATION-2", engine: "gemini", model: "gemini-3.5-flash-lite", sourceHash: e.hash, flags: [FLAG_JUDGED] },
    { entryId: ids.hanakoTopic, field: "title", lang: "fr", kind: "primary", text: "SECRET-TITLE-FR", engine: "gemini", model: "gemini-3.1-flash-lite", fallback: true, sourceHash: e.hash },
  ]);
  await h.db.insert(divergences).values({ entryId: ids.hanakoTopic, lang: "en", segmentIdx: 0, severity: "high", note: "SECRET-DIVERGENCE-NOTE", judgeEngine: "claude", judgeModel: "claude-haiku-4-5", sourceHash: e.hash });
  // Hidden topics also have translations and divergences, which are not exported.
  await h.db.insert(translations).values({ entryId: ids.somchaiHidden, field: "body", lang: "en", kind: "primary", text: "SECRET-TRANSLATION-HIDDEN", engine: "gemini", model: "m" });
  await h.db.insert(divergences).values({ entryId: ids.somchaiHidden, lang: "en", segmentIdx: 0, severity: "low", note: "n", judgeEngine: "claude", judgeModel: "j" });
  // Embeddings for diversity metrics: at least five September posts by hanako in ja.
  for (const id of [ids.hanakoTopic, ids.johnnyTopic, ids.johnnyReply]) {
    await h.db.insert(entryEmbeddings).values({ entryId: id, model: FAKE_EMBEDDING_MODEL, dim: 768, embedding: fakeEmbeddingVector(`x ${id}`), sourceHash: "h" });
  }
  // Human-corrected translations, with no engine or model and excluded from personal exports, plus drafts.
  await h.db.insert(translations).values([
    { entryId: ids.hanakoTopic, field: "body", lang: "fr", kind: "human", text: "SECRET-HUMAN-BODY", sourceHash: e.hash },
    { entryId: ids.hanakoTopic, field: "title", lang: "fr", kind: "human", text: "SECRET-HUMAN-TITLE", sourceHash: e.hash },
  ]);
  const draft = await createDraft(h.db, h.ids.hanako_unique, { kind: "topic", title: "SECRET-DRAFT-TITLE", body: "SECRET-DRAFT-BODY", lang: "ja" });
  if (!draft.ok) throw new Error("draft failed");
  await createDraft(h.db, h.ids.johnny_unique, { kind: "topic", title: "SECRET-JOHNNY-DRAFT", body: "b", lang: "en" });
});
afterAll(() => {
  h.restore();
  if (savedOperators === undefined) delete process.env.OPERATOR_EMAILS;
  else process.env.OPERATOR_EMAILS = savedOperators;
});

const FORBIDDEN_IN_OBSERVATION = () => [
  "@example.com",
  ...Object.values(h.ids),
  "hanako_unique",
  "johnny_unique",
  "somchai_unique",
  "oscar_unique",
  "SECRET",
];

describe("the observation export", () => {
  const salt = Buffer.from("0".repeat(64), "hex");

  it("has no emails, user ids, handles, titles or bodies, and keeps authors as pseudonymous keys", async () => {
    const out = await buildObservationExport(h.db, { model: FAKE_EMBEDDING_MODEL, now: new Date("2026-10-15T00:00:00Z"), salt });
    const text = JSON.stringify(out);
    for (const needle of FORBIDDEN_IN_OBSERVATION()) expect(text, needle).not.toContain(needle);
    expect(out).toMatchObject({ format: "tomola-observation-export", version: OBSERVATION_EXPORT_VERSION, generated_at: "2026-10-15T00:00:00.000Z", embedding_model: FAKE_EMBEDDING_MODEL });
    const visible = out.entries.filter((e) => e.status === "visible");
    const keyOf = (id: number) => (out.entries.find((e) => e.id === id) as { author: string }).author;
    expect(keyOf(ids.hanakoTopic)).toBe(createHmac("sha256", salt).update(h.ids.hanako_unique).digest("hex").slice(0, AUTHOR_KEY_LENGTH));
    expect(keyOf(ids.hanakoTopic)).toMatch(/^[0-9a-f]{16}$/);
    expect(keyOf(ids.johnnyTopic)).toBe(keyOf(ids.johnnyReply));
    expect(keyOf(ids.johnnyTopic)).not.toBe(keyOf(ids.hanakoTopic));
    expect(visible.map((e) => e.id)).toEqual([ids.hanakoTopic, ids.johnnyTopic, ids.johnnyReply]);
    // A separate export uses different author keys, preventing key-based linkage.
    const other = await buildObservationExport(h.db, { model: null });
    expect((other.entries.find((e) => e.id === ids.hanakoTopic) as { author: string }).author).not.toBe(keyOf(ids.hanakoTopic));
    expect(authorKeyOf("x", Buffer.from("a")) === authorKeyOf("x", Buffer.from("b"))).toBe(false);
  });

  it("gives the metadata of each entry, the Insightful total and number of languages per post (nothing per area), and the translation kinds, engines, models and fallback marks", async () => {
    const out = await buildObservationExport(h.db, { model: FAKE_EMBEDDING_MODEL, salt });
    const topic = out.entries.find((e) => e.id === ids.hanakoTopic) as Extract<(typeof out.entries)[number], { status: "visible" }>;
    expect(topic).toMatchObject({
      kind: "topic",
      thread_id: ids.hanakoTopic,
      lang: "ja",
      author_area: "ja",
      created_at: "2026-09-01T00:00:00.000Z",
      edited_at: "2026-09-08T00:00:00.000Z",
      ai_assistance: "draft",
      via: "web",
      asks_stance: false,
      alt_of: null,
      stance_tag: null,
      insightful: 3,
      insightful_langs: 2,
    });
    expect(topic).not.toHaveProperty("votes_by_area");
    expect(topic.translations).toEqual([
      { lang: "en", field: "body", kind: "primary", engine: "claude", model: "claude-haiku-4-5", fallback: false, flags: [] },
      { lang: "en", field: "body", kind: "secondary", engine: "gemini", model: "gemini-3.5-flash-lite", fallback: false, flags: [FLAG_JUDGED] },
      // Human corrections (kind human) have no engine or model.
      { lang: "fr", field: "body", kind: "human", engine: null, model: null, fallback: false, flags: [] },
      { lang: "fr", field: "title", kind: "human", engine: null, model: null, fallback: false, flags: [] },
      { lang: "fr", field: "title", kind: "primary", engine: "gemini", model: "gemini-3.1-flash-lite", fallback: true, flags: [] },
    ]);
    const reply = out.entries.find((e) => e.id === ids.johnnyReply) as Extract<(typeof out.entries)[number], { status: "visible" }>;
    expect(reply).toMatchObject({ kind: "reply", thread_id: ids.hanakoTopic, ai_assistance: "polish", insightful: 0, insightful_langs: 0 });
    // The count per language area of a post is not exported (it would show who pressed it on which post); only the total and the number of languages are.
    expect(JSON.stringify(out.entries)).not.toMatch(/votes_by_area|insightful_by_area|voter_area/);
  });

  it("says in the file that it is pseudonymous, not anonymous, and for operators only", async () => {
    const out = await buildObservationExport(h.db, { model: null, salt });
    expect(out.author_key.note).toMatch(/NOT anonymous/);
    expect(out.author_key.note).toMatch(/operator/i);
    expect(out.author_key.note).toMatch(/entry and thread ids/);
    expect(out.author_key.note).toMatch(/link exports/);
  });

  it("gives hidden and deleted entries as metadata only (no author, no votes, no translations)", async () => {
    const out = await buildObservationExport(h.db, { model: null });
    const hidden = out.entries.find((e) => e.id === ids.somchaiHidden)!;
    expect(hidden).toEqual({ id: ids.somchaiHidden, kind: "topic", thread_id: ids.somchaiHidden, lang: "th", created_at: "2026-09-03T00:00:00.000Z", status: "hidden" });
    const deleted = out.entries.find((e) => e.id === ids.johnnyDeleted)!;
    expect(deleted).toEqual({ id: ids.johnnyDeleted, kind: "topic", thread_id: ids.johnnyDeleted, lang: "en", created_at: "2026-09-04T00:00:00.000Z", status: "deleted" });
    // Do not export divergences for hidden topics.
    expect((await buildObservationExport(h.db, { model: null })).divergences.map((d) => d.entry_id)).not.toContain(ids.somchaiHidden);
  });

  it("gives replies under a hidden or a deleted topic as metadata only too (thread_hidden, thread_deleted): no author key, votes or translations", async () => {
    // Replies were created while the topic was readable; hidden or deleted topics reject replies. Insert rows directly here.
    const reply = async (topicId: number, as: string) => {
      const [row] = await h.db
        .insert(entries)
        .values({ kind: "reply", threadId: topicId, authorId: h.ids[as], lang: "en", body: "SECRET-REPLY-UNDER", sourceHash: "x", aiAssistance: "draft", authorArea: "en", createdAt: new Date("2026-09-12T00:00:00Z"), updatedAt: new Date("2026-09-12T00:00:00Z") })
        .returning({ id: entries.id });
      return row.id;
    };
    // Replies under hidden somchaiHidden and deleted johnnyDeleted topics, with votes and translations.
    const underHidden = await reply(ids.somchaiHidden, "johnny_unique");
    const [row] = await h.db.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, underHidden));
    await h.db.insert(translations).values({ entryId: underHidden, field: "body", lang: "ja", kind: "primary", text: "SECRET-UNDER-TRANSLATION", engine: "gemini", model: "m", sourceHash: row.hash });
    await h.db.insert(votes).values({ entryId: underHidden, voterId: h.ids.oscar_unique, voterArea: "en" });
    const underDeleted = await reply(ids.johnnyDeleted, "johnny_unique");
    const out = await buildObservationExport(h.db, { model: null, salt });
    const find = (id: number) => out.entries.find((e) => e.id === id)!;
    expect(find(underHidden)).toEqual({ id: underHidden, kind: "reply", thread_id: ids.somchaiHidden, lang: "en", created_at: "2026-09-12T00:00:00.000Z", status: "thread_hidden" });
    expect(find(underDeleted)).toEqual({ id: underDeleted, kind: "reply", thread_id: ids.johnnyDeleted, lang: "en", created_at: "2026-09-12T00:00:00.000Z", status: "thread_deleted" });
    const text = JSON.stringify(out);
    expect(text).not.toContain("SECRET-UNDER-TRANSLATION");
    expect(text).not.toContain("SECRET-REPLY-UNDER");
    // The replies themselves are neither deleted nor hidden.
    for (const id of [underHidden, underDeleted]) expect((await h.db.select({ d: entries.deletedAt, hd: entries.hiddenAt }).from(entries).where(eq(entries.id, id)))[0].hd).toBeNull();
    // Cleanup preserves other tests' assumptions about readable-post ordering.
    await h.db.delete(votes).where(eq(votes.entryId, underHidden));
    await h.db.delete(translations).where(eq(translations.entryId, underHidden));
    await h.db.delete(entries).where(eq(entries.id, underHidden));
    await h.db.delete(entries).where(eq(entries.id, underDeleted));
  });

  it("gives the divergence records without the judge's note, with the engines and whether the vendor was the same, and the diversity metrics", async () => {
    const out = await buildObservationExport(h.db, { model: FAKE_EMBEDDING_MODEL, now: new Date("2026-10-15T00:00:00Z"), salt });
    expect(out.divergences).toEqual([
      {
        entry_id: ids.hanakoTopic,
        lang: "en",
        segment_idx: 0,
        severity: "high",
        category: "meaning",
        judge_engine: "claude",
        judge_model: "claude-haiku-4-5",
        primary_engine: "claude",
        primary_model: "claude-haiku-4-5",
        secondary_engine: "gemini",
        secondary_model: "gemini-3.5-flash-lite",
        same_vendor: false,
      },
    ]);
    expect(out.divergence_summary).toMatchObject([{ from: "ja", to: "en", measured: 1, records: 1 }]);
    expect(out.diversity).toEqual([]);
    expect(out.ai_assistance).toEqual(expect.arrayContaining([expect.objectContaining({ area: "ja", month: "2026-09", total: 1 })]));
    expect(out.conformity_warnings).toEqual([]);
  });

  describe("the route", () => {
    const get = (as?: string) => h.outcome(() => import("~/routes/admin-export").then(async (m) => (await m.loader(h.args(h.request("/admin/export", { as }))))));

    it("is for operators only: visitors go to the login, other members get 404", async () => {
      expect(await get()).toMatchObject({ status: 302, location: "/login?next=%2Fadmin%2Fexport" });
      expect(await get("hanako_unique")).toMatchObject({ status: 404 });
    });

    it("downloads JSON with no-store and an attachment name, and is limited to 10 an hour", async () => {
      const res = await get("oscar_unique");
      expect(res.status).toBe(200);
      const response = res.value as Response;
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="tomola-observation-\d{4}-\d{2}-\d{2}\.json"$/);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ format: "tomola-observation-export" });
      for (const needle of FORBIDDEN_IN_OBSERVATION()) expect(body, needle).not.toContain(needle);
      const windowMs = MEMBER_RATE_LIMITS.export.windowSeconds * 1000;
      const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
      await h.db.insert(rateLimits).values({ key: `member:export:${h.ids.oscar_unique}`, windowStart, count: 10, expiresAt: new Date(windowStart.getTime() + windowMs) }).onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: 10 } });
      expect(await get("oscar_unique")).toMatchObject({ status: 429 });
    });
  });
});

describe("the observation page", () => {
  const get = (as?: string) => h.outcome(() => import("~/routes/admin-observation").then(async (m) => (await m.loader(h.args(h.request("/admin/observation", { as }))))));
  it("is for operators only (404 for other members, the login for visitors) and returns the three views", async () => {
    expect(await get()).toMatchObject({ status: 302, location: "/login?next=%2Fadmin%2Fobservation" });
    expect(await get("johnny_unique")).toMatchObject({ status: 404 });
    const res = await get("oscar_unique");
    expect(res.status).toBe(200);
    const data = res.value as { divergence: unknown[]; diversity: unknown[]; conformity: unknown[]; aiAssistance: unknown[]; model: string | null; divergenceEnabled: boolean };
    expect(data.model).toBe(FAKE_EMBEDDING_MODEL);
    // Multi-model divergence detection is disabled by default without TRANSLATION_SECONDARY and DIVERGENCE_JUDGE; show that on screen.
    expect(data.divergenceEnabled).toBe(false);
    expect(data.divergence).toHaveLength(1);
    expect(Array.isArray(data.diversity) && Array.isArray(data.conformity) && Array.isArray(data.aiAssistance)).toBe(true);
    // UI data also excludes email addresses and handles.
    expect(JSON.stringify(data)).not.toMatch(/@example\.com|_unique|SECRET/);
  });
});

describe("the member's own export", () => {
  const get = (as?: string) => h.outcome(() => import("~/routes/settings-export").then(async (m) => (await m.loader(h.args(h.request("/settings/export", { as }))))));

  it("has the member's own posts (hidden ones too, deleted ones not), their earlier versions, drafts and Insightful (and no author translations)", async () => {
    const out = await buildMemberExport(h.db, h.ids.hanako_unique, { now: new Date("2026-10-15T00:00:00Z") });
    expect(out).toMatchObject({ format: "tomola-member-export", version: MEMBER_EXPORT_VERSION, generated_at: "2026-10-15T00:00:00.000Z" });
    // No author-translation keys since version 2. Personal exports also exclude human-corrected translations.
    expect(Object.keys(out)).toEqual(["ai_materials", "format", "push_subscriptions", "version", "generated_at", "profile", "entries", "drafts", "insightful", "stances", "stance_changes", "saved_topics", "follows", "village_icons", "village_follows", "signatures", "chat_messages"]);
    expect(out.chat_messages).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("SECRET-HUMAN");
    expect(out.profile).toMatchObject({ handle: "hanako_unique", home_area: "ja", read_langs: ["ja", "en"] });
    // "writable languages" are gone: the key is not in the export
    expect(out.profile).not.toHaveProperty("write_langs");
    expect(out.entries.map((e) => [e.id, e.status])).toEqual([
      [ids.hanakoTopic, "visible"],
      [ids.hanakoHidden, "hidden"],
    ]);
    const mine = out.entries[0];
    expect(mine).toMatchObject({ title: "SECRET-TITLE-hanako-v2", body: "SECRET-BODY-hanako-v2", lang: "ja", ai_assistance: "draft", via: "web", author_area: "ja" });
    expect(mine.revisions).toEqual([{ title: "SECRET-TITLE-hanako", body: "SECRET-BODY-hanako", signature_ids: [], deleted_at: null, edited_at: "2026-09-08T00:00:00.000Z" }]);
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]).toMatchObject({ kind: "topic", title: "SECRET-DRAFT-TITLE", body: "SECRET-DRAFT-BODY", via: "web" });
    // Votes on other members' topics contain only the post ID and the viewer's own area.
    expect(out.insightful).toEqual([{ entry_id: ids.johnnyTopic, voter_area: "ja", created_at: expect.any(String) }]);
    expect(out).not.toHaveProperty("votes");
  });

  it("has the member's own follows (both states, topic ids only: nothing about the topic or anyone else)", async () => {
    const before = (await buildMemberExport(h.db, h.ids.hanako_unique)).follows;
    // The topics she wrote are followed automatically
    expect(before.map((f) => f.thread_id)).toEqual(expect.arrayContaining([ids.hanakoTopic, ids.hanakoHidden]));
    expect(before.every((f) => f.state === "following")).toBe(true);
    await setFollow(h.db, h.ids.hanako_unique, ids.hanakoTopic, false, { now: new Date("2026-10-10T00:00:00Z") });
    await setFollow(h.db, h.ids.hanako_unique, ids.johnnyTopic, true, { now: new Date("2026-10-11T00:00:00Z") });
    const out = await buildMemberExport(h.db, h.ids.hanako_unique);
    expect(out.follows.find((f) => f.thread_id === ids.hanakoTopic)).toEqual({ thread_id: ids.hanakoTopic, state: "unfollowed", created_at: expect.any(String), updated_at: "2026-10-10T00:00:00.000Z" });
    expect(out.follows.find((f) => f.thread_id === ids.johnnyTopic)).toMatchObject({ state: "following", updated_at: "2026-10-11T00:00:00.000Z" });
    for (const f of out.follows) expect(Object.keys(f)).toEqual(["thread_id", "state", "created_at", "updated_at"]);
    // Another member's follows are not in it
    expect(out.follows.map((f) => f.thread_id)).toEqual([...before.map((f) => f.thread_id), ids.johnnyTopic]);
    expect((await buildMemberExport(h.db, h.ids.johnny_unique)).follows.map((f) => f.thread_id)).not.toContain(ids.hanakoHidden);
  });

  it("has no other member's personal data: no emails, ids, handles, nor their posts or drafts", async () => {
    const res = await get("hanako_unique");
    expect(res.status).toBe(200);
    const response = res.value as Response;
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="tomola-my-data-\d{4}-\d{2}-\d{2}\.json"$/);
    const text = await response.text();
    for (const needle of ["johnny", "somchai", "oscar", "SECRET-TITLE-johnny", "SECRET-BODY-johnny", "SECRET-REPLY-johnny", "SECRET-JOHNNY-DRAFT", "SECRET-TITLE-hidden", "SECRET-TITLE-deleted", "SECRET-TITLE-hanako-deleted", "@example.com", h.ids.johnny_unique, h.ids.somchai_unique, h.ids.oscar_unique]) {
      expect(text, String(needle)).not.toContain(String(needle));
    }
    // Also omit the viewer's own user ID and email address.
    expect(text).not.toContain(h.ids.hanako_unique);
    expect(JSON.parse(text).entries.map((e: { id: number }) => e.id)).not.toContain(ids.johnnyReply);
  });

  it("is for members: visitors go to the login, a user mid-signup to onboarding, and a suspended member can still export", async () => {
    expect(await get()).toMatchObject({ status: 302, location: "/login?next=%2Fsettings%2Fexport" });
    await h.signIn("halfway", { profile: false });
    expect(await get("halfway")).toMatchObject({ status: 302, location: "/onboarding" });
    await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86_400_000), suspendedReason: "spam" }).where(eq(profiles.userId, h.ids.johnny_unique));
    const res = await get("johnny_unique");
    expect(res.status).toBe(200);
    expect(JSON.parse(await (res.value as Response).text()).entries.map((e: { id: number }) => e.id)).toEqual([ids.johnnyTopic, ids.johnnyReply]);
  });

  it("is limited to 10 an hour per member", async () => {
    const windowMs = MEMBER_RATE_LIMITS.export.windowSeconds * 1000;
    const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
    await h.db.insert(rateLimits).values({ key: `member:export:${h.ids.somchai_unique}`, windowStart, count: 10, expiresAt: new Date(windowStart.getTime() + windowMs) });
    expect(await get("somchai_unique")).toMatchObject({ status: 429 });
    expect((await get("hanako_unique")).status).toBe(200);
  });
});

describe("the drafts of other members do not leak into the observation export", () => {
  it("(the drafts table is not read at all)", async () => {
    expect((await h.db.select().from(drafts)).length).toBeGreaterThan(1);
    expect(JSON.stringify(await buildObservationExport(h.db, { model: null }))).not.toContain("DRAFT");
  });
});
